# claude-agent-manager

A little web dashboard for keeping an eye on several Claude Code agents at once.

I usually have a handful of Claude Code sessions running in tmux, each in its own
window, and I kept losing track of which ones were stuck waiting on me. So this
puts them all on one page: what each agent is doing, which ones need a decision,
how much context they've used, and buttons to approve/deny, message them, or
start and stop agents — without cycling through tmux.

It reads the files Claude Code already writes, so the agents don't have to do
anything special for it to work.

<!-- add a screenshot here: ![dashboard](docs/screenshot.png) -->

## Requirements

- Python 3 (standard library only — nothing to `pip install`)
- tmux
- Claude Code
- Linux (it reads `/proc` for process info; probably works on macOS but I haven't tried)

## Running it

```bash
git clone https://github.com/YOUR-USERNAME/claude-agent-manager.git
cd claude-agent-manager
python3 server.py
```

Then open http://127.0.0.1:8842.

If Claude Code is running on a remote machine, forward the port over SSH:

```bash
ssh -L 8842:localhost:8842 you@your-box
```

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
- Type a message to an agent and it lands in that pane.
- Spawn a new agent (pick a folder + optional first message) or kill one.
- Keep an eye on each agent's context-window usage so you can tell when one is
  about to compact.

## How it works

The backend is a single Python file using `http.server` — no framework, no
dependencies. The frontend is plain HTML/CSS/JS, no build step. It reads
`~/.claude` (session info, transcripts, task lists) and talks to tmux to place
agents and send them input. The page refreshes about once a second.

## License

MIT
