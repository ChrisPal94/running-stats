---
target: PR #38 Settings logout and signup duplicate-email error
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
p2_count: 2
p3_count: 1
target_path: src/pages/settings.astro
timestamp: 2026-09-25T16:46:00Z
slug: src-pages-settings-astro
reviewed_head: 7891f9e
pr: 38
---

Method: dual-agent (A: bc-daa56ab5-cc10-57de-824d-3e3e7638ddf6 · B: bc-2674c7de-3d65-5a59-86b5-26a7b6bd100a)

Browser: Puppeteer + headless Chrome against `http://127.0.0.1:4321` (no native browser tool). `/signup` duplicate-email state and signed-in `/settings` were captured. Unauthenticated `/settings` returns 302 to `/login`. CLI detector on `settings.astro`, `AuthForm.astro`, and `signup.astro` returned `[]` (exit 0). `detect.js` ran in that headless page only. No reliable user-visible overlay (no [Human] tab). Live server stopped.

Mode: Operate. Baseline: `PRODUCT.md` (accessible, dark ink, lime accent, Settings Account = email and log out) and `.impeccable/critique/2026-09-19T13-40-51Z__src-components-onboardingwizard-astro.md` (26/40, different slug). No `ignore.md`. No `DESIGN.md`.

## Design Health Score: 25/40

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Logout POST redirects to “Welcome back” with no sign-out status (`src/pages/logout.ts:23`, `src/pages/login.astro:58`) |
| 2 | Match System / Real World | 3 | The button says “Log out”; the system ends every session (`src/pages/settings.astro:168`, `src/lib/auth.ts:222-230`) |
| 3 | User Control and Freedom | 2 | Signing in again on this device does not restore the others (`src/lib/auth.ts:206`, `src/lib/auth.ts:227-230`) |
| 4 | Consistency and Standards | 3 | Same `text-xs leading-5 text-mist` as other captions, at `mt-3` under the button instead of `mt-1` (`src/pages/settings.astro:99`, `src/pages/settings.astro:170`) |
| 5 | Error Prevention | 2 | One submit revokes every session; the line discloses that and does not confirm it (`src/pages/settings.astro:163-170`) |
| 6 | Recognition Rather Than Recall | 3 | “Log in” and “Continue with Google” are on the same screen; the alert names them as prose (`src/components/AuthForm.astro:60-65`, `src/components/AuthForm.astro:174`, `src/components/AuthForm.astro:202`) |
| 7 | Flexibility and Efficiency | 2 | Signup has three methods; logout has no this-device-only path (`src/pages/settings.astro:163-170`) |
| 8 | Aesthetic and Minimalist Design | 3 | Account stays quiet; the all-devices fact is the smallest line under the button (`src/pages/settings.astro:156-170`) |
| 9 | Error Recovery | 3 | Duplicate copy names two next steps, keeps the email, and uses `role="alert"` (`src/lib/auth.ts:37-38`, `src/components/AuthForm.astro:59-65`, `src/pages/signup.astro:40`) |
| 10 | Help and Documentation | 2 | The caption is the only help, and it is not tied to the button (`src/pages/settings.astro:164-170`) |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment.** Partially specific. The chrome is this product: ink page, `#111718` cards at 82% opacity, lime primary, Chakra Petch, uppercase micro-labels, the same coral alert used on Settings and onboarding. The two strings under review are ordinary account copy. “Signs you out on all your devices.” could sit under any logout button, and the duplicate-email sentence is generic recovery that happens to name Google. That familiarity is right for Operate settings and signup. Neither moment uses today’s session, the plan, or running.

**Deterministic scan.** `impeccable detect --json` on `src/pages/settings.astro`, `src/components/AuthForm.astro`, and `src/pages/signup.astro`: **0 findings**, exit 0. The new helper was not flagged.

Headless `detect.js` (rendered page, including chrome the CLI file scan does not see):

