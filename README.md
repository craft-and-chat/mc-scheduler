# ⛏️ Craft & Chat — weekly session scheduler

Every week your friends tap when they're free; the app picks the best two 2-hour Minecraft sessions (configurable, `SESSIONS_PER_WEEK`, picked so everyone can play at least once) and
Discord announces it. No accounts — you just pick your name.

- **10-second answers:** one grid of hours (tap, or hold & drag; tinted by how many friends are free),
  "Same as last week" and "Can't play this week" are single taps, and **regular times**
  ("free every Sunday 17–21, forever / until a date") count you in automatically every week.
- **Automatic weekly cycle** (UK time, configurable): Fri 12:00 Discord "fill in your times" →
  Sat 18:00 reminder naming who hasn't answered → **Sun 18:00 the best slot is locked in and announced**
  (+ Google Calendar link, optional Discord Event) → reminder 1 hour before the session.
- **Free hosting:** GitHub Pages (web) + Cloudflare Workers + D1 (API, database, cron) + Discord webhook.

```
web/      Vite + Preact app (GitHub Pages)
worker/   Cloudflare Worker: API, D1 database, cron + Discord posts
shared/   scheduling logic used by both (weeks, timezones, ranking)
docs/     DESIGN.md (spec) and SETUP.md (deploy guide)
```

**Setup / deployment:** see [docs/SETUP.md](docs/SETUP.md). **How it works:** [docs/DESIGN.md](docs/DESIGN.md).

## Local development

```bash
# API (http://localhost:8787)
cd worker && npm install && cp .dev.vars.example .dev.vars
npm run db:init:local && npm run dev

# Web (http://localhost:5173) — against the local API…
cd web && npm install && echo "VITE_API_URL=http://localhost:8787" > .env.local && npm run dev
# …or without any backend: open http://localhost:5173/?mock=1 (fake friends, data in your browser)
```

Tests: `cd worker && npm test` (API, cron/Discord with a mock Discord server, scheduling unit tests) and
`cd web && npm test` (Playwright, phone-sized, against mock mode).
