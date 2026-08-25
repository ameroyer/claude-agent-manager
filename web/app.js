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

/* "new" pastille: Claude answered after the last time you opened that card.
   Seen marks live in localStorage (per-browser; wrapped for private mode). */
let seen = {};
try { seen = JSON.parse(localStorage.tamaSeen || "{}"); } catch { /* fresh */ }
let seenReady = (() => { try { return "tamaSeen" in localStorage; } catch { return true; } })();
function saveSeen() { try { localStorage.tamaSeen = JSON.stringify(seen); } catch { /* ignore */ } }
function markSeen(a) {  // true when the mark actually moved (caller then saves)
  if (!a || !a.last_activity || seen[a.sessionId] === a.last_activity) return false;
  seen[a.sessionId] = a.last_activity;
  return true;
}
function hasNew(a) {
  if (a.state === "busy" || a.state === "needs_input" || !a.last_activity) return false;
  const s = seen[a.sessionId];
  return s === undefined || a.last_activity > s + 2;
}

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

/* True while you're mid-selection inside `el`. The 1s poll re-renders whole
   subtrees, which silently destroys a selection in progress — so anything that
   replaces innerHTML checks this first and just waits a tick instead. */
function hasSelectionIn(el) {
  const sel = typeof getSelection === "function" ? getSelection() : null;
  if (!el || !sel || !sel.rangeCount || sel.isCollapsed) return false;
  return el.contains(sel.getRangeAt(0).commonAncestorContainer);
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
   Every visual axis encodes something: colour = model, hat = git repo,
   held item = git branch, and the eyes/zzz follow the live state. */

/* Monokai-pastel skins; "other" keeps the authentic clay Claude. */
const MODEL_SKIN = {
  fable:  {label: "Fable",  body: "#ff6188", outline: "#b23557"},
  opus:   {label: "Opus",   body: "#ab9df2", outline: "#7568b8"},
  sonnet: {label: "Sonnet", body: "#78dce8", outline: "#4899a5"},
  haiku:  {label: "Haiku",  body: "#a9dc76", outline: "#6f9c48"},
  other:  {label: "Egg", body: "#d08b6c", outline: "#9a5c40"},  // model not known yet
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

/* Three independent axes, so a pet's look tells you where it lives:
     body colour = model   ·   HAT = git repo   ·   HELD ITEM = git branch
   Agents in one repo wear the same hat; agents on one branch carry the same
   item, so a shared branch reads across repos too (everyone on `main` holds
   the same thing). Same repo AND branch = twins. Outside a git repo there is
   no repo or branch to key on, so both axes fall back to the directory — which
   keeps the promise that the same working dir looks the same.
   The device tint follows the hat, so repo-mates read as a family. */
const HAT_NAMES = ["crown", "helm", "hennin", "wizard", "halo", "flowers", "horns", "bow",
                   "cap", "beanie", "tophat", "antenna", "laurel", "chef", "headphones", "mohawk"];
const ITEM_NAMES = ["sword", "shield", "wand", "staff", "book", "lantern", "potion", "banner",
                    "key", "orb", "axe", "longbow", "scroll", "hammer", "balloon", "feather"];
const ACCENTS = ["#ffd866", "#ff6188", "#78dce8", "#ab9df2", "#fc9867", "#a9dc76", "#8fb8ff", "#ffa7c4"];

const hatKeyOf = a => a.git?.repo ? "repo:" + a.git.repo
                                  : "dir:" + (a.cwd || a.sessionId || "");
const itemKeyOf = a => a.git?.branch ? "branch:" + a.git.branch
                                     : "dir:" + (a.cwd || a.sessionId || "");

/* Hashing a key straight onto a sprite collides far more than intuition says:
   8 repos dropped into 8 hats have only a 0.2% chance of all coming out
   different (birthday paradox), so shared hats were the norm, not bad luck.
   The hash therefore only picks a *preferred* slot — a repo that wants one
   already taken probes forward to the next free sprite. That makes outfits
   genuinely distinct whenever the board holds no more repos (or branches) than
   there are sprites. Keys are assigned in sorted order so the result depends
   only on which agents are on the board, never on their arrival order. */
function assignSlots(keys, names) {
  const taken = new Array(names.length).fill(null);
  const out = {};
  for (const key of [...new Set(keys)].sort()) {
    let i = hashStr(key) % names.length;  // preferred slot
    for (let n = 0; n < names.length && taken[i] !== null; n++) i = (i + 1) % names.length;
    taken[i] = key;  // past `names.length` distinct keys, sharing is unavoidable
    out[key] = names[i];
  }
  return out;
}

/* Recomputed only when the set of repos/branches on the board changes. */
let _outfits = {key: null, hats: {}, items: {}, accents: {}};

function outfitMap() {
  const hatKeys = agents.map(hatKeyOf);
  const itemKeys = agents.map(itemKeyOf);
  const key = JSON.stringify([hatKeys, itemKeys]);
  if (_outfits.key !== key) {
    _outfits = {key, hats: assignSlots(hatKeys, HAT_NAMES),
                items: assignSlots(itemKeys, ITEM_NAMES),
                accents: assignSlots(hatKeys, ACCENTS)};
  }
  return _outfits;
}

function critterOf(a) {
  const model = (a.context_breakdown || {}).model;
  const skin = MODEL_SKIN[modelFamily(model)];
  const hk = hatKeyOf(a), ik = itemKeyOf(a);
  const {hats, items, accents} = outfitMap();
  // The fallbacks cover pets that aren't on the board (the brand mark).
  const rh = hashStr(hk);
  return {skin,
          hat: hats[hk] || HAT_NAMES[rh % HAT_NAMES.length],
          item: items[ik] || ITEM_NAMES[hashStr(ik) % ITEM_NAMES.length],
          accent: accents[hk] || ACCENTS[(rh >>> 5) % ACCENTS.length]};  // >>> : >> goes negative past 2^31
}

/* The pet IS the Claude Code creature: one big rectangle, two little arm nubs
   just below the middle, four stubby legs, and fixed rectangular pupils.
   18 wide × 16 tall grid. */
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
// Sleeping. Three loose pixels just read as a blue diagonal scratch, so this is
// an actual "z" glyph. Top-left corner, above every held item.
const ZZZ = [[0,0,"z"],[1,0,"z"],[2,0,"z"],
             [1,1,"z"],
             [0,2,"z"],[1,2,"z"],[2,2,"z"]];

// Before the first reply the model is unknown — the pet is still an egg.
const EGG = (() => {
  const rows = {2:[8,9], 3:[7,10], 4:[6,11], 5:[6,11], 6:[5,12], 7:[5,12],
                8:[5,12], 9:[5,12], 10:[6,11], 11:[7,10]};
  const c = [];
  for (const [y, [x0, x1]] of Object.entries(rows))
    for (let x = x0; x <= x1; x++) c.push([x, +y]);
  return c;
})();
const EGG_SPECKLES = [[8,3,"W"],[6,8,"W"],[11,5,"W"],[9,10,"W"]];

// Sprites: [x, y, role] — G gold, S steel, W white/bone, D wood, A repo accent.
// Hats sit in rows 0-3 above the head; items are held at the arms (rows 0-9,
// x0-2 left / x15-17 right) so the two axes can never collide.
const HAT = {
  crown:   [[5,2,"G"],[8,2,"G"],[11,2,"G"],
            [5,3,"G"],[6,3,"G"],[7,3,"A"],[8,3,"G"],[9,3,"G"],[10,3,"A"],[11,3,"G"],[12,3,"G"]],
  helm:    [[8,0,"A"],[8,1,"A"],[9,1,"A"],
            [5,2,"S"],[6,2,"S"],[7,2,"S"],[8,2,"S"],[9,2,"S"],[10,2,"S"],[11,2,"S"],[12,2,"S"],
            [5,3,"S"],[6,3,"S"],[11,3,"S"],[12,3,"S"]],
  hennin:  [[10,0,"A"],[9,1,"A"],[10,1,"A"],[9,2,"A"],[10,2,"A"],[11,2,"A"],
            [8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],
            [11,0,"W"],[12,1,"W"],[13,2,"W"]],                      // cone + veil
  wizard:  [[8,0,"G"],[8,1,"A"],[9,1,"A"],[7,2,"A"],[8,2,"A"],[9,2,"A"],[10,2,"A"],
            [5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],[12,3,"A"]],
  halo:    [[7,1,"G"],[8,1,"G"],[9,1,"G"],[10,1,"G"]],
  flowers: [[5,3,"A"],[6,3,"W"],[7,3,"A"],[8,3,"W"],[9,3,"A"],[10,3,"W"],[11,3,"A"],[12,3,"W"],
            [6,2,"A"],[9,2,"W"],[12,2,"A"]],
  horns:   [[3,1,"W"],[4,2,"W"],[4,3,"W"],[14,1,"W"],[13,2,"W"],[13,3,"W"]],
  bow:     [[7,1,"A"],[7,2,"A"],[10,1,"A"],[10,2,"A"],[8,2,"G"],[9,2,"G"],[8,3,"A"],[9,3,"A"]],
  cap:     [[6,2,"A"],[7,2,"A"],[8,2,"A"],[9,2,"A"],[10,2,"A"],[11,2,"A"],
            [5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],
            [12,3,"W"],[13,3,"W"],[14,3,"W"]],                    // dome + brim
  beanie:  [[8,1,"W"],[9,1,"W"],                                  // bobble, sat on the dome
            [6,2,"A"],[7,2,"A"],[8,2,"A"],[9,2,"A"],[10,2,"A"],[11,2,"A"],
            [5,3,"W"],[6,3,"W"],[7,3,"W"],[8,3,"W"],[9,3,"W"],[10,3,"W"],[11,3,"W"],[12,3,"W"]],
  tophat:  [[6,0,"A"],[7,0,"A"],[8,0,"A"],[9,0,"A"],[10,0,"A"],[11,0,"A"],
            [6,1,"A"],[7,1,"A"],[8,1,"A"],[9,1,"A"],[10,1,"A"],[11,1,"A"],
            [6,2,"G"],[7,2,"G"],[8,2,"G"],[9,2,"G"],[10,2,"G"],[11,2,"G"],   // band
            [4,3,"A"],[5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],
            [10,3,"A"],[11,3,"A"],[12,3,"A"],[13,3,"A"]],
  antenna: [[5,0,"G"],[12,0,"G"],[5,1,"S"],[12,1,"S"],[6,2,"S"],[11,2,"S"],
            [7,3,"S"],[8,3,"S"],[9,3,"S"],[10,3,"S"]],            // bulbs on stalks
  laurel:  [[3,3,"A"],[4,2,"A"],[5,1,"A"],[6,1,"A"],
            [14,3,"A"],[13,2,"A"],[12,1,"A"],[11,1,"A"],
            [8,1,"G"],[9,1,"G"]],                                 // wreath + gem
  chef:    [[6,0,"W"],[7,0,"W"],[9,0,"W"],[10,0,"W"],             // puffs
            [6,1,"W"],[7,1,"W"],[8,1,"W"],[9,1,"W"],[10,1,"W"],[11,1,"W"],
            [6,2,"W"],[7,2,"W"],[8,2,"W"],[9,2,"W"],[10,2,"W"],[11,2,"W"],
            [5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],[12,3,"A"]],
  headphones: [[4,1,"S"],[5,1,"S"],[6,1,"S"],[7,1,"S"],[8,1,"S"],[9,1,"S"],
            [10,1,"S"],[11,1,"S"],[12,1,"S"],[13,1,"S"],          // band
            [3,2,"S"],[3,3,"A"],[14,2,"S"],[14,3,"A"]],           // ear cups
  mohawk:  [[6,1,"A"],[8,1,"A"],[10,1,"A"],                       // spikes, not a cone
            [6,2,"A"],[7,2,"A"],[8,2,"A"],[9,2,"A"],[10,2,"A"],[11,2,"A"],
            [5,3,"A"],[6,3,"A"],[7,3,"A"],[8,3,"A"],[9,3,"A"],[10,3,"A"],[11,3,"A"],[12,3,"A"]],
};

const ITEM = {
  sword:   [[16,0,"W"],[16,1,"S"],[16,2,"S"],[16,3,"S"],[16,4,"S"],[16,5,"S"],
            [15,6,"G"],[16,6,"G"],[17,6,"G"],[16,7,"D"]],
  shield:  [[0,5,"S"],[1,5,"S"],[0,6,"S"],[1,6,"S"],[0,7,"S"],[1,7,"A"],
            [0,8,"S"],[1,8,"S"],[0,9,"S"],[1,9,"S"]],               // off-hand
  wand:    [[16,2,"G"],[15,3,"G"],[16,3,"G"],[17,3,"G"],
            [16,4,"D"],[16,5,"D"],[16,6,"D"],[16,7,"D"]],
  staff:   [[16,0,"A"],[15,1,"A"],[16,1,"A"],[17,1,"A"],[16,2,"A"],
            [16,3,"D"],[16,4,"D"],[16,5,"D"],[16,6,"D"],[16,7,"D"],[16,8,"D"]],
  book:    [[16,5,"A"],[17,5,"A"],[16,6,"A"],[17,6,"W"],[16,7,"A"],[17,7,"W"],[16,8,"A"],[17,8,"W"]],
  lantern: [[16,3,"D"],[16,4,"D"],
            [15,5,"G"],[16,5,"G"],[17,5,"G"],[15,6,"G"],[16,6,"W"],[17,6,"G"],
            [15,7,"G"],[16,7,"W"],[17,7,"G"],[15,8,"G"],[16,8,"G"],[17,8,"G"]],
  potion:  [[16,3,"D"],[16,4,"W"],[16,5,"W"],
            [16,6,"A"],[17,6,"A"],[16,7,"A"],[17,7,"A"],[16,8,"A"],[17,8,"A"]],
  banner:  [[16,1,"D"],[16,2,"D"],[16,3,"D"],[16,4,"D"],[16,5,"D"],[16,6,"D"],[16,7,"D"],[16,8,"D"],
            [17,1,"A"],[17,2,"A"],[17,3,"A"],[17,4,"A"]],
  key:     [[16,2,"G"],[15,3,"G"],[17,3,"G"],[16,4,"G"],                 // ring
            [16,5,"G"],[16,6,"G"],[16,7,"G"],[16,8,"G"],
            [17,6,"G"],[17,8,"G"]],                                      // teeth
  orb:     [[16,3,"A"],[15,4,"A"],[16,4,"W"],[17,4,"A"],
            [15,5,"A"],[16,5,"A"],[17,5,"A"],[16,6,"A"]],
  axe:     [[16,1,"S"],[17,1,"S"],[15,2,"S"],[16,2,"S"],[17,2,"S"],[15,3,"S"],[16,3,"S"],
            [16,4,"D"],[16,5,"D"],[16,6,"D"],[16,7,"D"],[16,8,"D"]],
  longbow: [[1,3,"D"],[0,4,"D"],[0,5,"D"],[0,6,"D"],[0,7,"D"],[1,8,"D"],   // off-hand
            [2,3,"W"],[2,4,"W"],[2,5,"W"],[2,6,"W"],[2,7,"W"],[2,8,"W"]],  // string
  scroll:  [[15,4,"W"],[16,4,"W"],[17,4,"W"],
            [15,5,"D"],[16,5,"W"],[17,5,"D"],
            [15,6,"D"],[16,6,"W"],[17,6,"D"],
            [15,7,"W"],[16,7,"W"],[17,7,"W"]],
  hammer:  [[15,2,"S"],[16,2,"S"],[17,2,"S"],[15,3,"S"],[16,3,"S"],[17,3,"S"],
            [16,4,"D"],[16,5,"D"],[16,6,"D"],[16,7,"D"],[16,8,"D"]],
  balloon: [[16,0,"A"],[15,1,"A"],[16,1,"A"],[17,1,"A"],
            [15,2,"A"],[16,2,"A"],[17,2,"A"],[16,3,"A"],
            [16,4,"W"],[16,5,"W"],[16,6,"W"],[16,7,"W"]],                // string
  feather: [[17,1,"W"],[16,2,"W"],[17,2,"W"],[16,3,"W"],[17,3,"W"],[16,4,"W"],
            [16,5,"D"],[16,6,"D"],[16,7,"D"],[16,8,"D"]],                // quill
};

function mascotSvg(a, cls = "") {
  const {skin, hat, item, accent} = critterOf(a);
  const px = [];
  const cell = (x, y, c) =>
    px.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`);
  if (!(a.context_breakdown || {}).model) {  // no reply yet: an egg, no outfit
    EGG.forEach(([x, y]) => cell(x, y, skin.body));
    EGG_SPECKLES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  } else {
    CREATURE.forEach(([x, y, r]) => cell(x, y, r === "T" ? skin.body : skin.outline));
    (HAT[hat] || []).forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
    (ITEM[item] || []).forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  }
  EYES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  if (a.state === "idle") ZZZ.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  return `<svg xmlns="http://www.w3.org/2000/svg" class="mascot ${esc(a.state)} ${cls}"
    viewBox="0 0 18 14.2" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"
    aria-hidden="true">${px.join("")}</svg>`;
}

function legendHtml() {
  return `<div class="legend" title="Pet colour = model · hat = git repo (or folder, outside a repo) · held item = git branch. Egg = no reply yet, so the model is unknown.">
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

/* ---------- cards ---------- */

function summaryLine(a) {
  return a.agent_status?.summary || a.title || a.last_assistant || "";
}

const STATE_ICON = {needs_input: "⚠", waiting: "⏸", busy: "●", idle: "○"};

const MODE_LABEL = {default: "Manual", acceptEdits: "Auto-edit", plan: "Plan",
                    auto: "Auto", bypassPermissions: "Bypass"};
const MODE_SHORT = {default: "manual", acceptEdits: "auto-edit", plan: "plan",
                    auto: "auto", bypassPermissions: "bypass"};
// The modes ⇧⇥ cycles through — the ones we can offer to switch to. Bypass is a
// separate opt-in with its own confirmation, so it is displayed but never set.
const MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"];

/* Colour a menu option by what it does. Keyed on the label rather than the
   position, because a question menu ("1. Red / 2. Green") has no affirmative
   first option to paint green. */
const OPTION_KINDS = [
  [/^\s*(no|deny|reject|cancel|keep planning)\b/i, "no"],
  [/^\s*(yes|allow|approve|accept)\b/i, "ok"],
];

function optionClass(label) {
  const hit = OPTION_KINDS.find(([re]) => re.test(label || ""));
  return hit ? hit[1] : "alt";
}

/* "tamaclaudchi:0.1" is tmux's session:window.pane address — opaque unless you
   already know tmux. Spell it out, and give the command that gets you there. */
function tmuxTitle(target) {
  const m = /^(.+):(\d+)\.(\d+)$/.exec(target || "");
  if (!m) return `tmux pane ${target || "unknown"}`;
  return `Where this agent runs.\n`
    + `tmux session "${m[1]}", window ${m[2]}, pane ${m[3]}.\n`
    + `To watch it yourself, from a terminal on the machine running the agents:\n`
    + `    tmux attach -t ${m[1]}`;
}

function keyBtn(target, key, label, cls) {
  return `<button class="key-btn ${cls}" data-target="${esc(target)}" data-key="${esc(key)}">${label}</button>`;
}

/* Mirror whatever menu the CLI is actually showing, so the buttons match the
   real options (manual mode included). Falls back to the classic trio when the
   pane can't be read. */
function approvalActionsHtml(a) {
  if (a.state !== "needs_input" || !a.tmux) return "";
  const opts = a.prompt && a.prompt.options;
  if (opts && opts.length) {
    // "Yes" and "Yes, allow all edits" share a first segment — when the short
    // forms collide, keep enough of the label to tell the buttons apart.
    const heads = opts.map(o => o.label.split(/[,(]/)[0].trim());
    const labels = opts.map((o, i) =>
      heads.filter(h => h === heads[i]).length > 1
        ? o.label.slice(0, 20).trim() + (o.label.length > 20 ? "…" : "")
        : heads[i] || o.key);
    return `<div class="approve-row">${opts.map((o, i) => {
      const cls = optionClass(o.label);
      return `<button class="key-btn ${cls}" data-target="${esc(a.tmux.target)}"
        data-key="${esc(o.key)}" title="${esc(o.key)}. ${esc(o.label)}">${esc(labels[i])}</button>`;
    }).join("")}</div>`;
  }
  return `<div class="approve-row">
    ${keyBtn(a.tmux.target, "1", "✓ Approve", "ok")}
    ${keyBtn(a.tmux.target, "2", "Always", "alt")}
    ${keyBtn(a.tmux.target, "Escape", "✕ Deny", "no")}
  </div>`;
}

function modeSelectorHtml(a) {
  if (!a.permission_mode) return "";
  const cur = a.permission_mode;
  const btns = MODE_CYCLE.map(id => `<button class="mode-btn${id === cur ? " active" : ""}"
      data-target="${esc(a.tmux ? a.tmux.target : "")}" data-mode="${esc(id)}"
      ${a.tmux ? "" : "disabled"}>${esc(MODE_LABEL[id])}</button>`).join("");
  return `<div class="section"><div class="section-title">Permission mode
      ${MODE_CYCLE.includes(cur) ? "" : `<span class="when">${esc(MODE_LABEL[cur] || cur)}</span>`}</div>
    <div class="mode-row">${btns}</div>
    <div class="mode-hint">${a.tmux
      ? "Presses ⇧⇥ in the session until its footer reports the mode you picked."
      : "No tmux pane — the mode can't be changed from here."}</div></div>`;
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
  return (a.prompt && a.prompt.question) || a.notification || "Needs your approval";
}

/* Sub-agents a session spawned via the Task/Agent tool. They run *inside* the
   parent process — no pid, no tmux pane, no transcript of their own — so they
   can never be a pet on the shelf. The parent's card is the only place they
   can be shown. Running ones are called out; finished ones fade to history and
   drop off entirely once there are newer ones. */
function subagentsHtml(a) {
  const subs = a.subagents || [];
  if (!subs.length) return "";
  const live = subs.filter(s => s.running);
  const shown = live.length ? live : subs.slice(-2);
  return `<div class="subagents" title="Sub-agents spawned by this session. They run inside this agent, so they have no pet of their own.">
    <span class="sub-label">${live.length ? "running" : "spawned"}</span>
    ${shown.map(s => `<span class="sub-chip${s.running ? " live" : ""}"
       title="${esc(s.type)}${s.task ? " — " + esc(s.task) : ""}">${esc(s.type)}</span>`).join("")}
  </div>`;
}

function subagentsSectionHtml(a) {
  const subs = a.subagents || [];
  if (!subs.length) return "";
  const rows = subs.slice().reverse().map(s => `<div class="sub-row${s.running ? " live" : ""}">
    <span class="sub-chip${s.running ? " live" : ""}">${esc(s.type)}</span>
    <span class="sub-task">${esc(s.task || "—")}</span>
    <span class="sub-state">${s.running ? "running" : "done"}</span>
  </div>`).join("");
  return `<div class="section">
    <div class="section-title">Sub-agents
      <span class="when">run inside this session — no pet of their own</span></div>
    <div class="sub-list">${rows}</div>
  </div>`;
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

  return `<div class="card tama ${esc(a.state)}${a.spawned_by ? " child" : ""}" data-sid="${esc(a.sessionId)}"
    style="--pet-accent:${accent}">
    <div class="tama-screen">
      <div class="tama-top">
        <span class="state-ico ${esc(a.state)}" title="${STATE_LABEL[a.state] || ""}">${STATE_ICON[a.state] || "○"}</span>
        <span class="agent-name" title="${esc(a.name)} — click to open, rename inside">${esc(a.display_name || a.name)}</span>
        ${hasNew(a) ? `<span class="new-pip" title="Claude answered since you last opened this card">new</span>` : ""}
        ${drafts[a.sessionId] ? `<span class="draft-pip" title="Unsent message waiting here: ${esc(drafts[a.sessionId].slice(0, 120))}">draft</span>` : ""}
        ${a.tmux ? `<button class="model-tag" data-target="${esc(a.tmux.target)}"
           title="Model (the pet's colour) — click to switch model">${esc(model.label)}</button>`
         : `<span class="model-tag" title="Model — the pet's colour">${esc(model.label)}</span>`}
      </div>
      <div class="lcd-dir" title="Working directory: ${esc(a.cwd)}">${esc(a.cwd)}</div>
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
      ${subagentsHtml(a)}
      ${approvalActionsHtml(a)}
    </div>
    <div class="tama-buttons">
      <span class="led st-${esc(a.state)}" title="Status light: ${STATE_LABEL[a.state] || ""}"></span>
      <span class="led ctx-${ctx ? ctx.level : "off"}" title="Context light: ${ctx ? `${ctx.label} used (${ctx.pct}%)` : "no data yet"}"></span>
      <span class="led led-repo" title="Family light: same colour = same repo"></span>
    </div>
    <div class="shell-meta">
      ${a.git ? `<div title="Repository ${esc(a.git.repo)}${a.git.worktree ? `, linked worktree ${esc(a.git.worktree)}` : ""} · branch ${esc(a.git.branch)} @ commit ${esc(a.git.commit)}"><b>git</b> ${esc(a.git.repo)} · ${esc(a.git.branch)} @ ${esc(a.git.commit)}</div>` : ""}
      <div title="Session started ${esc(whenAbs(a.startedAt))} — id ${esc(a.sessionId)}">
        <b>born</b> ${ago(a.startedAt)} <span class="sid">#${esc((a.sessionId || "").slice(0, 8))}</span></div>
      ${a.spawned_by ? `<div class="lineage" title="This session didn't start on its own — ${esc(a.spawned_by)} launched it."><b>from</b> ↳ ${esc(a.spawned_by)}</div>` : ""}
      ${(a.spawns || []).length ? `<div class="lineage" title="Sessions this agent launched: ${esc(a.spawns.join(", "))}"><b>spawns</b> ${esc(a.spawns.join(", "))}</div>` : ""}
    </div>
    <div class="tama-foot">
      ${a.permission_mode ? (a.tmux
        ? `<button class="mode-chip" data-target="${esc(a.tmux.target)}"
             title="Permission mode: ${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)} — click to change">${esc(MODE_SHORT[a.permission_mode] || a.permission_mode)}</button>`
        : `<span class="mode-chip" title="Permission mode: ${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)}">${esc(MODE_SHORT[a.permission_mode] || a.permission_mode)}</span>`) : ""}
      ${a.tmux ? `<span class="tmux-tag"
         title="${esc(tmuxTitle(a.tmux.target))}">${esc(a.tmux.target)}</span>` : ""}
      <span class="time" title="Last message in this conversation">${ago(a.last_activity)}</span>
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
  {id: "exchange", label: "Exchange",
   show: a => a.last_prompt || a.last_assistant || a.state === "needs_input"},
  {id: "artifacts", label: "Artifacts", show: () => true},
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

function chatBubble(role, text, who, ts, thinking, pending) {
  const think = (role !== "user" && thinking)
    ? `<details class="think"><summary>Thinking</summary>
        <div class="think-body">${mdHtml(thinking)}</div></details>`
    : "";
  return `<div class="msg ${role === "user" ? "user" : "assistant"}${pending ? " pending" : ""}">
    <div class="msg-meta">${esc(who)}${ts ? `<span>${msgTime(ts)}</span>` : ""}
      ${pending ? `<span class="pending-tag">sending…</span>` : ""}
      <button class="copy-btn" data-copy="${esc(text)}" title="Copy this message">⧉</button>
    </div>
    ${think}
    <div class="msg-text">${mdHtml(text)}</div>
  </div>`;
}

/* Copy to clipboard; falls back to execCommand outside secure contexts. */
async function copyText(text, btn) {
  let ok = true;
  try { await navigator.clipboard.writeText(text); }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  if (btn) {
    btn.textContent = ok ? "✓" : "✕";
    setTimeout(() => { btn.textContent = "⧉"; }, 1200);
  }
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
    <div class="chat">${renderChatEntries(a, withPending(a, msgs))}</div></div>`;
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
    ["Repo", a.git ? `${a.git.repo}${a.git.worktree ? ` (worktree ${a.git.worktree})` : ""}`
                     + ` · ${a.git.branch} @ ${a.git.commit}` : "—"],
    ["tmux", a.tmux ? a.tmux.target : "not found"],
    ["Tasks", tasks.length ? `${done}/${tasks.length} done` : "–"],
    ["Launched by", a.spawned_by || "started on its own"],
    ["Spawned", (a.spawns || []).length ? a.spawns.join(", ") : "–"],
    ["Born", a.startedAt ? `${whenAbs(a.startedAt)} (${ago(a.startedAt)})` : "–"],
    ["Runtime", fmtDuration(a.startedAt)],
    ["Last activity", ago(a.last_activity)],
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
  out.push(subagentsSectionHtml(a));
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
      if (pending && pending.sid === sid) {
        const head = pending.text.trim().slice(0, 60);
        const landed = chat.messages.some(m => m.role === "user" && m.text.trim().startsWith(head));
        if (landed || Date.now() - pending.ts > 60000) pending = null;
      }
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
    return chatBubble(m.role, m.text, m.role === "user" ? "You" : name, m.ts, m.thinking, m.pending);
  }).join("");
}

/* The permission dialog the pane is showing, as the last entry in the
   conversation. It used to live only on the card and in Overview, so the
   Exchange read as though the agent had simply gone quiet mid-turn. */
function approvalPromptHtml(a) {
  if (a.state !== "needs_input") return "";
  const p = a.pending_tool;
  const q = (a.prompt && a.prompt.question) || a.notification || "Needs your approval";
  return `<div class="msg approval">
    <div class="msg-meta">⚠ waiting on you</div>
    <div class="msg-text">
      <div class="approve-q">${esc(q)}</div>
      ${p ? `<div class="approve-detail"><span class="tool-name">${esc(p.name)}</span>${
        p.detail ? `<pre class="tool-cmd">${esc(p.detail)}</pre>` : ""}</div>` : ""}
      ${approvalActionsHtml(a)}
    </div>
  </div>`;
}

function exchangeTab(a) {
  if (chat.sid !== a.sessionId || !chat.messages) {
    return `<div class="section"><div class="chat-loading">Loading conversation…</div></div>`;
  }
  const approval = approvalPromptHtml(a);
  if (!chat.messages.length && !approval) {
    return `<div class="section"><div class="chat-loading">No conversation found in the transcript tail.</div></div>`;
  }
  return `<div class="section"><div class="chat">${
    renderChatEntries(a, withPending(a, chat.messages))}${approval}</div></div>`;
}

/* ---------- artifacts: any .md/.txt files or folders you pin ---------- */

/* Artifacts: one collapsible row per file. A row's text is fetched the first
   time you open it and kept, so the tab costs nothing to show and each file is
   read at most once per visit. */
let arts = {sid: null, files: [], sources: [], open: [], texts: {}, error: null};

async function loadArtifacts(sid) {
  try {
    const d = await (await fetch(`/api/artifacts?sid=${encodeURIComponent(sid)}`,
      {headers: authHeaders()})).json();
    if (openSid !== sid) return;
    const fresh = arts.sid !== sid;
    arts = {sid, files: d.files || [], sources: d.sources || [],
            open: fresh ? [] : arts.open, texts: fresh ? {} : arts.texts,
            error: d.error || null};
    if (activeTab === "artifacts") renderModal();
  } catch { /* next open retries */ }
}

async function openArtifact(sid, path) {
  try {
    const d = await (await fetch(
      `/api/artifacts?sid=${encodeURIComponent(sid)}&path=${encodeURIComponent(path)}`,
      {headers: authHeaders()})).json();
    if (openSid !== sid || arts.sid !== sid) return;
    arts.texts[path] = d.error ? `_${d.error}_` : (d.text || "");
    if (activeTab === "artifacts") renderModal();
  } catch { /* the row stays on "loading" until you toggle it again */ }
}

function toggleArtifact(path) {
  const i = arts.open.indexOf(path);
  if (i >= 0) {
    arts.open.splice(i, 1);
  } else {
    arts.open.push(path);
    if (arts.texts[path] === undefined) openArtifact(arts.sid, path);
  }
  renderModal();
}

function artifactRowBody(path) {
  const text = arts.texts[path];
  if (text === undefined) return `<div class="chat-loading">Loading…</div>`;
  return path.toLowerCase().endsWith(".txt")
    ? `<pre class="codeblock"><code>${esc(text)}</code></pre>`
    : mdHtml(text);
}

function fmtBytes(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + " MB"
       : n >= 1e3 ? Math.round(n / 1e3) + " KB" : n + " B";
}

/* Completions for the pin box. Only re-queried when the directory part of what
   you typed changes, so typing a filename doesn't hit the server per keystroke. */
let browseDir = null;

async function loadBrowse(value) {
  const dir = value.slice(0, value.lastIndexOf("/") + 1);
  if (dir === browseDir) return;
  browseDir = dir;
  try {
    const d = await (await fetch(`/api/browse?path=${encodeURIComponent(value)}`,
      {headers: authHeaders()})).json();
    const list = modal.querySelector("#art-suggest");
    if (list && browseDir === dir) {
      list.innerHTML = (d.paths || [])
        .map(p => `<option value="${esc(p)}"></option>`).join("");
    }
  } catch { /* completions are optional */ }
}

function artifactsTab(a) {
  if (arts.sid !== a.sessionId) {
    loadArtifacts(a.sessionId);
    return `<div class="section"><div class="chat-loading">Loading artifacts…</div></div>`;
  }
  const rows = arts.files.map(f => {
    const isOpen = arts.open.includes(f.path);
    return `<div class="art-item${isOpen ? " open" : ""}">
      <button class="art-head" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="art-caret">${isOpen ? "▾" : "▸"}</span>
        <span class="art-name">${esc(f.name)}</span>
        <span class="art-meta">${fmtBytes(f.size)} · ${ago(f.mtime)}</span>
      </button>
      ${isOpen ? `<div class="art-body">${artifactRowBody(f.path)}</div>` : ""}
    </div>`;
  }).join("");
  const chips = arts.sources.map(src =>
    `<span class="art-chip" title="${esc(src)}">${esc(src.split("/").slice(-2).join("/"))}
      <button class="art-unpin" data-path="${esc(src)}" title="Stop watching this">✕</button></span>`).join("");
  return `<div class="section">
    <div class="art-list">${rows || '<div class="chat-loading">Nothing to show yet — pin a file or folder below.</div>'}</div>
    <div class="art-bar">
      <input class="art-add" list="art-suggest" spellcheck="false"
        placeholder="pin a .md/.txt file or a folder — start typing a path…">
      <datalist id="art-suggest"></datalist>
      <button class="art-pin-btn">Pin</button>
    </div>
    <div class="art-sources"><span class="dim">watching:</span> ${chips || '<span class="dim">nothing pinned</span>'}</div>
  </div>`;
}

function modalHtml(a) {
  if (activeTab === "graph") return graphTab(a);
  if (activeTab === "exchange") return exchangeTab(a);
  if (activeTab === "artifacts") return artifactsTab(a);
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
    ${a.tmux ? `<span class="tmux-tag" title="${esc(tmuxTitle(a.tmux.target))}">${esc(a.tmux.target)}</span>` : ""}
    <button class="kill-btn" data-sid="${esc(a.sessionId)}" title="Terminate this agent">Kill</button>
    <button class="modal-close" title="Close (Esc)">✕</button>`;
}

function composerHtml(a) {
  if (!a.tmux) {
    return `<div class="composer"><span class="composer-note">No tmux pane found — can't send input.</span></div>`;
  }
  return `<div class="composer-grip" title="Drag to resize the reply box"></div>
  <div class="composer">
    <textarea class="composer-input" rows="3"
      placeholder="Message ${esc(a.name)}…  (Enter to send, Shift+Enter for newline)"></textarea>
    <button class="send-btn">Send</button>
    <button class="stop-btn" title="Interrupt what the agent is doing (sends Esc)">Stop</button>
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

/* Returns the server's {ok, msg} so callers can show why something failed. */
async function post(path, payload) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: authHeaders({"Content-Type": "application/json"}),
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    return {ok: false, msg: String(e)};
  }
}

let toastTimer = null;
function toast(msg, isErr) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 7000);
}

function flashStatus(ok) {
  const el = modal.querySelector(".composer-status");
  if (!el) return;
  el.textContent = ok ? "✓ sent" : "✕ failed";
  el.className = "composer-status " + (ok ? "ok" : "err");
  setTimeout(() => { el.textContent = ""; }, 2000);
}

/* Unsent composer text, kept per session so closing a card to go look at
   another pet — or reloading the page — doesn't throw away a half-written
   message. Cleared once the message is actually sent. */
let drafts = {};
try { drafts = JSON.parse(localStorage.tamaDrafts || "{}"); } catch { /* fresh */ }

function setDraft(sid, text) {
  if (!sid) return;
  if (text.trim()) drafts[sid] = text;
  else delete drafts[sid];
  try { localStorage.tamaDrafts = JSON.stringify(drafts); } catch { /* private mode */ }
}

/* Your message, shown immediately; cleared once the transcript catches up
   (Claude Code writes the turn to disk a beat after we paste it). */
let pending = null;  // {sid, text, ts}

function withPending(a, msgs) {
  return pending && pending.sid === a.sessionId
    ? msgs.concat([{role: "user", text: pending.text, ts: pending.ts, pending: true}])
    : msgs;
}

async function sendMessage() {
  const a = currentAgent();
  const input = modal.querySelector(".composer-input");
  if (!a?.tmux || !input || !input.value.trim()) return;
  const text = input.value;
  input.value = "";
  setDraft(a.sessionId, "");  // it's on its way out; stop remembering it
  pending = {sid: a.sessionId, text, ts: Date.now()};
  renderModal();
  const r = await post("/api/send", {target: a.tmux.target, text});
  flashStatus(r.ok);
  if (!r.ok) {  // nothing was delivered — hand the text back rather than lose it
    pending = null;
    setDraft(a.sessionId, text);
    if (!input.value.trim()) input.value = text;
    renderModal();
    return;
  }
  loadChat(a.sessionId);                                   // catch it early
  setTimeout(() => loadChat(a.sessionId), 900);            // and once it lands
}

async function stopAgent() {
  const a = currentAgent();
  if (!a?.tmux) return;
  flashStatus((await post("/api/key", {target: a.tmux.target, key: "Escape"})).ok);
}

function wireComposer() {
  const input = modal.querySelector(".composer-input");
  if (!input) return;
  input.value = drafts[openSid] || "";  // whatever you were part-way through
  input.addEventListener("input", () => setDraft(openSid, input.value));
  // remember however tall you dragged the reply box
  try { if (localStorage.tamaComposerH) input.style.height = localStorage.tamaComposerH; }
  catch { /* private mode */ }
  const saveH = () => {
    try { localStorage.tamaComposerH = input.style.height || input.offsetHeight + "px"; }
    catch { /* private mode */ }
  };
  input.addEventListener("mouseup", saveH);  // native corner grip
  // explicit drag bar: dragging up grows the box, down shrinks it
  modal.querySelector(".composer-grip")?.addEventListener("pointerdown", e => {
    e.preventDefault();
    const startY = e.clientY, startH = input.offsetHeight;
    const move = ev => {
      input.style.height =
        Math.max(56, Math.min(innerHeight * 0.75, startH + startY - ev.clientY)) + "px";
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      saveH();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    e.stopPropagation();
  });
  modal.querySelector(".send-btn").addEventListener("click", sendMessage);
  modal.querySelector(".stop-btn")?.addEventListener("click", stopAgent);
}

function renderModal() {
  const a = currentAgent();
  if (!a) { closeModal(); return; }
  if (markSeen(a)) saveSeen();  // the card is open — count it all as seen
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
  if (body.contains(document.activeElement) &&
      document.activeElement.classList.contains("art-add")) return;  // mid-typing
  if (hasSelectionIn(body)) return;  // don't yank the text out from under a selection
  const scroll = activeTab === lastRenderedTab ? body.scrollTop : 0;
  body.innerHTML = modalHtml(a);
  const msgs = chat.messages || [];
  // Tool entries carry no .text — reading it unguarded threw here, which
  // aborted the render before the scroll-to-bottom below. That is why opening
  // an agent stuck on a tool/approval left you at the top of the conversation.
  const last = msgs[msgs.length - 1];
  // The approval block is part of the exchange, so it counts as "new content"
  // to scroll to when it appears.
  const chatKey = activeTab === "exchange"
    ? `${msgs.length}:${last?.role}:${last?.text?.length || 0}:${a.state}` : "";
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
  arts = {sid: null, files: [], sources: [], open: [], texts: {}, error: null};
  browseDir = null;
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
  // Don't yank an open picker, or text you're in the middle of selecting.
  // Everything outside the grid still refreshes.
  if (!grid.querySelector(".model-menu") && !hasSelectionIn(grid)) {
    grid.innerHTML = agents.length
      ? GROUPS.map(g => {
          const list = agents.filter(a => g.states.includes(a.state));
          if (!list.length) return "";
          // Most recent exchange first. Sorted on last_activity (the newest
          // timestamped record) rather than the transcript's file mtime, which
          // Claude Code bumps on week-old conversations for its own bookkeeping
          // and which therefore ordered the board almost at random.
          // "Working" stays alphabetical so busy cards don't reshuffle each tick.
          if (g.id !== "working")
            list.sort((x, y) => (y.last_activity || 0) - (x.last_activity || 0));
          return `<div class="group-head ${g.id}">
              <span class="group-label">${g.label}</span>
              <span class="group-count">${list.length}</span>
              <span class="group-rule"></span>
            </div>` + list.map(cardHtml).join("");
        }).join("")
      : `<div class="empty">No agents running yet.<br>Start one with <b>+ New agent</b>.</div>`;
  }
  document.title = agents.some(a => a.state === "needs_input")
    ? "⚠ TamaClaudchi" : "TamaClaudchi";
  if (openSid) renderModal();
}

/* ---------- theme switch ---------- */
const themeBtn = document.getElementById("theme-toggle");
const systemDark = () => {
  try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
};
let theme = (() => {
  try { return localStorage.tamaTheme || (systemDark() ? "dark" : "light"); }
  catch { return systemDark() ? "dark" : "light"; }
})();
function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = theme === "dark" ? "☾" : "☀";
  themeBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  try { localStorage.tamaTheme = theme; } catch { /* private mode */ }
  applyTheme();
});
applyTheme();

document.getElementById("legend").innerHTML = legendHtml();
// the brand mark is a resident pet: crowned clay Claude with a sword
document.querySelector(".brand-mark").innerHTML =
  mascotSvg({state: "busy", sessionId: "brand", cwd: "/D1",
             git: {repo: "R5"}, context_breakdown: {model: "clay"}});

/* Click the model pill or the mode chip → pick from a popup → the server drives
   the change inside that session. Both axes share one menu; they differ only in
   the choices they offer and what applying one does. */
const MODEL_IDS = {Fable: "claude-fable-5", Opus: "claude-opus-5",
                   Sonnet: "claude-sonnet-5", Haiku: "claude-haiku-4-5"};

async function setModel(target, model) {
  const r = await post("/api/model", {target, model});
  toast(r.ok ? `Sent /model ${model}. The pill updates after the next reply.\n${r.msg}`
             : `Model switch failed: ${r.msg}`, !r.ok);
}

async function setMode(target, mode) {
  const r = await post("/api/mode", {target, mode});
  toast(r.ok ? `Permission mode is now ${MODE_LABEL[mode] || mode}.`
             : `Mode switch failed: ${r.msg}`, !r.ok);
  tick();  // the chip reads back from the pane, so refresh it now
}

const PICKERS = {
  model: {items: () => Object.entries(MODEL_IDS), apply: setModel},
  mode:  {items: () => MODE_CYCLE.map(id => [MODE_LABEL[id], id]), apply: setMode,
          foot: true},  // the mode chip lives at the bottom of the card
};

function openPickMenu(btn, kind) {
  const spec = PICKERS[kind];
  document.querySelectorAll(".model-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "model-menu" + (spec.foot ? " at-foot" : "");
  menu.innerHTML = spec.items()
    .map(([label, id]) => `<button data-pick="${esc(id)}">${esc(label)}</button>`).join("");
  btn.closest(".card").appendChild(menu);
  menu.addEventListener("click", async e => {
    e.stopPropagation();
    const b = e.target.closest("button[data-pick]");
    if (!b) return;
    b.textContent = "…";
    const pick = b.dataset.pick;
    menu.remove();
    await spec.apply(btn.dataset.target, pick);
  });
  // close on the next outside click (deferred so this very click doesn't count)
  setTimeout(() => document.addEventListener("click",
    () => menu.remove(), {once: true}), 0);
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
  const ok = (await post("/api/kill", {sid: btn.dataset.sid})).ok;
  if (ok) { closeModal(); tick(); }
  else { btn.textContent = "Kill failed"; }
}

document.body.addEventListener("click", e => {
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
  const unpin = e.target.closest(".art-unpin");
  if (unpin) {
    e.stopPropagation();
    post("/api/artifact-pin", {sid: openSid, path: unpin.dataset.path, remove: true})
      .then(() => loadArtifacts(openSid));
    return;
  }
  const head = e.target.closest(".art-head");
  if (head) {
    e.stopPropagation();
    toggleArtifact(head.dataset.path);
    return;
  }
  if (e.target.closest(".art-pin-btn")) {
    e.stopPropagation();
    pinArtifact();
    return;
  }
  const cp = e.target.closest(".copy-btn");
  if (cp) {
    e.stopPropagation();
    copyText(cp.dataset.copy, cp);
    return;
  }
  if (e.target.closest(".rename-btn")) {
    e.stopPropagation();
    startRename();
    return;
  }
  const mp = e.target.closest(".model-tag");
  if (mp && mp.dataset.target) {
    e.stopPropagation();
    openPickMenu(mp, "model");
    return;
  }
  const mc = e.target.closest(".mode-chip");
  if (mc && mc.dataset.target) {
    e.stopPropagation();
    openPickMenu(mc, "mode");
    return;
  }
  const mb = e.target.closest(".mode-btn");
  if (mb && !mb.disabled) {
    e.stopPropagation();
    mb.textContent = "…";
    setMode(mb.dataset.target, mb.dataset.mode);
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
    if (activeTab === "artifacts" && openSid) loadArtifacts(openSid);
    renderModal();
    return;
  }
  // A drag that ends on a card is a text selection, not a click on the card.
  const card = e.target.closest(".card");
  if (card && !hasSelectionIn(card)) openModal(card.dataset.sid);
});

/* Double-click a command or a code block to select exactly it — dragging across
   a chat bubble picks up the surrounding prose and the message metadata. */
document.body.addEventListener("dblclick", e => {
  const block = e.target.closest(".tool-cmd, .codeblock, .tool-call-detail");
  if (!block) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

async function pinArtifact() {
  const input = modal.querySelector(".art-add");
  const path = input && input.value.trim();
  if (!path || !openSid) return;
  const r = await post("/api/artifact-pin", {sid: openSid, path});
  if (r.ok) { input.value = ""; loadArtifacts(openSid); }
  else toast(r.msg || "could not pin that path", true);
}

document.body.addEventListener("input", e => {
  if (e.target.closest(".art-add")) loadBrowse(e.target.value);
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
const spawnResume = document.getElementById("spawn-resume");

/* Fill the resume dropdown with past conversations found in the chosen folder. */
async function loadResumable() {
  const cwd = spawnCwd.value.trim();
  spawnResume.innerHTML = `<option value="">start a fresh session</option>`;
  if (!cwd) return;
  try {
    const res = await fetch(`/api/sessions?cwd=${encodeURIComponent(cwd)}`,
      {headers: authHeaders()});
    const d = await res.json();
    for (const s of d.sessions || []) {
      const label = `${s.title || "#" + s.sid.slice(0, 8)} · ${ago(s.mtime)}${s.live ? " · LIVE" : ""}`;
      spawnResume.insertAdjacentHTML("beforeend",
        `<option value="${esc(s.sid)}" ${s.live ? "disabled" : ""}>${esc(label)}</option>`);
    }
  } catch { /* dropdown just stays "fresh" */ }
}

function openSpawn() {
  spawnStatus.textContent = "";
  spawnOverlay.classList.remove("hidden");
  if (!spawnCwd.value) spawnCwd.value = spawnDir;
  loadResumable();
  spawnCwd.focus();
}
function closeSpawn() { spawnOverlay.classList.add("hidden"); }

async function doSpawn() {
  const cwd = spawnCwd.value.trim();
  if (!cwd) { spawnCwd.focus(); return; }
  spawnStatus.textContent = "launching…";
  spawnStatus.className = "composer-status";
  const ok = (await post("/api/spawn",
    {cwd, name: spawnName.value, prompt: spawnPrompt.value,
     resume: spawnResume.value})).ok;
  if (ok) {
    spawnName.value = "";
    spawnPrompt.value = "";
    spawnResume.value = "";
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
spawnCwd.addEventListener("change", loadResumable);
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
    if (!seenReady) {  // first visit ever: baseline, so nothing screams "new"
      agents.forEach(markSeen);
      seenReady = true;
      saveSeen();
    }
    if (Object.keys(seen).length > 300) {  // prune marks of long-gone sessions
      const live = new Set(agents.map(a => a.sessionId));
      seen = Object.fromEntries(Object.entries(seen).filter(([k]) => live.has(k)));
      saveSeen();
    }
    if (Object.keys(drafts).length > 50) {  // same, for drafts of dead sessions
      const live = new Set(agents.map(a => a.sessionId));
      drafts = Object.fromEntries(Object.entries(drafts)
        .filter(([k]) => live.has(k) || k === openSid));
      try { localStorage.tamaDrafts = JSON.stringify(drafts); } catch { /* private */ }
    }
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
