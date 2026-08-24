const grid = document.getElementById("grid");
const counts = document.getElementById("counts");
const conn = document.getElementById("conn");
const overlay = document.getElementById("modal-overlay");
const modal = document.getElementById("modal");
let openSid = null;
let agents = [];
let editingName = false;  // pause head re-render while the rename input is open
let lastPayload = "";
let spawnDir = "~/";  // server expands ~; refined from /api/state

// The server gates /api/* on this token; it rides in the URL fragment
// (never sent on the wire by the browser) and on every request we make.
const token = location.hash.slice(1);
const authHeaders = extra => Object.assign({"X-Auth-Token": token}, extra || {});

const STATE_LABEL = {
  needs_input: "needs approval",
  waiting: "waiting for you",
  busy: "working",
  idle: "idle",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

function ago(ts) {
  if (!ts) return "–";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}

function badge(state, extraClass = "") {
  const pulse = state === "needs_input" || state === "busy" ? "pulse" : "";
  return `<span class="badge ${esc(state)} ${extraClass}">
    <span class="dot ${pulse}"></span>${STATE_LABEL[state] || esc(state)}</span>`;
}

function whenAbs(ts) {
  if (!ts) return "";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return isNaN(d) ? "" : d.toLocaleString();
}

function fmtDuration(ts) {
  if (!ts) return "–";
  const ms = ts > 1e12 ? ts : ts * 1000;
  let s = Math.max(0, (Date.now() - ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ---------- pixel mascot (a little Tamagotchi Claude per session) ----------
   Body colour = model family (see legend). Hat + accent = deterministic from the
   repo (or dir) so agents that share a repo look like a family. Face = live
   state, so the pet's mood tracks what the agent is doing. */

/* Monokai-pastel skins; "other" keeps the authentic clay Claude. */
const MODEL_SKIN = {
  fable:  {label: "Fable",  body: "#ff6188", outline: "#b23557"},
  opus:   {label: "Opus",   body: "#ab9df2", outline: "#7568b8"},
  sonnet: {label: "Sonnet", body: "#78dce8", outline: "#4899a5"},
  haiku:  {label: "Haiku",  body: "#a9dc76", outline: "#6f9c48"},
  other:  {label: "Claude", body: "#d08b6c", outline: "#9a5c40"},
};
const MODEL_ORDER = ["fable", "opus", "sonnet", "haiku", "other"];

function modelFamily(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Fantasy kit (hat/held item) picked deterministically per repo, tinted by ACCENT.
const KITS = ["king", "knight", "princess", "wizard", "fairy", "mage", "guardian", "warrior"];
const ACCENTS = ["#ffd866", "#ff6188", "#78dce8", "#ab9df2", "#fc9867", "#a9dc76", "#8fb8ff", "#ffa7c4"];

function critterOf(a) {
  const model = (a.context_breakdown || {}).model;
  const skin = MODEL_SKIN[modelFamily(model)];
  const key = a.git?.repo ? "repo:" + a.git.repo : "dir:" + (a.cwd || a.sessionId);
  const h = hashStr(key);
  return {skin, kit: KITS[h % KITS.length], accent: ACCENTS[(h >> 5) % ACCENTS.length]};
}

/* The pet IS the Claude Code creature: one big rectangle, two little arm nubs
   just below the middle, four stubby legs, and fixed rectangular pupils.
   Body colour = model, kit = repo. 18 wide × 16 tall grid. */
const CREATURE = (() => {
  const c = [];
  for (let y = 4; y <= 11; y++) for (let x = 3; x <= 14; x++) {
    const corner = (x === 3 || x === 14) && (y === 4 || y === 11);
    if (!corner) c.push([x, y, "T"]);
  }
  // arm nubs, a bit below the middle
  [[1,7],[2,7],[1,8],[2,8],[15,7],[16,7],[15,8],[16,8]].forEach(([x, y]) => c.push([x, y, "T"]));
  [4, 7, 10, 13].forEach(x => { c.push([x, 12, "t"]); c.push([x, 13, "t"]); });
  return c;
})();

const CLR = {A: null, G: "#ffd866", S: "#c7ced6", W: "#fdf6ee", D: "#9a6b3f",
             E: "#2d2a2e", z: "#78dce8"};
const paint = (role, accent) => CLR[role] || accent;

// The eyes never change: two 1×2 rectangular pupils. Idle just dreams in zzz.
const EYES = [[6,6,"E"],[6,7,"E"],[11,6,"E"],[11,7,"E"]];
const ZZZ = [[1,1,"z"],[2,0,"z"],[2,2,"z"]];

// Kits: [x, y, role] — G gold, S steel, W white, D wood, A repo accent.
// Hats live in rows 0–3; held items attach at the arms (rows 7–8).
const KIT = {
  king:    [[5,2,"G"],[8,2,"G"],[11,2,"G"],
            [5,3,"G"],[6,3,"G"],[7,3,"A"],[8,3,"G"],[9,3,"G"],[10,3,"A"],[11,3,"G"],[12,3,"G"]],
  knight:  [[8,0,"A"],[8,1,"A"],[9,1,"A"],
            [5,2,"S"],[6,2,"S"],[7,2,"S"],[8,2,"S"],[9,2,"S"],[10,2,"S"],[11,2,"S"],[12,2,"S"],
            [5,3,"S"],[6,3,"S"],[11,3,"S"],[12,3,"S"]],
  princess:[[10,0,"A"],[9,1,"A"],[10,1,"A"],[9,2,"A"],[10,2,"A"],[11,2,"A"],
            [8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],
            [11,0,"W"],[12,1,"W"],[13,2,"W"]],                        // hennin + veil
  wizard:  [[8,0,"G"],[8,1,"A"],[9,1,"A"],[7,2,"A"],[8,2,"A"],[9,2,"A"],[10,2,"A"],
            [5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],[12,3,"A"],
            [16,3,"G"],[16,4,"D"],[16,5,"D"],[16,6,"D"],[15,2,"A"],[17,2,"A"]],  // + wand in hand
  fairy:   [[2,3,"W"],[1,4,"W"],[2,4,"W"],[0,5,"W"],[1,5,"A"],[2,5,"W"],[1,6,"W"],[2,6,"A"],
            [15,3,"W"],[15,4,"W"],[16,4,"W"],[17,5,"W"],[16,5,"A"],[15,5,"W"],[16,6,"W"],[15,6,"A"],
            [9,0,"G"],[8,1,"G"],[10,1,"G"],[9,2,"G"]],  // big wings + a little sparkle halo
  mage:    [[1,2,"A"],[0,1,"G"],[2,1,"G"],[1,3,"D"],[1,4,"D"],[1,5,"D"],[1,6,"D"]],  // orb staff
  guardian:[[16,5,"S"],[17,5,"S"],[16,6,"S"],[17,6,"S"],[16,7,"A"],[17,7,"A"],
            [16,8,"S"],[17,8,"S"],[16,9,"S"],[17,9,"S"],[16,10,"S"],[17,10,"S"]],  // shield
  warrior: [[16,0,"W"],[16,1,"S"],[16,2,"S"],[16,3,"S"],[16,4,"S"],[16,5,"S"],
            [15,6,"G"],[16,6,"G"],[17,6,"G"]],                        // sword held high
};

function mascotSvg(a, cls = "") {
  const {skin, kit, accent} = critterOf(a);
  const px = [];
  const cell = (x, y, c) =>
    px.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`);
  CREATURE.forEach(([x, y, r]) => cell(x, y, r === "T" ? skin.body : skin.outline));
  (KIT[kit] || []).forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  EYES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  if (a.state === "idle") ZZZ.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  return `<svg xmlns="http://www.w3.org/2000/svg" class="mascot ${esc(a.state)} ${cls}"
    viewBox="0 0 18 14.2" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"
    aria-hidden="true">${px.join("")}</svg>`;
}

function legendHtml() {
  return `<div class="legend" title="Mascot colour = model">
    ${MODEL_ORDER.map(k => `<span class="legend-item">
      <span class="legend-dot" style="background:${MODEL_SKIN[k].body}"></span>${MODEL_SKIN[k].label}</span>`).join("")}
  </div>`;
}

/* ---------- generic DAG (SVG) ----------
   nodes: [{id, label, status}], edges: [[from, to]] */

function dagSvg(nodes, edges) {
  const byId = Object.fromEntries(nodes.map(n => [String(n.id), n]));
  const parents = {};
  for (const [a, b] of edges) {
    if (byId[a] && byId[b]) (parents[b] = parents[b] || []).push(String(a));
  }
  const depthMemo = {};
  function depth(id, seen = new Set()) {
    if (id in depthMemo) return depthMemo[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = parents[id] || [];
    depthMemo[id] = deps.length ? 1 + Math.max(...deps.map(d => depth(d, seen))) : 0;
    return depthMemo[id];
  }
  const cols = {};
  for (const n of nodes) {
    const d = depth(String(n.id));
    (cols[d] = cols[d] || []).push(n);
  }
  const W = 172, H = 46, GX = 54, GY = 14;
  const pos = {};
  let maxRow = 0;
  for (const [d, list] of Object.entries(cols)) {
    list.forEach((n, i) => {
      pos[n.id] = {x: d * (W + GX), y: i * (H + GY)};
      maxRow = Math.max(maxRow, i + 1);
    });
  }
  const width = Object.keys(cols).length * (W + GX) - GX;
  const height = maxRow * (H + GY) - GY;

  let edgeSvg = "";
  for (const [a, b] of edges) {
    if (!pos[a] || !pos[b]) continue;
    const p1 = pos[a], p2 = pos[b];
    const x1 = p1.x + W, y1 = p1.y + H / 2, x2 = p2.x, y2 = p2.y + H / 2;
    const mx = (x1 + x2) / 2;
    edgeSvg += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"
      marker-end="url(#arr)"/>`;
  }

  const ICON = {completed: "✓", in_progress: "▶", blocked: "✕", pending: "•"};
  let nodeSvg = "";
  for (const n of nodes) {
    const p = pos[n.id];
    const status = ICON[n.status] ? n.status : "pending";
    const label = `${ICON[status]} ${n.label || n.id}`;
    const line1 = esc(label.slice(0, 26));
    const line2 = esc(label.slice(26, 52)) + (label.length > 52 ? "…" : "");
    nodeSvg += `<g class="node ${status}" transform="translate(${p.x},${p.y})">
      <title>${esc(n.label)} [${status}]</title>
      <rect width="${W}" height="${H}" rx="8"/>
      <text x="9" y="${line2 ? 19 : 27}">${line1}</text>
      ${line2 ? `<text x="9" y="34">${line2}</text>` : ""}
    </g>`;
  }

  const legend = `<div class="dag-legend">
    <span><span class="key completed"></span>done</span>
    <span><span class="key in_progress"></span>in progress</span>
    <span><span class="key pending"></span>pending</span>
    <span><span class="key blocked"></span>blocked</span>
  </div>`;

  return `<div class="dag-wrap"><svg class="dag" viewBox="0 0 ${width} ${height}"
    preserveAspectRatio="xMinYMin meet" style="width:100%;height:auto;max-width:${width}px">
    <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7"
      markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#898781"/></marker></defs>
    ${edgeSvg}${nodeSvg}</svg>${legend}</div>`;
}

function checklistHtml(nodes) {
  const ICON = {completed: "✓", in_progress: "▶", blocked: "✕", pending: "○"};
  const items = nodes.map(n => {
    const status = ICON[n.status] ? n.status : "pending";
    return `<li class="${status}"><span class="ico">${ICON[status]}</span>
      <span>${esc(n.label)}</span></li>`;
  }).join("");
  return `<ul class="tasklist">${items}</ul>`;
}

function graphHtml(nodes, edges) {
  if (!nodes.length) return "";
  return edges.length ? dagSvg(nodes, edges) : checklistHtml(nodes);
}

/* Best available graph: agent-written first, TodoWrite task store second. */
function agentGraph(a) {
  const g = a.agent_status?.graph;
  if (g && Array.isArray(g.nodes) && g.nodes.length) {
    const nodes = g.nodes.map(n => ({id: n.id, label: n.label || n.id, status: n.status}));
    const edges = (Array.isArray(g.edges) ? g.edges : [])
      .filter(e => Array.isArray(e) && e.length === 2)
      .map(e => [String(e[0]), String(e[1])]);
    return {nodes, edges, source: "agent"};
  }
  if (a.tasks?.length) {
    const nodes = a.tasks.map(t =>
      ({id: String(t.id), label: t.subject || t.activeForm, status: t.status}));
    const edges = [];
    for (const t of a.tasks) {
      for (const dep of (t.blockedBy || [])) edges.push([String(dep), String(t.id)]);
    }
    return {nodes, edges, source: "tasks"};
  }
  return null;
}

/* ---------- markdown renderer (escape-first, safe subset) ---------- */

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdHtml(text) {
  const lines = esc(text).split("\n");
  const out = [];
  let inCode = false, inList = null, para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join("<br>"))}</p>`); para = []; }
  };
  const closeList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushPara(); closeList();
      out.push(inCode ? "</code></pre>" : '<pre class="codeblock"><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line + "\n"); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`);
    } else if (ul) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${mdInline(ul[1])}</li>`);
    } else if (ol) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${mdInline(ol[1])}</li>`);
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      para.push(line);
    }
  }
  if (inCode) out.push("</code></pre>");
  flushPara(); closeList();
  return `<div class="md">${out.join("")}</div>`;
}

