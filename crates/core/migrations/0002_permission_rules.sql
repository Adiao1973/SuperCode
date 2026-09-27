-- P1-5 规则库：全局持久化的预授权规则（architecture §6）
CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'ask')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_rules_pattern_effect
  ON permission_rules (pattern, effect);
