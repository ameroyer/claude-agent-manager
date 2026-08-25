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
import datetime
import hmac
import json
import os
import re
import secrets
import signal
import subprocess
import tempfile
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
NAMES_FILE = os.path.join(CLAUDE_DIR, "agent-manager-names.json")
ARTIFACTS_FILE = os.path.join(CLAUDE_DIR, "agent-manager-artifacts.json")
SPAWNS_FILE = os.path.join(CLAUDE_DIR, "agent-manager-spawns.json")
CLAUDE_CONFIG = os.path.join(HOME, ".claude.json")
# realpath, not abspath: installed into a venv (uvx/pip) any parent may be a
# symlink, and the static-file guard below compares against a realpath'd
# candidate — a mismatch there would 404 every asset.
WEB_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))

TRANSCRIPT_TAIL_BYTES = 256 * 1024
CHAT_TAIL_BYTES = 2 * 1024 * 1024
CHAT_MAX_MESSAGES = 150
CHAT_MAX_CHARS = 20000
THINK_MAX_CHARS = 8000
# Card/Overview preview of the latest turn. The full conversation is served
# separately by /api/chat, so this only has to be enough to read at a glance.
EXCHANGE_PREVIEW_CHARS = 2000
# Upper bound on a request body. Every endpoint takes a small JSON object; the
# largest realistic payload is a typed message.
MAX_BODY_BYTES = 1024 * 1024


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


def iso_to_epoch(ts):
    """'2026-08-18T10:27:34.598Z' -> epoch seconds, or None."""
    if not isinstance(ts, str):
        return None
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


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
    """Most recent hook event for a session, or None."""
    path = os.path.join(EVENTS_DIR, f"{session_id}.jsonl")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 16384))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return None
    for line in reversed(lines):
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if "event" in ev:
            return ev
    return None


def transcript_path(cwd, session_id):
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    return os.path.join(PROJECTS_DIR, slug, f"{session_id}.jsonl")


def transcript_title(path):
    """ai-title records are written early in the transcript — scan the head."""
    try:
        with open(path, "rb") as f:
            head = f.read(64 * 1024).decode("utf-8", "replace")
    except OSError:
        return None
    for line in head.splitlines():
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") == "ai-title":
            return rec.get("aiTitle") or rec.get("title")
    return None


def list_resumable(cwd):
    """Past conversations for a cwd, newest first, for `claude --resume`."""
    cwd = os.path.expanduser((cwd or "").strip()).rstrip("/") or "/"
    d = os.path.join(PROJECTS_DIR, re.sub(r"[^A-Za-z0-9]", "-", cwd))
    live = {a["sessionId"] for a in cached_state()["agents"]}
    out = []
    try:
        names = [f for f in os.listdir(d) if f.endswith(".jsonl")]
    except OSError:
        return []
    for f in names:
        p = os.path.join(d, f)
        try:
            m = os.path.getmtime(p)
        except OSError:
            continue
        out.append({"sid": f[:-len(".jsonl")], "mtime": m})
    out.sort(key=lambda s: -s["mtime"])
    out = out[:20]  # titles need a head-read each; cap the work
    for s in out:
        s["title"] = transcript_title(os.path.join(d, s["sid"] + ".jsonl"))
        s["live"] = s["sid"] in live
    return out


_tail_cache = {}


def tail_transcript(cwd, session_id):
    """Return dict with last assistant text, last user prompt, title, mtime.
    Cached by transcript mtime so a fast poll doesn't re-read the tail."""
    path = transcript_path(cwd, session_id)
    info = {"last_assistant": None, "last_prompt": None, "title": None,
            "mtime": None, "context_tokens": None, "context_breakdown": None,
            "permission_mode": None, "pending_tool": None, "last_activity": None,
            "last_assistant_ts": None, "last_prompt_ts": None, "subagents": [],
            "spawned": []}
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
        info["title"] = transcript_title(path)
    for line in reversed(lines):
        if (info["last_assistant"] and info["last_prompt"] and info["title"]
                and info["permission_mode"] and info["last_activity"]):
            break
        try:
            rec = json.loads(line)
        except Exception:
            continue
        # Newest record that carries a real timestamp = when this conversation
        # last actually moved. The file's own mtime does NOT mean that: Claude
        # Code rewrites bookkeeping records (last-prompt, ai-title, mode,
        # permission-mode — none of them timestamped) long after the last
        # exchange, which floated week-old sessions to the top of the board.
        if info["last_activity"] is None and rec.get("timestamp"):
            info["last_activity"] = iso_to_epoch(rec["timestamp"])
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
                    info["last_assistant"] = " ".join(texts)[:EXCHANGE_PREVIEW_CHARS]
                    info["last_assistant_ts"] = rec.get("timestamp")
        elif t == "user" and not info["last_prompt"]:
            content = (rec.get("message") or {}).get("content")
            if isinstance(content, list):  # some human turns are text-block lists
                content = "\n".join(b.get("text", "") for b in content
                                    if isinstance(b, dict) and b.get("type") == "text")
            if isinstance(content, str) and content.strip() and \
                    not content.startswith("<") and "tool_result" not in line[:200]:
                info["last_prompt"] = content[:EXCHANGE_PREVIEW_CHARS]
                info["last_prompt_ts"] = rec.get("timestamp")
        elif t == "ai-title" and not info["title"]:
            info["title"] = rec.get("aiTitle") or rec.get("title")
        elif t == "last-prompt" and not info["last_prompt"]:
            p = rec.get("prompt") or rec.get("text")
            if p and p.strip():
                info["last_prompt"] = p[:EXCHANGE_PREVIEW_CHARS]
        elif t == "permission-mode" and not info["permission_mode"]:
            info["permission_mode"] = rec.get("permissionMode")
    info.update(scan_tool_calls(lines))
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


