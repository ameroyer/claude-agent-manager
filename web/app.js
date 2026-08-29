const grid = document.getElementById("grid");
const counts = document.getElementById("counts");
const conn = document.getElementById("conn");
const overlay = document.getElementById("modal-overlay");
const modal = document.getElementById("modal");
let openSid = null;
let agents = [];
let editingName = false;  // pause head re-render while the rename input is open
let lastPayload = "";
let lastGridHtml = "";  // same idea as lastBodyHtml, for the shelf
let lastHeadHtml = "", lastTabHtml = "", lastCountsHtml = "";  // ditto, the fixed chrome
let killArmed = null;  // sessionId whose Kill button is showing "Confirm kill?"
/* A click only fires when mousedown and mouseup land on the *same* element. The
   poll rebuilds the shelf and the modal chrome with innerHTML, so a rebuild
   arriving between the two threw the click away — which is why cards and the ✕
   sometimes needed pressing twice. Nothing is rebuilt while a button is held. */
let pointerHeld = false;
document.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
for (const ev of ["pointerup", "pointercancel"])
  document.addEventListener(ev, () => { pointerHeld = false; }, true);
// Releasing the button outside the window fires no pointerup here, and the
// board would then be frozen until the next click.
addEventListener("blur", () => { pointerHeld = false; });
let spawnDir = "~/";  // server expands ~; refined from /api/state
/* Past conversations — sessions that are no longer running. Fetched from its
   own endpoint on a slow timer, never from the 1s board poll: building it walks
   every project directory. */
let history = [];
let graveOpen = false;
try { graveOpen = localStorage.tamaGrave === "1"; } catch { /* private mode */ }
let graveFilter = {model: "", repo: "", text: "", minTok: "", maxTok: ""};
let graveSort = "recent";  // "recent" | "name" | "tokens"

// The server gates /api/* on this token; it rides in the URL fragment
// (never sent on the wire by the browser) and on every request we make.
const token = location.hash.slice(1);
const authHeaders = extra => Object.assign({"X-Auth-Token": token}, extra || {});

/* "new" pastille: Claude answered after the last time you opened that card.
   Seen marks live in localStorage (per-browser; wrapped for private mode).

   A session we have no mark for is NOT new — it is simply one we have not
   recorded yet, so it gets baselined on sight (see tick). Defaulting the other
   way meant every card you had never opened wore the pill forever, and a fresh
   board lit up wholesale; with localStorage unavailable it could never clear. */
let seen = {};
try { seen = JSON.parse(localStorage.tamaSeen || "{}"); } catch { /* fresh */ }
function saveSeen() { try { localStorage.tamaSeen = JSON.stringify(seen); } catch { /* ignore */ } }
function markSeen(a) {  // true when the mark actually moved (caller then saves)
  if (!a || !a.last_activity || seen[a.sessionId] === a.last_activity) return false;
  seen[a.sessionId] = a.last_activity;
  return true;
}
function hasNew(a) {
  if (a.state === "busy" || a.state === "needs_input" || !a.last_activity) return false;
  const s = seen[a.sessionId];
  return s !== undefined && a.last_activity > s + 2;
}
/* Record every session we have not met before, so the pill can only ever mean
   "this conversation moved since you last looked at it". */
