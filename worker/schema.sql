-- D1 (SQLite) schema. Apply with: npx wrangler d1 execute mc-scheduler --file=schema.sql [--local|--remote]

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,           -- lower-cased, whitespace-collapsed name for matching
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per person per week they explicitly filled in. Overrides their regular times for that week.
CREATE TABLE IF NOT EXISTS responses (
  person_id INTEGER NOT NULL,
  week TEXT NOT NULL,                       -- weekId (Monday, YYYY-MM-DD)
  blocks TEXT NOT NULL DEFAULT '[]',        -- JSON int[] (day*32+hour)
  maybe TEXT NOT NULL DEFAULT '[]',         -- JSON int[] "maybe" hours
  no TEXT NOT NULL DEFAULT '[]',            -- JSON int[] "definitely not" hours
  cant INTEGER NOT NULL DEFAULT 0,          -- 1 = "can't play this week"
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (person_id, week)
);

-- "I'm free every <weekday> <start>-<end> until <date|forever>"
CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL,                 -- 0=Mon..6=Sun
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,                -- exclusive
  until TEXT,                               -- inclusive YYYY-MM-DD, NULL = forever
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS recurring_person ON recurring(person_id);

-- LEGACY (one session per week). Superseded by week_sessions; no longer read or written.
CREATE TABLE IF NOT EXISTS sessions (
  week TEXT PRIMARY KEY,
  status TEXT NOT NULL,                     -- 'scheduled' | 'none' (nobody/too few could make it)
  day INTEGER,
  hour INTEGER,
  start_utc TEXT,
  end_utc TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',     -- JSON string[] of names who said they can make it
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  discord_event_id TEXT                     -- optional Discord scheduled event id
);

-- The decided sessions for a week (written at lock time), idx 0.. in chronological order.
-- A 'none' week is a single row idx 0 with status 'none'.
CREATE TABLE IF NOT EXISTS week_sessions (
  week TEXT NOT NULL,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL,                     -- 'scheduled' | 'none'
  day INTEGER,
  hour INTEGER,
  start_utc TEXT,
  end_utc TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  discord_event_id TEXT,
  PRIMARY KEY (week, idx)
);

-- Idempotency for cron-driven Discord posts, e.g. 'open:2026-10-26', 'remind:..', 'lock:..', 'soon:..'
CREATE TABLE IF NOT EXISTS sent_events (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
