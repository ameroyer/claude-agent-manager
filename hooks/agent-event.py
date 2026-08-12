#!/usr/bin/env python3
"""Claude Code hook: append lifecycle events to ~/.claude/agent-events/<session_id>.jsonl.

Registered for Notification / Stop / UserPromptSubmit / PostToolUse in settings.json.
The claude-agent-manager dashboard reads these to show needs-input / waiting / busy states.
"""
import json
import os
import sys
import time

EVENT_MAP = {
    "Notification": "notification",
    "Stop": "stop",
    "UserPromptSubmit": "prompt",
    "PostToolUse": "activity",
    "SessionStart": "start",
}

STATUS_INSTRUCTIONS = """\
[claude-agent-manager] A local dashboard shows this session to the user. Maintain your \
status file at {path} so the dashboard stays accurate. Rewrite the whole file \
(valid JSON) at the end of each turn and whenever your plan changes materially:
{{"name": "<2-4 word name for this session's task, e.g. 'Fixing eval OOM'>",
 "summary": "<2-3 sentences: current goal, progress so far, any blocker or \
question for the user>",
 "graph": {{"nodes": [{{"id": "<short-id>", "label": "<step, max ~40 chars>", \
"status": "pending|in_progress|completed|blocked"}}],
           "edges": [["<from-id>", "<to-id>"]]}}}}
The graph is your work-plan DAG (3-12 nodes; edges mean "must finish before"). \
Keep it truthful and current - the user relies on it to decide when to check in."""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    sid = payload.get("session_id")
    event = EVENT_MAP.get(payload.get("hook_event_name"))
    if not sid or not event:
        return
    d = os.path.join(os.path.expanduser("~"), ".claude", "agent-events")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{sid}.jsonl")
    if event == "start":
        status_dir = os.path.join(os.path.expanduser("~"), ".claude", "agent-status")
        os.makedirs(status_dir, exist_ok=True)
        ctx = STATUS_INSTRUCTIONS.format(path=os.path.join(status_dir, f"{sid}.json"))
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart", "additionalContext": ctx}}))
    # PostToolUse fires on every tool call; throttle to one heartbeat per 5s.
    if event == "activity":
        try:
            if time.time() - os.path.getmtime(path) < 5:
                return
        except OSError:
            pass
    rec = {"ts": time.time(), "event": event}
    if event == "notification":
        rec["message"] = payload.get("message")
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
