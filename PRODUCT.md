# Running Stats

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro with TypeScript and Tailwind CSS.

## Users

Primary users are runners who want to know what to run today, see the week at a glance, and track progress without noise. Detailed user segments remain undecided.

## Product Purpose

Running Stats is a coach AI for an adaptive training plan. One plan is shown as three views:

- **Hoy (Today):** the next session to run.
- **Plan:** the week, with no more than three sessions in focus.
- **Progreso (Progress):** a short set of progress signals.

When the plan changes, an **AdaptationEvent** explains what changed and why.

## Positioning

A training plan that adapts after every run—so you always know what to run next, and why. The landing demonstrates Hoy / Plan / Progreso plus an explainable AdaptationEvent. Distance chips are not social proof. The longer-term differentiator is the adaptive, explainable plan.

## Operating Context

Users evaluate the product on a marketing landing page, then start or return to a plan with email and password or Google. Signed-in users complete a five-step onboarding that creates Plan v1, then land in the Hoy / Plan / Progreso app shell.

## Capabilities and Constraints

- The landing includes the hero (value, CTAs, nav) and the product preview of Hoy / Plan / Progreso with an AdaptationEvent inside Today.
- English marketing, onboarding, and shell copy is provisional and must remain easy to replace.
- Activity and plan data on the landing are illustrative examples, not commercial claims. Mock values must be marked **Illustrative example**.
- The landing AdaptationEvent includes a visual “Why?” control that stays non-interactive (illustrative example: no modal, no JS, not a working link, no underline). In the Today shell, **Why?** opens a bottom sheet when `reason` is non-empty.
- Auth is email + password and Google (no Strava, not magic link). The stored identity is the user’s.
- After signup (email or first Google), continue to `/onboarding`. After login (email or returning Google), continue to `/today` when a plan exists, otherwise `/onboarding`. Shell routes send signed-in users without a plan back to onboarding.
- Onboarding is five steps (goal, level, baseline, days, cadence). Generate my plan writes onboarding answers plus Plan v1 and Sessions. No AdaptationEvent is written here. Skip baseline uses the same Plan v1 heuristic as before; last-race / Cooper may adjust volumes and intensities by at most ±20%.
- The app shell is mobile-first (~390) with a bottom nav: Today | Plan | Progress, plus an avatar/settings entry. Calendar “today” uses **America/Guayaquil**, not UTC.
- Today shows the session dated for that Guayaquil calendar day. Empty copy is **No session today**. Skip / Feeling off write Feedback immediately and never open a map. **Done** opens a bottom sheet **Log this run**; **Save** writes Feedback plus a separate `RunLog`; **Skip map** writes Feedback only. AdaptationEvents are read-only in the shell (chip = `title` + `summary`). **Why?** opens a bottom sheet with `reason` when it is non-empty; if there is no `reason`, Why? is not shown. Written only by the 21:00 job, and only when Feedback exists that day.
- Plan shows a Monday–Sunday week strip and at most three remaining sessions this week. Progress shows at most six rows: **Consistency**, **Easy pace**, **Weekly distance**, **Avg pace (7d)**, **Longest run (28d)**, **Time running (7d)** (Easy pace uses easy `RunLog`s when present; otherwise provisional).
- Settings **Connected apps** can Connect Intervals.icu using a server env key (no key paste in the UI). Import matches Run activities to a Session by Guayaquil day; no orphan `RunLog`s. Manual Log this run wins over import.
- There is no live plan editing yet. A 21:00 `America/Guayaquil` Node job (`npm run adapt` / `POST /api/adapt`) reads `Plan.feedbackCadence` and writes AdaptationEvents (same shape) and may ease tomorrow’s session only — never a full Plan rewrite. Daily keeps the current nightly path; weekly/monthly skip unless the schedule matches.
- On ~390px widths, the hero fold must show the H1 and the primary CTA without a dedicated redesign—tighten spacing rather than inventing a new layout. Onboarding is mobile-first at the same width.
- `/signup` is a real auth page and is indexable. Landing CTAs still go to `/signup`.
- Marketing pages share basic Open Graph tags (title, description, url). Do not invent share imagery.
- The experience must be responsive and accessible.
- Future work must not fabricate testimonials, member counts, partners, awards, or performance claims.

