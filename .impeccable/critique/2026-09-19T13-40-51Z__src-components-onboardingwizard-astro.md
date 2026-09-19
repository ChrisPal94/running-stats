---
target: el onboarding de running-stats
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/christian/code/running-stats/src/components/OnboardingWizard.astro"
target_fingerprint: "sha256:0e46253affd199c01dc41918109d61ebf5af406447f86d2d6990855860245a89"
target_path: /Users/christian/code/running-stats/src/components/OnboardingWizard.astro
timestamp: 2026-09-19T13-40-51Z
slug: src-components-onboardingwizard-astro
closed: true
---
# Critique: Onboarding de Running Stats

Method: dual-agent (A: gentle-ai-explore mu8fo73z-1-dgbx · B: gentle-ai-verify mu8fo74r-2-vw8e)
Browser overlay: SKIPPED — no native browser tool in harness; route session-gated (302 -> /signup). Detector: 0 findings, 0 false positives.

## Design Health Score: 26/40

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Silent POST/redirect on Generate; no pending state |
| 2 | Match System / Real World | 3 | "adapt"/"baseline" jargon explained only at step 5 |
| 3 | User Control and Freedom | 3 | No Back on step 1; signed-in user trapped in flow |
| 4 | Consistency and Standards | 3 | Validation stance flips per step; pace warning in success lime |
| 5 | Error Prevention | 2 | Step 3 Continue enabled with empty required fields -> error loop |
| 6 | Recognition Rather Than Recall | 3 | Step-3 distance chips identical to step-1 goal chips; hh:mm:ss is recall |
| 7 | Flexibility and Efficiency | 2 | No visible focus rings on custom controls |
| 8 | Aesthetic and Minimalist Design | 3 | Steps 1 and 3 overload; empty Skip panel reads as bug |
| 9 | Error Recovery | 2 | Failed POST wipes user input (repopulates from stored draft, not submission) |
| 10 | Help and Documentation | 2 | Cooper mechanics, Skip consequence, post-Generate behavior unexplained |

## Design Specificity Verdict
Partially specific — branded skin, generic wizard skeleton. Structure is a template any habit app could use; nothing in composition/interaction encodes coaching (no week preview, no effort language). Domain copy is genuinely coach-specific.

## Overall Impression
Coherent wizard sabotaged at its three moments of truth: step 3 error loop that erases typed input, Cooper promise with silent infra-dependent failure, and a silent commit for the product's peak moment. Biggest opportunity: turn the final commit into a plan preview.

## What's Working
1. One coherent chip/toggle/panel interaction grammar across all five steps (has-[:checked] lime fill, uppercase micro-labels, glow CTA, sr-only progress duplication).
2. Progressive feedback: live pace preview + non-blocking soft warning; step 4 disabled Continue + dynamic hint is the right pattern.
3. Resilient server-persisted draft; server-side step clamping prevents URL skips.

## Priority Issues
1. [P1] Step 3 defaults to "Last race" empty with Continue enabled; failed submits wipe typed input (re-render repopulates from stored draft). Fix: neutral render, client-side inline validation, repopulate from submission. (harden)
2. [P1] Cooper promise has silent failure modes: unconditional "picked up automatically" vs env-key + Settings + qualifying-run dependencies; resolution rewrites future sessions with no AdaptationEvent, contradicting the landing promise. Fix: conditional copy, expectation setting, persistent pending chip, AdaptationEvent on resolution. (harden/adapt)
3. [P2] Generate is a blind commit: silent redirect, possibly to "No session today". Fix: post-Generate handoff/plan preview. (onboard)
4. [P2] Invisible keyboard focus on all custom controls (sr-only inputs; global focus-visible clipped). Fix: has-[:focus-visible] ring on labels. (harden)
5. [P3] Marketing Header on onboarding contradicts flow ("Start your plan" -> /signup for a signed-in user). Fix: minimal authed header. (distill)

## Persona Red Flags
- Jordan (first-timer): step-3 error loop wipes typed time; "Run as far as you can in 12 minutes" timed as a now-instruction with payoff hidden in Settings; may end on "No session today".
- Sam (distracted mobile): hh:mm:ss with inputmode="numeric" (iOS numeric keypad has no colon); ambiguous M T W T F S S circles; error banner off-screen from thumb after full reload.
- Riley (skeptical): "adapts and explains why" contradicted by unexplained Cooper rewrites and commit without preview.

## Minor Observations
- Pace warning shares lime success color (amber would separate semantics)
- Empty "Skip for now" panel reads as render bug
- Step 3 requires hh:mm:ss while Log-this-run sheet accepts mm:ss
- Pace preview plain text with layout shift
- Race-date input before goal makes it moot for "Just consistent"
- CSRF copy opaque; day-count hint without aria-live; marketing OG tags on signed-in-only route without noindex

## Questions to Consider
1. If cooper-pending and skip produce identical Plan v1, why is Cooper an onboarding option instead of a post-plan Settings action with a Today status chip?
2. Why does Cooper resolution rewrite future sessions with zero AdaptationEvent?
3. What if Generate resolved into a first-week plan preview instead of a silent redirect?
