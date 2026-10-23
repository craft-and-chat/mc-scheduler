-- Multiple sessions per week. Run once per database:
--   npx wrangler d1 execute mc-scheduler --file=migrations/0002_week_sessions.sql [--local|--remote]
-- The old `sessions` table is left untouched (no longer used).
CREATE TABLE IF NOT EXISTS week_sessions (
  week TEXT NOT NULL,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  day INTEGER,
  hour INTEGER,
  start_utc TEXT,
  end_utc TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  discord_event_id TEXT,
  PRIMARY KEY (week, idx)
);
INSERT OR IGNORE INTO week_sessions (week, idx, status, day, hour, start_utc, end_utc, attendees, locked_at, discord_event_id)
  SELECT week, 0, status, day, hour, start_utc, end_utc, attendees, locked_at, discord_event_id FROM sessions;
