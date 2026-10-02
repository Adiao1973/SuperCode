-- Explicit user choice: local-only SQLite credentials; never tracked or exported.
CREATE TABLE commander_credentials (
    scope TEXT PRIMARY KEY NOT NULL,
    key_value TEXT NOT NULL
);
