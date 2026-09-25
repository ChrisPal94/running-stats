# Deploy (Railway)

Production host for Stride Lab. Product behavior stays in `PRODUCT.md`; this file is the Railway plan and smoke checklist.

The Node standalone server binds with `HOST` and `PORT`. `npm start` sets `HOST=0.0.0.0` so Railway can reach the process. Railway injects `PORT`.

## Web service

| Setting | Value |
| --- | --- |
| Build | `npm run build` (`astro check && astro build`) |
| Start | `HOST=0.0.0.0 node ./dist/server/entry.mjs` (`npm start`) |
| Healthcheck | Path `/api/health` — unauthenticated `GET` returns `200` JSON `{ ok: true, adaptCronConfigured: true or false }`. Does not touch SQLite or return secrets. `adaptCronConfigured` is true when `ADAPT_CRON_SECRET` is set (non-empty after trim). Cron is a **separate** Railway service (below), not this web process. |
| Volume | Mount at `.data` (Nixpacks workdir is `/app`, so `/app/.data`) |
| Runtime | Node 22.14+ (built-in `node:sqlite`; no extra native module) |

Nixpacks already runs `npm run build` and `npm start`. Keep the start command as `npm start` (or the `HOST=0.0.0.0 node ./dist/server/entry.mjs` equivalent). Do not use `astro preview` in production.

The SQLite database lives at `.data/app.db` (`users`, onboarding, plans, sessions, feedbacks, run logs, AdaptationEvents, Intervals connection status, magic link tokens). Without a volume it disappears on every deploy. If `users.json` / `training.json` are still on the volume and `app.db` is empty, they are imported once on boot. The Intervals API key is env-only and is not stored in `app.db`. Raw magic-link tokens are never stored; only a hash, email, expiry, and used-at.

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
| `RESEND_API_KEY` | For magic link mail | Resend HTTP API. Required with `MAIL_FROM` to send. Unset in production → **Couldn’t send the link. Try again.** (token/link never logged). Unset in local/dev (`NODE_ENV !== production`) → log the full `/auth/magic?token=…` URL and still show **Check your email**. |
| `MAIL_FROM` | For magic link mail | From address (verified in Resend). Prefer this name. |
| `MAGIC_LINK_FROM` | Fallback | One-release fallback if `MAIL_FROM` is unset. |
| `ADAPT_CRON_SECRET` | For `/api/adapt` | Bearer secret for the nightly job. 16+ characters. |
| `ADAPT_LLM_API_KEY` | No | Unset = heuristic. If set and the LLM fails, the job logs and does not mutate the plan. |
| `ADAPT_LLM_BASE_URL` | No | Default `https://api.openai.com/v1`. |
| `ADAPT_LLM_MODEL` | No | Default `gpt-4o-mini`. |
| `INTERVALS_ICU_API_KEY` | For Connect | Intervals.icu personal API key. Basic auth user is `API_KEY`. HTTP `User-Agent: RunningStatsMVP/0.1`; athlete path `0`. Never stored in SQLite or shown in the UI. Only accounts listed in `INTERVALS_OWNER_EMAILS` may use it. |
| `INTERVALS_ICU_ATHLETE_ID` | No | Display fallback (default `i704884`). HTTP paths use `0`. |
| `INTERVALS_OWNER_EMAILS` | For Connect | Comma-separated emails allowed to use the shared Intervals key. Case-insensitive; whitespace around each address is ignored. Unset or empty: nobody can connect, sync, or read Intervals (fail closed). Production must set `crispal94@gmail.com`. |

Google Cloud Console: add the production authorized redirect URI before testing Continue with Google.

Do not commit a production `.env`. Railway variables are enough at runtime (`process.env`); no `.env` file is required on the host.

## Reverse proxy / CSRF

Railway (and similar TLS-terminating proxies) must forward `X-Forwarded-Proto` and `X-Forwarded-Host` (Railway does this by default). Form POSTs — signup, login, magic-link send, onboarding, Today, Settings — compare the browser `Origin` (or `Referer`) to that **public** origin, not the internal `http://…` `request.url`. Magic-link emails also use that public origin so Sign in points at `https://<public-host>/auth/magic?token=…`.

If those headers are stripped, Astro’s origin check returns **403** `Cross-site POST form submissions are forbidden` because the socket origin is `http://…` while the public site is `https://<host>`. Use the public HTTPS URL for POSTs (browser or curl). CSRF is not disabled: a cross-site `Origin` still fails.

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Origin: https://<public-host>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "email=test@example.com&password=testpass1" \
  https://<public-host>/login
