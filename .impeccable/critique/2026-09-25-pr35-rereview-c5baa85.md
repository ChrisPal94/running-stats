---
target: "Intervals.icu settings row, Today notice, and OAuth callback errors (PR #35 re-review)"
total_score: 28
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 2
target_identity: "file:/workspace/src/components/ConnectedApps.astro"
target_path: /workspace/src/components/ConnectedApps.astro
reviewed_commit: c5baa85c32de7099ac15442e13a69630fc59d10f
previous_score: 23
timestamp: 2026-09-25T18-30-00Z
slug: src-components-connectedapps-astro
---

Method: dual-agent (A: bc-d4630b8c-3399-5b97-9c95-9f9ff0c83a3a · B: bc-f37a903e-dbd4-5a72-8a23-55d40c4e6f71)

# Critique: PR #35 re-review at c5baa85

Reviewed commit `c5baa85` (`fix(intervals): point reconnect at the Settings row`) on `cursor/per-user-intervals-key-0ca8`. HEAD matched that commit. Scope is the Settings Intervals row (`src/components/ConnectedApps.astro`, `src/pages/settings.astro`), the Today notice (`src/components/IntervalsExpiredNotice.astro`, `src/pages/today.astro`), and the OAuth callback errors (`src/pages/auth/intervals/callback.ts`, `src/lib/intervals-oauth.ts`). Mode: Operate. No `src/` edits. No pull request.

Previous critique at `7e7e6a4` scored **23/40** and requested changes. This run scores **28/40**. The row shape, the OAuth return, and the Today notice are fixed. Two release blockers remain: connect still prints operator sentences, and a half-filled key form replaces Settings with a plaintext 403.

**Verdict: BLOCKING.**

Issue #44 (disconnect confirm and toast, Sync in-flight disable and success toast, removing “Your API key is encrypted and never shown again.”) is still open and is not counted as blocking.

## Checklist

| Item | Result | Exact rendered string | Evidence |
|---|---|---|---|
| a. Secret missing | **PASS** | `Connecting Intervals.icu isn’t available right now. Try again later.` | `src/lib/intervals.ts:48-49`, helper `src/components/ConnectedApps.astro:54` and `:190`, disabled control `:146-152`. OAuth on and OAuth unset both keep the card, `Not connected`, and `Connect Intervals.icu`. `Not available for your account` is absent from `src/` render paths and from the painted pages. |
| b. Internal errors | **FAIL** | Connect can paint `Intervals encryption is not configured.` and `API key not configured`. Sync paints `Couldn’t sync. Try again.` | Connect returns the operator strings at `src/lib/intervals.ts:1024` and `:1044` and `src/lib/training.ts:2212` assigns `result.error` with no mapping. Settings prints it at `src/pages/settings.astro:69` and `src/components/ConnectedApps.astro:96`. Sync maps both through `intervalsSyncUserError` (`src/lib/intervals.ts:81`, `src/lib/training.ts:2219`). A stubbed `handleSettingsPost` returned those three strings exactly. |
| c. Expired or mismatched OAuth state | **PASS** | `Couldn’t connect to Intervals. Try again.` | `kind: "csrf"` at `src/lib/intervals-oauth.ts:236`. Callback sends `toast=intervals-error` at `src/pages/auth/intervals/callback.ts:18-22`. Mapped at `src/lib/intervals.ts:103-105`. Painted on the row with Connect still an active link. |
| d. Missing `CALENDAR:WRITE` | **PASS** | `Couldn’t connect. Stride Lab needs permission to add workouts to your Intervals calendar. Try again and allow calendar access.` | `src/lib/intervals.ts:42-43`, callback `src/pages/auth/intervals/callback.ts:18-20`, grant check `src/lib/intervals-oauth.ts:181`. Painted alert. Connect stays `href="/auth/intervals/start"` and is not disabled. |
| e. Sync without a connection | **PASS** | `Connect Intervals.icu to import your runs.` | Constant `src/lib/intervals.ts:45`. Returned at `src/lib/training.ts:2201-2202`. Link text `Connect Intervals.icu` plus ` to import your runs.` at `src/components/ConnectedApps.astro:88-94`, `href="/settings#intervals"`. |
| f. Athlete id example | **PASS** | Placeholder and validation: `Enter an athlete ID like i123456.` | `src/lib/intervals.ts:30`, `placeholder` at `src/components/ConnectedApps.astro:125`. `i704884` appears only as a negative assert in `src/lib/intervals-oauth.test.ts:725`. It is not in any painted page. |
| g. Today notice | **PASS** | `Intervals access expired. Reconnect to keep your runs and plan in sync.` | Shared constant `src/lib/intervals.ts:35-38`. Notice splits that constant at `src/components/IntervalsExpiredNotice.astro:13-26`. `Reconnect` links to `/settings#intervals`. Card id is `intervals` (`src/lib/intervals.ts:46`, `src/components/ConnectedApps.astro:70`). Shown from `src/pages/today.astro:82`. |
| h. `aria-describedby` | **PASS** | Disabled Connect and Reconnect use `aria-describedby="intervals-unavailable"`. The visible line is `<p id="intervals-unavailable">`. | `src/components/ConnectedApps.astro:150` and `:190`. Id constant `src/lib/intervals.ts:50-51`. |
| i. Disconnect always works | **PASS** | Button label `Disconnect`. | Delete does not decrypt (`src/lib/intervals.ts:1120-1124`). The post does not check the secret (`src/lib/training.ts:2275-2277`). Painted enabled next to a disabled Reconnect when the secret is missing. |
| j. Contrast of new error and helper lines | **FAIL** | Error sentences pass. The placeholder helper does not. | Unavailable line 9.73:1, alert text 9.84:1, sync helper 10.94:1, Today notice 10.00:1, Reconnect link 14.67:1, logout helper 9.73:1. Placeholder `Enter an athlete ID like i123456.` paints at **3.30:1** (`placeholder:text-mist/50` on `bg-panel`, `src/components/ConnectedApps.astro:130`). Small text needs 4.5:1. |
| Logout from PR #38 | **PASS** | `Log out` and `Signs you out on all your devices.` | `src/pages/settings.astro:184` and `:186`. Present after the merge of `970416b` into this branch. Painted on the Account card. |