## Brand Commitments

- Product name: Running Stats.
- Visual references supplied by the user define the athletic composition, dark palette, lime accent, and supplied background artwork.
- The supplied background must not use zoom, parallax, or scale animation.

## Evidence on Hand

- Three user-supplied visual references.
- No verified testimonials, member counts, partners, awards, or performance claims; future work must not fabricate them.

## Product Principles

- Make Hoy, Plan, and Progreso legible at a glance.
- When the plan adapts, say what changed and why (explainable AdaptationEvent).
- Let real activity metrics carry the motivation; mark mock data clearly.
- Keep the primary action unmistakable.
- Preserve speed and clarity across device sizes.

## Auth (MVP)

- Routes: `/signup`, `/login`, `/logout` (POST), `/auth/google`, `/auth/google/callback`, `/onboarding`, `/today`, `/plan`, `/progress`, `/settings`.
- Stack: Astro 7 + Vite 8, `@astrojs/node` 11.x (`standalone`). Landing stays prerendered; auth, onboarding, and shell routes set `prerender = false`.
- Identity: email + scrypt password hash and/or Google account id in SQLite (`.data/app.db` by default, or `AUTH_DATA_DIR/app.db`). HMAC-signed `rs_session` cookie. On first boot, if the DB is empty and `.data/users.json` / `.data/training.json` exist, they are imported once; SQLite is then the source of truth.
- Google: real OAuth redirect when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` are set. If they are missing, Continue with Google shows “Couldn’t connect to Google. Try email or try again.” Email + password still works.
- After signup (email or first Google), Continue goes to `/onboarding`. After login (email or returning Google), Continue goes to `/today` if a plan exists, otherwise `/onboarding`.
- Env: `AUTH_SECRET` (required in production; see `.env.example`). Optional `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `AUTH_DATA_DIR`, `AUTH_COOKIE_SECURE`. Adapt job: `ADAPT_CRON_SECRET` (required for `/api/adapt`). Optional LLM: `ADAPT_LLM_API_KEY`, `ADAPT_LLM_BASE_URL`, `ADAPT_LLM_MODEL`. Optional Intervals.icu: `INTERVALS_ICU_API_KEY` (required to Connect; Basic auth user `API_KEY`; HTTP `User-Agent: RunningStatsMVP/0.1`; paths use athlete `0`). Optional `INTERVALS_ICU_ATHLETE_ID` is display-only (default Christian `i704884`). The API key is never stored in SQLite or shown in the UI. No separate `SITE` / `APP_URL` — public origin is the request URL / `GOOGLE_CALLBACK_URL`.
- Build: `npm run build` still runs `astro check && astro build`. With the Node adapter, output is `dist/client` + `dist/server`. Preview with `AUTH_SECRET=... AUTH_COOKIE_SECURE=false npm run preview`, or `npm start` after build (`HOST=0.0.0.0 node ./dist/server/entry.mjs`).

## Onboarding (MVP)

- Signed-in only. Logged-out visits to `/onboarding` redirect to `/signup`.
- Five steps with progress 1/5–5/5: **Goal** (5K, 10K, Half, Marathon, Just consistent; optional race date), **Level** (Beginner, Intermediate, Advanced), **Baseline** (Last race | Cooper test | Skip for now), **Days** (M–S toggles, minimum 3, CTA **Continue**), **Cadence** (Daily | Weekly | Monthly; default Daily). CTA **Generate my plan** creates Plan v1 + Sessions and continues to `/today`.
- Baseline is stored on `OnboardingRecord`, `OnboardingAnswers`, and `Plan` (`version: 1`) as the same optional discriminated union: `{ kind: "last-race"; distanceKm; timeSec; paceSecPerKm; date? }` | `{ kind: "cooper"; distanceKm; durationSec: 720 }` | `{ kind: "skip" }`. Last-race `paceSecPerKm` is computed server-side as `timeSec / distanceKm` (client pace is display-only; typical band ~150–720 s/km). Cooper distance is 0.5–5 km and `durationSec` is always 720. Skip, omit, or null keeps the current Plan v1 heuristic. Last-race / Cooper may change session volumes/intensities by at most ±20% vs that heuristic. Wizard steps are 1|2|3|4|5 (Baseline=3, Days=4, Cadence=5).
- `feedbackCadence` (`"daily" | "weekly" | "monthly"`, default `"daily"`) lives on `OnboardingRecord`, `OnboardingAnswers`, and `Plan` — not Session. It is chosen on the Cadence step and can be changed later in Settings / You. Persist through the training store APIs (SQLite `.data/app.db`).
- Answers, plans, sessions, Baseline, cadence, Feedback, RunLogs, and Intervals connection status persist in `.data/app.db` (same `AUTH_DATA_DIR` as users). The Intervals API key is env-only. No AdaptationEvent is written here.