function baselineUnseen() {
  let added = false;
  for (const a of agents) {
    if (a.last_activity && seen[a.sessionId] === undefined) {
      seen[a.sessionId] = a.last_activity;
      added = true;
    }
  }
  if (added) saveSeen();
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

/* Model identity, used for the pill and the legend. The pet's BODY colour no
   longer comes from here — colour means repo now, and the model is the hat. */
const MODEL_SKIN = {
  fable:  {label: "Fable",  body: "#ff6188", outline: "#b23557"},
  opus:   {label: "Opus",   body: "#ab9df2", outline: "#7568b8"},
  sonnet: {label: "Sonnet", body: "#78dce8", outline: "#4899a5"},
  haiku:  {label: "Haiku",  body: "#a9dc76", outline: "#6f9c48"},
  other:  {label: "egg", body: "#d08b6c", outline: "#9a5c40"},
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
     BODY COLOUR = git repo (or the folder, outside a repo)
     HAT         = the model — a fixed, deliberately unmistakable hat each
     HELD ITEM   = git branch
   Repo-mates are the same colour and share the device tint; everyone on one
   branch carries the same thing; the hat says which model is answering. */
/* Bodies are deliberately saturated and mid-dark: the steel helm (#c7ced6),
   white/bone items and gold all have to read clearly on top of every one of
   them, so no pale or greyish entries here. */
/* Sixteen pastels, evenly spaced around the hue wheel. Pastel bodies only work
   if what sits on them is dark, so the knight's helm is iron rather than bright
   steel — that way the colours stay soft and the hat still reads (contrast
   2.8-6.0 against the helm, vs 1.9 the other way round). */
const REPO_SKINS = [
  {body: "#f794ad", outline: "#ad4e66"}, {body: "#f7a194", outline: "#ad5a4e"},
  {body: "#f7c694", outline: "#ad7e4e"}, {body: "#f7eb94", outline: "#ada14e"},
  {body: "#dff794", outline: "#96ad4e"}, {body: "#baf794", outline: "#72ad4e"},
  {body: "#94f794", outline: "#4ead4e"}, {body: "#94f7ba", outline: "#4ead72"},
  {body: "#94f7df", outline: "#4ead96"}, {body: "#94ebf7", outline: "#4ea1ad"},
  {body: "#94c6f7", outline: "#4e7ead"}, {body: "#94a1f7", outline: "#4e5aad"},
  {body: "#ad94f7", outline: "#664ead"}, {body: "#d294f7", outline: "#8a4ead"},
  {body: "#f794f7", outline: "#ad4ead"}, {body: "#f794d2", outline: "#ad4e8a"},
];
const ITEM_NAMES = ["sword", "shield", "fairywand", "elfstaff", "spellbook", "lantern",
                    "potion", "crystal", "mushroom", "acorn", "apple", "petleash",
                    "leek", "teacup", "sunflower", "balloon", "lollipop", "umbrella",
                    "scroll", "quill"];
/* One hat per model, fixed — not hashed, so it is always readable. */
const MODEL_HAT = {fable: "wizard", opus: "crown", sonnet: "poet", haiku: "kitsune",
                   other: null};

const repoKeyOf = a => a.git?.repo ? "repo:" + a.git.repo
                                   : "dir:" + (a.cwd || a.sessionId || "");
const itemKeyOf = a => a.git?.branch ? "branch:" + a.git.branch
                                     : "dir:" + (a.cwd || a.sessionId || "");
/* The branch most sessions sit on deserves the nicest item, rather than
   whatever the hash happens to land on. Reserved, so nothing else takes it. */
const MAIN_BRANCHES = ["main", "master", "trunk"];
const MAIN_ITEM = "sword";
const isMainBranch = a => MAIN_BRANCHES.includes((a.git && a.git.branch) || "");

/* Hashing a key straight onto a slot collides far more than intuition says:
   8 keys dropped into 8 slots have only a 0.2% chance of all coming out
   different (birthday paradox). The hash therefore only picks a *preferred*
   slot — anything already taken probes forward to the next free one. Keys are
   assigned in sorted order so the result depends only on which sessions are on
   the board, never on their arrival order. */
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
let _outfits = {key: null, colors: {}, items: {}};

function outfitMap() {
  const all = agents.concat(history);  // past pets follow the same scheme
  const repoKeys = all.map(repoKeyOf);
  // main is handed the reserved item directly, so it is kept out of the pool
  const itemKeys = all.filter(a => !isMainBranch(a)).map(itemKeyOf);
  const key = JSON.stringify([repoKeys, itemKeys]);
  if (_outfits.key !== key) {
    _outfits = {key, colors: assignSlots(repoKeys, REPO_SKINS),
                items: assignSlots(itemKeys, ITEM_NAMES.filter(n => n !== MAIN_ITEM))};
  }
  return _outfits;
}

function critterOf(a) {
  const family = modelFamily((a.context_breakdown || {}).model);
  const rk = repoKeyOf(a), ik = itemKeyOf(a);
  const {colors, items} = outfitMap();
  // The fallbacks cover pets that aren't on the board (the brand mark).
  const skin = colors[rk] || REPO_SKINS[hashStr(rk) % REPO_SKINS.length];
  return {skin, family,
          hat: MODEL_HAT[family],
          item: isMainBranch(a) ? MAIN_ITEM
              : items[ik] || ITEM_NAMES[hashStr(ik) % ITEM_NAMES.length],
          accent: skin.body};
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

/* Boundary cells of a sprite: a cell with a missing neighbour. Used for the
   legend, where the body is drawn hollow so the hat is unmistakably the point. */
function outlineOf(cells) {
  const has = new Set(cells.map(([x, y]) => x + "," + y));
  return cells.filter(([x, y]) =>
    !has.has((x - 1) + "," + y) || !has.has((x + 1) + "," + y) ||
    !has.has(x + "," + (y - 1)) || !has.has(x + "," + (y + 1)));
}
const CREATURE_OUTLINE = outlineOf(CREATURE);

/* The empty cells touching a sprite. Drawn behind a held item so a pale one
   (parchment, a white plume) still reads against a pale card. It uses the pet's
   own outline colour, not black: a hard black rim was the only such edge on the
   sprite — neither the body nor the hat has one — and it made every item look
   stuck on rather than held. */
function haloOf(cells) {
  const has = new Set(cells.map(([x, y]) => x + "," + y));
  const out = new Set();
  for (const [x, y] of cells) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (x + dx) + "," + (y + dy);
      if (!has.has(k)) out.add(k);
    }
  }
  return [...out].map(k => k.split(",").map(Number));
}

// Upper case: the saturated set, worn by the hats, which have to stay legible at
// legend size. Lower case: the pastel set the held items are drawn in — the hats
// are the loud thing on the sprite and an item in hat colours fought them.
const CLR = {A: null, G: "#ffd866", S: "#c7ced6", W: "#fdf6ee", D: "#9a6b3f",
             E: "#2d2a2e", P: "#5b53c9", R: "#e0453f", K: "#2a2730",
             N: "#7fbf4d", C: "#5fc9e0", I: "#4f5a6b", B: "#8c5a3c",
             g: "#ffe6a3", r: "#ffb3c1", p: "#cfc4f2", c: "#a9e2f0",
             n: "#bce5a4", s: "#e2e8ee", d: "#cda684"};
const paint = (role, accent) => CLR[role] || accent;

// The eyes never change: two 1×2 rectangular pupils. Idle just dreams in zzz.
const EYES = [[6,6,"E"],[6,7,"E"],[11,6,"E"],[11,7,"E"]];

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

// Sprites: [x, y, role] — G gold, S steel, W white/bone, D wood, E/K dark,
// P wizard indigo, R red. One hat per model, and they may reach down over the
// head (the helm's visor, the kitsune mask) — eyes are drawn BEFORE hats so a
// hat can cover them.
const HAT = {
  // Fable — tall pointed wizard cone, gold star on the tip, stars on the cloth
  wizard:  [[8,0,"G"],
            [8,1,"P"],[9,1,"P"],
            [7,2,"P"],[8,2,"G"],[9,2,"P"],[10,2,"P"],
            [6,3,"P"],[7,3,"P"],[8,3,"P"],[9,3,"G"],[10,3,"P"],[11,3,"P"],
            [4,4,"P"],[5,4,"G"],[6,4,"P"],[7,4,"P"],[8,4,"P"],[9,4,"P"],
            [10,4,"P"],[11,4,"G"],[12,4,"P"],[13,4,"P"]],
  // Opus — a diadem rather than a helm: the knight's visor was the least cute
  // thing on the shelf. Gold band, three points, a jewel in each.
  crown:   [[4,3,"G"],[5,3,"G"],[6,3,"G"],[7,3,"G"],[8,3,"G"],[9,3,"G"],
            [10,3,"G"],[11,3,"G"],[12,3,"G"],[13,3,"G"],             // band
            [5,2,"G"],[8,2,"G"],[9,2,"G"],[12,2,"G"],                // points
            [5,1,"C"],[8,1,"R"],[9,1,"R"],[12,1,"C"],                // jewels
            [6,3,"P"],[11,3,"P"]],                                   // inset gems
  // Sonnet — wide-brimmed poet's hat, black, with a white quill
  poet:    [[7,1,"K"],[8,1,"K"],[9,1,"K"],[10,1,"K"],
            [6,2,"K"],[7,2,"K"],[8,2,"K"],[9,2,"K"],[10,2,"K"],[11,2,"K"],
            [3,3,"K"],[4,3,"K"],[5,3,"K"],[6,3,"K"],[7,3,"K"],[8,3,"K"],
            [9,3,"K"],[10,3,"K"],[11,3,"K"],[12,3,"K"],[13,3,"K"],[14,3,"K"],
            [13,0,"W"],[12,1,"W"],[13,1,"W"],[12,2,"W"]],          // quill
  // Haiku — fox mask pushed to the side of the head, not over the eyes
  kitsune: [[2,1,"K"],[5,1,"K"],                                   // ear tips
            [2,2,"W"],[5,2,"W"],
            [1,3,"K"],[2,3,"W"],[3,3,"W"],[4,3,"W"],[5,3,"W"],[6,3,"K"],
            [1,4,"K"],[2,4,"W"],[3,4,"R"],[4,4,"R"],[5,4,"W"],[6,4,"K"],
            [1,5,"K"],[2,5,"W"],[3,5,"W"],[4,5,"W"],[5,5,"W"],[6,5,"K"],
            [2,6,"K"],[3,6,"W"],[4,6,"R"],[5,6,"K"]],               // rimmed snout
};

/* Cute fantasy kit, drawn in the pastel roles. Every item is held in the right
   hand, x15-18, rows 0-10; the hand is the arm nub at y7-8, so an item wants to
   reach down to about there. Two of them used to be held off-hand at x0-2,
   which is exactly where the kitsune mask sits — a Haiku session with a shield
   had the two sprites drawn on top of each other. Every item is rimmed automatically (see ITEM_HALO), so
   shapes matter more than colours — at 84px a whole cell is four screen pixels,
   which is why the shapes here are blunt silhouettes rather than fine detail.
   One highlight pixel ("W") per item is what keeps a flat pastel blob reading
   as a rounded object. */
const ITEM = {
  sword:     [[16,0,"W"],[17,0,"s"],                                   // tip
              [16,1,"W"],[17,1,"s"],
              [16,2,"W"],[17,2,"s"],
              [16,3,"W"],[17,3,"s"],
              [15,4,"g"],[16,4,"g"],[17,4,"g"],[18,4,"g"],             // crossguard
              [16,5,"d"],[17,5,"d"],[16,6,"d"],[17,6,"d"],             // grip
              [16,7,"g"],[17,7,"g"]],                                  // pommel
  shield:    [[15,3,"s"],[16,3,"s"],[17,3,"s"],[18,3,"s"],
              [15,4,"s"],[16,4,"c"],[17,4,"c"],[18,4,"s"],
              [15,5,"s"],[16,5,"W"],[17,5,"c"],[18,5,"s"],
              [15,6,"s"],[16,6,"c"],[17,6,"c"],[18,6,"s"],
              [16,7,"s"],[17,7,"s"],
              [16,8,"s"]],
  // A four-point star on a slim wand. It used to be a solid gold lump on a
  // same-width stick, which read as a stick of dynamite.
  fairywand: [[16,0,"g"],
              [15,1,"g"],[16,1,"W"],[17,1,"g"],
              [16,2,"g"],
              [16,3,"p"],[16,4,"p"],[16,5,"p"],[16,6,"p"],[16,7,"p"],[16,8,"p"]],
  elfstaff:  [[16,0,"n"],[15,1,"n"],[17,1,"n"],                        // leaves
              [16,1,"c"],[16,2,"W"],                                   // gem
              [16,3,"d"],[16,4,"d"],[15,5,"n"],[16,5,"d"],
              [16,6,"d"],[16,7,"d"],[16,8,"d"]],
  spellbook: [[15,3,"p"],[16,3,"p"],[17,3,"p"],[18,3,"p"],
              [15,4,"p"],[16,4,"g"],[17,4,"g"],[18,4,"p"],             // clasp
              [15,5,"p"],[16,5,"p"],[17,5,"p"],[18,5,"p"],
              [15,6,"W"],[16,6,"W"],[17,6,"W"],[18,6,"W"],             // page block
              [15,7,"W"],[16,7,"W"],[17,7,"W"],[18,7,"W"]],
  lantern:   [[16,2,"d"],[15,3,"d"],[17,3,"d"],                        // hoop
              [15,4,"s"],[16,4,"s"],[17,4,"s"],
              [15,5,"g"],[16,5,"W"],[17,5,"g"],
              [15,6,"g"],[16,6,"g"],[17,6,"g"],
              [15,7,"s"],[16,7,"s"],[17,7,"s"]],
  potion:    [[16,2,"d"],[16,3,"W"],                                   // cork, neck
              [15,4,"W"],[16,4,"W"],[17,4,"W"],
              [15,5,"r"],[16,5,"W"],[17,5,"r"],
              [15,6,"r"],[16,6,"r"],[17,6,"r"],
              [16,7,"r"]],
  crystal:   [[16,2,"c"],
              [15,3,"c"],[16,3,"W"],[17,3,"c"],
              [15,4,"c"],[16,4,"c"],[17,4,"c"],
              [15,5,"c"],[16,5,"c"],[17,5,"c"],
              [16,6,"c"]],
  mushroom:  [[15,3,"r"],[16,3,"r"],[17,3,"r"],
              [15,4,"r"],[16,4,"W"],[17,4,"r"],
              [15,5,"W"],[16,5,"W"],[17,5,"W"],                        // gills
              [16,6,"W"],[16,7,"W"],[16,8,"W"]],
  acorn:     [[16,2,"n"],                                              // stalk
              [15,3,"d"],[16,3,"d"],[17,3,"d"],                        // cap
              [15,4,"g"],[16,4,"g"],[17,4,"g"],
              [15,5,"g"],[16,5,"W"],[17,5,"g"],
              [16,6,"g"]],
  apple:     [[16,2,"d"],[17,2,"n"],
              [15,3,"r"],[16,3,"r"],[17,3,"r"],
              [15,4,"r"],[16,4,"W"],[17,4,"r"],
              [15,5,"r"],[16,5,"r"],[17,5,"r"],
              [16,6,"r"]],
  // A lead running down from the hand to a small round companion.
  petleash:  [[15,4,"d"],[15,5,"d"],[16,6,"d"],                        // lead
              [16,7,"g"],[18,7,"g"],                                   // ears
              [16,8,"g"],[17,8,"g"],[18,8,"g"],
              [16,9,"E"],[17,9,"g"],[18,9,"E"],                        // eyes
              [16,10,"g"],[17,10,"g"],[18,10,"g"]],
  leek:      [[15,0,"n"],[17,0,"n"],[15,1,"n"],[16,1,"n"],[17,1,"n"],
              [16,2,"n"],[16,3,"n"],
              [16,4,"W"],[16,5,"W"],[16,6,"W"],[16,7,"W"],[16,8,"W"]],
  teacup:    [[17,1,"W"],[16,2,"W"],                                   // steam
              [15,4,"W"],[16,4,"W"],[17,4,"W"],
              [15,5,"W"],[16,5,"c"],[17,5,"W"],[18,5,"W"],             // handle
              [15,6,"W"],[16,6,"W"],[17,6,"W"],
              [15,7,"s"],[16,7,"s"],[17,7,"s"],[18,7,"s"]],            // saucer
  sunflower: [[15,2,"g"],[16,2,"g"],[17,2,"g"],
              [15,3,"g"],[16,3,"d"],[17,3,"g"],
              [15,4,"g"],[16,4,"g"],[17,4,"g"],
              [16,5,"n"],[16,6,"n"],[17,6,"n"],[16,7,"n"],[16,8,"n"]],
  balloon:   [[16,0,"r"],
              [15,1,"r"],[16,1,"W"],[17,1,"r"],
              [15,2,"r"],[16,2,"r"],[17,2,"r"],
              [16,3,"r"],
              [16,4,"W"],[16,5,"W"],[16,6,"W"],[16,7,"W"]],
  lollipop:  [[16,1,"r"],
              [15,2,"r"],[16,2,"W"],[17,2,"r"],
              [15,3,"W"],[16,3,"r"],[17,3,"r"],                        // swirl
              [16,4,"r"],
              [16,5,"W"],[16,6,"W"],[16,7,"W"],[16,8,"W"]],
  umbrella:  [[16,0,"r"],
              [15,1,"r"],[16,1,"W"],[17,1,"r"],
              [15,2,"r"],[16,2,"r"],[17,2,"r"],
              [15,3,"W"],[16,3,"r"],[17,3,"W"],                        // scallops
              [16,4,"d"],[16,5,"d"],[16,6,"d"],[16,7,"d"],[16,8,"d"],[17,8,"d"]],
  scroll:    [[15,3,"d"],[16,3,"d"],[17,3,"d"],[18,3,"d"],             // top rod
              [15,4,"W"],[16,4,"W"],[17,4,"W"],[18,4,"W"],
              [15,5,"W"],[16,5,"d"],[17,5,"d"],[18,5,"W"],             // writing
              [15,6,"W"],[16,6,"W"],[17,6,"W"],[18,6,"W"],
              [15,7,"d"],[16,7,"d"],[17,7,"d"],[18,7,"d"]],            // bottom rod
  quill:     [[18,0,"W"],[17,1,"W"],[18,1,"W"],
              [17,2,"W"],[18,2,"W"],[16,3,"W"],[17,3,"W"],
              [16,4,"W"],[17,4,"W"],
              [16,5,"g"],                                              // nib
              [16,6,"d"],[16,7,"d"],[16,8,"d"]],
};

/* Rim for each item, computed once. */
const ITEM_HALO = Object.fromEntries(
  Object.entries(ITEM).map(([name, cells]) => [name, haloOf(cells)]));

function mascotSvg(a, cls = "", opts = {}) {
  const c = critterOf(a);
  const {hat, item, accent} = c;
  const skin = opts.skin || c.skin;
  const px = [];
  const cell = (x, y, c) =>
    px.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`);
  if (!(a.context_breakdown || {}).model) {  // no reply yet: an egg, no outfit
    EGG.forEach(([x, y]) => cell(x, y, skin.body));
    EGG_SPECKLES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
    EYES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
  } else {
    if (opts.hollow) {
      CREATURE_OUTLINE.forEach(([x, y]) => cell(x, y, skin.outline));
    } else {
      CREATURE.forEach(([x, y, r]) => cell(x, y, r === "T" ? skin.body : skin.outline));
    }
    EYES.forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
    (HAT[hat] || []).forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
    if (!opts.hideItem) {
      (ITEM_HALO[item] || []).forEach(([x, y]) => cell(x, y, skin.outline));
      (ITEM[item] || []).forEach(([x, y, r]) => cell(x, y, paint(r, accent)));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="mascot ${esc(a.state)} ${cls}"
    viewBox="-1 -1 21 15.4" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"
    aria-hidden="true">${px.join("")}</svg>`;
}

const LEGEND_SKIN = {body: "#cfc9d6", outline: "#9a94a3"};

function legendHtml() {
  return `<div class="legend" title="Hat = model · body colour = git repo (or folder) · held item = git branch. An egg means no reply yet, so the model is still unknown.">
    ${MODEL_ORDER.map(k => `<span class="legend-item">
      ${mascotSvg({state: "idle", sessionId: "legend-" + k, cwd: "/legend",
                   context_breakdown: k === "other" ? null : {model: k}}, "legend-pet",
                  {skin: LEGEND_SKIN, hollow: true, hideItem: true})}
      ${MODEL_SKIN[k].label}</span>`).join("")}
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
/* A multi-question form answers one question per click and then advances, so
   without this the menu silently becomes a different question and the click
   looks like it did nothing. */
function formStepsHtml(a) {
  const steps = (a.prompt && a.prompt.steps) || [];
  if (!steps.length) return "";
  const left = steps.filter(x => !x.done).length - 1;  // the Submit step is not a question
  return `<div class="form-steps" title="This is a multi-part question — answering one moves to the next.">
    ${steps.map(x => `<span class="step${x.done ? " done" : ""}">${x.done ? "✓ " : ""}${esc(x.label)}</span>`).join("")}
    ${left > 0 ? `<span class="step-left">${left} more to answer</span>` : ""}
  </div>`;
}

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
    return `${formStepsHtml(a)}<div class="approve-row">${opts.map((o, i) => {
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
  // A past session knows its final size but not how it split across the usage
  // buckets, so there is nothing to chart — only draw this when a real split
  // exists, or every bar reads zero.
  if (!b || !a.context_tokens || !CTX_PARTS.some(p => b[p.key])) return "";
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

/* The parent's own pet, inline next to "from ↳". Hovering it highlights the
   parent's card, so the link is visible rather than a name you have to match
   up by eye. */
function parentPetHtml(a) {
  const parent = agents.find(x => x.sessionId === a.spawned_by_sid);
  if (!parent) return "";
  return `<span class="lineage-pet" data-parent="${esc(parent.sessionId)}"
    title="Launched by ${esc(parent.display_name || parent.name)} — hover to find its card">${
    mascotSvg(parent, "lineage-mascot", {hideItem: true})}</span>`;
}

/* The three lamps used to be status / context level / repo family. Status is
   already said three other ways on this card, and the repo is now the card's own
   colour, so two of them said nothing. They are one gauge instead: five lamps
   filled in proportion to the context window used, coloured by how full it is. */
const GAUGE_LAMPS = 5;

function contextGaugeHtml(a) {
  const c = contextInfo(a);
  const lit = c ? Math.max(1, Math.ceil(c.pct / (100 / GAUGE_LAMPS))) : 0;
  return `<div class="tama-buttons" title="${esc(c
      ? `Context used: ${c.label} (${c.pct}%) — ${lit} of ${GAUGE_LAMPS} lamps`
      : "Context: nothing measured yet")}">
    ${Array.from({length: GAUGE_LAMPS}, (_, i) =>
      `<span class="led ${i < lit ? "lit " + c.level : "off"}"></span>`).join("")}
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
    style="--pet-accent:${accent};--card-tint:${accent}">
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
            <span class="stat-pair"><span class="stat-num">${ctx.pct}%</span><span class="stat-unit">ctx</span></span>
            <span class="stat-pair"><span class="stat-num">${fmtTokens(a.context_tokens)}</span><span class="stat-unit">tokens</span></span>
          </div>` : ""}
          <div class="stat-sub" title="${done}/${total} tasks done">${total ? `${done}/${total} tasks` : "no tasks"}</div>
          <div class="stat-sub state-word ${esc(a.state)}">${STATE_LABEL[a.state] || esc(a.state)}</div>
        </div>
        <div class="tama-pet">${mascotSvg(a)}<div class="pet-ground"></div></div>
      </div>
      <div class="mood-pill ${esc(a.state)}" title="${esc(mood)}">${esc(mood)}</div>
      ${subagentsHtml(a)}
      ${approvalActionsHtml(a)}
    </div>
    ${contextGaugeHtml(a)}
    <div class="shell-meta">
      ${a.git ? `<div title="Repository ${esc(a.git.repo)}${a.git.worktree ? `, linked worktree ${esc(a.git.worktree)}` : ""} · branch ${esc(a.git.branch)} @ commit ${esc(a.git.commit)}"><b>git</b> ${esc(a.git.repo)} · ${esc(a.git.branch)} @ ${esc(a.git.commit)}</div>` : ""}
      <div title="Session started ${esc(whenAbs(a.startedAt))} — id ${esc(a.sessionId)}">
        <b>born</b> ${ago(a.startedAt)} <span class="sid">#${esc((a.sessionId || "").slice(0, 8))}</span></div>
      ${a.spawned_by ? `<div class="lineage" title="This session didn't start on its own — ${esc(a.spawned_by)} launched it.">
        <b>from</b> ↳ ${parentPetHtml(a)}${esc(a.spawned_by)}</div>` : ""}
      ${(a.spawns || []).length ? `<div class="lineage" title="Sessions this agent launched: ${esc(a.spawns.join(", "))}"><b>spawns</b> ${esc(a.spawns.join(", "))}</div>` : ""}
    </div>
    <div class="tama-foot">
      ${a.permission_mode ? (a.tmux
        ? `<button class="mode-chip" data-target="${esc(a.tmux.target)}"
             title="Permission mode: ${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)} — click to change">${esc(MODE_SHORT[a.permission_mode] || a.permission_mode)}</button>`
        : `<span class="mode-chip" title="Permission mode: ${esc(MODE_LABEL[a.permission_mode] || a.permission_mode)}">${esc(MODE_SHORT[a.permission_mode] || a.permission_mode)}</span>`) : ""}
      ${a.tmux ? `<span class="tmux-tag"
         title="${esc(tmuxTitle(a.tmux.target))}">${esc(a.tmux.target)}</span>`
       : a.remote ? `<span class="tmux-tag remote"
         title="This session runs on another machine (a Slurm allocation, or any host sharing ~/.claude). Its files are visible here; its tmux pane is not, so it can't be driven from this dashboard.">elsewhere</span>` : ""}
      <span class="time" title="Last message in this conversation">${ago(a.last_activity)}</span>
    </div>
  </div>`;
}

/* Lay the cemetery out as families: a session that launched others is shown
   full size with its children half size beside it. Lineage is only known for
   pairs the dashboard saw while both were alive (tmux daemonises, so nothing on
   disk connects them afterwards); everything else is a plain headstone. */
/* Group a headstone under its launcher's headstone — but only when the launcher
   is in the cemetery too. A session whose parent is still alive (or filtered
   out) can't be plotted next to it, so it stays where it is and says who
   launched it on the card instead; previously it showed as an orphan with no
   sign it had ever had a parent. */
function graveFamilies(list) {
  const present = new Set(list.map(a => a.sessionId));
  const kids = new Map();
  for (const a of list) {
    if (a.spawned_by_sid && present.has(a.spawned_by_sid) && a.spawned_by_sid !== a.sessionId) {
      if (!kids.has(a.spawned_by_sid)) kids.set(a.spawned_by_sid, []);
      kids.get(a.spawned_by_sid).push(a);
    }
  }
  const claimed = new Set([].concat(...[...kids.values()]).map(a => a.sessionId));
  return list.filter(a => !claimed.has(a.sessionId))
             .map(a => ({parent: a, children: kids.get(a.sessionId) || []}));
}

function graveFamilyHtml(fam) {
  if (!fam.children.length) return graveCardHtml(fam.parent);
  return `<div class="grave-family" title="${esc(fam.parent.display_name)} and the ${
    fam.children.length} session${fam.children.length === 1 ? "" : "s"} it launched">
    ${graveCardHtml(fam.parent)}
    <div class="grave-kids">${fam.children.map(c => graveCardHtml(c, true)).join("")}</div>
  </div>`;
}

/* Cemetery filters: model, repo/folder, and a free-text match on the name and
   path. All client-side — the whole list is already in memory. */
function graveRepoOf(a) {
  return (a.git && a.git.repo) || a.project || a.cwd || "";
}

function graveMatches(a) {
  const f = graveFilter;
  if (f.model && modelFamily((a.context_breakdown || {}).model) !== f.model) return false;
  if (f.repo && graveRepoOf(a) !== f.repo) return false;
  if (f.text) {
    const hay = `${a.display_name} ${a.cwd} ${(a.git && a.git.branch) || ""}`.toLowerCase();
    if (!hay.includes(f.text.toLowerCase())) return false;
  }
  // Token range, in thousands. A conversation whose size we never recovered is
  // excluded as soon as you ask for a range at all — it cannot satisfy one.
  const lo = parseFloat(f.minTok), hi = parseFloat(f.maxTok);
  if (!isNaN(lo) || !isNaN(hi)) {
    if (!a.tokens) return false;
    if (!isNaN(lo) && a.tokens < lo * 1000) return false;
    if (!isNaN(hi) && a.tokens > hi * 1000) return false;
  }
  return true;
}

/* Re-filter without touching the controls. Rebuilding the whole grid on each
   keystroke destroyed the focused input: input[type=number] reports a null
   selectionStart, so restoring the caret sent it to position 0 and typing "10"
   came out "01", and a select-all was wiped before the key landed. */
/* Cemetery order. The server hands them over newest-death-first; these re-sort
   client-side, so switching costs nothing. */
const GRAVE_SORTS = {
  recent: {label: "last seen",
           cmp: (a, b) => (b.last_activity || 0) - (a.last_activity || 0)},
  name: {label: "name (A-Z)",
         cmp: (a, b) => (a.display_name || "").toLowerCase()
                          .localeCompare((b.display_name || "").toLowerCase())},
  tokens: {label: "tokens (most first)",
           cmp: (a, b) => (b.tokens || 0) - (a.tokens || 0)},
};

function graveSorted(list) {
  return list.slice().sort(GRAVE_SORTS[graveSort].cmp);
}

function refreshGraveResults() {
  const gridEl = grid.querySelector(".grave-grid");
  if (!gridEl) return;
  const shown = graveSorted(history.filter(graveMatches));
  gridEl.innerHTML = graveFamilies(shown).map(graveFamilyHtml).join("")
    || '<div class="empty">Nothing matches that filter.</div>';
  const count = grid.querySelector(".grave-count");
  if (count) count.textContent = `${shown.length} of ${history.length}`;
}

function graveFilterHtml(shown, total) {
  const repos = [...new Set(history.map(graveRepoOf))].filter(Boolean).sort();
  const models = MODEL_ORDER.filter(m =>
    history.some(a => modelFamily((a.context_breakdown || {}).model) === m));
  const opt = (v, label, cur) =>
    `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  return `<div class="grave-filter">
    <input class="grave-search" placeholder="filter by name, path or branch…"
      value="${esc(graveFilter.text)}" spellcheck="false">
    <select class="grave-model">${opt("", "any model", graveFilter.model)}
      ${models.map(m => opt(m, MODEL_SKIN[m].label, graveFilter.model)).join("")}</select>
    <select class="grave-repo">${opt("", "any repo", graveFilter.repo)}
      ${repos.map(r => opt(r, r, graveFilter.repo)).join("")}</select>
    <select class="grave-sort">${Object.entries(GRAVE_SORTS)
      .map(([k, v]) => opt(k, "sort: " + v.label, graveSort)).join("")}</select>
    <span class="grave-tok">
      <input class="grave-min" type="number" min="0" step="10" placeholder="min"
        value="${esc(graveFilter.minTok)}">–<input class="grave-max" type="number"
        min="0" step="10" placeholder="max" value="${esc(graveFilter.maxTok)}">k tok
    </span>
    <span class="grave-count">${shown} of ${total}</span>
    <button class="grave-clear">clear</button>
  </div>`;
}

/* Faces for the epitaph. Picked from the session id rather than at random, so a
   given pet keeps its expression instead of twitching on every re-render. */
const EPITAPH_FACES = ["^_^", ":)", ";)", "u_u", "o_o", "-_-", "x_x", "~_~",
                       "._.", "o7", "*_*", "n_n"];

function epitaphFace(sid) {
  return EPITAPH_FACES[hashStr(sid || "") % EPITAPH_FACES.length];
}

/* A past session: a headstone rather than a handheld — the pet, who it was,
   where it lived, the two dates, and an epitaph carrying the session id you
   need to resume it. */
function graveCardHtml(a, small) {
  const accent = critterOf(a).accent;
  const model = MODEL_SKIN[modelFamily((a.context_breakdown || {}).model)];
  return `<div class="grave-card${small ? " kid" : ""}" data-sid="${esc(a.sessionId)}"
    style="--pet-accent:${accent};--card-tint:${accent}"
    title="${esc(a.display_name)}\n${esc(a.cwd)}\nborn ${esc(whenAbs(a.startedAt))}\nlast active ${esc(whenAbs(a.last_activity))}">
    <div class="grave-pet">${mascotSvg(a)}</div>
    <div class="grave-name">${esc(a.display_name)}</div>
    ${a.spawned_by ? `<div class="grave-lineage" title="Launched by ${esc(a.spawned_by)}"
      >↳ ${esc(a.spawned_by)}</div>` : ""}
    <div class="grave-path">${esc(a.cwd)}</div>
    ${a.git ? `<div class="grave-git">${esc(a.git.repo || a.project)} · ${esc(a.git.branch || "—")}</div>` : ""}
    <div class="grave-dates">
      <span>born ${ago(a.startedAt)}</span><span>died ${ago(a.last_activity)}</span>
    </div>
    <div class="grave-epitaph" title="Session id — resume with:  claude --resume ${esc(a.sessionId)}">
      ${esc(String(a.sessionId).slice(0, 8))}${a.tokens ? ` · ${fmtTokens(a.tokens)} tok` : ""}
      <span class="grave-face">${esc(epitaphFace(a.sessionId))}</span>
    </div>
  </div>`;
}

/* ---------- modal (tabbed) ---------- */

let activeTab = "overview";
let lastRenderedTab = null;
let lastChatKey = "";
/* The modal body is re-rendered on every poll. Replacing innerHTML destroys
   every bit of DOM state inside it — scroll positions, open <details>, the
   caret — and only the body's own scrollTop was ever restored. So compare the
   markup first and leave the DOM completely alone when nothing changed. */
let lastBodyHtml = "";

const TABS = [
  {id: "overview", label: "Overview", show: () => true},
  {id: "graph", label: "Work graph", show: a => !a.dead && !!agentGraph(a)},
  {id: "exchange", label: "Exchange",
   show: a => a.dead || a.last_prompt || a.last_assistant || a.state === "needs_input"},
  {id: "mcp", label: "MCP", show: a => !a.dead && (a.mcp || []).length > 0},
  {id: "artifacts", label: "Artifacts", show: a => !a.dead},
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
  const working = workingStripHtml(a);
  if (!msgs.length && !working) return "";
  return `<div class="section">
    <div class="section-title">Last exchange</div>
    <div class="chat">${renderChatEntries(a, withPending(a, msgs))}${working}</div></div>`;
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
    ["tmux", a.tmux ? a.tmux.target : a.remote ? "on another machine" : "not found"],
    ["Tasks", tasks.length ? `${done}/${tasks.length} done` : "–"],
    ["Context", a.context_tokens ? `${a.context_tokens.toLocaleString()} tokens` : "–"],
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

/* What the pane says the agent is doing, in a couple of words.

   A long reply is the awkward case. Claude Code drops the spinner line the
   moment prose starts streaming, and nothing reaches the transcript until the
   turn ends — so for a minute at a time the conversation looked frozen even
   though the footer still offered "esc to interrupt". Working with no spinner
   is exactly that case, and it gets its own label rather than none.
   Compaction is the other one: its spinner reads "Compacting conversation…"
   with a progress bar, neither of which showed up here at all. */
function workingLabel(a) {
  const word = (a.activity || "").split("…")[0].trim();
  if (/compact/i.test(word)) return "compacting the conversation";
  // A progress bar means a long mechanical pass, never a reply being typed —
  // don't guess "writing" for one just because its phrase was unreadable.
  if (!word) return typeof a.progress === "number" ? "working" : "writing a reply";
  return word.toLowerCase();
}

/* A pet strolling along a line under the last message, with its status walking
   behind it, so a long silent turn still looks alive. The stroll is offset by
   wall-clock time: the poll rebuilds this element, and without that the
   animation would restart from the left edge on every rebuild. */
const WALK_SECONDS = 11;  // must match the pet-stroll duration in style.css
function workingStripHtml(a) {
  if (a.state !== "busy") return "";
  const pct = typeof a.progress === "number" ? ` ${a.progress}%` : "";
  const phase = (Date.now() / 1000) % WALK_SECONDS;
  return `<div class="work-strip"><div class="work-track">
      <span class="work-walker" style="animation-delay:-${phase.toFixed(2)}s">
        ${mascotSvg(a, "work-pet", {hideItem: true})}
        <span class="work-label">${esc(workingLabel(a))}${pct}…</span>
      </span>
    </div></div>`;
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
  const working = workingStripHtml(a);
  if (!chat.messages.length && !approval && !working) {
    return `<div class="section"><div class="chat-loading">No conversation found in the transcript tail.</div></div>`;
  }
  return `<div class="section"><div class="chat">${
    renderChatEntries(a, withPending(a, chat.messages))}${approval}${working}</div></div>`;
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

/* MCP servers this session knows about, and whether they're usable. Names and
   status only — a server's env/args/URL carry API keys, so the server never
   reads or sends them. */
const MCP_STATUS = {
  connected: "connected",
  configured: "not connected",
  disabled: "disabled",
};

function mcpTab(a) {
  const servers = a.mcp || [];
  const live = servers.filter(m => m.status === "connected").length;
  const rows = servers.map(m => `<div class="mcp-row ${esc(m.status)}">
    <span class="mcp-dot"></span>
    <span class="mcp-name">${esc(m.name)}</span>
    <span class="mcp-state">${MCP_STATUS[m.status] || esc(m.status)}</span>
  </div>`).join("");
  return `<div class="section">
    <div class="section-title">MCP servers
      <span class="when">${live} of ${servers.length} connected</span></div>
    <div class="mcp-list">${rows}</div>
  </div>`;
}

function modalHtml(a) {
  if (activeTab === "graph") return graphTab(a);
  if (activeTab === "exchange") return exchangeTab(a);
  if (activeTab === "mcp") return mcpTab(a);
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
    ${a.dead ? `<span class="grave-tag" title="This session is no longer running">ended ${ago(a.last_activity)}</span>`
             : `<button class="kill-btn${killArmed === a.sessionId ? " armed" : ""}"
                  data-sid="${esc(a.sessionId)}" title="Terminate this agent"
                  >${killArmed === a.sessionId ? "Confirm kill?" : "Kill"}</button>`}
    <button class="modal-close" title="Close (Esc)">✕</button>`;
}

function composerHtml(a) {
  if (a.remote) {
    return `<div class="composer"><span class="composer-note">This agent runs on another machine — visible here, but there's no pane to send input to.</span></div>`;
  }
  if (a.dead) {
    return `<div class="composer"><span class="composer-note">This conversation has ended — read-only.</span></div>`;
  }
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
  return agents.find(x => x.sessionId === openSid)
      || history.find(x => x.sessionId === openSid);
}

/* Adapt a past-session row into the shape the card and modal already expect,
   flagged `dead` so read-only paths can key off one field. */
function graveAgent(h) {
  // a rename you gave the session wins over its ai-title
  const name = h.name || h.title || ("#" + String(h.sessionId || "").slice(0, 8));
  const git = h.git ? Object.assign({}, h.git, {branch: h.branch || h.git.branch})
            : (h.branch ? {repo: null, branch: h.branch, commit: ""} : null);
  return {
    dead: true, sessionId: h.sessionId, name, display_name: name,
    cwd: h.cwd || "", git,
    project: (h.cwd || "").split("/").filter(Boolean).pop() || h.cwd || "",
    tmux: null, state: "idle", tasks: [], subagents: [], mcp: [],
    spawns: [], spawned_by: null, prompt: null, pending_tool: null,
    notification: null, activity: null, current_task: null, agent_status: null,
    context_breakdown: {model: h.model}, context_tokens: null, context_window: null,
    startedAt: h.born, last_activity: h.died, transcript_mtime: h.died,
    permission_mode: null, title: h.title, tokens: h.tokens,
    context_tokens: h.tokens || null,
    spawned_by: h.parent_name || null, spawned_by_sid: h.parent || null,
    last_prompt: null, last_assistant: null, last_exchange: [],
  };
}

async function loadHistory() {
  try {
    const d = await (await fetch("/api/history", {headers: authHeaders()})).json();
    history = (d.sessions || []).map(graveAgent);
    render();
  } catch { /* the next refresh retries */ }
}

function startRename() {
  const a = currentAgent();
  const holder = modal.querySelector(".name-holder");
  if (!a || !holder) return;
  editingName = true;
  lastHeadHtml = "";  // hand-edited below; the cache must not think it's current
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
      if (a.dead) loadHistory();  // headstones come from their own endpoint
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
  // Refresh the board now rather than waiting up to a second for the next poll,
  // then once more after the CLI has had time to start showing its spinner —
  // otherwise the card sits on "idle" for a beat after you hit send.
  tick();
  setTimeout(tick, 450);
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
    lastBodyHtml = lastHeadHtml = lastTabHtml = "";  // fresh shell, nothing in it yet
    wireComposer();
  }
  if (!TABS.find(t => t.id === activeTab)?.show(a)) activeTab = "overview";
  // The header and the tab bar hold the ✕, Kill and rename buttons. Rewriting
  // them on every tick destroyed and recreated those buttons under the cursor.
  if (!editingName) {
    const head = modalHeadHtml(a);
    if (head !== lastHeadHtml) {
      modal.querySelector(".modal-head").innerHTML = head;
      lastHeadHtml = head;
    }
  }
  const tabs = tabbarHtml(a);
  if (tabs !== lastTabHtml) {
    modal.querySelector(".tabbar").innerHTML = tabs;
    lastTabHtml = tabs;
  }
  const body = modal.querySelector(".modal-body");
  if (body.contains(document.activeElement) &&
      document.activeElement.classList.contains("art-add")) return;  // mid-typing
  if (hasSelectionIn(body)) return;  // don't yank the text out from under a selection
  const html = modalHtml(a);
  if (html === lastBodyHtml) {  // identical render — keep the DOM and its scroll
    lastRenderedTab = activeTab;
    return;
  }
  const scroll = activeTab === lastRenderedTab ? body.scrollTop : 0;
  // Open <details> (the Thinking disclosures) are DOM state too — they snapped
  // shut on every rebuild. Carry the flags across, matched by position.
  const opened = [...body.querySelectorAll("details")].map(d => d.open);
  body.innerHTML = html;
  lastBodyHtml = html;
  body.querySelectorAll("details").forEach((d, i) => { if (opened[i]) d.open = true; });
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
  activeTab = "exchange";  // finished conversations only have this one  // land on the conversation, scrolled to the latest
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
  killArmed = null;
  lastBodyHtml = lastHeadHtml = lastTabHtml = "";
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

const GRAVE_CONTROLS = ["grave-search", "grave-model", "grave-repo",
                        "grave-min", "grave-max", "grave-sort"];

/* True while any cemetery filter control has focus. The poll must leave the
   grid alone then: replacing the element would shut an open <select> popup and
   throw away the caret and selection in a text or number box. */
function graveFilterFocused() {
  const el = document.activeElement;
  return !!(el && el.classList && GRAVE_CONTROLS.some(c => el.classList.contains(c)));
}

function render(force) {
  if (pointerHeld && !force) return;  // a click is in progress; don't move the DOM
  const byState = {needs_input: 0, waiting: 0, busy: 0, idle: 0};
  agents.forEach(a => byState[a.state] = (byState[a.state] || 0) + 1);
  const countsHtml = Object.entries(byState)
    .filter(([, n]) => n)
    .map(([s, n]) => `<span class="stat ${s}"><span class="dot ${s}"></span><b>${n}</b> ${STATE_LABEL[s]}</span>`)
    .join("");
  if (countsHtml !== lastCountsHtml) {  // the tallies rarely move; don't rewrite them every tick
    counts.innerHTML = countsHtml;
    lastCountsHtml = countsHtml;
  }
  // Don't yank an open picker, text you're in the middle of selecting, or a
  // cemetery dropdown someone has open. Everything outside the grid refreshes.
  if (!grid.querySelector(".model-menu") && !hasSelectionIn(grid)
      && (force || !graveFilterFocused())) {
    const gridHtml = agents.length
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
    const shown = graveOpen ? graveSorted(history.filter(graveMatches)) : [];
    const graveHtml = history.length ? `<div class="group-head grave">
        <span class="group-label">Past sessions</span>
        <span class="group-count">${history.length}</span>
        <span class="group-rule"></span>
        <button class="grave-toggle">${graveOpen ? "hide" : "show"}</button>
      </div>` + (graveOpen
        ? graveFilterHtml(shown.length, history.length)
          + `<div class="grave-grid">${graveFamilies(shown).map(graveFamilyHtml).join("")
             || '<div class="empty">Nothing matches that filter.</div>'}</div>` : "")
      : "";
    // Only rebuild the shelf when it would actually look different; otherwise
    // the page scroll (and any hover) is disturbed once a second for nothing.
    if (gridHtml + graveHtml !== lastGridHtml) {
      grid.innerHTML = gridHtml + graveHtml;
      lastGridHtml = gridHtml + graveHtml;
    }
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
  // The CLI answers /model with its own confirmation, so don't claim the switch
  // happened — say what the pane actually shows.
  toast(r.ok ? r.msg : `Model switch failed: ${r.msg}`, !r.ok);
  tick();  // surface that confirmation on the card straight away
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

/* The armed "Confirm kill?" state used to live on the button element itself.
   The poll rebuilds the modal header, so it was wiped roughly once a second and
   the confirmation vanished before you could reach it. It is state, so it lives
   in state and is rendered from there. */
async function killAgent(btn) {
  const sid = btn.dataset.sid;
  if (killArmed !== sid) {
    killArmed = sid;
    renderModal();
    setTimeout(() => {
      if (killArmed !== sid) return;
      killArmed = null;
      if (openSid) renderModal();
    }, 8000);  // 3s was faster than most people can move a mouse
    return;
  }
  killArmed = null;
  btn.textContent = "Killing…";
  const ok = (await post("/api/kill", {sid})).ok;
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
  if (e.target.closest(".grave-clear")) {
    e.stopPropagation();
    graveFilter = {model: "", repo: "", text: "", minTok: "", maxTok: ""};
    render();
    return;
  }
  if (e.target.closest(".grave-toggle")) {
    e.stopPropagation();
    graveOpen = !graveOpen;
    try { localStorage.tamaGrave = graveOpen ? "1" : "0"; } catch { /* private mode */ }
    render();
    return;
  }
  // A drag that ends on a card is a text selection, not a click on the card.
  const card = e.target.closest(".card, .grave-card");
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
  if (e.target.closest(".grave-search")) {
    graveFilter.text = e.target.value;
    refreshGraveResults();
  }
  if (e.target.closest(".grave-min")) { graveFilter.minTok = e.target.value; refreshGraveResults(); }
  if (e.target.closest(".grave-max")) { graveFilter.maxTok = e.target.value; refreshGraveResults(); }
});

/* Hovering the little parent pet lights up the parent's card. */
document.body.addEventListener("mouseover", e => {
  const pet = e.target.closest && e.target.closest(".lineage-pet");
  if (!pet) return;
  const card = grid.querySelector(`.card[data-sid="${CSS.escape(pet.dataset.parent)}"]`);
  if (card) card.classList.add("kin-highlight");
});

document.body.addEventListener("mouseout", e => {
  if (e.target.closest && e.target.closest(".lineage-pet")) {
    grid.querySelectorAll(".kin-highlight").forEach(c => c.classList.remove("kin-highlight"));
  }
});

document.body.addEventListener("change", e => {
  if (e.target.closest(".grave-model")) { graveFilter.model = e.target.value; refreshGraveResults(); }
  if (e.target.closest(".grave-repo")) { graveFilter.repo = e.target.value; refreshGraveResults(); }
  if (e.target.closest(".grave-sort")) { graveSort = e.target.value; refreshGraveResults(); }
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
    baselineUnseen();  // never-met sessions start "seen", not "new"
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

/* 600ms rather than a second: the poll interval and the server's cache are the
   entire lag between an agent changing state and the card saying so, and at 1s
   that was up to 1.5s. */
tick();
setInterval(tick, 600);
loadHistory();
setInterval(loadHistory, 60000);  // past sessions change slowly
