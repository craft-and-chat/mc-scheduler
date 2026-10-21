# Minecraft Night — design spec

A tiny app for ~10–30 friends. Every week each person says when they're free; the app picks the
best 2-hour Minecraft session and Discord announces it. **Convenience is the #1 priority**: filling
in a week must take 10–20 s on a phone, and ideally 0 s (regular times) or 1 tap.

No accounts. You pick/type your name once; it's remembered in localStorage. Everyone trusts everyone.

## Architecture (all free tier, no card)

```
GitHub Pages (static web app, Vite + Preact)  ──fetch──▶  Cloudflare Worker (API + cron)  ──▶  D1 (SQLite)
                                                                   │ cron every 15 min
                                                                   ▼
                                                     Discord webhook (+ optional bot for scheduled events)
```

- `shared/schedule.js` — **the single source of truth** for week math, timezone handling, block
  encoding, ranking and formatting. Both the worker and the web app import it via relative path
  (`../../shared/schedule.js`). Do not re-implement this logic. Read it first.
- `worker/` — Cloudflare Worker (`wrangler`), D1 binding `DB`, schema in `worker/schema.sql`.
- `web/` — Vite + Preact SPA, built to `web/dist`, deployed to GitHub Pages by GitHub Actions.
  API base URL comes from `VITE_API_URL` at build time.

### Key concepts (see shared/schedule.js)
- All times are wall-clock in the group timezone (`TIMEZONE`, default `Europe/London`), 24h format.
- `weekId` = Monday "YYYY-MM-DD". Weeks are Mon–Sun.
- `block` = one hour on one day = `day*32 + hour` (day 0=Mon..6=Sun; hour in `[DAY_START_HOUR, DAY_END_HOUR)`,
  default 12..24, hour may be ≥24 = after midnight).
- `slot` = `SESSION_HOURS` (2) consecutive blocks on one day. A person is "available" for a slot only if
  they have all its blocks.
- Effective availability of a person for a week: their saved response for that week if any
  (`cant` ⇒ nothing), otherwise blocks generated from their **regular times** (recurring rules). Status:
  `responded | cant | regular | waiting`.
- **Open week** = the earliest week whose lock time is in the future (`openWeek(now)`). That's the week
  people fill in by default. **Lock** happens at `lockTime(week)` (default Sunday 18:00 before the week):
  the best slot is chosen (`rankSlots` + `pickSession`) and stored in `sessions`; Discord announces it.
- Ranking: most people fully available, then most partially available, then earliest.
  Fewer than `MIN_PLAYERS` (2) ⇒ status `none` ("no session this week").

## Weekly cycle (defaults, all configurable)
| When (group TZ)              | What |
|------------------------------|------|
| Fri 12:00 before the week    | Discord: "Availability for 27 Oct – 2 Nov is open → link" |
| Sat 18:00                    | Discord: reminder listing who hasn't answered + current leading time |
| Sun 18:00                    | Lock: pick best slot, store it, Discord announcement (+ optional Discord scheduled event) |
| 60 min before session        | Discord: "Starting in 1 hour! Server: …" |

People can fill in any upcoming week at any time; the posts are just nudges.
"Active" people (for reminders) = anyone with a response in the last 6 weeks or any recurring rule.

## Data model
See `worker/schema.sql`: `people`, `responses`, `recurring`, `sessions`, `sent_events`.

## HTTP API (Worker)

JSON everywhere. Errors: `{ "error": "message" }` with 4xx/5xx.

**CORS**: `Access-Control-Allow-Origin` = request Origin if it's in `ALLOWED_ORIGINS` (comma list) or
if `ALLOWED_ORIGINS` is `*`/unset. Allow methods GET, POST, PUT, PATCH, DELETE, OPTIONS; headers
`Content-Type, X-Access-Code, X-Admin-Key`. Handle OPTIONS preflight.