- `/signup`: 6 hits. `dark-glow` on the header primary CTA and Continue (`#b8f52c`). `undersized-ui-text` at 10.56px for “Coach AI”, “Email”, “Password”. `kicker-above-heading` on “Coach AI” / “Start your plan”.
- `/settings`: 8 hits. `undersized-ui-text` at 10.56px for “You”, “Connected apps”, “Account”, and at 9.92px for the bottom nav. `dark-glow` on Save.

`dark-glow` is a false positive. Those shadows are the shared lime primary class `shadow-[0_8px_28px_rgba(184,245,44,0.2)]` (`src/components/AuthForm.astro:101`, `src/pages/settings.astro:140`). The 10.56px and 9.92px sizes match existing `text-[0.66rem]` and `text-[0.62rem]` labels. They are not the new `text-xs` helper (computed 12px), and they are not introduced by this PR. The detector did not catch the label/scope mismatch or the missing `aria-describedby`. Those are judgment findings.

**Visual overlays.** Injection succeeded only inside headless Chrome. No user-visible overlay is available.

## Overall Impression

The Settings page still reads as three quiet cards, and the new line is true, high-contrast, and visually subordinate to Log out. The signup failure is a proper alert with the two remedies already on the page. The weak spot is the logout control’s name: it still says “Log out” while `logoutSession` ends every device, and the sentence that says so sits under the button.

## What's Working

1. The helper tells the truth about `logoutSession`, which bumps `sessionEpoch` and then clears this cookie (`src/lib/auth.ts:222-230`, `src/pages/settings.astro:170`). Log out stays a ghost button. Save stays the lime primary (`src/pages/settings.astro:138-143`).
2. `text-mist` at `text-xs` clears WCAG AA on the Account card. See measured contrast below.
3. The duplicate-email alert matches the Settings and onboarding banner: `role="alert"`, coral border and fill, `text-sm leading-6 text-[#ffb4aa]` (`src/components/AuthForm.astro:59-65`, `src/pages/settings.astro:101-107`). The email is returned into the field (`src/pages/signup.astro:40`, `src/components/AuthForm.astro:75`). The string does not say whether the address is registered (`src/lib/auth.ts:36-38`). “Continue with Google” (`src/components/AuthForm.astro:174-196`) and “Already training? Log in” (`src/pages/signup.astro:58`, `src/components/AuthForm.astro:202-208`) are in the same view.

## Priority Issues

### [P1] Log out still names a this-device action

**What:** The submit label is “Log out” (`src/pages/settings.astro:164-168`). There is no confirm in the form or in `src/pages/logout.ts`. The all-devices sentence is a following paragraph, not part of the button name, and it has no `aria-describedby` (`src/pages/settings.astro:170`).

**Why it matters:** `logoutSession` increments `sessionEpoch`, so other cookies stop matching (`src/lib/auth.ts:206`, `src/lib/auth.ts:227-230`). Logging in again on this device starts a new epoch. It does not bring the phone or the laptop back. The caption is below a full-width control (`mt-8` on the form, then the button, then `mt-3`), so a thumb can fire the action before the sentence. A literal reading of “Log out” is “this browser.”

**Fix:** Change the visible label to “Log out everywhere”, move the sentence above the button, and point the button at it with `aria-describedby`. If this-device logout is the common case, split the actions. A confirm is the alternative only if the label stays “Log out”.

**Suggested command:** `/impeccable harden`

### [P2] The duplicate-email remedies are prose

**What:** `SIGNUP_DUPLICATE_ERROR` is escaped text inside the alert (`src/lib/auth.ts:37-38`, `src/components/AuthForm.astro:59-65`). The rendered alert contains no links. “log in” and “continue with Google” are not the controls.

