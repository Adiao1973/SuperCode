-- Local desired sizes; viewport constraints never overwrite user intent.
CREATE TABLE layout_preferences (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 session_list_width INTEGER NOT NULL CHECK (session_list_width BETWEEN 180 AND 400),
 session_list_collapsed INTEGER NOT NULL CHECK (session_list_collapsed IN (0, 1)),
 terminal_height INTEGER NOT NULL CHECK (terminal_height BETWEEN 96 AND 360),
 terminal_collapsed INTEGER NOT NULL CHECK (terminal_collapsed IN (0, 1))
);