SUBAGENT_TOOLS = ("Task", "Agent")
# `tmux new-session -d -s foo -c /dir` / `tmux new -s foo`. A session an agent
# launched this way is a real, independent Claude — it gets its own pane, its
# own transcript and its own card — so this is how the board recovers who
# started it.
_NEW_SESSION_RE = re.compile(
    r"""tmux\s+new(?:-session)?\b[^\n;|&]*?-s[=\s]\s*["']?([A-Za-z0-9_.-]+)""", re.X)
MAX_SUBAGENTS = 6


def scan_tool_calls(lines):
    """One pass over the tail → the tool awaiting approval, the sub-agents this
    session spawned, and the tmux sessions it launched. Returned as a dict so
    another signal doesn't grow a tuple.

    A tool_use with no matching tool_result is still awaiting run/approval;
    that same pairing tells us which sub-agents are still going.

    Sub-agents run *inside* the parent process: they get no pid, no registry
    entry, no tmux pane and no transcript of their own, so they can never be a
    card on the board. The parent's transcript is the only place they exist,
    which is why they are reported as part of the parent."""
    uses, resolved = {}, set()
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
    spawned = []
    for name, inp in uses.values():
        cmd = (inp or {}).get("command") if isinstance(inp, dict) else None
        if isinstance(cmd, str) and "tmux" in cmd:
            spawned += _NEW_SESSION_RE.findall(cmd)
    pending = [nv for tid, nv in uses.items() if tid not in resolved]
    tool = None
    if pending:
        name, inp = pending[-1]
        tool = {"name": name, "detail": _tool_detail(name, inp)}
    subs = []
    for tid, (name, inp) in uses.items():
        if name in SUBAGENT_TOOLS:
            d = inp if isinstance(inp, dict) else {}
            subs.append({"type": d.get("subagent_type") or "agent",
                         "task": str(d.get("description") or "")[:80],
                         "running": tid not in resolved})
    return {"pending_tool": tool, "subagents": subs[-MAX_SUBAGENTS:],
            "spawned": spawned}


_config_cache = {"mtime": None, "cfg": {}}


def claude_config():
    """~/.claude.json, re-read only when it changes — it is ~100 KB and every
    agent would otherwise re-parse it on every poll."""
    try:
        mtime = os.path.getmtime(CLAUDE_CONFIG)
    except OSError:
        return {}
    if _config_cache["mtime"] != mtime:
        _config_cache.update(mtime=mtime, cfg=read_json(CLAUDE_CONFIG) or {})
    return _config_cache["cfg"]


MCP_SCAN_BYTES = 512 * 1024
MCP_STATE_TTL = 60
_mcp_state_cache = {}


def connected_mcp(cwd, session_id):
    """Servers whose tools are actually exposed to this session.

    Config can only say "enabled". Claude Code records real tool availability as
    `deferred_tools_delta` attachments naming `mcp__<server>__<tool>`, which is
    the only evidence a server actually connected — and it also catches servers
    that never appear in ~/.claude.json, such as the claude.ai-connected ones.

    Tools are tracked individually: `removedNames` drops one tool, not a whole
    server, so a server counts as connected while any of its tools remain."""
    hit = _mcp_state_cache.get(session_id)
    if hit and time.time() - hit[0] < MCP_STATE_TTL:
        return hit[1]
    try:
        with open(transcript_path(cwd, session_id), "rb") as f:
            blob = f.read(MCP_SCAN_BYTES).decode("utf-8", "replace")
    except OSError:
        blob = ""
    tools = set()
    for line in blob.splitlines():
        if "deferred_tools_delta" not in line:
            continue
        try:
            att = json.loads(line).get("attachment") or {}
        except Exception:
            continue
        for name in (att.get("addedNames") or []) + (att.get("readdedNames") or []):
            tools.add(str(name))
        for name in att.get("removedNames") or []:
            tools.discard(str(name))
    live = {t.split("__")[1] for t in tools
            if t.startswith("mcp__") and len(t.split("__")) >= 3}
    _mcp_state_cache[session_id] = (time.time(), live)
    return live


def mcp_servers(cwd, session_id):
    """Every MCP server this session knows about, and whether it is usable.

    Only the name and a status — a server's env, args and URL routinely carry
    API keys, and none of them are read or returned."""
    cfg = claude_config()
    proj = (cfg.get("projects") or {}).get(cwd) or {}
    disabled = set(proj.get("disabledMcpServers") or [])
    disabled |= set(proj.get("disabledMcpjsonServers") or [])
    live = connected_mcp(cwd, session_id)
    names = set(cfg.get("mcpServers") or {}) | set(proj.get("mcpServers") or {}) | live
    out = []
    for name in sorted(names, key=str.lower):
        status = ("disabled" if name in disabled
                  else "connected" if name in live else "configured")
        out.append({"name": name, "status": status})
    return out


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
            # Content is usually a plain string, but Claude Code also writes
            # some human turns as a [{"type":"text"}] list. Treating those as
            # "not a human turn" silently dropped them from the chat.
            if isinstance(content, list):
                if any(isinstance(b, dict) and b.get("type") == "tool_result"
                       for b in content):
                    continue  # tool output, not a human turn
                text = "\n".join(b.get("text", "") for b in content
                                 if isinstance(b, dict) and b.get("type") == "text").strip()
            elif isinstance(content, str):
                text = content.strip()
            else:
                continue
            if not text or text.startswith("<"):
                continue
            pending_think = []  # new human turn; drop any orphan thinking
            messages.append({"role": "user", "text": cap(text, CHAT_MAX_CHARS),
                             "ts": rec.get("timestamp"), "thinking": None})
    messages = messages[-CHAT_MAX_MESSAGES:]
    _chat_cache[session_id] = (mtime, messages)
    return messages


