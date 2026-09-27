-- P1-9 简版任务看板：任务绑定会话（引用 agent_session_id；绑定是引用不是从属，
-- 会话删除时由 delete_session 级联解绑，见 Store::delete_session_by_agent）。

ALTER TABLE tasks ADD COLUMN session_id TEXT;
