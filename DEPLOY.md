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

The SQLite database lives at `.data/app.db` (`users`, onboarding, plans, sessions, feedbacks, run logs, AdaptationEvents, Intervals connections, magic link tokens). `users.emailVerifiedAt` is nullable and is not backfilled: existing accounts stay unverified until a Google sign-in (only when `email_verified === true`; false or missing does not count) or a consumed magic link sets it. Password signup does not. Without a volume it disappears on every deploy. If `users.json` / `training.json` are still on the volume and `app.db` is empty, they are imported once on boot and still start unverified. Each user’s own Intervals access token or API key is stored only as AES-256-GCM ciphertext (`apiKeyEnc`, unique IV, auth tag checked on read). It is never written to HTML, JSON, or logs. Raw magic-link tokens are never stored; only a hash, email, expiry, and used-at.

## Environment

Set these on the **web** service. Names match `.env.example`. Intervals OAuth `redirect_uri` is built from `PUBLIC_ORIGIN`, not from `Host` or `X-Forwarded-Host`. Google still uses `GOOGLE_CALLBACK_URL`.

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
| `ADAPT_LLM_API_KEY` | No | Shared by the nightly adapt job and Generate feedback. Unset = adapt heuristic; Generate feedback shows a generic try-later message (no env names in the UI). If set and the adapt LLM fails, the job logs and does not mutate the plan. |
| `ADAPT_LLM_BASE_URL` | No | Default `https://api.openai.com/v1`. Same variable for adapt and Generate feedback. |
| `ADAPT_LLM_MODEL` | No | Default `gpt-4o-mini`. Same variable for adapt and Generate feedback. |
| `OLLAMA_API_KEY` | Fallback | One-release fallback when `ADAPT_LLM_API_KEY` is unset. Prefer `ADAPT_LLM_API_KEY`. Ignores `ADAPT_LLM_BASE_URL` and `ADAPT_LLM_MODEL`. Host is `https://ollama.com/v1`. |
| `OLLAMA_MODEL` | Fallback | Model for the `OLLAMA_API_KEY` fallback. Default `gemma4:31b`. |
| `INTERVALS_KEY_ENC_SECRET` | For Connect | 32-byte key that encrypts each user’s Intervals access token or API key at rest (AES-256-GCM). Standard base64 only, from `openssl rand -base64 32` (44 characters, decodes to exactly 32 bytes). Hex and other formats are treated as missing (logged once, no crash). Missing or invalid: the Connect button stays visible but disabled with **Connecting Intervals.icu isn’t available right now. Try again later.** Nothing is stored in plaintext. Existing rows are left in place. The secret is never stored or logged. Set it on the **web** service (the process that writes `app.db` and runs `/api/adapt`). |
| `PUBLIC_ORIGIN` | For Intervals OAuth | Public site origin with no path, for example `https://running-stats-production.up.railway.app`. The OAuth `redirect_uri` is this origin plus `/auth/intervals/callback`. It does not use `Host` or `X-Forwarded-Host`. In production, if this is unset, Intervals OAuth is treated as not configured. Local dev without it falls back to the request origin. |
| `INTERVALS_CLIENT_ID` | For OAuth | Intervals.icu OAuth client id from [the app form](https://intervals.icu/oauth/apply). When this and `INTERVALS_CLIENT_SECRET` are both set, and `PUBLIC_ORIGIN` is set in production, Settings uses **Connect Intervals.icu**. Otherwise it shows the API key and athlete ID form. |
| `INTERVALS_CLIENT_SECRET` | For OAuth | OAuth client secret. Used only on the server when exchanging the code at `https://intervals.icu/api/oauth/token`. Never sent to the browser. |
| `INTERVALS_ICU_API_KEY` | No | Shared Intervals key. Not used unless `INTERVALS_OWNER_ENV_FALLBACK=true`. Basic auth user is `API_KEY`. HTTP `User-Agent: RunningStatsMVP/0.1`. Only a verified account listed in `INTERVALS_OWNER_EMAILS` may use it. |
| `INTERVALS_ICU_ATHLETE_ID` | No | Athlete id for that shared key (for example `i704884`). Used only with the owner env fallback. |
| `INTERVALS_OWNER_ENV_FALLBACK` | No | Set to `true` to let a verified allowlisted owner use `INTERVALS_ICU_API_KEY` and `INTERVALS_ICU_ATHLETE_ID` when they have no stored personal key. Default off. Anyone else uses their own OAuth token or pasted key, which does not require the allowlist or a verified email. |
| `INTERVALS_OWNER_EMAILS` | For owner fallback | Comma-separated emails allowed to use the shared env key. Case-insensitive; whitespace around each address is ignored. Unset or empty: the env fallback matches nobody. The account must also have `emailVerifiedAt` set (Google `email_verified === true`, or a consumed magic link). Password signup does not verify, and existing rows are not backfilled. The allowlist does not gate per-user OAuth or pasted keys. Production must set `crispal94@gmail.com` if the env fallback is on. |

### Intervals.icu OAuth

Primary connect path when `INTERVALS_CLIENT_ID` and `INTERVALS_CLIENT_SECRET` are set. Pasted API key + athlete ID is the fallback when they are not. Either path is available to any signed-in user. The owner allowlist and verified email apply only to the shared env key.

Register and approve the app at https://intervals.icu/oauth/apply. Authorize URL: `https://intervals.icu/oauth/authorize` (`client_id`, `redirect_uri`, `scope`, `state`). Token URL: `https://intervals.icu/api/oauth/token` (form `client_id`, `client_secret`, `code`). The token JSON includes `athlete.id` and `athlete.name`; those are stored from that response.

Scopes (one per area — `ACTIVITY:READ,ACTIVITY:WRITE` fails with **Duplicate scope**; `WRITE` already implies read):

```
ACTIVITY:READ,CALENDAR:WRITE
```

Redirect URI (must match the app settings exactly). Production:

```
https://running-stats-production.up.railway.app/auth/intervals/callback
```

Local: `http://localhost:4321/auth/intervals/callback`. Production builds it from `PUBLIC_ORIGIN` (`https://running-stats-production.up.railway.app/auth/intervals/callback`), not from `Host` or `X-Forwarded-Host`. If `PUBLIC_ORIGIN` is unset in production, OAuth is not configured.

Google Cloud Console: add the production authorized redirect URI before testing Continue with Google.

After this deploy, Intervals is unavailable for everyone until the owner signs in once with Google (`email_verified === true` on the userinfo or id token; false or missing does not count) or a magic link. That sign-in sets `emailVerifiedAt`. Password signup and password login do not. If the account was unverified, that first verified sign-in clears the password hash and invalidates every existing session in one database transaction, then issues the new session. A later sign-in on an already-verified account does not clear the password.

If the real training account is not already `crispal94@gmail.com`, follow the owner runbook below before expecting Intervals to work. The cleanup dry run is step 1. Cleanup `--apply` waits until the Google sign-in in step 3 has set `emailVerifiedAt`.

Do not commit a production `.env`. Railway variables are enough at runtime (`process.env`); no `.env` file is required on the host.

## Owner runbook

Run these on the **web** service (the service that mounts `.data` / `app.db`, workdir `/app`). Do not run them on the cron service; that service has no volume. `INTERVALS_OWNER_EMAILS` must be `crispal94@gmail.com` (see Environment above).

0. Set `INTERVALS_KEY_ENC_SECRET` in the Railway web service environment. Generate it with `openssl rand -base64 32`.

0b. Register the Intervals.icu OAuth app. Callback URL: `https://running-stats-production.up.railway.app/auth/intervals/callback`. Set `INTERVALS_CLIENT_ID` and `INTERVALS_CLIENT_SECRET` on the web service.

Steps 0 and 0b are only needed once the per-user Intervals PR is in production.

1. Dry-run the Intervals cleanup. This prints counts and deletes nothing.

```bash
npm run cleanup:intervals-nonowners
```

2. Reassign **before any Google login**. Do not sign in with Google, and do not send the owner through Google, until `--apply` below has finished. Dry-run, then apply:

```bash
npm run reassign-owner-email -- --from chrispalacios94@gmail.com --to crispal94@gmail.com
npm run reassign-owner-email -- --from chrispalacios94@gmail.com --to crispal94@gmail.com --apply
```

If the dry run or `--apply` aborts because the target account already has rows (onboarding, plan, training sessions, feedback, run logs, adaptation events, or an Intervals connection), stop and ask the team. Do not delete those rows by hand.

3. Sign in on the site with Google as `crispal94@gmail.com` (`email_verified` must be true). That sets `emailVerifiedAt` on the renamed account. Do this only after step 2 `--apply`.

4. Connect Intervals in Settings. The owner’s legacy Intervals connection row (no stored personal key) disappears after deploy unless `INTERVALS_OWNER_ENV_FALLBACK=true`. Running adapt, or opening Settings and submitting an Intervals action, deletes that row. Run logs are kept. After the verified Google sign-in the owner must Connect again in Settings.

5. **Cleanup `--apply` only after the Google login.** Until `emailVerifiedAt` is set, cleanup `--apply` aborts and deletes no RunLogs. Then dry-run again; it should show 0.

```bash
npm run cleanup:intervals-nonowners -- --apply
npm run cleanup:intervals-nonowners
```

## One-off: reassign the owner email

Default is a dry run. Addresses are trim + lowercase. It prints the FROM user (`id`, stored `email`, counts of onboarding, plans, training sessions, feedbacks, run logs, adaptation events, Intervals connection, magic-link tokens), the TO user (`id` or `none`, the same counts, `deletable=yes|no`), and the planned change. It does not write.

```bash
npm run reassign-owner-email -- --from <realEmail> --to crispal94@gmail.com
```

`--apply` deletes the TO user and renames FROM in one transaction:

```bash
npm run reassign-owner-email -- --from <realEmail> --to crispal94@gmail.com --apply
```

- FROM must already exist. If it does not, the script exits 1 and changes nothing.
- TO is deleted only when it has no rows in any table keyed by `userId` (onboarding, plans, training `sessions`, feedbacks, run logs, adaptation events, Intervals connection, plus any later table that adds `userId`). If any of those exist, the script exits 1, prints the counts, and tells you to stop and ask the dev team. Do not delete those rows manually. It does not move those rows onto FROM.
- A dry run does not rewrite a database whose tables and columns are already present. If tables or columns are missing, opening the database applies that migration and the dry run prints a note.
- Deleting TO also deletes magic-link tokens for that email. Auth sessions are stateless HMAC cookies checked against the user row, so removing the user invalidates them. There is no session table.
- FROM’s email becomes the target address. `emailVerifiedAt` is set to null and is not backfilled. `passwordHash`, `googleId`, and every training row stay on that same user id.
- Google accounts are stored on `users.googleId` (the provider subject), not on the email. This script does not change `googleId`. The next Google sign-in looks up that subject first, then the normalized email. A subject match sets `emailVerifiedAt` only when the Google email equals the stored email. If this row’s subject already matches and the Google email is the new address, that sign-in marks it verified, clears `passwordHash`, and invalidates older sessions. If the subject is new, the email lookup does the same and stores the subject on this row. If the email account is unverified and already has a different `googleId`, that sign-in replaces it and logs a warning with the user id only (no email). If the account is already verified and the `googleId` differs, the sign-in returns the generic Google error and does not overwrite. If the subject matches a user whose stored email is different, that user is signed in and `emailVerifiedAt` is left unchanged; the account that already owns the Google email is not modified. Plans, sessions, feedback, run logs, adaptation events, onboarding, and the Intervals connection stay on the renamed user id.

## One-off: remove non-owner Intervals imports

Order is the owner runbook, not dry-run then `--apply` back to back. Dry-run first (step 1), before reassign and before any Google login. `--apply` is step 5, only after that Google login and Connect. Then dry-run again; it should show 0. `INTERVALS_OWNER_EMAILS` must be `crispal94@gmail.com` and, before `--apply`, that account’s `emailVerifiedAt` must be set. Do not run it on the cron service; that service has no volume.

Railway: web service shell, or a one-off command that uses the web service variables and the mounted volume (workdir `/app`).

Default is a dry run. It prints each account (`userId`, `email`, `verified`, `wouldDelete`), including verified owners at `0`, plus a total. `verified=yes` only when `emailVerifiedAt` is set. It does not delete.

```bash
npm run cleanup:intervals-nonowners
```

`--apply` is owner runbook step 5, only after the Google login. It is not the next command after the step 1 dry run:

```bash
npm run cleanup:intervals-nonowners -- --apply
```

Optional cutoff (ISO). The default is `2026-09-25T00:00:00.000Z` (`PER_USER_INTERVALS_SINCE`):

```bash
npm run cleanup:intervals-nonowners -- --before 2026-09-25T00:00:00.000Z
npm run cleanup:intervals-nonowners -- --apply --before 2026-09-25T00:00:00.000Z
```

A row is deleted only when all of these are true: `source = intervals`, the account is not a verified owner (`canUseIntervals` is false), the account has no encrypted Intervals token or API key of its own, and `createdAt` is strictly before the cutoff. Verified owners, accounts that connected their own Intervals (OAuth or API key), logs at or after the cutoff, and every manual `RunLog` stay. The dry run logs `email=`, `verified=`, and `wouldDelete=`. `--apply` logs `wouldDelete=` before the delete and `deleted=` after, with `userId` only (no email). If an allowlisted email matches an account with no `emailVerifiedAt`, the dry run warns and omits that account, and `--apply` exits 1 without deleting any RunLogs until that account is verified; an allowlisted email with no account does not abort. If `INTERVALS_OWNER_EMAILS` is unset or empty, or `--before` is not an ISO timestamp, both modes log why and delete nothing (exit code 1). Safe to run again; a second `--apply` deletes zero rows.

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
5. **Shell** — `/today`, `/plan`, `/progress`, `/settings`. Bottom nav works. Logged-out shell routes → `/login`. Settings **You** can change Adaptation frequency (Daily / Weekly / Monthly) and Save. Settings **Connected apps** shows Intervals.icu (`Not connected` / `Connected · {id}`). Connect asks for that user’s API key (password field) and athlete ID; the key is checked with Intervals before it is stored encrypted, and it is not shown again. Sync now / Disconnect do not delete `RunLog`s. Disconnect removes the stored key and athlete id.
6. **Today** — Skip / Feeling off persist immediately (no map). Done opens **Log this run** bottom sheet; Save writes a `RunLog` and toasts **Saved**; Skip map writes Feedback only. Empty copy is **No session today**; CTA **See the week** → `/plan`; optional **Next run: {weekday}** when a later Session exists. AdaptationEvent **Why?** opens **Why this changed** when `reason` is present; no Why? control when `reason` is empty.
7. **Login** — log out, then email Continue → `/today` (existing plan). Password tab remains the default.
8. **Magic link** — Email link tab → **Email me a link** → **Check your email** / **Link expires in 15 minutes** / **Resend link**. Production needs `RESEND_API_KEY` + `MAIL_FROM` (`MAGIC_LINK_FROM` is a one-release fallback). If mail is unset in local/dev, copy the `/auth/magic?token=…` URL from web logs. Unset mail in production fails with **Couldn’t send the link. Try again.** and does not log the token. First-time click → `/onboarding`. Returning with a plan → `/today`. Used or expired token → `/login` + toast **That link expired. Request a new one.**
9. **Google** (if env is set) — Continue with Google on `/signup` and `/login`; first Google → onboarding, returning Google with a plan → `/today`. Missing/wrong Google env → **Couldn’t connect to Google. Try email or try again.**
10. **Volume** — sign in, generate a plan, redeploy or restart the web service, sign in again: users and plan are still there (`app.db` on the volume).
11. **Adapt HTTP** — Bare `POST /api/adapt` without `Content-Type` → `403` (Astro CSRF). `POST` with `-H "Content-Type: application/json"` and no/wrong `Authorization` → `401`. Same `Content-Type` plus `Authorization: Bearer $ADAPT_CRON_SECRET` → `200` JSON (`processed` / `written` / `skipped` / `patched`). `GET` with the same Bearer also works. No Feedback that day → `written: 0` is success, not a failure.

Out of scope for this deploy pass: screenshots, Strava, live plan editing.
