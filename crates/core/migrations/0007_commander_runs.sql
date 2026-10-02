-- Commander snapshots: immutable plan/cwd plus atomically updated task states.
CREATE TABLE commander_runs (
    id TEXT PRIMARY KEY NOT NULL,
    plan_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','running','succeeded','failed','cancelled','interrupted')),
    tasks_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX commander_runs_status ON commander_runs(status);