ART_EXTS = (".md", ".txt")
BROWSE_MAX = 60
ART_MAX_BYTES = 256 * 1024
ART_MAX_FILES = 60


def artifact_sources(cwd, session_id):
    """Files/folders to surface for a session: whatever the user pinned, plus
    the conventional <cwd>/tasks/todo.md so it keeps working out of the box."""
    pinned = (read_json(ARTIFACTS_FILE) or {}).get(session_id) or []
    default = os.path.join(cwd, "tasks", "todo.md") if cwd else None
    out = list(pinned)
    if default and default not in out:
        out.append(default)
    return out


def list_artifacts(cwd, session_id):
    """Expand each source into readable .md/.txt files, newest first."""
    files, seen = [], set()
    for src in artifact_sources(cwd, session_id):
        src = os.path.expanduser(src)
        paths = []
        if os.path.isdir(src):
            try:
                paths = [os.path.join(src, n) for n in sorted(os.listdir(src))
                         if n.lower().endswith(ART_EXTS)]
            except OSError:
                paths = []
        elif src.lower().endswith(ART_EXTS):
            paths = [src]
        for p in paths[:ART_MAX_FILES]:
            rp = os.path.realpath(p)
            if rp in seen or not os.path.isfile(rp):
                continue
            seen.add(rp)
            try:
                st = os.stat(rp)
            except OSError:
                continue
            files.append({"path": rp, "name": os.path.basename(rp),
                          "mtime": st.st_mtime, "size": st.st_size})
    files.sort(key=lambda f: -f["mtime"])
    return files[:ART_MAX_FILES]


def browse_paths(prefix):
    """Completions for the artifact picker: sub-directories and .md/.txt files
    matching what has been typed so far.

    Read-only and listing-only, and it widens nothing: pin_artifact already
    accepts any path, so anything listed here was already reachable. Hidden
    entries stay hidden unless explicitly typed."""
    prefix = os.path.expanduser(prefix or "")
    ends_in_sep = prefix.endswith(os.sep)
    base = (prefix if ends_in_sep else os.path.dirname(prefix)) or "."
    head = "" if ends_in_sep else os.path.basename(prefix)
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return []
    out = []
    for n in names:
        if n.startswith(".") and not head.startswith("."):
            continue
        if head and not n.lower().startswith(head.lower()):
            continue
        full = os.path.join(base, n)
        if os.path.isdir(full):
            out.append(full + os.sep)
        elif n.lower().endswith(ART_EXTS):
            out.append(full)
        if len(out) >= BROWSE_MAX:
            break
    return out


def read_artifact(cwd, session_id, path):
    """Read one artifact. The path must be one this session actually exposes —
    that whitelist is what keeps the endpoint from reading arbitrary files."""
    allowed = {f["path"] for f in list_artifacts(cwd, session_id)}
    rp = os.path.realpath(os.path.expanduser(path or ""))
    if rp not in allowed:
        return None, "not an artifact of this session"
    try:
        if os.path.getsize(rp) > ART_MAX_BYTES:
            return None, "file too large (>256 KB)"
        with open(rp, errors="replace") as f:
            return f.read(), None
    except OSError as e:
        return None, str(e)


def pin_artifact(session_id, path, remove=False):
    """Add/remove a file or folder from a session's artifact sources."""
    if not session_id:
        return False, "no session"
    path = os.path.expanduser((path or "").strip())
    if not remove:
        if not (os.path.isdir(path) or path.lower().endswith(ART_EXTS)):
            return False, "pick a .md/.txt file or a folder"
        if not os.path.exists(path):
            return False, "path not found"
    cfg = read_json(ARTIFACTS_FILE) or {}
    cur = [p for p in (cfg.get(session_id) or []) if p != path]
    if not remove:
        cur.append(path)
    if cur:
        cfg[session_id] = cur
    else:
        cfg.pop(session_id, None)
    try:
        with open(ARTIFACTS_FILE + ".tmp", "w") as f:
            json.dump(cfg, f)
        os.replace(ARTIFACTS_FILE + ".tmp", ARTIFACTS_FILE)
    except OSError as e:
        return False, str(e)
    return True, ("removed" if remove else "added") + " " + path


def derive_state(registry_status, last_event, transcript_mtime=None, working=None,
                 prompt=None):
    """Display state, with the pane spinner as the ground truth for "working".

    `working` (from pane_status) is True when the pane shows an activity spinner
    or "esc to interrupt", False when it clearly doesn't, None when unknown (no
    pane). Events still distinguish the not-working attention states: a permission
    prompt is needs_input; a finished turn ("waiting for your input"/stop) is
    waiting. Notifications are ignored once the transcript advanced past them."""
    if prompt:
        return "needs_input"  # the pane is literally showing a menu
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


