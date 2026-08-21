#!/usr/bin/env python3
"""claude-agent-manager: local dashboard for Claude Code agents running in tmux.

Aggregates, per live agent:
  - ~/.claude/sessions/<pid>.json      live registry (name, cwd, busy/idle)
  - tmux pane mapping                  which session:window.pane it lives in
  - ~/.claude/tasks/<sessionId>/*.json task list with dependency edges
  - ~/.claude/agent-events/<sid>.jsonl hook events (needs-input detection)
  - transcript tail                    latest assistant text / user prompt
  - <cwd>/tasks/todo.md                per-repo checklist

Stdlib only. Run: python3 server.py [--port 8842] [--host 127.0.0.1]
"""

import argparse
import hmac
import json
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude")
SESSIONS_DIR = os.path.join(CLAUDE_DIR, "sessions")
TASKS_DIR = os.path.join(CLAUDE_DIR, "tasks")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")
EVENTS_DIR = os.path.join(CLAUDE_DIR, "agent-events")
STATUS_DIR = os.path.join(CLAUDE_DIR, "agent-status")
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

TRANSCRIPT_TAIL_BYTES = 256 * 1024
CHAT_TAIL_BYTES = 2 * 1024 * 1024
CHAT_MAX_MESSAGES = 150
CHAT_MAX_CHARS = 20000
THINK_MAX_CHARS = 8000


def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


# CLI override; 0 = auto-detect from ~/.claude/settings.json
CONTEXT_WINDOW_OVERRIDE = 0

# Shared secret gating every /api/* request (set in main). Since these endpoints
# read transcripts and drive agents, the token is the whole security boundary:
# it defeats CSRF, DNS-rebinding, and shared-host snooping without CORS/Origin
# juggling. It rides in the dashboard URL fragment and the X-Auth-Token header.
AUTH_TOKEN = ""


# Per-model context window as (default, max-with-1M-beta). The window isn't
# recorded in any session file, so it's derived: pick the model's row, use the
# 1M column only when the 1M beta is enabled. Unknown models fall back to
# DEFAULT_WINDOWS. Edit this table as models change.
DEFAULT_WINDOWS = (200_000, 1_000_000)
MODEL_WINDOWS = {
    "claude-fable-5":    (200_000, 1_000_000),
    "claude-mythos-5":   (200_000, 1_000_000),
    "claude-opus-5":     (200_000, 1_000_000),
    "claude-opus-4-8":   (200_000, 1_000_000),
    "claude-opus-4-7":   (200_000, 1_000_000),
    "claude-sonnet-5":   (200_000, 1_000_000),
    "claude-sonnet-4-5": (200_000, 1_000_000),
    "claude-haiku-4-5":  (200_000, 200_000),
}


def beta_1m_enabled():
    settings = read_json(os.path.join(CLAUDE_DIR, "settings.json")) or {}
    return "[1m]" in settings.get("model", "")


def context_window_for(model, ctx_tokens):
    """Window for a session: its model's row × whether the 1M beta is on. A
    prompt already past 200k proves the 1M window regardless of the above."""
    if CONTEXT_WINDOW_OVERRIDE:
        return CONTEXT_WINDOW_OVERRIDE
    key = (model or "").split("[")[0].strip()
    default_w, max_w = MODEL_WINDOWS.get(key, DEFAULT_WINDOWS)
    window = max_w if beta_1m_enabled() else default_w
    if (ctx_tokens or 0) > 200_000:
        window = max(window, 1_000_000)
    return window


def pid_alive(pid):
    return os.path.exists(f"/proc/{pid}")


