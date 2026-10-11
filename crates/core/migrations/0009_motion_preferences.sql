-- Independent local motion preference; existing tables and theme unchanged.
CREATE TABLE motion_preferences (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 motion TEXT NOT NULL CHECK (motion IN ('system', 'reduce', 'full'))
);