def proc_start_time(pid):
    """True process start as epoch seconds (field 22 of /proc/<pid>/stat).
    The /proc dir's own mtime is NOT the start time and must not be used."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            ticks = float(f.read().rsplit(")", 1)[1].split()[19])
        with open("/proc/uptime") as f:
            uptime = float(f.read().split()[0])
        return time.time() - (uptime - ticks / os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError, IndexError):
        return None


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
_OPTION_RE = re.compile(r"^(?P<lead>[\s│>❯]*)(?P<key>\d)\.\s+(?P<label>.+?)\s*$")
# Every blocking dialog Claude Code draws ends with this hint line.
_DIALOG_HINT_RE = re.compile(r"esc to cancel", re.I)
# A dialog always sits at the foot of the pane; a numbered list in the
# conversation generally does not.
PROMPT_TAIL_LINES = 12


# The step bar a multi-question AskUserQuestion draws above its options:
#   \u2190  \u2612 Editor  \u2610 Shell  \u2714 Submit  \u2192
# \u2612 answered, \u2610 still to answer, \u2714 the final submit step.
_FORM_MARKS = "\u2610\u2612\u2714"
_FORM_STEP_RE = re.compile("([%s])\\s*([^%s\u2190\u2192]+)" % (_FORM_MARKS, _FORM_MARKS))


def form_steps(lines):
    """Steps of a multi-question form, or [] for an ordinary single menu.

    Answering one question advances to the next, so one click is rarely the
    whole interaction. Without this the menu silently turns into a different
    question and it looks like the click did nothing."""
    for line in reversed(lines[-(PROMPT_TAIL_LINES + 6):]):
        if "\u2714" in line and ("\u2610" in line or "\u2612" in line):
            steps = [{"label": label.strip()[:24], "done": mark == "\u2612"}
                     for mark, label in _FORM_STEP_RE.findall(line) if label.strip()]
            if len(steps) >= 2:
                return steps
    return []


def detect_prompt(lines):
    """Read whatever blocking menu the pane is showing.

    Hooks are optional, so the dialog itself — a question plus numbered
    options — is the ground truth for "this agent is waiting on you".

    It must stay strict, or an ordinary numbered list in the conversation
    reads as a dialog. The original rule ("some option says yes") was strict
    but far too narrow: it only ever matched permission prompts, so an
    AskUserQuestion menu ("1. Red / 2. Green / …") left the agent showing as
    *idle* while it sat blocked, and you had to go to the terminal. So accept
    any of three independent dialog tells, all absent from prose: the ❯
    selection cursor, the "Esc to cancel" hint line, or a yes-ish option."""
    opts, cursor, last_at = {}, False, -1
    for i, ln in enumerate(lines):
        m = _OPTION_RE.match(ln)
        if m:
            opts[m.group("key")] = m.group("label")[:60]
            cursor = cursor or "❯" in m.group("lead")
            last_at = i
    keys = sorted(opts)
    if len(keys) < 2 or keys != [str(i) for i in range(1, len(keys) + 1)]:
        return None
    if last_at < len(lines) - PROMPT_TAIL_LINES:
        return None  # too far up the pane to be a live dialog
    has_yes = any("yes" in v.lower() for v in opts.values())
    hint = any(_DIALOG_HINT_RE.search(ln) for ln in lines[-PROMPT_TAIL_LINES:])
    if not (cursor or hint or has_yes):
        return None
    question = None
    for ln in lines:  # last text line before the options is the question
        if _OPTION_RE.match(ln):
            break
        if ln.strip():
            question = ln.strip()[:160]
    return {"question": question, "steps": form_steps(lines),
            "options": [{"key": k, "label": opts[k]} for k in keys]}


# Footer text → permission mode, most specific first ("accept edits on" must be
# tested before the looser bypass check).
_MODE_FOOTERS = (("accept edits on", "acceptEdits"),
                 ("plan mode on", "plan"),
                 ("auto mode on", "auto"),
                 ("manual mode on", "default"))
# The footer is followed by the live agent roster when sub-agents are running,
# so the scan has to reach past a parent line plus a few sub-agent rows.
FOOTER_SCAN_LINES = 10


def footer_mode(lines):
    """Permission mode from the pane's status footer, or None.

    The footer is NOT reliably the last line: Claude Code renders extra rows
    under it — "new task? /clear to save 488.4k tokens" once a session has used
    a lot of context, an attached-file indicator, and so on. Reading only
    lines[-1] therefore returned None on exactly the long-running sessions you
    most want to retune, and /api/mode refused with "can't read the permission
    mode from the pane".

    Scanning bottom-up over the last few rows keeps the anti-spoofing property
    that motivated the original single-line rule — the real footer always sits
    below the conversation, so it is always reached first."""
    for ln in reversed(lines[-FOOTER_SCAN_LINES:]):
        low = ln.lower()
        for needle, mode in _MODE_FOOTERS:
            if needle in low:
                return mode
        if "bypass" in low and " on" in low:
            return "bypassPermissions"
    return None


# The live agent roster Claude Code draws under the footer while sub-agents run:
#   ● main
#   ◯ general-purpose  Write vim history essay
# "●" is the parent session, "◯" each running sub-agent.
# \u25cf "●" parent, \u25ef "◯" a running sub-agent (\u25cb kept as a variant).
_ROSTER_RE = re.compile(
    r"^\s*[\u25cf\u25ef\u25cb]\s+(?P<type>\S+)(?:\s{2,}(?P<task>.+?))?\s*$")


def roster_subagents(lines):
    """Sub-agents running right now, read off the pane's agent roster.

    The transcript can't answer this: Claude Code only writes a Task's tool_use
    record once the sub-agent has finished, so by the time a sub-agent is
    visible there it is already done. The roster is the only live view."""
    out = []
    for ln in lines[-FOOTER_SCAN_LINES:]:
        m = _ROSTER_RE.match(ln)
        if m and m.group("type") != "main":
            out.append({"type": m.group("type")[:40],
                        "task": (m.group("task") or "").strip()[:80],
                        "running": True})
    return out[:MAX_SUBAGENTS]


def pane_status(target):
    """One pane capture → the live permission mode and the activity line.

    Mode comes from the bottom status footer ('⏵⏵ auto mode on · …'). Activity
    is the spinner line while the agent works ('✽ Ideating… (1m 39s · ↓ 6.2k)')."""
    result = {"mode": None, "activity": None, "working": None, "prompt": None,
              "subagents": []}
    if not target:
        return result
    out = run(["tmux", "capture-pane", "-p", "-t", target, "-S", "-20"])
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if not lines:
        return result
    result["working"] = False
    result["mode"] = footer_mode(lines)
    for ln in lines:
        m = _ACTIVITY_RE.search(ln)
        if m:
            result["activity"] = m.group(1)
            break
    # "esc to interrupt" or a spinner line means the agent is actively working.
    result["working"] = bool(result["activity"]) or "esc to interrupt" in out.lower()
    result["prompt"] = detect_prompt(lines)
    result["subagents"] = roster_subagents(lines)
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
        started = proc_start_time(pid) or st.st_mtime
        sid = newest_session_id(cwd, since=started)
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
                    "startedAt": started})
    return out


_git_cache = {}


def canonical_repo(cwd, toplevel, common_dir):
    """Name of the repository a checkout belongs to.

    A linked worktree has its own toplevel, so using that would call every
    worktree a separate repo — four checkouts of one project got four different
    hats. `git-common-dir` points at the *shared* .git for every worktree of a
    repo, so its parent is the one directory they all agree on."""
    if not common_dir:
        return os.path.basename(toplevel)
    abs_common = os.path.normpath(os.path.join(cwd, common_dir))
    root = (os.path.dirname(abs_common)
            if os.path.basename(abs_common) == ".git" else abs_common)
    return os.path.basename(root) or os.path.basename(toplevel)


def git_info(cwd):
    """{repo, worktree, branch, commit} for cwd's git repo, or None. Cached ~15s
    per cwd so the fast poll doesn't spawn a git process per agent per tick."""
    if not cwd or not os.path.isdir(cwd):
        return None
    now = time.time()
    hit = _git_cache.get(cwd)
    if hit and now - hit[0] < 15:
        return hit[1]
    out = run(["git", "-C", cwd, "rev-parse",
               "--show-toplevel", "--git-common-dir", "--short", "HEAD"]).split()
    info = None
    if len(out) == 3:
        toplevel, common_dir, commit = out
        repo = canonical_repo(cwd, toplevel, common_dir)
        checkout = os.path.basename(toplevel)
        branch = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).strip()
        info = {"repo": repo, "commit": commit, "branch": branch,
                # only set when this is a linked worktree, not the main checkout
                "worktree": checkout if checkout != repo else None}
    _git_cache[cwd] = (now, info)
    return info


