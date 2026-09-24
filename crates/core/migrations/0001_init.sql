-- SuperCode schema v1（docs/architecture.md §6）。只增不改：新变更走新迁移文件。

CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    display_name      TEXT NOT NULL,
    driver_kind       TEXT NOT NULL,
    spawn_json        TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    installed_version TEXT,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,          -- SuperCode 侧 UUID
    agent_id         TEXT NOT NULL REFERENCES agents(id),
    agent_session_id TEXT NOT NULL,             -- agent 侧会话标识（ACP sessionId 等），恢复用
    cwd              TEXT NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'active',  -- active|completed|failed|cancelled
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    role         TEXT NOT NULL,                 -- user | agent
    content_json TEXT NOT NULL,                 -- ContentBlock[] 序列化
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    name        TEXT,
    kind        TEXT,
    status      TEXT,
    input_json  TEXT,
    output_json TEXT,
    started_at  TEXT,
    ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

CREATE TABLE IF NOT EXISTS approvals (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    tool_call_id TEXT,
    tool_name    TEXT NOT NULL,
    request_json TEXT NOT NULL,
    decision     TEXT NOT NULL,                 -- option_id
    decided_by   TEXT NOT NULL,                 -- rule:<pattern> | user
    created_at   TEXT NOT NULL,
    decided_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);

CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    status     TEXT NOT NULL,                   -- backlog|in_progress|review|done
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