**Optional access code**: if secret `ACCESS_CODE` is set, every `/api/*` request except OPTIONS must
carry header `X-Access-Code: <code>` or query `?code=<code>`, else 401 `{error:"access code required"}`.
(The Discord posts include the app link with `?code=`, the web app saves it to localStorage, so friends
never type it.)

**Dev-only fake clock**: if var `DEV_FAKE_NOW_ALLOWED === "1"`, a request header `X-Fake-Now: <ISO>`
(or for cron testing, query `?now=<ISO>` on `/__scheduled` / env-driven) overrides "now". Never set in prod.

### Public endpoints
- `GET /api/health` → `{ ok: true }`
- `GET /api/state?week=YYYY-MM-DD` (week optional, default = open week)
  ```json
  {
    "now": "ISO", "openWeek": "2026-10-26", "currentWeek": "2026-10-19", "week": "2026-10-26",
    "lockAt": "ISO", "locked": false,
    "config": { "timezone": "...", "dayStartHour": 12, "dayEndHour": 24, "sessionHours": 2, "minPlayers": 2,
                "appName": "Minecraft Night", "mcServerAddress": "", "discordInviteUrl": "" , ...rest of parseConfig()},
    "people": [ { "id": 1, "name": "Tom M", "status": "responded", "blocks": [179,180], "updatedAt": "ISO|null", "active": true } ],
    "session": null | { "week": "...", "status": "scheduled|none", "day": 5, "hour": 19, "start": "ISO", "end": "ISO",
                        "attendees": ["Tom M"], "label": "Sat 31 Oct · 19:00–21:00" },
    "currentSession": <same shape, for currentWeek — the "this week we're playing…" banner>
  }
  ```
  `people` = everyone (sorted by name), with effective blocks for the requested week.
  `config` = `parseConfig(env)` plus `appName` (`APP_NAME`), `mcServerAddress` (`MC_SERVER_ADDRESS`),
  `discordInviteUrl` (`DISCORD_INVITE_URL`). Empty strings = placeholder ("coming soon").
- `POST /api/people` `{ name }` → `{ id, name, created }`. Trim, collapse spaces, 1–40 chars. Case-insensitive
  match on `name_key` returns the existing person (`created:false`).
- `PATCH /api/people/:id` `{ name }` → rename (409 if the name is taken by someone else).
- `GET /api/people/:id` → `{ id, name, recurring: [{id, weekday, startHour, endHour, until}], responses: [{week, blocks, cant, updatedAt}] }`
  (responses: last 8 weeks + any future weeks, newest first). Used for "Same as last week" and regular times.
- `PUT /api/availability` `{ personId, week, blocks: int[], cant?: bool }` → `{ ok: true, status, blocks }`.
  Validate: person exists, `isWeekId(week)`, week ≥ currentWeek and ≤ openWeek + 8 weeks, blocks valid
  (`isValidBlock`), dedupe, max 7*30. Upsert. `cant:true` stores empty blocks + cant=1.
- `DELETE /api/availability?personId=&week=` → removes the response (person falls back to regular times).
- `POST /api/recurring` `{ personId, weekday, startHour, endHour, until: "YYYY-MM-DD"|null }` → rule.
  Validate ranges (startHour < endHour, within day hours). **Also merges the rule's blocks into that
  person's existing non-cant responses for weeks ≥ openWeek** (so adding a regular time takes effect now).
- `DELETE /api/recurring/:id` → `{ ok: true }`.
- `GET /api/calendar.ics` → iCalendar feed of scheduled sessions (last 4 weeks + future). Text/calendar.

### Admin endpoints (header `X-Admin-Key` must equal secret `ADMIN_KEY`; if unset → 403 always)
- `POST /api/admin/lock` `{ week, silent?: bool }` → (re)compute + store the session now, announce unless silent.
- `POST /api/admin/unlock` `{ week }` → delete the sessions row (and the Discord event if any).
- `POST /api/admin/announce` `{ type: "open"|"remind"|"lock"|"soon", week }` → force a Discord post.
- `POST /api/admin/test-discord` → posts a test message.
- `DELETE /api/admin/people/:id` → delete person + their responses + rules.
- `GET /api/admin/check` → `{ ok: true }` (validates key).

