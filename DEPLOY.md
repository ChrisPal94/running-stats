# Deploy (Railway)

Production host for Running Stats. Product behavior stays in `PRODUCT.md`; this file is the Railway plan and smoke checklist.

The Node standalone server binds with `HOST` and `PORT`. `npm start` sets `HOST=0.0.0.0` so Railway can reach the process. Railway injects `PORT`.

## Web service

| Setting | Value |
| --- | --- |
| Build | `npm run build` (`astro check && astro build`) |
| Start | `HOST=0.0.0.0 node ./dist/server/entry.mjs` (`npm start`) |
| Volume | Mount at `.data` (Nixpacks workdir is `/app`, so `/app/.data`) |
| Runtime | Node 22+ (built-in `node:sqlite`; no extra native module) |

Nixpacks already runs `npm run build` and `npm start`. Keep the start command as `npm start` (or the `HOST=0.0.0.0 node ./dist/server/entry.mjs` equivalent). Do not use `astro preview` in production.

The SQLite database lives at `.data/app.db` (`users`, onboarding, plans, sessions, feedbacks, run logs, AdaptationEvents). Without a volume it disappears on every deploy. If `users.json` / `training.json` are still on the volume and `app.db` is empty, they are imported once on boot.

## Environment

Set these on the **web** service. Names match `.env.example`. The app does not read a separate `SITE` / `APP_URL`; the public origin is the Railway URL (and `GOOGLE_CALLBACK_URL` for OAuth).

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | Yes | Session HMAC. Random, 16+ characters (`openssl rand -base64 32`). |
| `AUTH_COOKIE_SECURE` | No | Defaults to Secure in production. Set `true` on HTTPS, or omit. |
| `AUTH_DATA_DIR` | No | Default `.data`. SQLite file is `app.db` inside it. Omit if the volume is mounted at `.data`. |
| `GOOGLE_CLIENT_ID` | For Google | OAuth 2.0 Web client. |
| `GOOGLE_CLIENT_SECRET` | For Google | OAuth 2.0 Web client. |
| `GOOGLE_CALLBACK_URL` | For Google | `https://<public-host>/auth/google/callback` — must match Google Cloud Console exactly. |
| `ADAPT_CRON_SECRET` | For `/api/adapt` | Bearer secret for the nightly job. 16+ characters. |
| `ADAPT_LLM_API_KEY` | No | Unset = heuristic. If set and the LLM fails, the job logs and does not mutate the plan. |
| `ADAPT_LLM_BASE_URL` | No | Default `https://api.openai.com/v1`. |
| `ADAPT_LLM_MODEL` | No | Default `gpt-4o-mini`. |

Google Cloud Console: add the production authorized redirect URI before testing Continue with Google.

Do not commit a production `.env`. Railway variables are enough at runtime (`process.env`); no `.env` file is required on the host.

## Cron

21:00 `America/Guayaquil` is `02:00` UTC (ECT is UTC−5, no DST).

Railway Cron Job (UTC):

```
0 2 * * *
```

Command (same secret as the web service; substitute the public host):

```bash
curl -fsS -X POST -H "Authorization: Bearer $ADAPT_CRON_SECRET" https://<public-host>/api/adapt
```

`GET` with the same `Authorization` header also works. Alternate header: `X-Adapt-Cron-Secret`.

Share `ADAPT_CRON_SECRET` with the cron service (Railway shared variable or duplicate). Missing secret → `503`. Wrong secret → `401`.

If there is **no Feedback that Guayaquil day**, the job returns 200 and does not write an AdaptationEvent or change tomorrow’s sessions.

Local equivalent (not used on Railway): `npm run adapt` once, or `npm run adapt:cron`.

## Smoke tests (Bowser)

Use the Railway public HTTPS URL. Expect session cookies with `Secure`.

1. **Landing** — `/` loads; **Start your plan** goes to `/signup`.
2. **Signup** — email + password Continue → `/onboarding`.
3. **Onboarding** — Goal → Level → Baseline → Days (min 3) → **Generate my plan** → `/today`.
4. **Shell** — `/today`, `/plan`, `/progress`, `/settings`. Bottom nav works. Logged-out shell routes → `/login`.
5. **Today** — Skip / Feeling off persist immediately (no map). Done opens **Log this run** bottom sheet; Save writes a `RunLog` and toasts **Saved**; Skip map writes Feedback only. Empty copy is **No session today**. AdaptationEvent **Why?** opens **Why this changed** when `reason` is present; no Why? control when `reason` is empty.
6. **Login** — log out, then email Continue → `/today` (existing plan).
7. **Google** (if env is set) — Continue with Google on `/signup` and `/login`; first Google → onboarding, returning Google with a plan → `/today`. Missing/wrong Google env → **Couldn’t connect to Google. Try email or try again.**
8. **Volume** — sign in, generate a plan, redeploy or restart the web service, sign in again: users and plan are still there (`app.db` on the volume).
9. **Adapt HTTP** — `POST /api/adapt` without `Authorization` → `401`. With `Authorization: Bearer $ADAPT_CRON_SECRET` → `200` JSON (`processed` / `written` / `skipped` / `patched`). No Feedback that day → `written: 0` is success, not a failure.

Out of scope for this deploy pass: screenshots, Strava, live plan editing.
