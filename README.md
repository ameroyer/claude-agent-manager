# claude-agent-manager (TamaClaudchi)

A little web dashboard for keeping an eye on several Claude Code agents at once —
styled as a shelf of Tamagotchi-like handhelds, one pixel-Claude pet per session.

Each pet's look encodes where it lives, so you can read the fleet at a glance:

| what you see | what it means |
|---|---|
| body colour | the git repo (or the folder, outside one) — worktrees of a repo share it, and so does the device tint |
| hat | the model — wizard / crown / poet's hat / kitsune mask for Fable / Opus / Sonnet / Haiku |
| held item | the git branch — everyone on `main` carries the sword |
| an egg instead of a pet | the session hasn't replied yet, so its model is unknown |

The mood pill, the badge and the card's border track what the agent is doing
right now, and the device lights fill up as the session eats its context window.
Nothing on a card blinks or twitches — the pets hold still. When an agent
is mid-turn — writing a long reply, or compacting — a small pet strolls along a
line at the foot of the conversation with its status walking behind it, because
neither of those writes anything to the transcript until it finishes.

I usually have a handful of Claude Code sessions running in tmux, each in its own
window, and I kept losing track of which ones were stuck waiting on me. So this
puts them all on one page: what each agent is doing, which ones need a decision,
how much context they've used, and buttons to approve/deny, message them, or
start and stop agents — without cycling through tmux.

It reads the files Claude Code already writes, so the agents don't have to do
anything special for it to work.

<!-- add a screenshot here: ![dashboard](docs/screenshot.png) -->

## Requirements

- Python 3.9+ (standard library only — nothing to `pip install`)
- tmux
- Claude Code
- Linux on the machine running the server — it reads `/proc` for process info,
  so it won't run on a macOS host (a macOS *browser* pointed at a Linux box over
  SSH is fine)

## Running it

No clone, no install — `uvx` fetches and runs it:

```bash
uvx --from git+https://github.com/YOUR-USERNAME/claude-agent-manager tamaclaudchi
```

Or from a clone, with nothing installed at all:

```bash
git clone https://github.com/YOUR-USERNAME/claude-agent-manager.git
cd claude-agent-manager
python3 server.py
```

Both run the same server, and take the same flags (`--port`, `--host`,
`--token`). It's stdlib-only with no runtime dependencies, so `uvx` pulls this
package and nothing else.

On startup it prints a URL with an access token in the fragment, e.g.
`http://127.0.0.1:8842/#Xk3p…`. Open that exact URL — the token gates every
`/api/*` call, so the dashboard is inert without it. This is what keeps another
local user, or a random website you have open, from reading your transcripts or
driving your agents. Set a fixed token with `--token` or `CAM_TOKEN` if you'd
rather bookmark it.

If Claude Code is running on a remote machine, forward the port over SSH:

```bash
ssh -L 8842:localhost:8842 you@your-box
```

Run `server.py` on the remote box (it reads that box's `~/.claude` and `/proc`);
the browser stays local. It's Linux-only on the server side — it relies on
`/proc`, so it won't serve from a macOS host.

## Hooks (recommended)

The dashboard works without any setup, but two things are nicer with hooks:
knowing the moment an agent needs your input, and letting agents write their own
one-line status and a little task graph.

Point Claude Code at the included hook script by adding this to
`~/.claude/settings.json` (change the path to wherever you cloned it):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "python3 /path/to/claude-agent-manager/hooks/agent-event.py" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "python3 /path/to/claude-agent-manager/hooks/agent-event.py" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "python3 /path/to/claude-agent-manager/hooks/agent-event.py" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/claude-agent-manager/hooks/agent-event.py" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "python3 /path/to/claude-agent-manager/hooks/agent-event.py", "async": true }] }]
  }
}
```

Sessions that were already open when you add the hooks won't pick them up until
you restart them.

## What you can do

- See every live agent grouped by state: needs approval, waiting for you,
  working, or idle. The browser tab gets a ⚠ when something needs you.
- Click an agent for a summary, its work graph, the recent chat, and its
  `tasks/todo.md`.
- Approve or deny a permission prompt right from the card — it shows what's
  being requested (e.g. `Bash: rm -rf …`).
- Type a message to an agent and it lands in that pane. A half-written message
  is kept per session, so you can go look at another pet (or reload) and come
  back to it — cards with unsent text show a `draft` pill.
- Switch a session's model (the pet's colour) or its permission mode — manual,
  auto-edit, plan, auto — from the card or the Overview tab. The mode switch
  presses ⇧⇥ in the session until its own footer reports the mode you picked, so
  what you see is what the CLI actually did. Bypass is left as a manual opt-in.
- Spawn a new agent (pick a folder + optional first message), resume a past
  conversation from that folder (`claude --resume`), or kill one.
- See where a session came from. A session that another *agent* launched says
  who launched it, and the launcher lists what it spawned — hover the little
  parent pet to light up its card. tmux daemonises, so `/proc` can't answer
  this: it comes from the parent's own transcript, remembered while both are
  alive in `~/.claude/agent-manager-spawns.json`. Starting a session yourself
  with **+ New agent** doesn't make it anyone's child.
- See sub-agents a session spawned with the Task tool. Those run *inside* the
  parent process — no pid, no pane, no transcript of their own — so they never
  get a pet; they show as chips on the parent's card, live ones from the pane's
  agent roster and finished ones from the transcript.
- If a session ever fails to show up on the board, open `/api/debug?token=…` —
  it lists every tmux-pane process and registry entry with the checks each one
  passed, which pinpoints why it was filtered out.
- Rename a session from its popup (the ✎ next to the name); names persist in
  `~/.claude/agent-manager-names.json`.
- See each card's working directory, git repo · branch @ commit, birth time, and
  session id at a glance; the popup adds runtime, transcript and scratchpad paths.
- Keep an eye on each agent's context-window usage so you can tell when one is
  about to compact.

## How it works

The backend is a single Python file using `http.server` — no framework, no
dependencies. The frontend is plain, self-contained HTML/CSS/JS — no build step
and no external assets, so it works fully offline. It reads `~/.claude` (session
info, transcripts, task lists) and talks to tmux to place agents and send them
input. The page refreshes about once a second.

## Security

The dashboard can read every agent's conversation and send them input, so treat
the server like a key to your machine:

- Every `/api/*` request needs the access token printed at startup. Without it
  the API returns `401`, so another local user or a website open in your browser
  can't read your transcripts or drive your agents.
- Keep it bound to `127.0.0.1` (the default) and reach a remote box over the SSH
  tunnel above rather than binding to `0.0.0.0`.

## License

MIT
