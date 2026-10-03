CREATE TABLE IF NOT EXISTS cv2_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
);
INSERT OR IGNORE INTO cv2_counter (id, value) VALUES (1, 0);
