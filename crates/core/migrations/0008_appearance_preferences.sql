-- Local visual preference only; existing sessions/configuration/credentials unchanged.
CREATE TABLE appearance_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark'))
);