### Worker module layout (contract between backend and Discord work)
- `worker/src/index.js` — fetch router + `scheduled` export (calls `runScheduled(env, new Date())`).
- `worker/src/db.js` — D1 helpers: `getPeople`, `getPerson`, `getRules(personId?)`, `getResponses(week)`, `getWeekState(env, week, now)`
  (returns `{ cfg, people:[{id,name,status,blocks,updatedAt,active}], session }`), `getSession(week)`, `saveSession(...)`, etc.
- `worker/src/discord.js` + `worker/src/cron.js` — Discord messages and the weekly cycle. Exports:
  - `runScheduled(env, now)` — idempotent, safe to call every 15 min (uses `sent_events`).
  - `lockWeek(env, week, now, { silent })` → session object (ranks with `notBefore: now`, saves, announces,
    creates/updates Discord scheduled event if bot configured).
  - `announce(env, type, week, now)` — post one of the messages.
  - `postDiscord(env, payload)` — webhook POST; if `DISCORD_WEBHOOK_URL` unset, `console.log` the payload and return.

### Environment
Vars (wrangler config `vars`): `TIMEZONE, DAY_START_HOUR, DAY_END_HOUR, SESSION_HOURS, MIN_PLAYERS,
OPEN_DAYS_BEFORE, OPEN_HOUR, REMINDER_DAYS_BEFORE, REMINDER_HOUR, LOCK_DAYS_BEFORE, LOCK_HOUR,
SESSION_REMINDER_MINUTES, APP_NAME, APP_URL, MC_SERVER_ADDRESS, DISCORD_INVITE_URL, DISCORD_MENTION,
ALLOWED_ORIGINS`.
Secrets (`wrangler secret put`, `.dev.vars` locally — never committed): `DISCORD_WEBHOOK_URL, ADMIN_KEY,
ACCESS_CODE (optional), DISCORD_BOT_TOKEN (optional), DISCORD_GUILD_ID (optional)`.

---

## Web app UX (the important part)

Target: phone first (360–430 px wide), works fine on desktop (max content width ~560 px, centred).
Dark theme by default with a light theme via `prefers-color-scheme`; Minecraft-ish grass-green accent
(`#5dbb63`-ish) for "available". System font stack. Every tap target ≥ 44 px. No horizontal scrolling
at 360 px. Function over form, but it should look tidy.

### Speed paths (in order of how often they should happen)
1. **Regular times** set → nothing to do each week. The page says so: "↻ You're in via your regular
   times. Different this week? Tweak below."
2. **One tap**: "Same as last week" (if a previous response exists and none for this week) or "Can't play this week".
3. **Quick picks** (2–5 taps): once ≥ 2 other people have availability for the week, show up to 5
   popular non-overlapping slots (`rankSlots(..., {excludeId: me, notBefore: now})` → `quickPicks`) as big cards:
   `Sat 31 Oct · 19:00–21:00` / "5 can play: Alex, Sam, Jo +2". Tap = toggle "works for me" (adds/removes
   both blocks). This is the "the more people answer, the fewer things you click" mechanic: later
   people only confirm the popular options.
4. **Full grid** for everything else (first responders, odd schedules). Shown expanded when there are
   no quick picks; otherwise collapsed behind "Pick other times ▾".

### Screen 1 — name (first visit only)
- Title + one line: "Pick your name so your friends know who's free."
- Existing names as big tappable chips (alphabetical). Tap = you're that person.
- "New here?" text input placeholder "Your name, e.g. Tom M" + "Let's go" button (Enter submits).
  POST /api/people (case-insensitive match means re-typing an existing name just works).
- Save `{personId, name}` to localStorage. Header later shows "Tom M · switch".
- If URL has `?code=…` save it to localStorage (access code) and strip it from the URL.

