# claude-agent-manager — dashboard for Claude Code agents running in tmux

## Goal / acceptance criteria
- One local web page showing every live Claude Code agent: which tmux pane it lives in, busy / idle / **needs input**, what it's currently doing, and task progress.
- Task graph (from `~/.claude/tasks/<sessionId>/*.json` blocks/blockedBy edges) rendered per agent: done / in progress / pending.
- Per-project `tasks/todo.md` shown when present.
- No manual bookkeeping required from the agents; "needs input" comes from hooks, not model cooperation.

## Data sources (discovered)
- `~/.claude/sessions/<pid>.json` — live registry: pid, sessionId, cwd, name, status (busy|idle), timestamps. Primary.
- `tmux list-panes -a` + `ps -eo pid,ppid` — map claude pid → tmux pane target.
- `~/.claude/tasks/<sessionId>/N.json` — task list with dependency edges.
- `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` — transcript; tail for latest assistant text / last-prompt.
- `~/.claude/agent-events/<sessionId>.jsonl` — NEW, written by hooks (Notification/Stop/UserPromptSubmit) for needs-input detection.
- `<cwd>/tasks/todo.md` — per-repo checklist.

## Plan
- [x] Verify data formats (sessions registry, task store)
- [x] `server.py` — stdlib-only HTTP server: `/api/state` aggregate + static files
- [x] `web/` — index.html / app.js / style.css: agent cards + detail panel + SVG task DAG
- [x] `hooks/agent-event.py` — append hook events to ~/.claude/agent-events/
- [x] Register hooks in ~/.claude/settings.json
- [x] Verify: run server, curl /api/state, headless render tests
- [x] Results summary

## Results
- Server live on http://127.0.0.1:8842 (background). `/api/state` returns all 6
  live agents with correct tmux targets, task lists (3 tasks for
  multistep-tool-attacks incl. edges), todo.md content.
- Hooks validated with jq, pipe-tested with synthetic payloads, and proven live
  (PostToolUse events recorded for this session without a restart).
- Frontend verified headless via node vm: DAG renders 4 nodes/4 edges on a
  diamond dependency graph, falls back to a checklist when no edges, and the
  needs-input card shows badge + notification message. No Chrome on this box,
  so no screenshot — visual check pending user opening the page.
- Bug found+fixed during verification: empty `last-prompt` transcript records
  produced `last_prompt: ""`; now skipped.

## Iteration 2 (2026-07-19): design + modal + agent-written status
- [x] SessionStart hook injects per-session instructions: maintain ~/.claude/agent-status/<sid>.json {summary, graph}
- [x] server.py reads agent-status files into /api/state
- [x] Frontend redesign: stat tiles, refined cards, modal popup (summary / graph / last exchange / todo.md)
- [x] Verify: hook pipe-test, jq validate, curl, node vm render tests

### Iteration 2 results
- SessionStart hook pipe-tested: emits additionalContext with the per-session
  status-file path; ~/.claude/agent-status/ auto-created. jq-validated in settings.
- /api/state now carries agent_status (verified live: this session's own status
  file flows through with 5 graph nodes).
- node vm tests: redesigned card (badge/summary/notif), modal (agent graph
  preferred, 3 nodes incl. blocked state, all 4 sections), fallback to
  task-list graph + transcript summary when no status file. node --check clean.
- Existing agent sessions only get the status-file instructions after restart.

## Iteration 3 (2026-07-22): interact with agents from the UI
- [x] /api/send — paste message into agent's pane (tmux load-buffer + paste-buffer -p, then Enter after 350ms)
- [x] /api/key — whitelisted single keys (1/2/3/Enter/Escape/arrows/y/n/Tab) for permission prompts & interrupt
- [x] Modal composer (persistent across poll re-renders: modal split into re-rendered head/body + static composer)
- [x] Verify: E2E against a scratch tmux `cat` pane (message delivered; empty/unknown-pane/bad-key rejected), node vm render tests

## Iteration 4 (2026-07-22): declutter cards (user picked "glanceable card" layout)
- [x] Card = 3 zones: identity (icon+name+tmux), single "now" line (notif > current task > summary > state), footer (progress + activity time)
- [x] Dropped from card: full cwd, pid, status-age, stacked summary/task/notif blocks; all still in modal
- [x] needs_input = red left edge; state icons differ by shape (⚠ ⏸ ● ○) so color never carries meaning alone
- [x] Verified: node vm tests for now-line priority, fallbacks, dropped fields

## Iteration 5 (2026-07-22): tabbed agent popup
- [x] Modal body split into tabs: Overview / Work graph / Exchange / todo.md (tabs hidden when empty)
- [x] Overview = notification + summary + details grid (path, tmux, tasks, started, activity, pid)
- [x] Red pulse dot on Overview tab when input needed; active tab survives poll re-renders, scroll preserved per tab
- [x] Composer stays pinned below all tabs; verified via node vm tests