## App shell (MVP)

- Signed-in with a plan only. Logged-out visits to `/today`, `/plan`, `/progress`, and `/settings` redirect to `/login`. Signed-in without a plan redirects to `/onboarding`.
- Calendar day and “hoy” use `America/Guayaquil`. A new Guayaquil day starts at 05:00 UTC (UTC−5, no DST). Session dates in SQLite are civil `YYYY-MM-DD` values compared to that calendar day — not `Date#toISOString()` UTC.
- **Today (`/today`):** the Session whose `date` equals today’s Guayaquil date. Empty copy: **No session today**. Skip / Feeling off persist Feedback immediately (Skip also sets session `outcome`) and never show a map. **Done** opens a bottom sheet and does not persist until **Save** or **Skip map**. Save writes Feedback (`kind: "done"`) plus a `RunLog`. Skip map writes Feedback only (no `RunLog`). Planned `Session.distanceKm` is unchanged. AdaptationEvents are loaded for display only (chip `title` + `summary`; never written here). **Why?** is clickable only when `reason` is non-empty and opens the Why this changed sheet.
- **Why this changed:** mobile-first **bottom sheet** (~390), not a centered modal. Header **Why this changed** + X / swipe down. Body: `reason` (1–2 lines) plus optional **Based on:** Done | Skip | Feeling off for the source day’s Feedback. Footer **Got it** closes. Empty `reason` → no clickable Why? control. A11y: `aria-modal`, focus trap (`showModal()`), Esc. Copy is provisional EN.
- **Log this run (Done only):** mobile-first **bottom sheet** (~390), not a centered modal. Header **Log this run** + X / swipe down. Map shows a GPS polyline when `route.type === "polyline"`; otherwise a pin and **No route yet**. Editable Distance (km), Time (hh:mm:ss), Pace (auto, editable). Distance prefills from the Session target when present; time and pace start empty. Pace is recomputed server-side as `timeSec / distanceKm` (client pace is not trusted). Time `> 0` is required (`hh:mm:ss`; `mm:ss` accepted). Distance 0.1–100 km. Pace outside ~150–720 s/km (~2:30–12:00 /km) is a soft warning and does not block Save. Primary **Save** closes the sheet and shows a brief **Saved** toast. Secondary **Skip map** closes without writing a `RunLog`. A11y: `aria-modal`, focus trap, Esc. `route` is `{ type: "none" }` for MVP (no GPS hardware); polyline `coords` can be stored later. No Strava attach. After Save, Today shows the map and logged stats when a `RunLog` exists.
- **RunLog (Zelda):** stored in `.data/app.db` (`run_logs`), separate from Feedback. Shape: `{ id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, route?: { type: "polyline"; coords } | { type: "none" }, createdAt, source?: "manual" | "intervals" }`. 1:1 with Session (no orphans). Skip map = no write. Manual Log this run (`source: "manual"`) wins over Intervals import.
- **Plan (`/plan`):** week strip M–S for the Guayaquil week (Monday–Sunday) and up to three remaining sessions this week.
- **Progress (`/progress`):** at most six rows, provisional EN: **Consistency**, **Easy pace**, **Weekly distance**, **Avg pace (7d)**, **Longest run (28d)**, **Time running (7d)**. Consistency from this week’s session outcomes. Easy pace uses this week’s easy `RunLog`s when present; otherwise **Provisional**. Weekly distance prefers `RunLog` distance over the planned Session. The 7d/28d rows use `RunLog`s dated by the Session’s Guayaquil day.
- **Settings (`/settings`):** **You** — Adaptation frequency (Daily / Weekly / Monthly, same options as onboarding; Save updates `Plan.feedbackCadence` and the onboarding record). **Connected apps** — Intervals.icu (`Not connected` | `Connected · i704884`). Connect uses `INTERVALS_ICU_API_KEY` on the server (copy: **API key stays on the server**; no key paste). Connected: **Sync now** / **Disconnect** (Disconnect stops import and does not delete `RunLog`s). Last sync: `Synced 2h ago`, or soft error **Couldn’t sync. Try again.** Import: Run activities only; match Guayaquil day to a Session; skip + toast **No planned session that day** when there is no Session (no orphan `RunLog`). If that day has one Session and more than one Run, a **Which run?** sheet lists time + distance (default = closest to the Session target) before upsert. Manual Log this run wins if already saved. Feedback / AdaptationEvent are untouched. **Account** — email and log out.