```

Expect **200** (invalid credentials still render the form), not **403**.

## Cron

21:00 `America/Guayaquil` is `02:00` UTC (ECT is UTC−5, no DST).

This is a **separate Railway Cron service** (or Cron Job). It only HTTP-POSTs the public web URL. It is **not** a second Node app: do not run `npm start` / `npm run adapt` on it, and do **not** mount `.data` there. SQLite stays on the web service volume. `GET /api/health` only reports whether the secret is configured on the **web** service (`adaptCronConfigured`); it does not run Cron.

Railway Cron Job schedule (UTC):

```
0 2 * * *
```

Command — `POST` the web service public URL `/api/adapt` with the **same** `ADAPT_CRON_SECRET` as the web service (Railway shared variable or duplicate; substitute the public host). Include `Content-Type: application/json`: a bare `POST` without it hits Astro CSRF and returns **403**.

```bash
curl -fsS -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $ADAPT_CRON_SECRET" https://<public-host>/api/adapt
```

`GET` with the same `Authorization: Bearer $ADAPT_CRON_SECRET` also works and avoids the Content-Type CSRF footgun. Alternate header: `X-Adapt-Cron-Secret`.

Missing secret on the web service → `503`. Wrong secret → `401`.

If there is **no Feedback that Guayaquil day**, the job returns 200 and does not write an AdaptationEvent or change tomorrow’s sessions.

Local equivalent (not used on Railway): `npm run adapt` once, or `npm run adapt:cron`.

## Smoke tests (Bowser)

Use the Railway public HTTPS URL. Expect session cookies with `Secure`. Signup/login POSTs must not return 403 (see Reverse proxy / CSRF above).

1. **Health** — `GET /api/health` (no auth) → `200` `{ "ok": true, "adaptCronConfigured": true|false }`. Boolean only; never the secret. Cron is a separate Railway service (see Cron above), not this web process.
2. **Landing** — `/` loads; **Start your plan** goes to `/signup`.
3. **Signup** — email + password Continue → `/onboarding`.
4. **Onboarding** — Goal → Level → Baseline → Days (min 3) → Cadence (Daily / Weekly / Monthly) → **Generate my plan** → `/today`.
5. **Shell** — `/today`, `/plan`, `/progress`, `/settings`. Bottom nav works. Logged-out shell routes → `/login`. Settings **You** can change Adaptation frequency (Daily / Weekly / Monthly) and Save. Settings **Connected apps** shows Intervals.icu (`Not connected` / `Connected · {id}`); Connect uses the server env key (no paste). Sync now / Disconnect do not delete `RunLog`s.
6. **Today** — Skip / Feeling off persist immediately (no map). Done opens **Log this run** bottom sheet; Save writes a `RunLog` and toasts **Saved**; Skip map writes Feedback only. Empty copy is **No session today**; CTA **See the week** → `/plan`; optional **Next run: {weekday}** when a later Session exists. AdaptationEvent **Why?** opens **Why this changed** when `reason` is present; no Why? control when `reason` is empty.
7. **Login** — log out, then email Continue → `/today` (existing plan). Password tab remains the default.
8. **Magic link** — Email link tab → **Email me a link** → **Check your email** / **Link expires in 15 minutes** / **Resend link**. Production needs `RESEND_API_KEY` + `MAIL_FROM` (`MAGIC_LINK_FROM` is a one-release fallback). If mail is unset in local/dev, copy the `/auth/magic?token=…` URL from web logs. Unset mail in production fails with **Couldn’t send the link. Try again.** and does not log the token. First-time click → `/onboarding`. Returning with a plan → `/today`. Used or expired token → `/login` + toast **That link expired. Request a new one.**
9. **Google** (if env is set) — Continue with Google on `/signup` and `/login`; first Google → onboarding, returning Google with a plan → `/today`. Missing/wrong Google env → **Couldn’t connect to Google. Try email or try again.**
10. **Volume** — sign in, generate a plan, redeploy or restart the web service, sign in again: users and plan are still there (`app.db` on the volume).
11. **Adapt HTTP** — Bare `POST /api/adapt` without `Content-Type` → `403` (Astro CSRF). `POST` with `-H "Content-Type: application/json"` and no/wrong `Authorization` → `401`. Same `Content-Type` plus `Authorization: Bearer $ADAPT_CRON_SECRET` → `200` JSON (`processed` / `written` / `skipped` / `patched`). `GET` with the same Bearer also works. No Feedback that day → `written: 0` is success, not a failure.

Out of scope for this deploy pass: screenshots, Strava, live plan editing.