## Iteration 6 (2026-07-22): popup polish
- [x] Modal enlarged to min(1140px, 100%) × 92vh
- [x] Nested scrollbars removed: snippets + todo.md flow freely, single modal-body scroll; tabbar wraps instead of x-scrolling
- [x] Graph autoscales: SVG viewBox + width:100% (capped at natural size), no horizontal slider
- [x] Quick-key row (1/2/3/⏎/Esc) removed from composer; /api/key endpoint kept (API-only)

## Iteration 7 (2026-07-22): chat history
- [x] /api/chat?sid= — last 100 user/assistant messages from a 2MB transcript tail, mtime-cached server-side
- [x] Exchange tab = chat bubbles (you right/accent, agent left/neutral, timestamps), auto-pins to latest, refreshes while open
- [x] Overview regains the "Last exchange" prompt/response pair
- [x] Verified: curl own session (45 msgs, roles+ts correct, 404 on bad sid), node vm render tests

## Iteration 8 (2026-07-22): reliable last user message + markdown/LaTeX in messages
- [x] last_prompt/last_assistant now derived from the chat parser (2MB window, mtime-cached) — user prompts no longer lost when tool results flood the 256KB tail
- [x] mdHtml(): escape-first markdown subset (bold/italic/code/code blocks/lists/headings/http links) applied to chat bubbles, summary, last-exchange snippets
- [x] KaTeX via CDN for \\( \\) \\[ \\] $$ $$ (skipped silently offline); renderMath after each modal body render
- [x] Verified: all 6 live agents now show real last prompts; md unit tests incl. XSS + javascript: link rejection

## Iteration 9 (2026-07-22): meaningful agent names
- [x] display_name resolution: status-file "name" > user /rename (nameSource != derived) > transcript ai-title > derived id
- [x] ai-title lives ~40KB into the transcript (field is `aiTitle`, not `title`) — head-scan first 64KB
- [x] SessionStart instructions now ask agents for a "name" field too; raw session id moved to Details
- [x] Verified live: all 5 agents named (e.g. klimt-d5 -> "Extend model context size to 32k or 64k")

## Iteration 10 (2026-07-22): grouped card layout
- [x] Cards grouped under section headers: Needs your attention / Working / Idle (empty groups hidden, counts + colored labels + hairline rule)
- [x] Within groups: stable sort by project then name (server-side) — cards no longer shuffle on every busy/idle flip
- [x] Verified: node vm tests for grouping, counts, ordering, empty-group omission

## Iteration 11 (2026-07-22): kill + spawn agents from the UI
- [x] POST /api/kill {sid} — SIGTERM the tracked pid; guards: session must be known, pid alive, owned by our uid
- [x] POST /api/spawn {cwd, prompt} — tmux new-session -d (capture pane_id, base-index safe) -> send `claude` -> optional first message after 2.5s boot
- [x] UI: "+ New agent" header button + spawn dialog; "Kill" button in modal header with two-click "Confirm kill?" arm (3s timeout)
- [x] Verified E2E: spawn launched a real registered claude session, kill removed its pid; bad dir + unknown sid rejected
- [x] Fixed: window target assumed :0 but user's tmux is 1-indexed -> use pane_id

## Iteration 12 (2026-07-22): context-window usage
- [x] Parse last assistant message.usage from transcript tail; context_tokens = input + cache_read + cache_creation + output
- [x] Window auto-detected: 1M if usage > 200k (must be on the beta), else 200k (registry has no model/window)
- [x] Overview: context meter (bar + "238k / 1M · 24%") under summary; card footer: compact % chip
- [x] Color thresholds: ok < 65%, warn 65-85% (amber), critical >= 85% (red)
- [x] Verified live (5 agents, correct windows) + node vm render tests for chip/meter/thresholds

## Iteration 13 (2026-07-22): optional tmux session name on spawn
- [x] spawn_session takes optional name; sanitized ([^A-Za-z0-9_-]→-), falls back to cwd basename, still uniquified
- [x] Spawn dialog: "tmux session name (optional)" field between dir and first message; Enter chains focus
- [x] Verified: "my eval@run" → session "my-eval-run"

## Iteration 14 (2026-07-22): context breakdown detail
- [x] Server exposes context_breakdown {fresh_input, cache_read, cache_write, output, model} from last usage
- [x] Overview "Context detail" section: segmented bar + per-component rows (tokens + % of total) + total/window rows + model
- [x] Verified: breakdown sums to context_tokens; node vm render tests

## Iteration 15 (2026-07-22): Overview section reorder
- [x] Overview order now: (notification) → Context (meter + breakdown) → Last exchange → Summary → Details
- [x] Meter folded into the Context section header; section renamed "Context"
- [x] Extracted lastExchange/summary/details section helpers; verified order via node vm