def scratchpad_path(cwd, session_id):
    """Best-guess session scratchpad dir, returned only if it actually exists."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    for base in (tempfile.gettempdir(), "/tmp", "/private/tmp"):
        p = os.path.join(base, f"claude-{os.getuid()}", slug, session_id, "scratchpad")
        if os.path.isdir(p):
            return p
    return None


def load_names():
    return read_json(NAMES_FILE) or {}


def set_name(session_id, name):
    """Persist a user-chosen display name for a session (empty clears it)."""
    if not session_id:
        return False, "no session"
    name = (name or "").strip()[:60]
    names = load_names()
    if name:
        names[session_id] = name
    else:
        names.pop(session_id, None)
    try:
        with open(NAMES_FILE + ".tmp", "w") as f:
            json.dump(names, f)
        os.replace(NAMES_FILE + ".tmp", NAMES_FILE)  # atomic — no torn writes
    except Exception as e:
        return False, str(e)
    _cache["t"] = 0.0  # reflect the new name on the next poll
    return True, name or "cleared"


def build_agent(reg, pid_to_pane, names=None):
    sid = reg.get("sessionId", "")
    cwd = reg.get("cwd", "")
    pane = pid_to_pane.get(reg["pid"])
    tasks = load_tasks(sid)
    last_event = load_events(sid)
    tinfo = tail_transcript(cwd, sid)
    # Preview of the latest turn, straight from the tail we already parsed.
    # This used to re-parse the whole 2 MB chat tail per agent per poll just to
    # recover two messages tail_transcript had already found. /api/chat still
    # builds the full conversation, but only for the one card you have open.
    last_exchange = [m for m in (
        {"role": "user", "text": tinfo["last_prompt"], "ts": tinfo["last_prompt_ts"]},
        {"role": "assistant", "text": tinfo["last_assistant"],
         "ts": tinfo["last_assistant_ts"]}) if m["text"]]
    last_exchange.sort(key=lambda m: iso_to_epoch(m["ts"]) or 0)  # chat order
    pstatus = pane_status(pane["target"]) if pane else {
        "mode": None, "activity": None, "working": None, "prompt": None,
        "subagents": []}
    # When the conversation last actually moved. Falls back to the file mtime
    # only when nothing in the tail carried a timestamp.
    last_activity = tinfo["last_activity"] or tinfo["mtime"]
    state = derive_state(reg.get("status"), last_event, last_activity,
                         pstatus["working"], pstatus["prompt"])
    notif_msg = None
    if last_event and last_event.get("event") == "notification" and state in ("needs_input", "waiting"):
        notif_msg = last_event.get("message")
    ctx_tokens = tinfo["context_tokens"]
    ctx_model = (tinfo["context_breakdown"] or {}).get("model")
    ctx_window = context_window_for(ctx_model, ctx_tokens)
    in_progress = [t for t in tasks if t["status"] == "in_progress"]
    status = load_agent_status(sid)
    user_name = (names or {}).get(sid)
    # Display name: user rename > agent-chosen > registry rename > AI title > id
    if user_name:
        display_name = user_name
    elif status and status.get("name"):
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
        "git": git_info(cwd),
        "transcript": transcript_path(cwd, sid) if cwd else None,
        "scratchpad": scratchpad_path(cwd, sid) if cwd else None,
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
        "last_assistant": tinfo["last_assistant"],
        "last_prompt": tinfo["last_prompt"],
        "last_exchange": last_exchange,
        "transcript_mtime": tinfo["mtime"],
        "last_activity": last_activity,
        "context_tokens": ctx_tokens,
        "context_window": ctx_window if ctx_tokens else None,
        "context_breakdown": tinfo["context_breakdown"],
        "permission_mode": pstatus["mode"] or tinfo["permission_mode"],
        "activity": pstatus["activity"] if state == "busy" else None,
        "pending_tool": tinfo["pending_tool"] if state == "needs_input" else None,
        "subagents": pstatus["subagents"] + [x for x in tinfo["subagents"]
                                            if not x["running"]][-3:],
        "_spawned": tinfo["spawned"],
        "mcp": mcp_servers(cwd, sid),
        "prompt": pstatus["prompt"],
        "agent_status": status,
    }


def link_spawns(agents):
    """Attribute each session to whatever launched it.

    tmux daemonises, so a spawned session's process parent is the tmux server,
    not the agent that ran the command — /proc genuinely cannot answer this.
    Two sources that can: the parent's own transcript, which recorded the
    `tmux new-session` it ran, and the dashboard's own spawn log."""
    by_session = {}
    for a in agents:
        if a["tmux"]:
            by_session.setdefault(a["tmux"]["session"], a)
    for a in agents:
        a["spawns"], a["spawned_by"] = [], None
    for a in agents:
        for name in a.pop("_spawned", []):
            child = by_session.get(name)
            if child is not None and child is not a and not child["spawned_by"]:
                child["spawned_by"] = a["display_name"] or a["name"]
                a["spawns"].append(child["display_name"] or child["name"])
    dashboard = read_json(SPAWNS_FILE) or {}
    for a in agents:
        if not a["spawned_by"] and a["tmux"] and a["tmux"]["session"] in dashboard:
            a["spawned_by"] = "dashboard"
    return agents


