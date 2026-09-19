# Feature: Onboarding polish + animate (impeccable refinement)

## Goal

Refine the onboarding wizard's existing visual world — never a concealed
redesign: motion system (step arrivals, panel swap, selection feedback),
semantic polish (amber pace warning, pace preview, aria-live hints, skip
reassurance, tabular numerals, caret), staying inside the committed
Chakra Petch / ink-panel-lime world.

## Product decisions (user-approved)

- Direction: polish + animate (refinement, identity preserved).
- Motion thesis: focal moment = step arrival (each step enters with a
  short authored entrance, ~300-400ms exponential ease-out; progress strip
  fill), because steps are full POST redirects. Supporting: step-3 panel
  swap ~200ms, chip/toggle press feedback. CSS only, no new deps;
  prefers-reduced-motion already handled globally in global.css.
- Semantic separation: the pace soft-warning leaves the lime success hue
  and gains an amber token (missing-token fix at system level).
- Copy stays English, terse, factual; no claim changes.

## Tasks

- [x] 1. Motion system: step-arrival entrance + progress strip fill,
      step-3 panel swap, chip/toggle press feedback; reduced-motion safe.
      Surfaces: `src/components/OnboardingWizard.astro`, `src/styles/global.css`.
      Evidence: commit 6495793 (2 files, +72/-15). Writer: 78/78 tests,
      0 check errors.
- [x] 2. Semantic polish: amber warning token for the pace soft-warning,
      pace preview styled without layout shift, aria-live on dynamic hints
      (days + baseline), one reassurance line in the empty Skip panel,
      tabular numerals for time/pace values, lime caret.
      Surfaces: `src/components/OnboardingWizard.astro`, `src/styles/global.css`.
      Evidence: commit df4d9b4 (2 files, +31/-12). Amber #f5c542 ≈12.3:1 on ink.
      Writer verified settings.astro has no baseline editing before writing the
      skip line (no false claims). 78/78 tests, 0 check errors.
- [ ] 3. Verification: full path walk (magic link, keyboard + mobile ~390),
      `npm test` + `npm run check`, detector scan on changed files, and the
      user's visual pass on localhost:4321.

## Evidence

- (filled per task: commit hash + verification)

## Notes

- Prior critique (26/40) snapshot closed by today's 5 fixes; this is an
  independent refinement pass per polish.md.
- craft-floor bans respected: no gradient text, no glass decoration, no
  colored border-left, no new display face; kicker ban (the wizard already
  uses a step counter kicker — incumbent identity, preserved not propagated).