Owner env fallback is outside the default secret-missing row. With `INTERVALS_OWNER_ENV_FALLBACK=true`, OAuth unset, and the encryption secret missing, Connect is enabled (`src/pages/settings.astro:94`, `src/components/ConnectedApps.astro:158-164`) and the unavailable sentence is not the helper. That button is how `API key not configured` reaches the alert when the env key is empty.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | The notice and the unavailable line say what stopped. Sync still has no pending state, and a successful import stays silent (tracked in #44). |
| 2 | Match System / Real World | 3 | OAuth, the calendar sentence, and the Today notice speak like a coach. The key form still says API key, Athlete ID, and Settings > Developer. |
| 3 | User Control and Freedom | 3 | Cancel, expired state, and Disconnect return to Settings. A half-filled key post replaces the shell with a plaintext 403. |
| 4 | Consistency and Standards | 3 | The notice and the row share one expired phrase and one unavailable sentence. Connect still has a second, operator voice. |
| 5 | Error Prevention | 2 | A bad athlete id never hits the network. The key fields are not required, so one filled field never reaches that check. |
| 6 | Recognition Rather Than Recall | 3 | Reconnect on Today lands on `#intervals`. The athlete-id example lives in the placeholder and disappears once someone types. |
| 7 | Flexibility and Efficiency | 2 | One deep link. Sync cannot be stopped or confirmed while it runs (tracked in #44). |
| 8 | Aesthetic and Minimalist Design | 3 | The OAuth card is one action and one sentence. The key form still adds the encrypted line (tracked in #44). |
| 9 | Error Recovery | 3 | Calendar scope and a bad OAuth state say what to do next. The encryption sentence and the account 403 do not. |
| 10 | Help and Documentation | 3 | Unavailable, calendar permission, and the Today notice are task help at the moment of failure. Sync and Disconnect still have none. |
| **Total** | | **28/40** | **Good** |

Previous run: **23/40 Acceptable**. This run: **28/40 Good**. The gain is the expired notice, the OAuth return, and one row shape. The score stays at the bottom of Good because connect recovery is still unfinished.

## Design Specificity Verdict

**LLM assessment.** The chrome is Stride Lab’s: ink card, lime pill, tracked uppercase eyebrow. The sentence that could only be this product is the calendar-scope error, which names Stride Lab and the workout calendar. The Today notice is the same voice: runs and plan, not a status code. The key fallback is still a developer form. An unrelated product could ship “API key” and “Athlete ID” unchanged.

**Deterministic scan.** `impeccable detect --json` on `ConnectedApps.astro`, `settings.astro`, `IntervalsExpiredNotice.astro`, and `today.astro` returned `[]` (exit 0). No rule hits. That scan reads Astro as regex, so Tailwind sizes, opacity, and the lime glow are invisible to it. It did not catch the placeholder contrast. No false positives to reject.

**Visual overlays.** No user-visible overlay. Assessment B did not inject `detect.js` (the routes are session-gated and there was no static page). The parent then rendered each state in headless Chrome at 390px with Intervals fetches blocked. Screenshots confirmed the strings above. Contrast was read from painted pixels, not from the token hex alone.

## Overall Impression

The OAuth idle row and the Today notice now do the job the last critique asked for: one named action, one sentence, and a way back to that row. The contract still breaks when a connect post fails for a configuration reason, and when the key form is only half filled. Those two responses talk like an operator, or they leave the product.

## What’s Working

- Secret missing keeps the card. Connect is disabled, and the only explanation is “Connecting Intervals.icu isn’t available right now. Try again later.” The old “Not available for your account” status is gone (`src/components/ConnectedApps.astro:43-54`).
- An expired OAuth state and a missing calendar scope both return to Settings. The calendar sentence names the permission. Connect stays available (`src/pages/auth/intervals/callback.ts:18-22`).
- The Today notice is one shared constant, and Reconnect goes to `/settings#intervals` (`src/lib/intervals.ts:35-38`, `src/components/IntervalsExpiredNotice.astro:23`). Disconnect still submits when decryption cannot run.

## Priority Issues

### [P1] Operator sentences still reach the connect alert

`handleSettingsPost` for `intervals-connect` returns `result.error` unchanged (`src/lib/training.ts:2212`). `connectIntervals` returns `Intervals encryption is not configured.` when the secret is missing (`src/lib/intervals.ts:1024`, constant `src/lib/intervals-crypto.ts:4`) and `API key not configured` when the owner env key is missing (`src/lib/intervals.ts:39` and `:1044`). Settings assigns that string to the alert (`src/pages/settings.astro:69`, `src/components/ConnectedApps.astro:96`). A stubbed post produced both sentences in the response. Sync already maps them to `Couldn’t sync. Try again.` (`src/lib/intervals.ts:81`).

**Why it matters:** The last critique required these two sentences to stay off the page. A runner who hits the owner fallback Connect, or who posts a key after the secret is pulled, is told about encryption and API keys.

**Fix:** On connect, map both strings to `Connecting Intervals.icu isn’t available right now. Try again later.` before `intervalsError` is set. Keep the sync mapping as it is. Log the operator detail on the server.

**Suggested command:** `/impeccable harden`

### [P1] A half-filled key form replaces Settings with a plaintext 403

`personalIntervalsConnect` is true only when both fields are non-empty (`src/lib/training.ts:2154-2158`). One filled field skips the input error and returns `Intervals.icu import isn’t available for your account yet.` with status 403 (`src/lib/intervals.ts:60-61`, `src/lib/training.ts:2199-2204`). Settings writes that body as `text/plain` and drops the shell (`src/pages/settings.astro:63-67`). A stubbed post with only `intervalsAthleteId=i123456` returned that object. The fields are not `required` (`src/components/ConnectedApps.astro:110-131`).

**Why it matters:** A first attempt that misses the key or the athlete id looks like the feature is closed to this account. The draft dies with the page.

**Fix:** If the post is incomplete, render `Enter your Intervals API key and athlete ID.` (`src/lib/intervals.ts:29`) in the row alert and keep the shell. Reserve the account sentence for a real gate.

**Suggested command:** `/impeccable harden`

### [P2] The athlete-id placeholder fails AA

`Enter an athlete ID like i123456.` in the alert is `#ffb4aa` on the salmon wash, **9.84:1**. The same string as a placeholder is mist at 50% on `#0d1415`, painted **3.30:1** at 14px (`src/components/ConnectedApps.astro:125-130`). Small text needs 4.5:1.

**Why it matters:** The example is the only hint of the `i` plus digits shape until validation. At 3.30:1 it is easy to miss, so the first submit is how people learn the format.

**Fix:** Use the same mist as the labels (`#b5beb5`, 9.73:1 on the panel) or put the example in the helper line so it stays visible after typing.

**Suggested command:** `/impeccable audit`

### [P2] Expired access on the OAuth row still has no consequence

When OAuth is ready, the status is `Intervals access expired` in mist, then Reconnect and Disconnect, and the helper is empty (`src/components/ConnectedApps.astro:53-56` skips the calendar line while `reconnecting`). The Today notice already says what resumes. The row does not.

**Why it matters:** The runner arrives from Reconnect and gets a status word, not the reason they tapped it.

**Fix:** Under Reconnect, repeat the notice consequence: imports and planned workouts stay stopped until they reconnect. Keep Disconnect beside it.

**Suggested command:** `/impeccable clarify`

## Tracked in #44 (not blocking)

- Disconnect still confirms `Disconnect Intervals.icu?` (`src/components/ConnectedApps.astro:173`) and returns to a bare `/settings` (`src/lib/training.ts:2277`). #44 asks for the runs-stay / calendar-stops sentence and the toast `Intervals disconnected`.
- Sync now is not disabled in flight (`src/components/ConnectedApps.astro:141-143`). A successful import stays silent (`src/lib/intervals.ts:97`).
- The key form still shows `Your API key is encrypted and never shown again.` (`src/lib/intervals.ts:26`, `src/components/ConnectedApps.astro:55`).

## Cognitive load

3 of 8 checks failed. Moderate, down from 4. The expired path no longer depends on memory. The key form still does.

| Check | Result | Why |
|---|---|---|
| Single focus | Pass | The notice links to `#intervals` (`src/components/IntervalsExpiredNotice.astro:23`). Cadence is still the first card, but the target is marked. |
| Chunking | Pass | Three cards. The key form is two fields. |
| Grouping | Pass | Intervals is its own article (`src/components/ConnectedApps.astro:69`). |
| Visual hierarchy | Fail | Expired and “Not connected” share `text-xs text-mist` (`src/components/ConnectedApps.astro:77`). |
| One thing at a time | Fail | The key path asks for a secret, an athlete id, and an off-site lookup together (`src/components/ConnectedApps.astro:108-132`). |
| Minimal choices | Pass | OAuth is one action. Connected is Sync and Disconnect. |
| Working memory | Fail | The `i123456` shape is only a placeholder (`src/components/ConnectedApps.astro:125`). |
| Progressive disclosure | Pass | The key form stays off the OAuth path (`src/components/ConnectedApps.astro:41-42`). |

No Intervals decision shows more than 4 options. Settings as a whole, when connected, still shows cadence, Save, Sync, Disconnect, and Log out.

## Emotional journey

The peak is a return from Intervals: toast `Intervals connected`, then `Connected as {name}`. The calendar-scope alert is the other peak. It names the permission and leaves Connect in place. Cancel stays quiet (`src/pages/auth/intervals/callback.ts:17`).

The valley that closed is the expired consent screen. It used to be a blank 403. It is now the try-again alert on Settings. The valley that remains is a half-filled key post, which throws the runner out of the shell, and a connect failure that says “encryption” or “API key” instead of the unavailable line. Disconnect still ends flat. That ending is #44.

## Persona Red Flags

**Jordan (first-timer).** OAuth idle is clear: one lime pill and one sentence about runs and the calendar. The key path is not. Athlete ID and a faint `i123456` look like an account number. Filling only one field produces a blank page: “Intervals.icu import isn’t available for your account yet.” If the owner fallback Connect fails, the alert says `API key not configured`.

**Sam (accessibility).** The disabled control points at the visible explanation, and that explanation clears AA (9.73:1). The placeholder does not (3.30:1). The 403 body has no heading and no link back (`src/pages/settings.astro:63-67`). The developer link is `target="_blank"` with no “opens in a new tab” (`src/components/ConnectedApps.astro:201-202`). The disabled label paints at 2.68:1 (`text-ink/70` on `bg-lime/40`, `src/components/ConnectedApps.astro:66`). WCAG 1.4.3 exempts inactive controls, so that ratio is not the item j failure. It is still hard to read.

**Casey (mobile, 390px).** The row keeps its shape in every shot: title, status, full-width button, helper. Connect sits below the cadence card, so the thumb zone is the bottom nav, not the pill. A failed key post clears the password field (`src/components/ConnectedApps.astro:110-117` has no `value`). The Today notice is one short paragraph with a lime Reconnect link. It is readable at 10.00:1 and 14.67:1.

## Minor Observations

- Button CSS uppercases the labels. The DOM text still matches the constants (`src/components/ConnectedApps.astro:63-66`).
- Eyebrows render at 10.56px. That size is shared with the rest of Settings. The regex detector did not flag it.
- `Intervals secret could not be read.` stays internal. A decrypt failure is shown as `Intervals access expired` (`src/lib/intervals.ts:916-917`).
- An explicit provider `error`, including cancel, returns to `/settings` with no alert (`src/lib/intervals-oauth.ts:228`, `src/pages/auth/intervals/callback.ts:17`).

## Questions to Consider

- If the key form is only a fallback, should a half-filled post ever be allowed to leave the Settings shell?
- The calendar sentence sounds like a coach. What would `API key not configured` sound like if that coach had to say it?
- Expired access on Today now says what stopped. Should the Settings row say the same sentence, or is the status word enough once they have arrived?