/* ---------- minimal todo.md renderer ---------- */

function todoMdHtml(md) {
  const out = [];
  let inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/);
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      const done = li[1] && li[1] !== " ";
      const box = li[1] !== undefined ? (done ? "☑ " : "☐ ") : "";
      out.push(`<li class="${done ? "done" : ""}">${box}${esc(li[2])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (h) out.push(`<h${h[1].length + 1}>${esc(h[2])}</h${h[1].length + 1}>`);
    else if (line.trim()) out.push(`<p>${esc(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return `<div class="todo-md">${out.join("")}</div>`;
}

/* ---------- cards ---------- */

function summaryLine(a) {
  return a.agent_status?.summary || a.title || a.last_assistant || "";
}

const STATE_ICON = {needs_input: "⚠", waiting: "⏸", busy: "●", idle: "○"};

// Only the modes reachable via Shift+Tab cycling (Bypass is a separate opt-in).
const MODE_LABEL = {default: "Manual", acceptEdits: "Auto-edit", plan: "Plan",
                    auto: "Auto", bypassPermissions: "Bypass"};
const MODE_SHORT = {default: "manual", acceptEdits: "auto-edit", plan: "plan",
                    auto: "auto", bypassPermissions: "bypass"};

function keyBtn(target, key, label, cls) {
  return `<button class="key-btn ${cls}" data-target="${esc(target)}" data-key="${esc(key)}">${label}</button>`;
}

function approvalActionsHtml(a) {
  if (a.state !== "needs_input" || !a.tmux) return "";
  return `<div class="approve-row">
    ${keyBtn(a.tmux.target, "1", "✓ Approve", "ok")}
    ${keyBtn(a.tmux.target, "2", "Always", "alt")}
    ${keyBtn(a.tmux.target, "Escape", "✕ Deny", "no")}
  </div>`;
}

function modeSelectorHtml(a) {
  if (!a.permission_mode) return "";
  return `<div class="section"><div class="section-title">Permission mode</div>
    <div class="mode-current">${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)}
      <span class="mode-hint">change it in the session with ⇧⇥</span></div></div>`;
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

/* Context-window usage: {pct, label, level} or null. */
function contextInfo(a) {
  if (!a.context_tokens || !a.context_window) return null;
  const pct = Math.min(100, Math.round(a.context_tokens / a.context_window * 100));
  const level = pct >= 85 ? "critical" : pct >= 65 ? "warn" : "ok";
  return {pct, level,
    label: `${fmtTokens(a.context_tokens)} / ${fmtTokens(a.context_window)}`};
}

function contextMeterHtml(a) {
  const c = contextInfo(a);
  if (!c) return "";
  return `<div class="ctx ${c.level}">
    <span class="ctx-track"><span class="ctx-fill" style="width:${c.pct}%"></span></span>
    <span class="ctx-label">${c.label} · ${c.pct}%</span>
  </div>`;
}

const CTX_PARTS = [
  {key: "cache_read", label: "Cache read", cls: "p-cacheread"},
  {key: "cache_write", label: "Cache write", cls: "p-cachewrite"},
  {key: "fresh_input", label: "Fresh input", cls: "p-fresh"},
  {key: "output", label: "Output", cls: "p-output"},
];

/* Detailed token breakdown of the last turn (Overview section). */
function contextDetailHtml(a) {
  const b = a.context_breakdown;
  if (!b) return "";
  const total = a.context_tokens || 1;
  const win = a.context_window;
  const segs = CTX_PARTS.map(p => {
    const v = b[p.key] || 0;
    return v ? `<span class="${p.cls}" style="flex:${v}"
      title="${p.label}: ${v.toLocaleString()}"></span>` : "";
  }).join("");
  const rows = CTX_PARTS.map(p => {
    const v = b[p.key] || 0;
    return `<div class="cd-row">
      <span class="cd-key"><span class="cd-dot ${p.cls}"></span>${p.label}</span>
      <span class="cd-val">${v.toLocaleString()}</span>
      <span class="cd-pct">${Math.round(v / total * 100)}%</span>
    </div>`;
  }).join("");
  return `<div class="section">
    <div class="section-title">Context
      ${b.model ? `<span class="when">${esc(b.model)}</span>` : ""}</div>
    ${contextMeterHtml(a)}
    <div class="cd-bar">${segs}</div>
    <div class="cd-list">${rows}
      <div class="cd-row cd-total">
        <span class="cd-key">Total in context</span>
        <span class="cd-val">${(a.context_tokens).toLocaleString()}</span>
        <span class="cd-pct">${win ? Math.round(a.context_tokens / win * 100) + "%" : ""}</span>
      </div>
      <div class="cd-row cd-window">
        <span class="cd-key">Window</span>
        <span class="cd-val">${win ? win.toLocaleString() : "–"}</span>
        <span class="cd-pct"></span>
      </div>
    </div>
  </div>`;
}

/* One line answering "what is it doing / what does it need". */
function pendingLabel(a) {
  const p = a.pending_tool;
  if (p) return p.name + (p.detail ? ": " + p.detail : "");
  return a.notification || "Needs your approval";
}

function cardHtml(a) {
  const tasks = a.tasks || [];
  const done = tasks.filter(t => t.status === "completed").length;
  const total = tasks.length;
  const model = MODEL_SKIN[modelFamily((a.context_breakdown || {}).model)];
  const accent = critterOf(a).accent;

  const ctx = contextInfo(a);
  const mood = a.state === "needs_input" ? `⚠ ${pendingLabel(a)}`
    : a.state === "waiting" ? `⏸ ${a.notification || "Waiting for your input"}`
    : a.activity ? `▶ ${a.activity}`
    : a.current_task ? `▶ ${a.current_task}`
    : summaryLine(a) || STATE_LABEL[a.state] || a.state;

  return `<div class="card tama ${esc(a.state)}" data-sid="${esc(a.sessionId)}"
    style="--pet-accent:${accent}">
    <div class="tama-screen">
      <div class="tama-top">
        <span class="state-ico ${esc(a.state)}" title="${STATE_LABEL[a.state] || ""}">${STATE_ICON[a.state] || "○"}</span>
        <span class="agent-name" title="${esc(a.name)} — click to open, rename inside">${esc(a.display_name || a.name)}</span>
        <span class="model-tag" title="Model — the pet's colour">${esc(model.label)}</span>
      </div>
      <div class="tama-mid">
        <div class="tama-stats">
          ${ctx ? `<div class="stat-big ${ctx.level}" title="Context window used: ${ctx.label}. Higher = closer to compacting.">
            <span class="stat-num">${ctx.pct}</span><span class="stat-unit">% ctx</span></div>` : ""}
          <div class="stat-sub" title="${done}/${total} tasks done">${total ? `${done}/${total} tasks` : "no tasks"}</div>
          <div class="stat-sub state-word ${esc(a.state)}">${STATE_LABEL[a.state] || esc(a.state)}</div>
        </div>
        <div class="tama-pet">${mascotSvg(a)}<div class="pet-ground"></div></div>
      </div>
      <div class="mood-pill ${esc(a.state)}" title="${esc(mood)}">${esc(mood)}</div>
      ${approvalActionsHtml(a)}
    </div>
    <div class="tama-buttons" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="shell-meta">
      <div title="Working directory"><b>dir</b> ${esc(a.cwd)}</div>
      ${a.git ? `<div title="git repository · branch @ commit"><b>git</b> ${esc(a.git.repo)} · ${esc(a.git.branch)} @ ${esc(a.git.commit)}</div>` : ""}
      <div title="Session started ${esc(whenAbs(a.startedAt))} — id ${esc(a.sessionId)}">
        <b>born</b> ${ago(a.startedAt)} <span class="sid">#${esc((a.sessionId || "").slice(0, 8))}</span></div>
    </div>
    <div class="tama-foot">
      ${a.permission_mode ? `<span class="mode-chip" title="Permission mode: ${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)}">${esc(MODE_SHORT[a.permission_mode] || a.permission_mode)}</span>` : ""}
      ${a.tmux ? `<button class="tmux-btn" data-target="${esc(a.tmux.target)}"
         title="tmux ${esc(a.tmux.target)} = session:window.pane — click to jump your terminal here">${esc(a.tmux.target)}</button>` : ""}
      <span class="time" title="Last activity">${ago(a.transcript_mtime)}</span>
    </div>
  </div>`;
}

/* ---------- modal (tabbed) ---------- */

let activeTab = "overview";
let lastRenderedTab = null;
let lastChatKey = "";

const TABS = [
  {id: "overview", label: "Overview", show: () => true},
  {id: "graph", label: "Work graph", show: a => !!agentGraph(a)},
  {id: "exchange", label: "Exchange", show: a => a.last_prompt || a.last_assistant},
  {id: "todo", label: "todo.md", show: a => !!a.todo_md},
];

function tabbarHtml(a) {
  return TABS.filter(t => t.show(a)).map(t => `<button
    class="tab ${t.id === activeTab ? "active" : ""}" data-tab="${t.id}">
    ${t.label}${t.id === "overview" && a.notification ? '<span class="tab-dot"></span>' : ""}
  </button>`).join("");
}

function toolLine(m) {
  const full = `${m.name || "tool"}${m.detail ? " " + m.detail : ""}`;
  return `<div class="tool-call" title="${esc(full)}">
    <span class="tool-call-name">${esc(m.name || "tool")}</span>
    ${m.detail ? `<span class="tool-call-detail">${esc(m.detail)}</span>` : ""}
  </div>`;
}

function chatBubble(role, text, who, ts, thinking) {
  const think = (role !== "user" && thinking)
    ? `<details class="think"><summary>Thinking</summary>
        <div class="think-body">${mdHtml(thinking)}</div></details>`
    : "";
  return `<div class="msg ${role === "user" ? "user" : "assistant"}">
    <div class="msg-meta">${esc(who)}${ts ? `<span>${msgTime(ts)}</span>` : ""}</div>
    ${think}
    <div class="msg-text">${mdHtml(text)}</div>
  </div>`;
}

function lastExchangeHtml(a) {
  // Prefer the live chat tail — shows the recent messages, tool calls and
  // thinking (what the model is doing now). Fall back to the lightweight
  // last_exchange from /api/state until the full chat has loaded.
  let msgs;
  if (chat.sid === a.sessionId && chat.messages && chat.messages.length) {
    const all = chat.messages;
    // Anchor on your last message so it stays visible, then show the response
    // after it; if that's long, keep your message + the recent tail with a marker.
    let lu = -1;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].role === "user") { lu = i; break; }
    if (lu >= 0) {
      const turn = all.slice(lu);
      const TAIL = 11;
      msgs = turn.length > TAIL + 1
        ? [turn[0], {role: "gap", count: turn.length - 1 - TAIL}, ...turn.slice(-TAIL)]
        : turn;
    } else {
      msgs = all.slice(-10);
    }
  } else if (a.last_exchange && a.last_exchange.length) {
    msgs = a.last_exchange;
  } else {
    msgs = [];
    if (a.last_prompt) msgs.push({role: "user", text: a.last_prompt});
    if (a.last_assistant) msgs.push({role: "assistant", text: a.last_assistant});
  }
  if (!msgs.length) return "";
  return `<div class="section">
    <div class="section-title">Last exchange</div>
    <div class="chat">${renderChatEntries(a, msgs)}</div></div>`;
}

function summarySectionHtml(a) {
  return `<div class="section">
    <div class="section-title">Summary
      ${a.agent_status ? `<span class="when">updated ${ago(a.agent_status.updated)}</span>`
                       : `<span class="when">from transcript</span>`}</div>
    <div class="summary-box">${mdHtml(a.agent_status?.summary || a.last_assistant || "No summary yet.")}</div>
  </div>`;
}

function detailsSectionHtml(a) {
  const tasks = a.tasks || [];
  const done = tasks.filter(t => t.status === "completed").length;
  const rows = [
    ["Session ID", a.sessionId],
    ["Path", a.cwd],
    ["Repo", a.git ? `${a.git.repo} · ${a.git.branch} @ ${a.git.commit}` : "—"],
    ["tmux", a.tmux ? a.tmux.target : "not found"],
    ["Tasks", tasks.length ? `${done}/${tasks.length} done` : "–"],
    ["Born", a.startedAt ? `${whenAbs(a.startedAt)} (${ago(a.startedAt)})` : "–"],
    ["Runtime", fmtDuration(a.startedAt)],
    ["Last activity", ago(a.transcript_mtime)],
    ["Transcript", a.transcript || "—"],
    ["Scratchpad", a.scratchpad || "— (none yet)"],
    ["pid", a.pid],
  ];
  return `<div class="section">
    <div class="section-title">Details</div>
    <dl class="details">${rows.map(([k, v]) =>
      `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
  </div>`;
}

function overviewTab(a) {
  const out = [];
  if (a.state === "needs_input" || a.notification) {
    const p = a.pending_tool;
    const detail = p
      ? `<div class="approve-detail"><span class="tool-name">${esc(p.name)}</span>${
          p.detail ? `<pre class="tool-cmd">${esc(p.detail)}</pre>` : ""}</div>`
      : "";
    out.push(`<div class="section"><div class="notif">⚠ ${esc(a.notification || "Needs your approval")}</div>
      ${detail}${approvalActionsHtml(a)}</div>`);
  }
  if (a.activity) {
    out.push(`<div class="section"><div class="card-activity big"><span class="spin-dot"></span>${esc(a.activity)}</div></div>`);
  }
  out.push(summarySectionHtml(a));
  out.push(modeSelectorHtml(a));
  out.push(detailsSectionHtml(a));
  out.push(contextDetailHtml(a));
  out.push(lastExchangeHtml(a));
  return out.join("");
}

function graphTab(a) {
  const g = agentGraph(a);
  if (!g) return "";
  return `<div class="section">
    <div class="section-title">Work graph
      <span class="when">${g.source === "agent" ? "agent-maintained" : "from task list"}</span></div>
    ${graphHtml(g.nodes, g.edges)}
  </div>`;
}

let chat = {sid: null, messages: null};

async function loadChat(sid) {
  try {
    const res = await fetch(`/api/chat?sid=${encodeURIComponent(sid)}`,
      {headers: authHeaders()});
    const d = await res.json();
    if (openSid === sid) {
      const changed = !chat.messages || chat.sid !== sid ||
        JSON.stringify(chat.messages) !== JSON.stringify(d.messages);
      chat = {sid, messages: d.messages || []};
      // Overview's last-exchange also uses the chat, so refresh it too.
      if (changed && (activeTab === "exchange" || activeTab === "overview")) renderModal();
    }
  } catch { /* next tick retries */ }
}

function msgTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
}

function renderChatEntries(a, msgs) {
  const name = a.display_name || a.name;
  return msgs.map(m => {
    if (m.role === "gap") {
      return `<div class="chat-gap">… ${m.count} earlier step${m.count === 1 ? "" : "s"} — open Exchange for the full turn</div>`;
    }
    if (m.role === "tool") return toolLine(m);
    return chatBubble(m.role, m.text, m.role === "user" ? "You" : name, m.ts, m.thinking);
  }).join("");
}

function exchangeTab(a) {
  if (chat.sid !== a.sessionId || !chat.messages) {
    return `<div class="section"><div class="chat-loading">Loading conversation…</div></div>`;
  }
  if (!chat.messages.length) {
    return `<div class="section"><div class="chat-loading">No conversation found in the transcript tail.</div></div>`;
  }
  return `<div class="section"><div class="chat">${renderChatEntries(a, chat.messages)}</div></div>`;
}

function modalHtml(a) {
  if (activeTab === "graph") return graphTab(a);
  if (activeTab === "exchange") return exchangeTab(a);
  if (activeTab === "todo") {
    return `<div class="section">${todoMdHtml(a.todo_md || "")}</div>`;
  }
  return overviewTab(a);
}

function modalHeadHtml(a) {
  const model = MODEL_SKIN[modelFamily((a.context_breakdown || {}).model)];
  return `<span class="modal-pet">${mascotSvg(a, "modal-mascot")}</span>
    ${badge(a.state)}
    <span class="name-holder">
      <span class="agent-name" title="${esc(a.name)}">${esc(a.display_name || a.name)}</span>
      <button class="rename-btn" title="Rename this pet">✎</button>
    </span>
    <span class="model-tag" style="color:${model.outline}" title="Model — mascot colour">${esc(model.label)}</span>
    <span class="project" style="margin:0;flex:1" title="${esc(a.cwd)}">${esc(a.cwd)}</span>
    ${a.tmux ? `<button class="tmux-btn" data-target="${esc(a.tmux.target)}" title="tmux ${esc(a.tmux.target)} — click to focus">${esc(a.tmux.target)}</button>` : ""}
    <button class="kill-btn" data-sid="${esc(a.sessionId)}" title="Terminate this agent">Kill</button>
    <button class="modal-close" title="Close (Esc)">✕</button>`;
}

function composerHtml(a) {
  if (!a.tmux) {
    return `<div class="composer"><span class="composer-note">No tmux pane found — can't send input.</span></div>`;
  }
  return `<div class="composer">
    <textarea class="composer-input" rows="1"
      placeholder="Message ${esc(a.name)}…  (Enter to send, Shift+Enter for newline)"></textarea>
    <button class="send-btn">Send</button>
    <span class="composer-status"></span>
  </div>`;
}