def record_spawn(session_name):
    """Remember that the dashboard created this tmux session, so its card can
    say so. Pruned to sessions that still exist on every write."""
    live = set(run(["tmux", "list-sessions", "-F", "#{session_name}"]).split())
    cfg = {k: v for k, v in (read_json(SPAWNS_FILE) or {}).items() if k in live}
    cfg[session_name] = "dashboard"
    try:
        with open(SPAWNS_FILE + ".tmp", "w") as f:
            json.dump(cfg, f)
        os.replace(SPAWNS_FILE + ".tmp", SPAWNS_FILE)  # atomic — no torn writes
    except OSError:
        pass


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
    names = load_names()
    agents = link_spawns([build_agent(reg, pid_to_pane, names) for reg in regs])
    # Stable identity sort; the frontend groups by attention state.
    agents.sort(key=lambda a: (a["project"] or "", a["name"] or ""))
    # These caches are keyed by session / cwd and would otherwise keep an entry
    # for every agent ever seen, for the life of the process.
    live_sids = {a["sessionId"] for a in agents}
    live_cwds = {a["cwd"] for a in agents}
    for cache, live in ((_tail_cache, live_sids), (_chat_cache, live_sids),
                        (_mcp_state_cache, live_sids), (_git_cache, live_cwds)):
        for key in [k for k in cache if k not in live]:
            cache.pop(key, None)
    spawn_dir = os.path.join(HOME, "projects")
    if not os.path.isdir(spawn_dir):
        spawn_dir = HOME
    return {"agents": agents, "generated_at": time.time(),
            "spawn_dir": spawn_dir + "/"}