## Nocturnal adaptation (MVP)

- **When:** 21:00 `America/Guayaquil`. Locally: `npm run adapt` (once) or `npm run adapt:cron` (waits until 21:00, then every night). HTTP: `POST` or `GET` `/api/adapt` with `Authorization: Bearer $ADAPT_CRON_SECRET` (or `X-Adapt-Cron-Secret`). Crontab: `CRON_TZ=America/Guayaquil` + `0 21 * * * curl -fsS -X POST -H "Authorization: Bearer $ADAPT_CRON_SECRET" https://host/api/adapt` — or UTC `0 2 * * *` (21:00 ECT, UTC−5, no DST).
- **Input:** Sessions + Feedback for that Guayaquil day (Done / Skip / Feeling off), gated by `Plan.feedbackCadence` (default `"daily"`). Daily: if there is **no Feedback that day**, the job does not create an AdaptationEvent and does not touch tomorrow’s Sessions. Weekly: skip unless today is Sunday (end of the Monday–Sunday Guayaquil week); then use the latest Feedback in that week. Monthly: skip unless today is the last civil day of the month; then use the latest Feedback in that month. No Feedback in the window → no write.
- **Who writes AdaptationEvents:** only this job. Onboarding and Today CTAs never create them. AdaptationEvent shape is unchanged (`title` / `summary` / `reason` / `sourceDate`).
- **If Feedback exists:** write one AdaptationEvent and adjust **tomorrow’s Session(s) only** — never an opaque full Plan rewrite. Idempotent per user + source day.
- **Copy (provisional EN):** `title` is always `Plan adjusted`. `summary` is one line of what changes tomorrow (e.g. Easy run shortened to 5 km). `reason` is one line why (e.g. Higher effort yesterday / You skipped Tuesday). No CTL/ATL jargon, no freeform coach chat.
- **Today UI:** chip shows `title` + `summary`. **Why?** opens the sheet with `reason` when non-empty; otherwise the control is omitted.
- **Heuristic (when `ADAPT_LLM_API_KEY` is unset):** skip / feeling-off ease tomorrow (shorter; intervals/tempo/long become easy). Done shortens tomorrow after higher effort. SQLite store: `.data/app.db` (`AUTH_DATA_DIR`).
- **LLM (optional):** if `ADAPT_LLM_API_KEY` is set, the job asks an OpenAI-compatible `/chat/completions` endpoint for **typed JSON** (`title`, `summary`, `reason`, `distanceKm`, `kind`), sending the planned Session plus optional actual `RunLog` stats (`distanceKm`, `timeSec`, `paceSecPerKm`, `source`) for the feedback day. On failure it logs and **does not mutate** the plan (retry next run). Unset key = heuristic, still only when Feedback exists.

## Deploy (Railway)

See **DEPLOY.md** for variables and Bowser smoke tests.

- **Web:** build `npm run build`, start `HOST=0.0.0.0 node ./dist/server/entry.mjs` (`npm start`).
- **Volume:** mounted at `.data` (default `AUTH_DATA_DIR`; SQLite file `app.db`).
- **Cron:** `0 2 * * *` UTC (= 21:00 America/Guayaquil) `curl` `POST` `/api/adapt` with `Authorization: Bearer $ADAPT_CRON_SECRET`.

## Security / deps (tech note)

Astro ≥7.2.8 (image-opt RCE fixed in 7.2.8+). Sharp pinned to 0.35.4 for libvips/libheif advisories. Do not use `npm audit fix --force`.