function currentAgent() {
  return agents.find(x => x.sessionId === openSid);
}

function startRename() {
  const a = currentAgent();
  const holder = modal.querySelector(".name-holder");
  if (!a || !holder) return;
  editingName = true;
  holder.innerHTML =
    `<input class="rename-input" maxlength="60" value="${esc(a.display_name || a.name || "")}">`;
  const inp = holder.querySelector(".rename-input");
  inp.focus();
  inp.select();
  inp.addEventListener("keydown", async e => {
    e.stopPropagation();
    if (e.key === "Enter") {
      await post("/api/rename", {sid: a.sessionId, name: inp.value.trim()});
      editingName = false;
      tick();
    } else if (e.key === "Escape") {
      editingName = false;
      renderModal();
    }
  });
  inp.addEventListener("blur", () => { editingName = false; renderModal(); });
}

async function post(path, payload) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: authHeaders({"Content-Type": "application/json"}),
      body: JSON.stringify(payload),
    });
    return (await res.json()).ok;
  } catch {
    return false;
  }
}

function flashStatus(ok) {
  const el = modal.querySelector(".composer-status");
  if (!el) return;
  el.textContent = ok ? "✓ sent" : "✕ failed";
  el.className = "composer-status " + (ok ? "ok" : "err");
  setTimeout(() => { el.textContent = ""; }, 2000);
}

