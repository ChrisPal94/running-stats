---
target: PR #63 Intervals disconnect toast only after a real connection
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
p2_count: 0
p3_count: 1
target_path: src/lib/training.ts
timestamp: 2026-10-05T14:45:00Z
slug: src-lib-training-ts
reviewed_head: d571168
reviewed_base: 2ea4695
pr: 63
closes: 58
baseline_pr35_score: 29
baseline_pr47_score: 28
baseline_pr57_score: 28
verdict: PASS
---

Method: dual-agent (A: bc-04bc9e02-b4de-5ca5-93d2-060168dc1d62 · B: bc-547aea72-276c-523f-970b-506bcf18678d)

Browser: headless Chrome at 390×844 against a worktree of `d571168`. Outbound hosts other than loopback were aborted. CLI `impeccable detect --json` on `settings.astro`, `ConnectedApps.astro`, and `AuthForm.astro` returned `[]` (exit 0). No user-visible overlay.

Mode: Operate. This is a narrow delta on the #57 Settings row, not a greenfield rescore. Trend baselines: PR #35 **29/40**, PR #47 **28/40**, PR #57 at `d6fc829` **28/40**. No `ignore.md`. No `DESIGN.md`.

## Verdict

**PASS.** No blockers. Design health **28/40** (Good, floor of the band). Trend: **29/40** (#35) → **28/40** (#47) → **28/40** (#57) → **28/40** (#63). No heuristic moved. Falsely toasting “Intervals disconnected” when nothing was connected is fixed. A real disconnect still shows that lime toast.

## Design Health Score: 28/40

Scores are the #57 scores. This delta does not move them.

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | The false disconnect toast is gone. The timed lime pill and Sync pending label still hold this at 3 |
| 2 | Match System / Real World | 3 | Unchanged from #57 |
| 3 | User Control and Freedom | 2 | Confirm / Escape / no-JS Disconnect is the same as #57 |
| 4 | Consistency and Standards | 3 | Unchanged from #57 |
| 5 | Error Prevention | 3 | The confirm guard was not touched. This delta corrects a false status after the action |
| 6 | Recognition Rather Than Recall | 3 | Unchanged from #57 |
| 7 | Flexibility and Efficiency | 2 | Unchanged from #57 |
| 8 | Aesthetic and Minimalist Design | 3 | Unchanged from #57 |
| 9 | Error Recovery | 3 | Unchanged from #57 |
| 10 | Help and Documentation | 3 | Unchanged from #57 |
| **Total** | | **28/40** | **Good** |

**Visibility stays 3.** A stored row still redirects to `/settings?toast=intervals-disconnected` (`src/lib/training.ts:2316-2317`, `src/lib/intervals.ts:141-142`). No row redirects to `/settings`. `settingsToastCopy` returns `""` for any other query (`src/lib/intervals.ts:146-152`), so the lime pill does not render. That removes a lie. It does not close the #57 gaps: the pill still hides on a timer, and Sync now still keeps its label while busy.

**Error Prevention stays 3.** Disconnect is still offered only when `connection.connected`, still uses `data-confirm` plus `window.confirm`, and still posts with no confirm when JavaScript is off. `ConnectedApps.astro` is not in this diff.

## What changed

`disconnectIntervals` returns `true` only when a stored row existed (`src/lib/intervals.ts:1164-1169`). It does not decrypt. `postIntervalsSettings` redirects with `removed ? intervalsDisconnectedRedirect() : "/settings"` (`src/lib/training.ts:2315-2317`).

| Case | Result at 390px |
|---|---|
| Real disconnect, confirm accepted | URL `?toast=intervals-disconnected`. Toast text **Intervals disconnected**, `role="status"`, no explicit `aria-live` (implicit polite). Disconnect is gone. Status **Not connected**. The key form is back |
| Second disconnect after the row is gone | URL `/settings`. No toast query. The words “Intervals disconnected” are not in the DOM |
| Disconnect with no stored connection | URL `/settings`. No toast |

Confirm message, exact, including U+2019 in “won’t”: `Disconnect Intervals.icu? Your logged runs stay in Stride Lab. New workouts won’t be added to your Intervals calendar.`

After a real disconnect the card is still one Intervals article, about 406×350. There is no empty hole where Disconnect was. The fixed lime toast overlaps the lower part of that taller card (toast bottom about 748px, card about 532–937px). The status and the heading stay clear. The overlap is the existing `bottom-24` pill, now sitting on a card that grew because the key form returned. It hides on the same 1.8s timer as before.

## Signup and login

The PR’s auth edits are assertions only (`src/lib/auth-session.test.ts`, `src/lib/intervals-verified-email.test.ts`). They require `duplicateAccount` with no `error` field on that branch, and the existing error strings on the other branch. `AuthForm.astro`, `signup.astro`, and `login.astro` are not in the diff.

Rendered again with no Google and no Resend: **Couldn’t create your account. If you already have one, log in.** `role="alert"`. One link, `log in` → `/login`. Email stayed `critique-b-intervals@example.com`. The other three sentences are the same `signupDuplicateMethods()` plus `recoverySeparator()` markup as #57, because that component did not change. Test-only edits do not move the score.

## Regressions

Absent from the diff, so still the #57 behavior: Sync now pending and `pageshow`, the Reconnect helper, in-row `role="alert"` errors, the athlete ID placeholder `i123456` at full mist, and the logout helper above Log out with `aria-describedby`.

## What's Working

1. “Intervals disconnected” now means a row was removed. A second post, and a post with nothing stored, return a quiet `/settings`.
2. A real disconnect still uses the same lime `role="status"` pill, and the row becomes **Not connected** with the key form, not a blank gap.
3. The four duplicate-signup sentences are untouched.

## Priority Issues

None introduced. No P0. No P1.

The false toast is closed at `src/lib/training.ts:2316-2317`.

The #57 items that still hold the score are not this PR: Disconnect confirms only with JavaScript, and Sync now keeps the label “Sync now” while busy.

## Low nits

- At 390px the disconnect toast overlaps the lower part of the Not connected card, because the card grew to include the key form and the pill is still `fixed` at `bottom-24`. It does not cover the status line, and it hides after 1.8s.
- Two in-flight disconnect posts can let the later, empty `/settings` response replace a navigation that had just earned the toast. One click stays a single submit, because `window.confirm` is modal.

## Persona notes

**Sam.** A no-op disconnect does not announce the lime status. A real delete still announces “Intervals disconnected”.

**Riley.** Repeating disconnect after the row is gone no longer shows a success toast. The reloaded row is the status.

**Casey.** After disconnect the key form is on screen at 390px and the toast sits over its lower edge for under two seconds. The primary actions above that edge stay visible.

## Questions to Consider

- For a disconnect that finds no row, is silence the right status, with the row itself saying Not connected?
- If a second in-flight post can hide a toast a real delete just earned, is the row enough, or should Disconnect disable as soon as confirm returns OK?
