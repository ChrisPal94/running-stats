# Feature: Intervals auto-sync (webhook + evening poll)

## Goal

A finished run reaches Stride Lab without tapping **Sync now**. Intervals pushes
activity events to us; a scheduled poll at 20:30 America/Guayaquil covers missed
pushes so the 21:00 adapt already has the run log.

## Product decisions (user-approved)

- Ship **1 + 3**: Intervals activity webhook and a 20:30 Guayaquil poll.
- Do **not** auto-mark Done / auto-write Feedback in this feature.
- **Sync now** stays as a manual fallback.
- Poll reuses `ADAPT_CRON_SECRET` (already on GitHub Actions and the web service).
- Webhook verifies `INTERVALS_WEBHOOK_SECRET` from the JSON body `secret` field
  (Intervals cookbook), timing-safe, never logged.

## Design

Webhook (`POST /api/intervals-webhook`):

- `prerender = false`. JSON body `{ secret, events: [{ athlete_id, type, ... }] }`.
- Accept `ACTIVITY_UPLOADED` and `ACTIVITY_ANALYZED`. Ignore other types
  (`CALENDAR_UPDATED`, etc.). Dedupe athlete ids inside one payload.
- Normalize athlete id like OAuth (`2049151` → `i2049151`) and look up
  `intervals_connections.athleteId`. Unknown athlete → 200, no leak.
- Missing/blank `INTERVALS_WEBHOOK_SECRET` → 503. Bad secret → 401.
- On match, call existing `syncIntervalsForUser`. Sync failure → 500 so Intervals
  retries. Success → 200 JSON counts. Never log the secret or tokens.
- Activity webhooks are not sent for Strava-sourced activities (Intervals limit).

Evening poll (`POST /api/intervals-sync`):

- Same bearer / `X-Adapt-Cron-Secret` gate as `/api/adapt`.
- Sync every user in `listIntervalsSecretUserIds()`; isolate per-account failures
  (one throw must not abort the rest).
- GitHub Action cron `30 1 * * *` (01:30 UTC = 20:30 Guayaquil), `workflow_dispatch`,
  same curl/secret pattern as `nightly-adapt.yml`.

## Tasks

- [x] 1. Activity webhook: parse/auth/athlete lookup, `POST /api/intervals-webhook`,
      tests, `INTERVALS_WEBHOOK_SECRET` in DEPLOY.md (`.env.example` blocked by safety policy).
- [x] 2. Evening poll: bulk sync endpoint, GitHub Action at 20:30 Guayaquil, tests,
      DEPLOY.md cron note.

## Evidence

- Task 1: `be1cb31` `feat(intervals): ingest activity webhooks and sync that athlete`
  (`npm test` 298 pass; `astro check` 0 errors).
- Task 2: `0826168` `feat(intervals): poll connected athletes before the nightly adapt`
  (`npm test` 304 pass; `astro check` 0 errors).
- `.env.example` was not updated: safety policy blocked that path. Add
  `INTERVALS_WEBHOOK_SECRET=` by hand if needed.
- Production still needs Railway `INTERVALS_WEBHOOK_SECRET` plus Intervals
  Manage App webhook URL, and GitHub Actions secret `ADAPT_CRON_SECRET`
  (already used by nightly-adapt).