async function sendMessage() {
  const a = currentAgent();
  const input = modal.querySelector(".composer-input");
  if (!a?.tmux || !input || !input.value.trim()) return;
  const text = input.value;
  input.value = "";
  flashStatus(await post("/api/send", {target: a.tmux.target, text}));
}

function wireComposer() {
  const input = modal.querySelector(".composer-input");
  if (!input) return;
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    e.stopPropagation();
  });
  modal.querySelector(".send-btn").addEventListener("click", sendMessage);
}

function renderModal() {
  const a = currentAgent();
  if (!a) { closeModal(); return; }
  if (modal.dataset.sid !== a.sessionId) {
    modal.dataset.sid = a.sessionId;
    modal.innerHTML = `<div class="modal-head"></div><div class="tabbar"></div>
      <div class="modal-body"></div>${composerHtml(a)}`;
    wireComposer();
  }
  if (!TABS.find(t => t.id === activeTab)?.show(a)) activeTab = "overview";
  if (!editingName) modal.querySelector(".modal-head").innerHTML = modalHeadHtml(a);
  modal.querySelector(".tabbar").innerHTML = tabbarHtml(a);
  const body = modal.querySelector(".modal-body");
  const scroll = activeTab === lastRenderedTab ? body.scrollTop : 0;
  body.innerHTML = modalHtml(a);
  const msgs = chat.messages || [];
  const chatKey = activeTab === "exchange"
    ? `${msgs.length}:${msgs[msgs.length - 1]?.text.length || 0}` : "";
  if (activeTab === "exchange" && (lastRenderedTab !== "exchange" || chatKey !== lastChatKey)) {
    body.scrollTop = body.scrollHeight;  // pin chat to the latest message
  } else {
    body.scrollTop = scroll;
  }
  lastChatKey = chatKey;
  lastRenderedTab = activeTab;
}

