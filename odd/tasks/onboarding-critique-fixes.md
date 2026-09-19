# Feature: Onboarding critique fixes (impeccable 2026-09-19)

## Goal

Fix the 5 priority issues from the impeccable critique of the onboarding flow
(snapshot: `.impeccable/critique/2026-09-19T13-40-51Z__src-components-onboardingwizard-astro.md`,
score 26/40). Approved by user: all 5 issues, Cooper resolution writes an
AdaptationEvent.

## Product decisions (user-approved)

- P1s first (friction + trust), then preview, a11y, chrome.
- Cooper resolution MUST write an AdaptationEvent explaining the future-session
  adjustment (consistent with the "adapts and explains why" landing promise).
- All 5 issues in this pass; one work-unit commit per task on the current
  feature branch `feature/cooper-test-via-intervals` (Cooper changes belong
  with the pending Cooper feature; user slices PRs later).
- `package-lock.json` stays dirty-excluded (pre-existing, user to decide).

## Tasks

- [x] 1. Step 3 neutral render + no input wipe: no pre-selected baseline kind
      (with one-line consequence per option), client-side inline validation
      before POST, and server error re-render repopulating from the submitted
      form data instead of the stored draft.
      Surfaces: `src/components/OnboardingWizard.astro`, `src/pages/onboarding.astro`,
      `src/lib/training.ts`, tests.
      Evidence: commit ad76a20 (4 files, +175/-17). Writer verified: focused suite
      13 pass; full `npm test` 73/73; `npm run check` 0 errors (2 pre-existing hints).
- [x] 2. Cooper trust: conditional copy ("when you connect Intervals.icu"),
      explicit "your plan will adjust later" expectation, persistent
      "Cooper pending" hint in the shell, and an AdaptationEvent written when
      the Cooper resolution recomputes future sessions.
      Surfaces: `src/components/OnboardingWizard.astro`, `src/lib/training.ts`,
      `src/lib/intervals.ts` (if needed), `src/pages/today.astro`, tests.
      Evidence: commit 7b6b3c2 (5 files, +182/-15). Independent gentle-ai-verify:
      77/77 tests, 0 check errors. Note: writer subagent was aborted mid-run
      after finishing edits; verification was re-delegated separately and passed.
- [x] 3. Post-Generate handoff: after "Generate my plan", land on Today with a
      first-run "Your plan is ready" handoff (existing toast pattern), not a
      silent redirect.
      Surfaces: `src/pages/today.astro`, `src/lib/training.ts`, tests.
      Evidence: commit 737b52e (3 files, +63/-1). Writer TDD: RED observed on the
      redirect assertion, then green; 78/78 tests, 0 check errors.
- [x] 4. Keyboard focus visibility: `has-[:focus-visible]` ring styles on all
      custom control labels (chips, toggles, day circles) in the wizard.
      Surfaces: `src/components/OnboardingWizard.astro`.
      Evidence: commit 422ff8f (1 file, +4/-4). Inline mechanical edit;
      `astro check` 0 errors (2 pre-existing hints).
- [x] 5. Minimal authenticated header during onboarding (logo + user entry,
      no marketing CTA/nav).
      Surfaces: `src/components/Header.astro`, `src/pages/onboarding.astro`.
      Evidence: commit b8ba038 (onboarding.astro only, +27/-2; Header.astro
      untouched by design — inline static logo, no exits). Writer: 78/78 tests,
      0 check errors.

## Evidence

- (filled per task: commit hash + verification)

## Notes

- Critique snapshot: 26/40, 2×P1, 2×P2, 1×P3; detector clean (0 findings).
- Engram mirror save failed at session time (Engram server down); file doc is
  the source of truth until Engram recovers.