## Iteration 16 (2026-07-22): visual overhaul — "ops console" (frontend-design skill)
- [x] Monospace identity (names/labels/numbers/tabs); sans for reading text
- [x] Signature: per-card state-colored "signal spine" (left edge) — fleet reads like a mixing desk
- [x] Graphite depth (cool near-black + top glow + layered shadows), cool-paper light theme
- [x] Blinking cursor brand mark; motion reserved for attention states; prefers-reduced-motion off
- [x] Smooth modal/spawn scale-in via opacity/visibility (not display:none); focus rings; inviting empty state
- [x] Kept validated dataviz palette for all meters/charts; see DESIGN.md
- [x] Verified: node --check, CSS brace balance (207/207), server serving 200. NO screenshot (headless box — user to eyeball)

## Iteration 17 (2026-07-22): context window detection + faster refresh
- [x] Root cause: transcript has NO window/beta marker (only model id) — window was a pure guess defaulting to 200k
- [x] Base window now read from ~/.claude/settings.json model [1m] flag (1M for this user); >200k usage still forces 1M; --context-window overrides
- [x] Fable-5 agents now show /1M correctly (106k → 11%, was 53% vs 200k)
- [x] Refresh: client poll 2s→1s; state cache TTL 1s→0.5s; tail_transcript now mtime-cached → /api/state ~2ms even when polled fast
- [x] Verified: correct windows live, override works, timing ~2ms

## Iteration 18 (2026-07-22): registry-resilient discovery + confirm 1M window
- [x] Confirmed via /context: true window is 1M; default_context_window() returns 1_000_000 from settings [1m] — aligned
- [x] Found dashboard was showing 0 agents: ~/.claude/sessions registry was reset (13:43) while sessions kept running, and running sessions don't re-register
- [x] Fallback discovery: enumerate live `claude` procs in tmux panes (comm=claude, uid=me, in pid_to_pane), recover sessionId from newest transcript in cwd's project dir; synth status from transcript recency
- [x] Refactored per-agent assembly into build_agent(); registry entries preferred, discovery fills the gaps; dedup by pid AND sessionId
- [x] Verified: 6 agents recovered from empty registry, all window=1M

## Iteration 19 (2026-07-22): fix approval-request visibility
- [x] Root cause: derive_state mapped ALL notifications → needs_input, so real approvals ("needs your permission") were buried among idle "waiting for your input" agents; stale notifications never expired
- [x] Classify by message: "permission/approval" → needs_input; "waiting for your input" → waiting; else waiting
- [x] Freshness: a notification is ignored if the transcript advanced >45s past it (agent kept working = resolved) → clears stale false-positives
- [x] Split cards into 4 sections: Needs approval / Waiting for you / Working / Idle; approvals get their own red section
- [x] Verified live: was 4 conflated needs_input → now 1 real approval + 1 waiting + rest idle; UI renders separate sections

## Iteration 20 (2026-07-22): act on approvals + permission-mode selector
- [x] Approval actions on needs_input cards + modal: Approve (key 1), Always (key 2), Deny (Escape) via /api/key
- [x] Permission mode read from transcript (last permission-mode record) → exposed as permission_mode; shown as card chip
- [x] Mode selector (Manual/Auto-edit/Plan/Auto/Bypass) in modal Overview; setMode cycles ⇧⇥ (BTab) until target reached, capped at 6, adapts to CLI cycle order
- [x] BTab added to key whitelist; verified permission_mode flows through + UI renders actions/selector

## Iteration 21 (2026-07-22): fix kill, mode cycle, approval detail
- [x] Kill: SIGTERM was caught by Claude Code → switched to `tmux kill-pane` (+ SIGKILL backstop). Verified kill-pane cascades to remove the session
- [x] Mode cycle "didn't work" = UI read mode from transcript (stale/absent for idle sessions). Now read live from pane footer (pane_mode: 'plan/auto/accept edits/bypass'→mode, else default). BTab itself always worked
- [x] Dropped Bypass from selector — not in the Shift+Tab cycle (separate opt-in). Cycle order: default→acceptEdits→plan→auto
- [x] Approval now shows WHAT: find_pending_tool() = tool_use with no tool_result; card shows "Bash: <cmd>", modal shows tool name + command block
- [x] Verified: live modes correct (auto/default), pending-tool unit tests pass, render tests pass

## Iteration 22 (2026-08-11): fix mode misread + cycle
- [x] Root cause: pane_mode substring-matched over several lines → picked up mode words in the *conversation text* (e.g. this session printing "plan mode on") not the footer. That false read also broke setMode convergence
- [x] Fix: inspect ONLY the last non-empty line (status/mode indicator); match "manual mode on"→default explicitly; return None (→ transcript fallback) when unreadable
- [x] Server was also STALE (old process) — restarted. Newer Claude Code cycle: manual→accept edits→plan→auto
- [x] Verified: all 8 live agents' modes match their terminals; convergence to every mode in 1-2 presses via server pane_mode

## Working notes
- Registry status values observed: only `busy`, `idle`. Permission-wait not distinguishable → hooks required.
- Transcripts can be 80+ MB → tail bytes only, never full parse.
- Shared box: other users run claude too, but ~/.claude is per-user so no filtering needed beyond the registry.
- Stale registry files possible → check /proc/<pid> before trusting.
