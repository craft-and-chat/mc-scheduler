-- Adds "maybe" and "definitely not" hours to responses. Run once per database:
--   npx wrangler d1 execute mc-scheduler --file=migrations/0001_maybe_no.sql [--local|--remote]
ALTER TABLE responses ADD COLUMN maybe TEXT NOT NULL DEFAULT '[]';
ALTER TABLE responses ADD COLUMN no TEXT NOT NULL DEFAULT '[]';