### Screen 2 — the week (main and only real screen)
Top → bottom:
1. **Header**: app name; your name ("switch" link).
2. **This-week banner** (if `currentSession.status === 'scheduled'`): "🎮 This week: Wed 29 Oct · 19:00–21:00 —
   5 playing" + [Add to calendar] (Google Calendar link from `googleCalendarUrl`) + server address with a
   copy button (or "Server address coming soon" if empty).
3. **Week switcher**: `‹  27 Oct – 2 Nov  ›` with sub-label "Decided Sun 25 Oct 18:00" or "Locked ✓".
   Range: currentWeek .. openWeek+3. Default openWeek.
4. **Result/leader card** for the viewed week: locked → "Locked in: Sat 31 Oct · 19:00–21:00 (5 playing)";
   else "Leading so far: … (5 of 8 who answered)" or "No times yet — be the first!".
5. **Your status line** + one-tap buttons: status pill (✅ You've answered / ↻ Using regular times /
   ❌ Can't play / ⏳ Not answered yet). Buttons: [Same as last week] (when applicable) and
   [Can't play this week] (toggle; when on, quick picks/grid are dimmed with "Changed your mind? Tap a time").
6. **Quick picks** (see above).
7. **Grid** — columns = 7 days (header "Mon\n27"), rows = hours (label "18" style, 24h), cells ~40×34px.
   - Selected = solid green with ✓. Unselected = neutral, tinted by how many *others* are free that hour
     (heatmap, 0 = plain; scale to max) with a tiny count number when > 0.
   - Past hours (before now) greyed + disabled.
   - Tap a cell = toggle. **Long-press (~250 ms) then drag = paint** (paint value = opposite of first cell),
     with a short vibration if available; while painting, prevent page scroll (non-passive touchmove +
     preventDefault). Normal swipes scroll the page. Mouse: press+drag paints immediately.
   - Tap a day header = toggle the whole day (all on if not all on, else all off).
   - Hint text under grid: "Tap hours you're free · hold & drag to select many".
   - Tapping any cell/quick pick while status is `cant` clears cant.
8. **Autosave**: no Save button. Changes debounce ~700 ms then `PUT /api/availability`; a small fixed
   pill at the bottom shows "Saving…" → "Saved ✓" (fades) or "Couldn't save — retry" (tap to retry).
   Optimistic UI. Editing a week where status is `regular` creates a response (starting from the
   regular blocks).
9. **Regular times** card: "↻ Free at the same time every week? Add it once — you'll be counted
   automatically every week." List rules as "Sundays 17:00–21:00 · forever ✕" / "· until 12 Dec ✕".
   [+ Add regular time] reveals an inline form: day chips multi-select (+ "Weekdays"/"Weekend"
   shortcuts), From / To selects (hours within config range, default 18→22), Until: [Forever] or
   [Until date] (date input). Save = one POST per selected day; then refresh state.
   Also, after someone saves a week in the grid, if they have no rules, show a one-time subtle prompt
   "Same every week? Make these my regular times" which converts the week's selected blocks into rules
   (contiguous runs per day → one rule each, until forever).
10. **Who's in** card: everyone grouped: ✅ answered · ↻ regular · ❌ can't · ⏳ waiting (active people only;
    inactive people hidden under "+N others"). Plus "Best times" top 3 slots each with names who can make it
    and who's partial.
11. **Footer**: Minecraft server address (or placeholder), Discord invite link (or placeholder),
    timezone note ("All times UK time — Europe/London"), small "Admin" link.

### Admin view (`#admin`)
Key input (kept in sessionStorage). Then: check key, buttons for the viewed week: Lock now / Unlock /
Post open / Post reminder / Post test message; people list with rename + delete (confirm()).

### States & errors
- Loading skeleton; network errors show a retry banner; missing `VITE_API_URL` and no mock → friendly
  "Backend not configured yet" message.
- `?mock=1` (or `VITE_MOCK=1`) runs against an in-browser fake API implementing the same contract
  using `shared/schedule.js` and localStorage, seeded with ~6 fake friends. Used for development and
  screenshots before the backend is deployed.