def tmux_pane_index():
    """Map every descendant pid of each tmux pane to its pane target."""
    panes = []
    out = run(["tmux", "list-panes", "-a", "-F",
               "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{window_name}"])
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 5:
            sess, win, pane, ppid, wname = parts
            panes.append({"target": f"{sess}:{win}.{pane}", "session": sess,
                          "window": wname, "pid": int(ppid)})
    children = {}
    for line in run(["ps", "-eo", "pid=,ppid="]).splitlines():
        try:
            pid, ppid = map(int, line.split())
            children.setdefault(ppid, []).append(pid)
        except ValueError:
            continue
    pid_to_pane = {}
    for p in panes:
        stack = [p["pid"]]
        while stack:
            pid = stack.pop()
            pid_to_pane[pid] = p
            stack.extend(children.get(pid, []))
    return pid_to_pane


def load_tasks(session_id):
    d = os.path.join(TASKS_DIR, session_id)
    if not os.path.isdir(d):
        return []
    tasks = []
    for name in os.listdir(d):
        if name.endswith(".json"):
            t = read_json(os.path.join(d, name))
            if t and "id" in t:
                tasks.append({k: t.get(k) for k in
                              ("id", "subject", "activeForm", "status", "blocks", "blockedBy")})
    tasks.sort(key=lambda t: int(t["id"]) if str(t["id"]).isdigit() else 0)
    return tasks


def load_events(session_id):
    """Return (state_override, last_notification_message, events_tail)."""
    path = os.path.join(EVENTS_DIR, f"{session_id}.jsonl")
    if not os.path.exists(path):
        return None, None
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 16384))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return None, None
    last = None
    for line in reversed(lines):
        try:
            ev = json.loads(line)
            if "event" in ev:
                last = ev
                break
        except Exception:
            continue
    return last, path


def transcript_path(cwd, session_id):
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    return os.path.join(PROJECTS_DIR, slug, f"{session_id}.jsonl")


_tail_cache = {}