def debug_state():
    """Why is a session (not) on the board? One row per tmux-pane process,
    plus every registry entry with the checks it passed. GET /api/debug."""
    pid_to_pane = tmux_pane_index()
    procs = []
    for pid, pane in pid_to_pane.items():
        comm = proc_comm(pid)
        if comm is None or (comm != "claude" and pid != pane["pid"]):
            continue  # only claudes + each pane's root process — keep it readable
        row = {"pid": pid, "comm": comm, "pane": pane["target"],
               "foreground": proc_foreground(pid)}
        try:
            row["cwd"] = os.readlink(f"/proc/{pid}/cwd")
            row["uid_ok"] = os.stat(f"/proc/{pid}").st_uid == os.getuid()
            row["started"] = proc_start_time(pid)
        except OSError:
            pass
        if comm == "claude" and row.get("cwd"):
            row["recovered_sid"] = newest_session_id(row["cwd"],
                                                     since=row.get("started") or 0)
        procs.append(row)
    regs = []
    if os.path.isdir(SESSIONS_DIR):
        for name in os.listdir(SESSIONS_DIR):
            if not name.endswith(".json"):
                continue
            reg = read_json(os.path.join(SESSIONS_DIR, name)) or {}
            pid = reg.get("pid", -1)
            regs.append({"file": name, "pid": pid, "sid": reg.get("sessionId"),
                         "cwd": reg.get("cwd"), "alive": pid_alive(pid),
                         "in_pane": pid in pid_to_pane,
                         "foreground": pid_alive(pid) and proc_foreground(pid)})
    return {"panes_procs": procs, "registry": regs, "generated_at": time.time()}


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


def composer_holds(target, probe):
    """True while `probe` is still sitting in the pane's input box.

    The composer is NOT the pane's last line — a rule and the mode footer sit
    below it — so the original lines[-1] check inspected the footer and never
    matched, meaning the retry it guarded never fired.

    Past user turns are drawn with the same "❯" marker as the input box, so a
    plain search matches the message we just sent and reports it as unsent. The
    composer is specifically the bottom-most "❯" line, so scan up from the end
    and test only that one."""
    lines = [ln for ln in
             run(["tmux", "capture-pane", "-p", "-t", target, "-S", "-4"]).splitlines()
             if ln.strip()]
    for line in reversed(lines):
        if line.lstrip().startswith("\u276f"):
            return probe in line
    return False


def wait_until(predicate, timeout, step=0.03):
    """Poll `predicate` until it holds. Returns whether it did."""
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(step)
    return False


def send_text(target, text):
    """Paste a message into the agent's composer and submit it.

    Waits on what the pane actually shows rather than on fixed sleeps: the two
    hardcoded ones here cost 900ms on every send, which is most of the delay
    before a card flips to "working". A busy pane can still swallow the Enter,
    leaving the message unsent, so if the text is still in the composer
    afterwards we press Enter once more."""
    if not text.strip():
        return False, "empty message"
    if not valid_pane(target):
        return False, "unknown pane"
    enter = ["tmux", "send-keys", "-t", target, "Enter"]
    probe = text.strip().splitlines()[0][:20]
    try:
        subprocess.run(["tmux", "load-buffer", "-b", "claude-agent-manager", "-"],
                       input=text.encode(), timeout=5, check=True)
        subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "claude-agent-manager",
                        "-t", target], timeout=5, check=True)
        # let the paste land before submitting, or the Enter gets swallowed
        wait_until(lambda: composer_holds(target, probe), 1.5)
        subprocess.run(enter, timeout=5, check=True)
        if not wait_until(lambda: not composer_holds(target, probe), 1.0):
            subprocess.run(enter, timeout=5, check=True)
            _cache["t"] = 0.0
            return True, "sent (needed a second Enter)"
    except Exception as e:
        return False, str(e)
    _cache["t"] = 0.0  # let the very next poll see the agent start working
    return True, "sent"


_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._\[\]-]{1,64}$")


def set_model(target, model):
    """Type `/model <id>` into the session (typed, not pasted, so the CLI parses
    it as a slash command) and report back what the pane shows, since the switch
    is otherwise invisible until the session's next reply. Deliberately never
    sends Escape: that would interrupt an agent mid-turn."""
    if not _MODEL_ID_RE.fullmatch(model or ""):
        return False, "bad model id"
    if not valid_pane(target):
        return False, "unknown pane"
    try:
        subprocess.run(["tmux", "send-keys", "-t", target, "C-u"],
                       timeout=5, check=True)
        subprocess.run(["tmux", "send-keys", "-t", target, "-l", f"/model {model}"],
                       timeout=5, check=True)
        time.sleep(0.5)  # let the slash-command autocomplete settle
        subprocess.run(["tmux", "send-keys", "-t", target, "Enter"],
                       timeout=5, check=True)
        time.sleep(0.8)  # let the CLI redraw before we look
    except Exception as e:
        return False, str(e)
    tail = [ln.strip() for ln in
            run(["tmux", "capture-pane", "-p", "-t", target, "-S", "-6"]).splitlines()
            if ln.strip()]
    return True, " | ".join(tail[-2:]) if tail else "sent"


# Permission modes reachable by cycling Shift+Tab inside the session. Bypass is
# a deliberate opt-in with its own confirmation dialog, so it isn't offered here.
CYCLE_MODES = ("default", "acceptEdits", "plan", "auto")


