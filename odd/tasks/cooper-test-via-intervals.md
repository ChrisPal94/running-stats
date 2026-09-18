# Feature: Cooper test via Intervals

## Goal

In onboarding Baseline, choosing "Cooper test" no longer asks for the distance in
the moment. Instead it stores a pending intent, instructs the user to go run the
12-minute test, and the result is resolved automatically from an Intervals.icu
Run activity on sync.

## Product decisions (user-approved)

- Plan is generated immediately with the base heuristic (like skip) while the
  Cooper result is pending.
- When the Cooper result arrives via Intervals, the baseline is updated and the
  plan re-adjusts (existing ±20% clamp).
- Detection is automatic by duration: a Run activity of ~720s moving time
  (tolerance 660–780s) resolves the pending baseline. No confirmation UI.

## Design

- `Baseline` union gains `{ kind: "cooper-pending" }`; stored on
  `OnboardingRecord`, `OnboardingAnswers`, and `Plan` like other baselines.
- `parseBaselineForm` maps the `cooper` radio to `{ kind: "cooper-pending" }`;
  manual distance parsing removed from the wizard UI (legacy `kind: "cooper"`
  records remain readable).
- `baselineFitnessFactor` / `isPresentBaseline` treat `cooper-pending` as
  absent (heuristic factor 1).
- Onboarding cooper panel: instructional copy only ("Run as far as you can in
  12 minutes… result syncs via Intervals.icu").
- Intervals sync: before session matching, if the user's plan baseline is
  `cooper-pending`, scan all fetched runs for a Cooper candidate
  (timeSec 660–780, distanceKm 0.5–5, closest to 720s). On hit: resolve to
  `{ kind: "cooper", distanceKm, durationSec: 720 }` on Plan + OnboardingRecord
  and recompute future sessions (date > today, America/Guayaquil) via the
  existing distance heuristics. Past sessions, RunLogs, Feedback, and
  AdaptationEvents are untouched; no AdaptationEvent is written.
- Sync toast gains a variant for "Cooper result synced, plan updated".

## Tasks

- [x] 1. Baseline model: `cooper-pending` kind, form parse, fitness factor,
      plan passthrough (`src/lib/training.ts`, tests).
- [x] 2. OnboardingWizard cooper panel: remove manual input, instructional
      copy (`src/components/OnboardingWizard.astro`).
- [x] 3. Intervals sync: Cooper detection + baseline resolution + future-session
      re-adjust + toast (`src/lib/training.ts`, `src/lib/intervals.ts`, tests).
- [ ] 4. Full verification: `npm test`, `npm run check`; manual flow
      signup → cooper → sync.

## Evidence

(commits recorded per task)

- Task 1–3 implementation verified with `npx tsx --test src/lib/training-cooper.test.ts
  src/lib/intervals-sync.test.ts` (29 pass) and full `npm test` (70 pass),
  `npm run check` (0 errors, 2 pre-existing hints in login/signup.astro).
- Toast note: the Cooper signal rides the existing `?toast=` redirect chain as a
  new `cooper` variant (priority over no-session/no-new-runs); it surfaces on the
  initial finished-sync redirect, not after a Which run? picker round-trip.
- `src/pages/settings.astro` needed a minimal whitelist addition so
  `?toast=cooper` can render (the toast param filter rejected unknown values).