**Why it matters:** The real targets are the Google link at `src/components/AuthForm.astro:174` and the footer at `src/components/AuthForm.astro:202-208`. They are on the same screen, so this is not a dead end. Tab order still hits email, password, and the lime Continue before either remedy, and Continue is the primary under a sentence that says not to create another account. The password is dropped on failure (no `value` on `src/components/AuthForm.astro:86-97`).

**Fix:** Make “log in” and “continue with Google” real links in the alert (`/login` and `/auth/google?from=signup`). Keep Continue from reading as the next step for this error.

**Suggested command:** `/impeccable clarify`

### [P2] The helper is grouped like an afterthought

**What:** Explanatory copy elsewhere on Settings is `mt-1` under its label (`src/pages/settings.astro:99`, `src/pages/settings.astro:133`) or above the action (`src/components/ConnectedApps.astro:75` at `mt-4`, then the button at `mt-5`). The logout line uses `mt-3`, the same offset as the cadence error banner (`src/pages/settings.astro:103`), and it follows the control (`src/pages/settings.astro:170`).

**Why it matters:** The Account card still scans (eyebrow, email, one button, one line). The 12px gap is loose next to the 4px caption rhythm, and the sentence arrives after the hit target. It is the same token family, so it does not look like a different product. It does look less bound to the button than “The plan updates after your runs on this schedule.” is bound to Adaptation frequency.

**Fix:** Place the sentence above the button at `mt-1`, and associate it with `aria-describedby`. Do not restyle the color.

**Suggested command:** `/impeccable layout`

### [P3] Logout ends on “Welcome back”

**What:** Success is `redirect("/login")` with no status (`src/pages/logout.ts:23`). Login’s heading is “Welcome back” (`src/pages/login.astro:58`). Its only toast is the expired magic link.

**Why it matters:** The tense moment is the click. The end is a friendly return screen, including on a phone whose session was just killed from another device.

**Fix:** One status line on arrival: signed out on this device and every other session.

**Suggested command:** `/impeccable clarify`

## Measured contrast

`text-mist` is `--color-mist: #b5beb5` (`src/styles/global.css:11`). The helper is `text-xs leading-5` with no weight class, so 12px regular (`src/pages/settings.astro:170`). Small text. WCAG AA bar is **4.5:1**.

The paragraph and the form are transparent. The painted surface is the Account card `bg-[#111718]/82` (`src/pages/settings.astro:154`) over `bg-ink` `#05090b` (`src/layouts/AppShell.astro` via `--color-ink` at `src/styles/global.css:6`). `backdrop-blur-md` does not change the under-color because the page behind the card is flat ink.

sRGB source-over: `C = 0.82·overlay + 0.18·ink` → `rgb(14.84, 20.48, 21.66)`.

WCAG relative luminance: `s = c/255`; if `s ≤ 0.04045` then `s/12.92`, else `((s+0.055)/1.055)^2.4`. `L = 0.2126R + 0.7152G + 0.0722B`. Ratio `(Llighter + 0.05) / (Ldarker + 0.05)`.

| Surface | Text | Background | Text L | Bg L | Ratio | AA 4.5:1 |
|---|---|---|---|---|---|---|
| Logout helper, painted pixel under the glyphs | `#b5beb5` | screenshot `#0e1416` `rgb(14, 20, 22)` | 0.499869 | 0.006516 | **9.73:1** | pass |
| Logout helper, token composite | `#b5beb5` | `#111718` at 82% over `#05090b` | 0.499869 | 0.006743 | **9.69:1** | pass |
| Duplicate-email alert, painted padding pixel | `#ffb4aa` | screenshot `#181314` `rgb(24, 19, 20)` | 0.568048 | 0.007104 | **10.82:1** | pass |
| Duplicate-email alert, token composite | `#ffb4aa` on `bg-[#ff8a80]/8` over page ink | unrounded `rgb(25, 19.32, 20.36)` | 0.568048 | 0.007351 | **10.78:1** | pass |

