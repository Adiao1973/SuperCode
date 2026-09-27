-- 工作空间模型（ADR-0007，docs/architecture.md §6）：项目空间 + 默认空间，会话归属空间。
-- 数据回填（distinct cwd → project 空间）在 Rust 侧 Store::backfill_session_workspaces
-- （连接后幂等执行，可测试、可复用 file_name 命名逻辑）。

CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT UNIQUE,                       -- project 空间=项目根绝对路径；默认空间为空
    kind       TEXT NOT NULL DEFAULT 'project',   -- project | default
    created_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