def tail_transcript(cwd, session_id):
    """Return dict with last assistant text, last user prompt, title, mtime.
    Cached by transcript mtime so a fast poll doesn't re-read the tail."""
    path = transcript_path(cwd, session_id)
    info = {"last_assistant": None, "last_prompt": None, "title": None,
            "mtime": None, "context_tokens": None, "context_window": None,
            "context_breakdown": None, "permission_mode": None,
            "pending_tool": None}
    if not os.path.exists(path):
        return info
    mtime = os.path.getmtime(path)
    cached = _tail_cache.get(session_id)
    if cached and cached[0] == mtime:
        return cached[1]
    info["mtime"] = mtime
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            chunk = f.read().decode("utf-8", "replace")
        lines = chunk.splitlines()
        if size > TRANSCRIPT_TAIL_BYTES:
            lines = lines[1:]  # drop partial first line
    except Exception:
        return info
    if info["title"] is None:
        # ai-title records are written early in the transcript, usually
        # far outside the tail window — scan the head for them too.
        try:
            with open(path, "rb") as f:
                head = f.read(64 * 1024).decode("utf-8", "replace")
            for line in head.splitlines():
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("type") == "ai-title":
                    info["title"] = rec.get("aiTitle") or rec.get("title")
        except Exception:
            pass
    for line in reversed(lines):
        if (info["last_assistant"] and info["last_prompt"] and info["title"]
                and info["permission_mode"]):
            break
        try:
            rec = json.loads(line)
        except Exception:
            continue
        t = rec.get("type")
        if t == "assistant":
            msg = rec.get("message") or {}
            if info["context_tokens"] is None:
                u = msg.get("usage") or {}
                if u:
                    fresh = u.get("input_tokens", 0)
                    cache_read = u.get("cache_read_input_tokens", 0)
                    cache_write = u.get("cache_creation_input_tokens", 0)
                    output = u.get("output_tokens", 0)
                    info["context_tokens"] = fresh + cache_read + cache_write + output
                    info["context_breakdown"] = {
                        "fresh_input": fresh, "cache_read": cache_read,
                        "cache_write": cache_write, "output": output,
                        "model": msg.get("model")}
            if not info["last_assistant"]:
                content = msg.get("content") or []
                texts = [b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text"]
                if texts:
                    info["last_assistant"] = " ".join(texts)[:600]
        elif t == "user" and not info["last_prompt"]:
            content = (rec.get("message") or {}).get("content")
            if isinstance(content, str) and content.strip() and \
                    not content.startswith("<") and "tool_result" not in line[:200]:
                info["last_prompt"] = content[:300]
        elif t == "ai-title" and not info["title"]:
            info["title"] = rec.get("aiTitle") or rec.get("title")
        elif t == "last-prompt" and not info["last_prompt"]:
            p = rec.get("prompt") or rec.get("text")
            if p and p.strip():
                info["last_prompt"] = p[:300]
        elif t == "permission-mode" and not info["permission_mode"]:
            info["permission_mode"] = rec.get("permissionMode")
    info["pending_tool"] = find_pending_tool(lines)
    _tail_cache[session_id] = (mtime, info)
    return info


def _tool_detail(name, inp):
    if not isinstance(inp, dict):
        return ""
    for k in ("command", "file_path", "path", "url", "pattern", "prompt", "description"):
        if inp.get(k):
            return str(inp[k]).strip()[:200]
    for v in inp.values():
        if isinstance(v, str) and v.strip():
            return v.strip()[:200]
    return ""


def find_pending_tool(lines):
    """A tool_use with no matching tool_result is awaiting run/approval."""
    uses = {}     # id -> (name, input)
    resolved = set()
    for line in lines:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        t = rec.get("type")
        content = (rec.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if t == "assistant" and b.get("type") == "tool_use":
                uses[b.get("id")] = (b.get("name"), b.get("input"))
            elif t == "user" and b.get("type") == "tool_result":
                resolved.add(b.get("tool_use_id"))
    pending = [(tid, nv) for tid, nv in uses.items() if tid not in resolved]
    if not pending:
        return None
    name, inp = pending[-1][1]
    return {"name": name, "detail": _tool_detail(name, inp)}


def load_agent_status(session_id):
    """Agent-maintained status file: {"summary": str, "graph": {nodes, edges}}."""
    path = os.path.join(STATUS_DIR, f"{session_id}.json")
    st = read_json(path)
    if not isinstance(st, dict):
        return None
    return {"name": st.get("name"), "summary": st.get("summary"),
            "graph": st.get("graph"), "updated": os.path.getmtime(path)}


_chat_cache = {}


def load_chat(cwd, session_id):
    """Last N user/assistant messages from the transcript tail (mtime-cached)."""
    path = transcript_path(cwd, session_id)
    if not os.path.exists(path):
        return []
    mtime = os.path.getmtime(path)
    cached = _chat_cache.get(session_id)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - CHAT_TAIL_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
        if size > CHAT_TAIL_BYTES:
            lines = lines[1:]
    except Exception:
        return []
    def cap(s, n):
        return s[:n] + "\n… [truncated]" if s and len(s) > n else s

    messages = []
    pending_think = []  # thinking from thinking-only records, attached to next reply
    for line in lines:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        t = rec.get("type")
        if t not in ("user", "assistant"):
            continue
        content = (rec.get("message") or {}).get("content")
        if t == "assistant":
            texts, thinks, tools = [], [], []
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        texts.append(b.get("text", ""))
                    elif b.get("type") == "thinking":
                        thinks.append(b.get("thinking") or b.get("text", ""))
                    elif b.get("type") == "tool_use":
                        tools.append({"name": b.get("name"),
                                      "detail": _tool_detail(b.get("name"), b.get("input"))})
            elif isinstance(content, str):
                texts.append(content)
            pending_think += [x for x in thinks if x.strip()]
            text = "\n".join(texts).strip()
            if text and not text.startswith("<"):
                thinking = "\n\n".join(pending_think).strip()
                pending_think = []
                messages.append({"role": "assistant", "text": cap(text, CHAT_MAX_CHARS),
                                 "ts": rec.get("timestamp"),
                                 "thinking": cap(thinking, THINK_MAX_CHARS) or None})
            for tu in tools:  # each tool call is its own inline entry
                messages.append({"role": "tool", "name": tu["name"],
                                 "detail": tu["detail"], "ts": rec.get("timestamp")})
        else:  # user
            if not isinstance(content, str):
                continue  # tool_result message — not a human turn
            text = content.strip()
            if not text or text.startswith("<"):
                continue
            pending_think = []  # new human turn; drop any orphan thinking
            messages.append({"role": "user", "text": cap(text, CHAT_MAX_CHARS),
                             "ts": rec.get("timestamp"), "thinking": None})
    messages = messages[-CHAT_MAX_MESSAGES:]
    _chat_cache[session_id] = (mtime, messages)
    return messages


def load_todo_md(cwd):
    path = os.path.join(cwd, "tasks", "todo.md")
    try:
        if os.path.getsize(path) > 64 * 1024:
            return None
        with open(path) as f:
            return f.read()
    except Exception:
        return None


def derive_state(registry_status, last_event, transcript_mtime=None, working=None):
    """Display state, with the pane spinner as the ground truth for "working".

    `working` (from pane_status) is True when the pane shows an activity spinner
    or "esc to interrupt", False when it clearly doesn't, None when unknown (no
    pane). Events still distinguish the not-working attention states: a permission
    prompt is needs_input; a finished turn ("waiting for your input"/stop) is
    waiting. Notifications are ignored once the transcript advanced past them."""
    if working:
        return "busy"
    if last_event:
        ev = last_event.get("event")
        ts = last_event.get("ts")
        stale = bool(transcript_mtime and ts and transcript_mtime > ts + 45)
        if ev == "notification" and not stale:
            msg = (last_event.get("message") or "").lower()
            if "permission" in msg or "approval" in msg or "approve" in msg:
                return "needs_input"
            return "waiting"
        if ev == "stop" and not stale:
            return "waiting"
    if working is False:
        return "idle"  # pane confirms nothing is running
    return "busy" if registry_status == "busy" else "idle"


def proc_comm(pid):
    try:
        with open(f"/proc/{pid}/comm") as f:
            return f.read().strip()
    except OSError:
        return None


def proc_foreground(pid):
    """True when the process owns its tty's foreground process group. A claude
    that was Ctrl+Z'd (or otherwise left behind a newer one in the same pane)
    fails this — input pasted into the pane would reach a different session."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
    except (OSError, IndexError):
        return False
    return fields[2] == fields[5]  # pgrp == tpgid


_ACTIVITY_RE = re.compile(r"([A-Z][a-zA-Z]+…\s*\([^)]*\))")


def pane_status(target):
    """One pane capture → the live permission mode and the activity line.

    Mode is the bottom status line ('⏵⏵ auto mode on · …'). Activity is the
    spinner line while the agent works ('✽ Ideating… (1m 39s · ↓ 6.2k tokens)').
    Only the bottom line is used for mode so conversation text can't spoof it."""
    result = {"mode": None, "activity": None, "working": None}
    if not target:
        return result
    out = run(["tmux", "capture-pane", "-p", "-t", target, "-S", "-8"])
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if not lines:
        return result
    result["working"] = False
    footer = lines[-1].lower()
    if "accept edits on" in footer:
        result["mode"] = "acceptEdits"
    elif "plan mode on" in footer:
        result["mode"] = "plan"
    elif "auto mode on" in footer:
        result["mode"] = "auto"
    elif "manual mode on" in footer:
        result["mode"] = "default"
    elif "bypass" in footer and " on" in footer:
        result["mode"] = "bypassPermissions"
    for ln in lines:
        m = _ACTIVITY_RE.search(ln)
        if m:
            result["activity"] = m.group(1)
            break
    # "esc to interrupt" or a spinner line means the agent is actively working.
    result["working"] = bool(result["activity"]) or "esc to interrupt" in out.lower()
    return result


def newest_session_id(cwd, since=0):
    """Recover a session id from the newest transcript in the cwd's project dir.
    Transcripts last written before `since` (the process start) are ignored —
    they belong to past conversations that happen to share the cwd."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    d = os.path.join(PROJECTS_DIR, slug)
    best = None
    try:
        for f in os.listdir(d):
            if not f.endswith(".jsonl"):
                continue
            try:
                m = os.path.getmtime(os.path.join(d, f))
            except OSError:
                continue
            if m >= since and (best is None or m > best[0]):
                best = (m, f)
    except OSError:
        return None
    return best[1][:-len(".jsonl")] if best else None


def discover_live_regs(pid_to_pane, seen_pids, seen_sids):
    """Fallback for when ~/.claude/sessions is missing entries (it can be reset
    while sessions keep running): synthesize registry records for live `claude`
    processes that sit in a tmux pane, recovering the session id from the
    newest transcript in their cwd."""
    uid = os.getuid()
    seen_sids = set(seen_sids)
    out = []
    for pid in pid_to_pane:
        if pid in seen_pids or proc_comm(pid) != "claude":
            continue
        if not proc_foreground(pid):
            continue
        try:
            st = os.stat(f"/proc/{pid}")
            if st.st_uid != uid:
                continue
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        sid = newest_session_id(cwd, since=st.st_mtime)
        if sid in seen_sids:
            continue
        recent = False
        if sid:
            try:
                recent = time.time() - os.path.getmtime(transcript_path(cwd, sid)) < 8
            except OSError:
                pass
        else:
            sid = f"new-{pid}"  # fresh conversation: no transcript on disk yet
        seen_sids.add(sid)
        out.append({"pid": pid, "sessionId": sid, "cwd": cwd,
                    "status": "busy" if recent else "idle",
                    "name": os.path.basename(cwd.rstrip("/")) or cwd,
                    "nameSource": "derived", "statusUpdatedAt": None,
                    "startedAt": st.st_mtime})
    return out


def build_agent(reg, pid_to_pane):
    sid = reg.get("sessionId", "")
    cwd = reg.get("cwd", "")
    pane = pid_to_pane.get(reg["pid"])
    tasks = load_tasks(sid)
    last_event, _ = load_events(sid)
    tinfo = tail_transcript(cwd, sid)
    chat_msgs = load_chat(cwd, sid)
    last_user = next((m["text"] for m in reversed(chat_msgs) if m["role"] == "user"), None)
    last_asst = next((m["text"] for m in reversed(chat_msgs) if m["role"] == "assistant"), None)
    # The most recent user + assistant messages, kept in transcript order so the
    # older one shows above the newer one (chat order).
    lu_i = max((i for i, m in enumerate(chat_msgs) if m["role"] == "user"), default=None)
    la_i = max((i for i, m in enumerate(chat_msgs) if m["role"] == "assistant"), default=None)
    last_exchange = [{"role": chat_msgs[i]["role"], "text": chat_msgs[i]["text"],
                      "ts": chat_msgs[i].get("ts"),
                      "thinking": (chat_msgs[i].get("thinking") or "")[:2500] or None}
                     for i in sorted(i for i in (lu_i, la_i) if i is not None)]
    pstatus = pane_status(pane["target"]) if pane else {"mode": None, "activity": None, "working": None}
    state = derive_state(reg.get("status"), last_event, tinfo["mtime"], pstatus["working"])
    notif_msg = None
    if last_event and last_event.get("event") == "notification" and state in ("needs_input", "waiting"):
        notif_msg = last_event.get("message")
    ctx_tokens = tinfo["context_tokens"]
    ctx_model = (tinfo["context_breakdown"] or {}).get("model")
    ctx_window = context_window_for(ctx_model, ctx_tokens)
    in_progress = [t for t in tasks if t["status"] == "in_progress"]
    status = load_agent_status(sid)
    # Display name: agent-chosen > user rename > AI topic title > derived id
    if status and status.get("name"):
        display_name = status["name"]
    elif reg.get("name") and reg.get("nameSource") not in (None, "derived"):
        display_name = reg["name"]
    elif tinfo["title"]:
        display_name = tinfo["title"]
    else:
        display_name = reg.get("name")
    return {
        "pid": reg["pid"],
        "sessionId": sid,
        "name": reg.get("name"),
        "display_name": (display_name or "")[:60] or reg.get("name"),
        "cwd": cwd,
        "project": os.path.basename(cwd.rstrip("/")) or cwd,
        "state": state,
        "registry_status": reg.get("status"),
        "statusUpdatedAt": reg.get("statusUpdatedAt"),
        "startedAt": reg.get("startedAt"),
        "tmux": pane,
        "tasks": tasks,
        "current_task": in_progress[0]["activeForm"] if in_progress else None,
        "notification": notif_msg,
        "last_event_ts": (last_event or {}).get("ts"),
        "title": tinfo["title"],
        "last_assistant": last_asst or tinfo["last_assistant"],
        "last_prompt": last_user or tinfo["last_prompt"],
        "last_exchange": last_exchange,
        "transcript_mtime": tinfo["mtime"],
        "context_tokens": ctx_tokens,
        "context_window": ctx_window if ctx_tokens else None,
        "context_breakdown": tinfo["context_breakdown"],
        "permission_mode": pstatus["mode"] or tinfo["permission_mode"],
        "activity": pstatus["activity"] if state == "busy" else None,
        "pending_tool": tinfo["pending_tool"] if state == "needs_input" else None,
        "agent_status": status,
        "todo_md": load_todo_md(cwd),
    }


def build_state():
    pid_to_pane = tmux_pane_index()
    regs = []
    seen_pids, seen_sids = set(), set()
    if os.path.isdir(SESSIONS_DIR):
        for name in os.listdir(SESSIONS_DIR):
            if not name.endswith(".json"):
                continue
            reg = read_json(os.path.join(SESSIONS_DIR, name))
            if not reg or not pid_alive(reg.get("pid", -1)):
                continue
            # The registry also holds daemon-hosted background copies of past
            # conversations (claude bg-spare / bg-pty-host children) and claudes
            # suspended behind a newer one in the same pane. Neither can receive
            # input, so only a pane's foreground process counts as an agent —
            # but keep their pids/sids so discovery can't reattribute them.
            seen_pids.add(reg["pid"])
            seen_sids.add(reg.get("sessionId"))
            if reg["pid"] in pid_to_pane and proc_foreground(reg["pid"]):
                regs.append(reg)
    regs.extend(discover_live_regs(pid_to_pane, seen_pids, seen_sids))
    agents = [build_agent(reg, pid_to_pane) for reg in regs]
    # Stable identity sort; the frontend groups by attention state.
    agents.sort(key=lambda a: (a["project"] or "", a["name"] or ""))
    spawn_dir = os.path.join(HOME, "projects")
    if not os.path.isdir(spawn_dir):
        spawn_dir = HOME
    return {"agents": agents, "generated_at": time.time(),
            "spawn_dir": spawn_dir + "/"}


_cache = {"t": 0.0, "state": None}
_cache_lock = threading.Lock()


def cached_state():
    with _cache_lock:
        if time.time() - _cache["t"] > 0.5:
            _cache["state"] = build_state()
            _cache["t"] = time.time()
        return _cache["state"]


def valid_pane(target):
    if not re.fullmatch(r"[\w.-]+:\d+\.\d+", target):
        return False
    out = run(["tmux", "list-panes", "-a", "-F",
               "#{session_name}:#{window_index}.#{pane_index}"])
    return target in out.split()


def send_text(target, text):
    """Paste a message into the agent's composer and submit it."""
    if not valid_pane(target):
        return False, "unknown pane"
    if not text.strip():
        return False, "empty message"
    try:
        subprocess.run(["tmux", "load-buffer", "-b", "claude-agent-manager", "-"],
                       input=text.encode(), timeout=5, check=True)
        subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "claude-agent-manager",
                        "-t", target], timeout=5, check=True)
        time.sleep(0.35)  # let the composer settle so Enter isn't swallowed
        subprocess.run(["tmux", "send-keys", "-t", target, "Enter"],
                       timeout=5, check=True)
    except Exception as e:
        return False, str(e)
    return True, "sent"