function openModal(sid) {
  openSid = sid;
  activeTab = "exchange";  // land on the conversation, scrolled to the latest
  lastRenderedTab = null;
  chat = {sid: null, messages: null};
  overlay.classList.remove("hidden");
  renderModal();
  loadChat(sid);  // populate the Overview's last-exchange tail promptly
  modal.querySelector(".composer-input")?.focus();
}

function closeModal() {
  openSid = null;
  modal.dataset.sid = "";
  overlay.classList.add("hidden");
}

/* ---------- render loop ---------- */

const GROUPS = [
  {id: "attention", label: "Needs approval", states: ["needs_input"]},
  {id: "waiting", label: "Waiting for you", states: ["waiting"]},
  {id: "working", label: "Working", states: ["busy"]},
  {id: "idle", label: "Idle", states: ["idle"]},
];

function render() {
  const byState = {needs_input: 0, waiting: 0, busy: 0, idle: 0};
  agents.forEach(a => byState[a.state] = (byState[a.state] || 0) + 1);
  counts.innerHTML = Object.entries(byState)
    .filter(([, n]) => n)
    .map(([s, n]) => `<span class="stat ${s}"><span class="dot ${s}"></span><b>${n}</b> ${STATE_LABEL[s]}</span>`)
    .join("");
  grid.innerHTML = agents.length
    ? GROUPS.map(g => {
        const list = agents.filter(a => g.states.includes(a.state));
        if (!list.length) return "";
        return `<div class="group-head ${g.id}">
            <span class="group-label">${g.label}</span>
            <span class="group-count">${list.length}</span>
            <span class="group-rule"></span>
          </div>` + list.map(cardHtml).join("");
      }).join("")
    : `<div class="empty">No agents running yet.<br>Start one with <b>+ New agent</b>.</div>`;
  document.title = agents.some(a => a.state === "needs_input")
    ? "⚠ TamaClaudchi" : "TamaClaudchi";
  if (openSid) renderModal();
}

