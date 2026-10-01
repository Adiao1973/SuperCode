-- Local-only connection parameters. API key values must not be persisted here.
CREATE TABLE commander_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config_json TEXT NOT NULL
);