ALLOWED_KEYS = {"Enter", "Escape", "Up", "Down", "1", "2", "3", "y", "n"}


def send_key(target, key):
    """Send a single key (answer permission prompts, interrupt, ...)."""
    if not valid_pane(target):
        return False, "unknown pane"
    if key not in ALLOWED_KEYS:
        return False, "key not allowed"
    try:
        subprocess.run(["tmux", "send-keys", "-t", target, key],
                       timeout=5, check=True)
    except Exception as e:
        return False, str(e)
    return True, "sent"


def kill_session(session_id):
    """Terminate a tracked agent. Claude Code catches SIGTERM, so kill the tmux
    pane it runs in (removes the pane + SIGHUPs its processes) and SIGKILL the
    process as a backstop."""
    agent = next((a for a in cached_state()["agents"]
                  if a["sessionId"] == session_id), None)
    if not agent:
        return False, "unknown session"
    pid = agent["pid"]
    # Guard: only touch a process we own.
    try:
        owned = os.stat(f"/proc/{pid}").st_uid == os.getuid()
    except OSError:
        owned = False
    pane = agent.get("tmux")
    killed = None
    if pane and valid_pane(pane["target"]):
        r = subprocess.run(["tmux", "kill-pane", "-t", pane["target"]],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            killed = "killed pane " + pane["target"]
        elif not owned:
            return False, (r.stderr.strip() or "tmux kill-pane failed")
    if owned and pid_alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
            killed = killed or "killed process"
        except OSError as e:
            if not killed:
                return False, str(e)
    if not killed:
        return False, "nothing to kill (no pane, not our process)"
    _cache["t"] = 0.0  # force a fresh state on next poll
    return True, killed


def spawn_session(cwd, prompt, name=None):
    """Launch `claude` in a new detached tmux session at cwd."""
    cwd = os.path.expanduser(cwd or "").strip()
    if not cwd or not os.path.isdir(cwd):
        return False, "directory not found"
    requested = re.sub(r"[^A-Za-z0-9_-]", "-", (name or "").strip()).strip("-")
    base = requested or re.sub(r"[^A-Za-z0-9_-]",
                               "-", os.path.basename(cwd.rstrip("/")) or "agent")
    existing = set(run(["tmux", "list-sessions", "-F", "#{session_name}"]).split())
    name = base
    i = 2
    while name in existing:
        name = f"{base}-{i}"
        i += 1
    try:
        # -P -F prints the new pane's id (base-index independent, e.g. "%42").
        pane = subprocess.run(
            ["tmux", "new-session", "-d", "-s", name, "-c", cwd,
             "-P", "-F", "#{pane_id}"],
            capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        subprocess.run(["tmux", "send-keys", "-t", pane, "claude", "Enter"],
                       timeout=5, check=True)
        if prompt and prompt.strip():
            time.sleep(2.5)  # let claude boot before sending the first message
            subprocess.run(["tmux", "load-buffer", "-b", "claude-agent-manager", "-"],
                           input=prompt.encode(), timeout=5, check=True)
            subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "claude-agent-manager",
                            "-t", pane], timeout=5, check=True)
            time.sleep(0.35)
            subprocess.run(["tmux", "send-keys", "-t", pane, "Enter"],
                           timeout=5, check=True)
    except Exception as e:
        return False, str(e)
    return True, name