document.getElementById("legend").innerHTML = legendHtml();
// the brand mark is a resident pet: clay Claude wearing the crown
document.querySelector(".brand-mark").innerHTML =
  mascotSvg({state: "busy", cwd: "brand", sessionId: "brand", git: {repo: "brand"}});

function focusTmux(target) {
  post("/api/focus", {target});
}

async function killAgent(btn) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Confirm kill?";
    btn.classList.add("armed");
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === "1") {
        btn.dataset.armed = "0";
        btn.textContent = "Kill";
        btn.classList.remove("armed");
      }
    }, 3000);
    return;
  }
  btn.textContent = "Killing…";
  const ok = await post("/api/kill", {sid: btn.dataset.sid});
  if (ok) { closeModal(); tick(); }
  else { btn.textContent = "Kill failed"; }
}

document.body.addEventListener("click", e => {
  const btn = e.target.closest(".tmux-btn");
  if (btn) {
    e.stopPropagation();
    focusTmux(btn.dataset.target);
    return;
  }
  const kb = e.target.closest(".key-btn");
  if (kb) {
    e.stopPropagation();
    post("/api/key", {target: kb.dataset.target, key: kb.dataset.key});
    kb.classList.add("sent");
    setTimeout(() => kb.classList.remove("sent"), 1200);
    return;
  }
  const kill = e.target.closest(".kill-btn");
  if (kill) {
    e.stopPropagation();
    killAgent(kill);
    return;
  }
  if (e.target.closest(".rename-btn")) {
    e.stopPropagation();
    startRename();
    return;
  }
  if (e.target.closest(".modal-close") || e.target === overlay) {
    closeModal();
    return;
  }
  const tab = e.target.closest(".tab");
  if (tab) {
    activeTab = tab.dataset.tab;
    if (activeTab === "exchange" && openSid) loadChat(openSid);
    renderModal();
    return;
  }
  const card = e.target.closest(".card");
  if (card) openModal(card.dataset.sid);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeModal(); closeSpawn(); }
});