The reported ratio for the helper is the painted measurement, **9.73:1**. The token composite agrees at **9.69:1**. Both clear 4.5:1. Mist on opaque `bg-panel` `#0d1415` (the cadence help inside the radios) is 9.75:1. Contrast is not a P0, P1, or P2.

## Cognitive load

Checklist against the Account card and the duplicate-email signup state: single focus pass, chunking pass (three Settings cards; Account is identity, one button, one line), grouping pass (same form and card; the gap is loose, the items are still grouped), visual hierarchy pass, one thing at a time pass, minimal choices **fail** (Password, Email link, Continue, Continue with Google, Already training? Log in — five visible controls, `src/components/AuthForm.astro:37-52` and `174-208`), working memory pass (email stays filled), progressive disclosure pass.

**1 failure. Low cognitive load.**

## Emotional journey

Logout’s peak is the click, and the end is the wrong emotion: every session dies, then `/login` says “Welcome back.” Failed signup peaks on a calm alert and ends on a form that still looks ready to submit. The sentence offers a way forward. Continue is still the lime button above the two remedies.

## Persona Red Flags

**Sam (keyboard, screen reader, contrast).** The logout button’s accessible name is “Log out”. The following paragraph is not `aria-describedby` (`src/pages/settings.astro:164-170`), so the all-devices fact is not announced with the control. The duplicate alert does announce: `role="alert"` at `src/components/AuthForm.astro:62` (an alert is an assertive live region; there is no separate `aria-live`, and none is required). The words inside that announcement are not links. Contrast is not Sam’s failure: 9.73:1 and 10.82:1. The logout control is a native button under the global lime `:focus-visible` outline (`src/styles/global.css:61-64`).

**Jordan (first-timer).** The button label is the instruction. The all-devices sentence is smaller and after it. “Couldn’t create your account” does not say the email collided (`src/lib/auth.ts:36-38`). Jordan can map “log in” to “Already training? Log in” only by looking past Continue.

**Casey (phone, one thumb).** Account is the last card (`src/pages/settings.astro:153-171`). Log out is full width with `py-3` and `text-xs`, short of a 44px target, and the caption sits under the hit area. A laptop logout ends the phone session. Coming back, the phone shows “Welcome back” (`src/pages/login.astro:58`).

## Minor Observations

- You, Connected apps, and Account share the mist uppercase eyebrow. The visible `h1` is “You” while the document title is “Account — Stride Lab” (`src/pages/settings.astro:85`, `src/pages/settings.astro:94`, `src/pages/settings.astro:156`). The 10.56px eyebrows are pre-existing, not the new helper.
- The whole Settings page still reads well around the addition: three cards, `gap-4`, Account last, helper quieter than the email and the button.
- Failed signup keeps the email and drops the password.
- Log out has no pending state during the POST.
- `role="alert"` on the signup error matches the cadence and Intervals alerts. Placement is the first block inside the password form, under the page intro, above the fields. That is the right place.

## Questions to Consider

- If signing back in here does not restore the other devices, why is the control still labeled “Log out”?
- What if a duplicate email made “log in” and “continue with Google” the links inside the alert, and left Continue for a changed address?
- What if logout ended on “Signed out everywhere” instead of “Welcome back”?

## Merge verdict

**No. Nothing in this review is BLOCKING for merging PR #38.**

Impeccable P0 means the task cannot be completed. Logout still signs out. The duplicate-email path still shows a recoverable alert, and Log in plus Continue with Google are on that screen. `text-mist` at `text-xs` on the Account card measures **9.73:1** (token composite **9.69:1**), above the 4.5:1 bar for small text. The error text measures **10.82:1**. There is no P0.

The highest finding is **P1**, which Impeccable scores as “fix before release,” not as a showstopper. It does not block this merge. The change that would clear the P1, if a later pass takes it, is in `src/pages/settings.astro`: label the button “Log out everywhere”, move “Signs you out on all your devices.” above that button at `mt-1`, and set `aria-describedby` from the button to that paragraph.