def focus_pane(target):
    """Jump the most recently active tmux client to the given pane."""
    if not re.fullmatch(r"[\w.-]+:\d+\.\d+", target):
        return False, "bad target"
    clients = run(["tmux", "list-clients", "-F", "#{client_name}\t#{client_activity}"])
    best = None
    for line in clients.splitlines():
        parts = line.split("\t")
        if len(parts) == 2:
            if best is None or int(parts[1]) > best[1]:
                best = (parts[0], int(parts[1]))
    if not best:
        return False, "no attached tmux client"
    sess = target.split(":")[0]
    run(["tmux", "switch-client", "-c", best[0], "-t", sess])
    run(["tmux", "select-window", "-t", target.rsplit(".", 1)[0]])
    run(["tmux", "select-pane", "-t", target])
    return True, "ok"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        supplied = (self.headers.get("X-Auth-Token")
                    or parse_qs(urlparse(self.path).query).get("token", [""])[0])
        return hmac.compare_digest(supplied.encode(), AUTH_TOKEN.encode())

    def do_GET(self):
        route = urlparse(self.path).path
        if route.startswith("/api/"):
            if not self._authed():
                self._send(401, {"error": "unauthorized"})
                return
            if route == "/api/state":
                self._send(200, cached_state())
                return
            if route == "/api/chat":
                sid = parse_qs(urlparse(self.path).query).get("sid", [""])[0]
                agent = next((a for a in cached_state()["agents"]
                              if a["sessionId"] == sid), None)
                self._send(*( (404, {"error": "unknown session"}) if not agent
                             else (200, {"messages": load_chat(agent["cwd"], sid)}) ))
                return
            self._send(404, {"error": "not found"})
            return
        # Static assets carry no secrets, so they load without the token — the
        # page bootstraps, then reads the token from its URL fragment for /api/*.
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        fpath = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if fpath.startswith(WEB_DIR + os.sep) and os.path.isfile(fpath):
            ctype = {"html": "text/html", "js": "text/javascript",
                     "css": "text/css"}.get(fpath.rsplit(".", 1)[-1],
                                            "application/octet-stream")
            with open(fpath, "rb") as f:
                self._send(200, f.read(), ctype)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            self._send(401, {"error": "unauthorized"})
            return
        actions = {"/api/focus": lambda b: focus_pane(b.get("target", "")),
                   "/api/send": lambda b: send_text(b.get("target", ""),
                                                    b.get("text", "")),
                   "/api/key": lambda b: send_key(b.get("target", ""),
                                                  b.get("key", "")),
                   "/api/kill": lambda b: kill_session(b.get("sid", "")),
                   "/api/spawn": lambda b: spawn_session(b.get("cwd", ""),
                                                         b.get("prompt", ""),
                                                         b.get("name", ""))}
        action = actions.get(self.path)
        if not action:
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            ok, msg = action(json.loads(self.rfile.read(length)))
        except Exception as e:
            ok, msg = False, str(e)
        self._send(200 if ok else 400, {"ok": ok, "msg": msg})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8842)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--context-window", type=int, default=0,
                    help="Force the context window in tokens (0 = auto from settings.json)")
    ap.add_argument("--token", default=os.environ.get("CAM_TOKEN", ""),
                    help="Access token (env CAM_TOKEN; a random one is generated if unset)")
    args = ap.parse_args()
    global CONTEXT_WINDOW_OVERRIDE, AUTH_TOKEN
    CONTEXT_WINDOW_OVERRIDE = args.context_window
    AUTH_TOKEN = args.token or secrets.token_urlsafe(18)
    os.makedirs(EVENTS_DIR, exist_ok=True)
    os.makedirs(STATUS_DIR, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"claude-agent-manager on http://{args.host}:{args.port}/#{AUTH_TOKEN}", flush=True)
    print("Open the URL above (the #token part is required).", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
