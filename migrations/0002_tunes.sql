DROP TABLE IF EXISTS tune_tags;
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS tunes;
DROP TABLE IF EXISTS notes;

CREATE TABLE tunes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  youtube_identifier TEXT NOT NULL CHECK (length(youtube_identifier) BETWEEN 1 AND 32),
  sheet_music_reference TEXT,
  submitted_ip TEXT NOT NULL,
  date_added TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  date_accepted TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  date_added TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tune_tags (
  tune_id INTEGER NOT NULL REFERENCES tunes(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (tune_id, tag_id)
);

CREATE TABLE votes (
  tune_id INTEGER NOT NULL REFERENCES tunes(id),
  visitor_ip TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  date_added TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tune_id, visitor_ip)
);

CREATE INDEX idx_tunes_date_accepted ON tunes(date_accepted);
CREATE INDEX idx_tune_tags_tag_id ON tune_tags(tag_id);
CREATE INDEX idx_votes_tune_id ON votes(tune_id);

INSERT INTO tags (name) VALUES
  ('beginner-friendly'),
  ('danish'),
  ('irish'),
  ('northumbrian'),
  ('scottish'),
  ('swedish');