/* ---------- spawn dialog ---------- */

const spawnOverlay = document.getElementById("spawn-overlay");
const spawnCwd = document.getElementById("spawn-cwd");
const spawnName = document.getElementById("spawn-name");
const spawnPrompt = document.getElementById("spawn-prompt");
const spawnStatus = document.getElementById("spawn-status");

function openSpawn() {
  spawnStatus.textContent = "";
  spawnOverlay.classList.remove("hidden");
  if (!spawnCwd.value) spawnCwd.value = spawnDir;
  spawnCwd.focus();
}
function closeSpawn() { spawnOverlay.classList.add("hidden"); }

async function doSpawn() {
  const cwd = spawnCwd.value.trim();
  if (!cwd) { spawnCwd.focus(); return; }
  spawnStatus.textContent = "launching…";
  spawnStatus.className = "composer-status";
  const ok = await post("/api/spawn",
    {cwd, name: spawnName.value, prompt: spawnPrompt.value});
  if (ok) {
    spawnName.value = "";
    spawnPrompt.value = "";
    closeSpawn();
    tick();
  } else {
    spawnStatus.textContent = "✕ failed — check the directory";
    spawnStatus.className = "composer-status err";
  }
}

document.getElementById("new-agent").addEventListener("click", openSpawn);
document.getElementById("spawn-cancel").addEventListener("click", closeSpawn);
document.getElementById("spawn-go").addEventListener("click", doSpawn);
spawnOverlay.addEventListener("click", e => { if (e.target === spawnOverlay) closeSpawn(); });
spawnCwd.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); spawnName.focus(); } });
spawnName.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); spawnPrompt.focus(); } });

async function tick() {
  try {
    const res = await fetch("/api/state", {headers: authHeaders()});
    if (res.status === 401) {
      conn.textContent = "unauthorized — open the URL (with #token) the server printed";
      conn.classList.add("err");
      return;
    }
    const data = await res.json();
    agents = data.agents || [];
    spawnDir = data.spawn_dir || spawnDir;
    const key = JSON.stringify(agents) + openSid;
    if (key !== lastPayload) {
      lastPayload = key;
      render();
    }
    conn.textContent = `updated ${new Date().toLocaleTimeString()}`;
    conn.classList.remove("err");
    if (openSid) loadChat(openSid);  // Overview + Exchange both use the chat
  } catch {
    conn.textContent = "server unreachable";
    conn.classList.add("err");
  }
}

tick();
setInterval(tick, 1000);
