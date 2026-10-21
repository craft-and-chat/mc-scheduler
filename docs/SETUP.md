# Setup guide

Everything here is free (no card needed). Secrets never go in git: they live in Cloudflare
(`wrangler secret put`) or in the gitignored `worker/.dev.vars` for local dev.
See `/.env.example` for a reference of every setting.

## 1. Web app on GitHub Pages
Already wired up: `.github/workflows/pages.yml` builds `web/` and deploys on every push to `main`.
- Repo → Settings → Pages → **Source: GitHub Actions**.
- Until the API exists, the site runs in **demo mode** (fake friends, data stays in your browser).
- Once the Worker is deployed (step 2): Settings → Secrets and variables → Actions → **Variables** →
  add `API_URL` = your Worker URL (e.g. `https://mc-scheduler.<you>.workers.dev`), then
  Actions → "Deploy web to GitHub Pages" → Run workflow.

## 2. API on Cloudflare Workers + D1
```bash
cd worker
npm install
npx wrangler login                       # opens the browser (free Cloudflare account)
npx wrangler d1 create mc-scheduler      # copy the database_id it prints…
#   …into worker/wrangler.jsonc → d1_databases[0].database_id
npm run db:init:remote                   # creates the tables
npx wrangler secret put ADMIN_KEY        # any long random string — unlocks <site>/#admin
npx wrangler secret put ACCESS_CODE      # optional but recommended: a short group code (see below)
npm run deploy                           # prints https://mc-scheduler.<you>.workers.dev
```
Check it: `curl https://mc-scheduler.<you>.workers.dev/api/health` (401 if ACCESS_CODE is set — that's fine).

**ACCESS_CODE**: the repo is public, so anyone could find the site. With a code set, the app only works
from links containing `?code=<code>` — the Discord posts include it automatically and the app remembers
it, so friends never type it. Share the link as `https://<user>.github.io/mc-scheduler/?code=<code>`.

Non-secret settings (timezone, hours, schedule, app name, server address…) are in
`worker/wrangler.jsonc` → `vars`. Change them and run `npm run deploy` again.
`ALLOWED_ORIGINS` must include your GitHub Pages origin (`https://<user>.github.io`).

Optional auto-deploy: add repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers")
and `CLOUDFLARE_ACCOUNT_ID`; `.github/workflows/worker.yml` then deploys on push.

## 3. Discord
1. In your server: pick a channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL.
2. `cd worker && npx wrangler secret put DISCORD_WEBHOOK_URL` (paste it).
3. In `worker/wrangler.jsonc` vars set `DISCORD_INVITE_URL` (shown in the app footer) and
   `DISCORD_MENTION` (`@everyone`, `@here`, `<@&ROLE_ID>` for a role, or empty for no ping); `npm run deploy`.
4. Open `<site>/#admin`, enter the ADMIN_KEY, press **Post test message**.

Optional — Discord "Events" for each session (shows in the server's Events list with an "Interested" button):
create an application at https://discord.com/developers/applications → Bot → Reset Token; invite it with
the `bot` scope and the **Manage Events** permission; then
`npx wrangler secret put DISCORD_BOT_TOKEN` and `npx wrangler secret put DISCORD_GUILD_ID`
(server id: enable Developer Mode in Discord → right-click the server → Copy Server ID).

## 4. Minecraft server
Set `MC_SERVER_ADDRESS` in `worker/wrangler.jsonc` vars and `npm run deploy`. Until then the app and
Discord posts say "Server address coming soon".

## Weekly cycle & admin
Defaults (Europe/London): Fri 12:00 "open" post → Sat 18:00 reminder → Sun 18:00 lock + announcement →
reminder 60 min before the session. The cron runs every 15 minutes and every post is sent once.
`<site>/#admin` lets you lock/unlock a week now (e.g. re-pick after people change their minds), re-send
posts, and rename/delete people.
