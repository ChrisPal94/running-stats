# Feature: Adapt the next session and upload it

## Goal

After a workout, Log / Skip / Feeling off plus the run's numbers can change
tomorrow's session. That change is saved locally at the 21:00 job and uploaded
to intervals.icu. The Ollama note stays an explanation. It does not set the
kilometers.

## Product decisions (user-approved)

- All three inputs are used, with separate jobs.
- Log, Skip, and Feeling off are the athlete's verdict. Skip and Feeling off
  ease tomorrow. A normal Log leaves tomorrow as it is.
- Distance versus plan, pace, heart rate, and cadence are the evidence. A Log
  changes tomorrow only when those numbers say the day was hard.
- Shorter than planned, with no hard heart-rate signal, does not change
  tomorrow.
- Generate feedback (Ollama) is the text inside You ran. It is not an input to
  the kilometer decision. If Ollama or the adapt model is down, the button plus
  the numbers still adjust the plan.
- The adapt model, when `ADAPT_LLM_API_KEY` is set, may move tomorrow between
  half and 20% more than the original distance. Skip and Feeling off cannot be
  made harder than the button ease.
- Heart-rate thresholds use LTHR. Cadence from Intervals is one-foot RPM; step
  rate is about twice that. Missing heart rate or cadence does not invent a
  threshold.
- The patched session is upserted to intervals.icu as a Run workout. The
  session id is the `external_id`, so a later night updates the same event.
  No API key skips the upload and still saves the local plan.

## Design

- The patched session is the next unfinished one after today. A rest day
  in between is skipped, so Feeling off on Thursday with no Friday session
  eases Saturday.
- `decideHeuristic`: `done` writes no distance patch. Skip stays 0.8 and
  Feeling off stays 0.75. Hard kinds (intervals, tempo, long) become easy for
  those two signals.
- `applyEffortToDecision` runs after that, for `done` only:
  - average HR ≥ 95% of LTHR: ease to 0.9 and a hard kind becomes easy.
  - actual distance < 85% of planned and average HR ≥ 90% of LTHR: ease to 0.85.
  - step rate < 160 and average HR ≥ 90% of LTHR: ease to 0.9.
  - The strongest ease wins. If rounding leaves distance and kind unchanged,
    tomorrow stays.
- `loadRunEffort` supplies HR and cadence for that day. Those fields are added
  to the adapt-model payload. The coach summary is not.
- If the adapt model fails, the heuristic decision is kept and `llmFailed`
  increments.
- `enforceButtonFloor` stops the model from raising distance above the Skip /
  Feeling off patch or restoring a hard kind.
- `upsertPlannedRuns` POSTs
  `/athlete/0/events/bulk?upsert=true` with `category: WORKOUT`, `type: Run`,
  `external_id` = session id, `start_date_local` at 08:00, distance in meters,
  and the session cue as plain description (no workout-step syntax).
- Upload runs only after a local adaptation event was written, and only for
  sessions that actually changed. Upload errors do not roll back the local plan.
- Today, after Feeling off: "Tomorrow's session updates tonight."

## Tasks

- [x] 1. Heuristic, effort overlay, model payload, button floor
      (`src/lib/adapt.ts`, `src/lib/adapt-effort.test.ts`).
- [x] 2. Intervals upsert of the patched session
      (`src/lib/intervals.ts`, tests in `src/lib/adapt-effort.test.ts`).
- [x] 3. Counts on the adapt log line (`src/lib/adapt-cron.ts`).
- [x] 4. Feeling-off copy on Today (`src/components/TodayCard.astro`).

## Evidence

- `npm test`: 103 pass / 0 fail, including `src/lib/adapt-effort.test.ts`.
- A failed upload does not roll back the local plan. The same night does not
  retry it, because the adaptation event is already stored. `uploadFailed`
  is on the adapt log line.
- Feeling off was clicked on the signed-in Today page (390px). Status
  changed from Up next to Noted, Log and Skip went away, and the card showed
  "Got it. Tomorrow's session updates tonight." Feedback `feeling-off` was
  stored for the 2026-09-24 Intervals · 13 km session. The next calendar day
  has no session; the next planned run is 2026-09-26.
