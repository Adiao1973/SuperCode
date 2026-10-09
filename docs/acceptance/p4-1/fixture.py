#!/usr/bin/env python3
"""P4-1 disposable baseline data/loopback planner; no real API or credentials.

Initialize DB with SUPERCODE_DB=<root>/baseline.db supercode sessions list first.
Run: python3 fixture.py seed <root> | python3 fixture.py serve <root>
Never pass an existing user directory: seed refuses a nonempty sessions table.
"""
import datetime
import json
from pathlib import Path
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(sys.argv[2]).resolve()
PORT = 19441
MODEL = "p41-local-fixture"
CONFIG = {"endpoint": f"http://127.0.0.1:{PORT}/v1/chat/completions",
          "model": MODEL, "api_key_env": "P41_DUMMY_KEY", "timeout_secs": 60}


def seed():
    db = sqlite3.connect(ROOT / "baseline.db")
    assert db.execute("select count(*) from sessions").fetchone()[0] == 0
    now = "2026-10-09T00:00:00.000Z"
    cwd = str(ROOT / "project")
    db.execute("insert into agents(id,display_name,driver_kind,updated_at) values(?,?,?,?)",
               ("opencode", "OpenCode", "acp", now))
    db.execute("insert into workspaces values(?,?,?,?,?)", ("p41-project", "体验基线项目", cwd, "project", now))
    for n in range(12):
        sid = f"00000000-0000-4000-8000-{n:012d}"
        title = "长会话 · 中文 / Markdown / 代码" if n == 0 else f"合成会话 {n:02d} · 交互体验记录"
        db.execute("insert into sessions values(?,?,?,?,?,?,?,?,?)",
                   (sid, "opencode", f"p41-history-{n}", cwd, title, "completed", now, now, "p41-project"))
        for i in range(1000 if n == 0 else 2):
            text = (f"消息 {i:04d}：请分析任务并保留上下文。\n" if i % 2 == 0 else
                    f"## 消息 {i:04d}：分析结果\n中文阅读、滚动位置与代码复制。\n"
                    "```ts\nconst state = { status: 'ready' };\n```\n|任务|状态|\n|---|---|\n|体验|待审阅|\n")
            stamp = (datetime.datetime(2026, 10, 9, tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=i)).isoformat()
            db.execute("insert into messages values(?,?,?,?,?)",
                       (f"p41-{n}-{i}", sid, "user" if i % 2 == 0 else "agent", json.dumps([{"type": "text", "text": text}], ensure_ascii=False), stamp))
    for n in range(12):
        db.execute("insert into tasks(id,title,cwd,status,created_at,updated_at,workspace_id) values(?,?,?,?,?,?,?)",
                   (f"p41-task-{n}", f"基线任务 {n:02d} · 记录状态与拖拽", cwd,
                    ["backlog", "in_progress", "review", "done"][n % 4], now, now, "p41-project"))
    db.execute("insert into commander_config values(1,?)", (json.dumps(CONFIG),))
    db.execute("insert into commander_credentials values(?,?)",
               (f"http://127.0.0.1:{PORT}/v1|P41_DUMMY_KEY", "p41-fake-not-a-real-key"))
    db.commit()
    db.close()
    (ROOT / "xdg/opencode").mkdir(parents=True, exist_ok=True)
    (ROOT / "xdg/opencode/opencode.json").write_text(json.dumps({"permission": {"edit": "ask", "bash": "ask"}}))
    print("Seeded 12 sessions / 1022 messages / 12 tasks; fake loopback config only")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        self.answer({"data": [{"id": MODEL}]})

    def answer(self, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/metrics":
            # Metrics schema only: no DOM text, prompts, keys or config exported.
            allowed = {"label", "viewport", "userAgent", "navigation", "frames", "input", "dom", "visibility"}
            assert set(payload) <= allowed
            with (ROOT / "metrics.jsonl").open("a") as f:
                f.write(json.dumps(payload) + "\n")
            self.answer({"ok": True})
            return
        plan = {"version": 1, "objective": "P4-1 本机合成计划：审阅与审批体验", "tasks": [
            {"id": "review", "title": "核对改动上下文", "agent_id": "opencode", "prompt": "permission"},
            {"id": "summary", "title": "总结验收结果", "agent_id": "opencode", "prompt": "fast", "depends_on": ["review"]}]}
        self.answer({"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(plan, ensure_ascii=False)}}]})


if sys.argv[1] == "seed":
    seed()
elif sys.argv[1] == "serve":
    print(f"P41 fixture listening on loopback:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
else:
    raise SystemExit("Expected seed or serve")