def set_mode(target, mode):
    """Switch a session's permission mode by pressing Shift+Tab until its own
    footer reports the mode you asked for.

    The footer is the ground truth: the cycle order and which modes are even in
    the cycle vary by version and config, so this presses and re-reads rather
    than counting steps. Refuses while an approval dialog is up, where Shift+Tab
    means something else, and gives up (rather than spinning) if a full lap
    doesn't land on the target."""
    if mode not in CYCLE_MODES:  # cheap allowlist first, and a truthful error
        return False, "unknown mode"
    if not valid_pane(target):
        return False, "unknown pane"
    st = pane_status(target)
    if st["prompt"]:
        return False, "answer the approval prompt first"
    if not st["mode"]:
        return False, "can't read the permission mode from the pane"
    # At most one full lap: any mode in the cycle is reachable in fewer presses
    # than that, and stopping there means a failed switch leaves the session on
    # the mode it started in rather than somewhere arbitrary.
    for _ in range(len(CYCLE_MODES)):
        if st["mode"] == mode:
            _cache["t"] = 0.0  # reflect the new mode on the next poll
            return True, mode
        try:
            subprocess.run(["tmux", "send-keys", "-t", target, "BTab"],
                           timeout=5, check=True)
        except Exception as e:
            return False, str(e)
        time.sleep(0.35)  # let the CLI redraw its footer before we re-read it
        st = pane_status(target)
    if st["mode"] == mode:
        _cache["t"] = 0.0
        return True, mode
    return False, f"'{mode}' is not in this session's ⇧⇥ cycle (back at {st['mode']})"


# Menus can run past four options (an AskUserQuestion menu adds "Type something"
# and "Chat about this"), and a key we refuse is a trip to the terminal — so
# every digit a menu can offer is allowed. Still a fixed allowlist of single
# keystrokes: nothing here can carry an argument or a payload.
ALLOWED_KEYS = {"Enter", "Escape", "Up", "Down", "y", "n"} | {str(i) for i in range(1, 10)}


def send_key(target, key):
    """Send a single key (answer permission prompts, interrupt, ...)."""
    if key not in ALLOWED_KEYS:  # cheap check first, and a truthful error
        return False, "key not allowed"
    if not valid_pane(target):
        return False, "unknown pane"
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
    # Verify the process actually died (pane kill is async; Claude Code ignores
    # some signals), and scrub its registry file so a stale entry can't keep
    # the card on the board.
    for _ in range(15):
        if not pid_alive(pid):
            break
        time.sleep(0.1)
    else:
        killed += " — process still shutting down"
    try:
        reg_path = os.path.join(SESSIONS_DIR, f"{pid}.json")
        reg = read_json(reg_path)
        if reg and reg.get("sessionId") == session_id:
            os.remove(reg_path)
    except OSError:
        pass
    _cache["t"] = 0.0  # force a fresh state on next poll
    return True, killed


def spawn_session(cwd, prompt, name=None, resume=None):
    """Launch `claude` (or `claude --resume <sid>`) in a new tmux session."""
    cwd = os.path.expanduser(cwd or "").strip()
    if not cwd or not os.path.isdir(cwd):
        return False, "directory not found"
    launch = "claude"
    if resume:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", resume):
            return False, "bad session id"
        launch = f"claude --resume {resume}"
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
        subprocess.run(["tmux", "send-keys", "-t", pane, launch, "Enter"],
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
    record_spawn(name)
    return True, name


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
            if route == "/api/artifacts":
                q = parse_qs(urlparse(self.path).query)
                sid = q.get("sid", [""])[0]
                agent = next((a for a in cached_state()["agents"]
                              if a["sessionId"] == sid), None)
                if not agent:
                    self._send(404, {"error": "unknown session"})
                    return
                cwd = agent["cwd"]
                path = q.get("path", [""])[0]
                text, err = read_artifact(cwd, sid, path) if path else (None, None)
                self._send(200, {"files": list_artifacts(cwd, sid),
                                 "sources": artifact_sources(cwd, sid),
                                 "path": path if text is not None else "",
                                 "text": text or "", "error": err})
                return
            if route == "/api/browse":
                q = parse_qs(urlparse(self.path).query)
                self._send(200, {"paths": browse_paths(q.get("path", [""])[0])})
                return
            if route == "/api/sessions":
                cwd = parse_qs(urlparse(self.path).query).get("cwd", [""])[0]
                self._send(200, {"sessions": list_resumable(cwd)})
                return
            if route == "/api/debug":
                self._send(200, debug_state())
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
                     "css": "text/css",
                     "svg": "image/svg+xml"}.get(fpath.rsplit(".", 1)[-1],
                                                 "application/octet-stream")
            with open(fpath, "rb") as f:
                self._send(200, f.read(), ctype)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            self._send(401, {"error": "unauthorized"})
            return
        actions = {"/api/send": lambda b: send_text(b.get("target", ""),
                                                    b.get("text", "")),
                   "/api/key": lambda b: send_key(b.get("target", ""),
                                                  b.get("key", "")),
                   "/api/kill": lambda b: kill_session(b.get("sid", "")),
                   "/api/rename": lambda b: set_name(b.get("sid", ""),
                                                     b.get("name", "")),
                   "/api/model": lambda b: set_model(b.get("target", ""),
                                                     b.get("model", "")),
                   "/api/mode": lambda b: set_mode(b.get("target", ""),
                                                   b.get("mode", "")),
                   "/api/artifact-pin": lambda b: pin_artifact(
                       b.get("sid", ""), b.get("path", ""), b.get("remove", False)),
                   "/api/spawn": lambda b: spawn_session(b.get("cwd", ""),
                                                         b.get("prompt", ""),
                                                         b.get("name", ""),
                                                         b.get("resume", ""))}
        action = actions.get(self.path)
        if not action:
            self._send(404, {"error": "not found"})
            return
        try:
            # Parsing the length inside the try matters: a malformed header used
            # to raise straight out of the handler. The cap keeps a bad or
            # oversized body from being read into memory wholesale.
            length = int(self.headers.get("Content-Length", 0))
            if not 0 <= length <= MAX_BODY_BYTES:
                raise ValueError("bad Content-Length")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
            ok, msg = action(body)
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
