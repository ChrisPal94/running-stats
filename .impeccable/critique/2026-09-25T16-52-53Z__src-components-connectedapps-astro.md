---
target: "Intervals.icu settings row and Today notice (PR #35)"
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/workspace/src/components/ConnectedApps.astro"
target_fingerprint: "sha256:ccc34ad6cd7cd025911686d5ca5191643d207f47e07456474db3d6d4f3f26571"
target_path: /workspace/src/components/ConnectedApps.astro
timestamp: 2026-09-25T16-52-53Z
slug: src-components-connectedapps-astro
---
Method: dual-agent (A: bc-619f6d7c-6d47-5142-82da-1fe8a04a8a07 · B: bc-9b63c219-272d-54f2-98f8-dae3d8d50b9b)

# Critique: PR #35 Intervals.icu settings row and Today notice

Reviewed commit `7e7e6a4` on `cursor/per-user-intervals-key-0ca8`. Scope is the Settings Intervals row (`ConnectedApps.astro`, `settings.astro`) and the Today notice (`IntervalsExpiredNotice.astro`). Mode: Operate. No `src/` edits.

Browser: the app was booted locally and `detect.js` was injected headless on `/settings` and `/today`. There is no user-visible overlay in this environment. The CLI scan of the four markup files returned `[]` (exit 0). Astro files are scanned as regex, so Tailwind sizes and shadows are invisible to that pass; the browser pass is the one that measured them.

## Spec check

| # | State | Result | Where |
|---|-------|--------|-------|
| 1 | Not connected, OAuth available | **Match** | Button and line: `src/lib/intervals.ts:42-44`, rendered `src/components/ConnectedApps.astro:114-126`. OAuth gate: `src/pages/settings.astro:91-95`. |
| 2 | Not connected, fallback form | **Match** | Fields and help link: `src/components/ConnectedApps.astro:150-191`, copy `src/lib/intervals.ts:45-46`. Rejected key: `src/lib/intervals.ts:33` and `src/lib/intervals.ts:1038-1041`, shown at `src/pages/settings.astro:68-69` and `src/components/ConnectedApps.astro:63-69`. Other failures use “Couldn’t connect. Try again.” (`src/lib/intervals.ts:30`, `src/lib/intervals.ts:1041`). Response bodies are logged (`src/lib/intervals.ts:832-838`), not rendered. This path does not return 500. |
| 3 | `INTERVALS_KEY_ENC_SECRET` missing | **Mismatch** | OAuth on: disabled “Connect Intervals.icu” plus the exact sentence, card kept (`src/components/ConnectedApps.astro:117-131`, `src/lib/intervals.ts:40-41`). OAuth off: the settings page does not keep that shape. See required change 1. |
| 4 | Callback | **Mismatch** | Success, cancel, and a rejected code match. An expired state cookie does not. See required change 3. |
| 5 | Connected | **Match** | “Connected as {name or athlete id}”: `src/lib/intervals.ts:735-749`. “Sync now” and “Disconnect”: `src/components/ConnectedApps.astro:90-98`. Confirm “Disconnect Intervals.icu?”: `src/components/ConnectedApps.astro:94` and `src/components/ConnectedApps.astro:211-215`. |
| 6 | 401/403 or failed decryption | **Match** | Status “Intervals access expired” and button “Reconnect”: `src/lib/intervals.ts:34`, `src/lib/intervals.ts:749`, `src/components/ConnectedApps.astro:38-42`. Today uses the same condition (`src/pages/today.astro:82`) as a small notice (`src/components/IntervalsExpiredNotice.astro:11-15`). No “Reconnect Intervals.” string in `src/`. |

### State 1

When `INTERVALS_CLIENT_ID` and `INTERVALS_CLIENT_SECRET` are set, the row is a link **Connect Intervals.icu** and one line **We import your runs and add planned workouts to your Intervals calendar.** The key fields are not in this branch (`src/components/ConnectedApps.astro:110`). A status line **Not connected** still sits under the product name (`src/lib/intervals.ts:732`, `src/components/ConnectedApps.astro:58`). That status is the connection state, not a second marketing line.

### State 2

With OAuth off and encryption ready, the row shows a password **API key**, a text **Athlete ID**, and the link **Your API key and athlete ID are in Intervals Settings > Developer.** to `https://intervals.icu/settings`. A 401, 403, or 404 becomes **Couldn’t connect. Check your API key and athlete ID.** The submit label is **Connect**, not **Connect Intervals.icu** (`src/components/ConnectedApps.astro:42`). An extra line, **Your API key is encrypted and never shown again.**, sits above the fields (`src/lib/intervals.ts:28`, `src/components/ConnectedApps.astro:142`). Empty or malformed input uses **Enter your Intervals API key and athlete ID.** or **Enter an athlete ID like i704884.** (`src/lib/intervals.ts:31-32`).

### State 3

`intervalsAvailable` is `oauthConfigured || encryptionReady || fallbackEligible` (`src/pages/settings.astro:95`).

- OAuth on, secret missing: disabled button still labeled **Connect Intervals.icu**, and the line is exactly **Connecting Intervals.icu isn’t available right now. Try again later.** The card, title, and **Not connected** status stay. This half matches the spec.
- OAuth off, owner env fallback off: `intervalsAvailable` is false, so the actions are removed and the status becomes **Not available for your account** (`src/lib/intervals.ts:258-263`, `src/lib/intervals.ts:50`). The disabled button and the specified sentence are not what the page renders. The key-form branch that would show them (`src/components/ConnectedApps.astro:144-181`) is not reached from `settings.astro`, because that page never passes `intervalsAvailable: true` together with `oauthConfigured: false` and `encryptionReady: false`.
- OAuth off, owner env fallback on: the row shows an enabled **Connect** (`src/components/ConnectedApps.astro:105-109`). A failed post can surface **API key not configured** (`src/lib/intervals.ts:1022`, `src/pages/settings.astro:68-69`).

### State 4

- Success redirects to `/settings?toast=intervals-connected`. The toast is **Intervals connected** (`src/pages/auth/intervals/callback.ts:16`, `src/pages/settings.astro:82-84`, `src/pages/settings.astro:196-205`, `src/lib/intervals.ts:39`).
- Any `error` query, including user cancel `access_denied`, redirects to `/settings` with no alert (`src/lib/intervals-oauth.ts:192`, `src/pages/auth/intervals/callback.ts:17`).
- A missing code, or a code the token endpoint rejects, redirects to `?toast=intervals-error`, which becomes **Couldn’t connect to Intervals. Try again.** (`src/lib/intervals-oauth.ts:203`, `src/lib/intervals-oauth.ts:223-225`, `src/pages/auth/intervals/callback.ts:19`, `src/pages/settings.astro:88-89`, `src/lib/intervals.ts:38`).
- An expired OAuth state (10 minutes) returns `kind: "csrf"` and a naked text/plain 403: **This request could not be verified. Try again.** (`src/lib/intervals-oauth.ts:200`, `src/pages/auth/intervals/callback.ts:18`, `src/lib/intervals.ts:54`, `src/lib/intervals.ts:280-283`). The shell is gone. `error=server_error` on the callback is treated as a silent cancel (`src/lib/intervals-oauth.ts:192`).

### State 5

Status is **Connected as {athlete name}**, or **Connected as {athlete id}** when the name is blank. Actions are **Sync now** and **Disconnect**. Disconnect asks `window.confirm("Disconnect Intervals.icu?")`.

### State 6

401/403 and a decrypt failure set `needsReconnect` and the status **Intervals access expired** (`src/lib/intervals.ts:828-830`, `src/lib/intervals.ts:927-929`, `src/lib/intervals.ts:1161-1164`). The row swaps Sync for **Reconnect** and still offers Disconnect (`src/components/ConnectedApps.astro:197-204`). Today shows **Intervals access expired.** plus a **Settings** link. The notice hardcodes the sentence with a period (`src/components/IntervalsExpiredNotice.astro:12`) instead of `INTERVALS_ACCESS_EXPIRED`. A search of `src` finds no **Reconnect Intervals.**

### Leaks

Env var names, ciphertext, and Intervals response bodies are not rendered. `INTERVALS_KEY_ENC_SECRET` appears only in a component comment (`src/components/ConnectedApps.astro:22`). Two operator sentences can still reach the red alert: **Intervals encryption is not configured.** (`src/lib/intervals-crypto.ts:4`, returned at `src/lib/intervals.ts:1002` and `src/lib/intervals.ts:931`, passed through at `src/lib/training.ts:2182-2187`) and **API key not configured** (`src/lib/intervals.ts:37`, `src/lib/intervals.ts:1022`). A missing encryption secret on an already stored connection does not flip the row to expired (`src/lib/intervals.ts:931`); Sync then shows the encryption sentence. A forbidden settings post also leaves the shell for a plain 403 body (`src/pages/settings.astro:63-67`).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Sync has no pending state, a successful import is silent, and expired access uses the same mist line as idle. |
| 2 | Match System / Real World | 3 | Connect and “Connected as {name}” are plain; Athlete ID still needs the help line. |
| 3 | User Control and Freedom | 2 | Disconnect confirms and cancel returns; an expired state cookie leaves a 403 with no path back. |
| 4 | Consistency and Standards | 2 | Today says “Intervals access expired.” and links to Settings; the row says “Intervals access expired” and Reconnect. Operator sentences break the friendly error voice. |
| 5 | Error Prevention | 3 | Disconnect confirms, and a bad athlete id never hits the network. The confirm never says what survives. |
| 6 | Recognition Rather Than Recall | 2 | OAuth is one visible action. The key form and the Settings link both depend on memory. |
| 7 | Flexibility and Efficiency | 2 | Sync and reconnect are single controls, with no jump from the notice to that row. |
| 8 | Aesthetic and Minimalist Design | 3 | The card matches the shell. The key form adds an encryption sentence a runner does not need. |
| 9 | Error Recovery | 2 | A bad key and a failed token exchange say what to do next. The encryption sentence and the naked 403 do not. |
| 10 | Help and Documentation | 2 | One contextual link on the key form. Sync, Disconnect, and the notice have no task help. |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment.** The chrome is Stride Lab’s: ink card, lime pill, tracked uppercase eyebrows, the same shape as You and Account. The connect flow inside that chrome is a category settings row. Swap the word Intervals.icu for any other calendar and the layout, the disabled state, the confirm, and the Today footnote still work. The one authored sentence is “We import your runs and add planned workouts to your Intervals calendar.” Expired access, the moment this coach and the runner’s calendar disagree, is the least specific thing on the page: a gray sentence and the word Settings.

**Deterministic scan.** CLI `impeccable detect --json` on `ConnectedApps.astro`, `IntervalsExpiredNotice.astro`, `settings.astro`, and `today.astro` returned `[]`, exit 0, including with `--no-config`. A throwaway `.astro` file with `font-family: Inter` did return `overused-font`, so the empty result is a real regex scan. `.astro` is non-HTML regex mode, so classes such as `text-[0.66rem]` and `shadow-[...]` are not measured statically.

Headless injection on the live pages (mutation preflight succeeded; live server port 8400, then stopped) reported:

- `/settings`, 11 anti-patterns, same count for “Not connected” and “Intervals access expired”: `undersized-ui-text` at 10.56px on “You” (`settings.astro:109`), “Connected apps” (`ConnectedApps.astro:54`), “API key” (`ConnectedApps.astro:153`), “Athlete ID” (`ConnectedApps.astro:165`), and “Account” (`settings.astro:175`); 9.92px on the bottom nav (`BottomNav.astro:48`); `dark-glow` `#b8f52c` on Save and on Connect / Reconnect (`ConnectedApps.astro:45`).
- `/today`, 12 anti-patterns. Showing the expired notice did not add a rule (`text-xs`, 12px). Hits are the Today eyebrow, “Up next”, the Log glow, hidden Log-this-run sheet labels, and the nav.

In-scope detector hits the review agrees with: the Connected apps eyebrow and the API key / Athlete ID labels are 10.56px, and the lime connect control carries a glow shadow. Out of scope for this row, still real on the page: You, Account, Save, Today, and the nav. False positives: a second `window.impeccableDetect()` after overlays existed flagged overlay labels (`undersized functional te`, `✦ glowing shadow accents`) and an amber `#ffba00` body glow that is not the product’s `#b8f52c`. The closed Log this run sheet is `isHidden: true` and should not count against the open Today view.

**Visual overlays.** No reliable user-visible overlay. Injection ran in headless Chrome. There is no `[Human]` tab.

## Overall Impression

OAuth idle is the right shape: one named action and one sentence about runs and the calendar. The contract breaks when the encryption secret is missing outside the OAuth branch, when a returning consent screen expires into a blank 403, and when “Intervals encryption is not configured.” can still land in the runner’s alert. The biggest opportunity is the expired-access moment: it is implemented, and it is the quietest message on Today.

## What’s Working

- OAuth idle is one named action and one sentence, and the key form stays off that path (`src/components/ConnectedApps.astro:110-126`).
- Disconnect asks first, the key field is a password, and a failed connect does not put the key back on the page (`src/components/ConnectedApps.astro:94-98`, `src/components/ConnectedApps.astro:154-157`, `src/pages/settings.astro:53-54`).
- Expired access is one shared condition, the old “Reconnect Intervals.” string is gone, and a bad key or a failed token exchange never shows Intervals’ raw body.

## Priority Issues

### [P1] The expired calendar is the quietest message on Today, and it lands in the wrong place

The notice is “Intervals access expired.” in mist, then a link whose label is Settings (`src/components/IntervalsExpiredNotice.astro:11-15`). Settings has no `#intervals` target. The first card is cadence (`src/pages/settings.astro:106-160`). On the row, expired uses the same style as “Not connected” (`src/components/ConnectedApps.astro:58`). A runner can change how often the plan adapts and never see Reconnect.

**Why it matters:** The product’s promise is that the plan and the calendar stay in step. This is the moment they diverge, and the UI treats it as a footnote.

**Fix:** Say what stopped and name Reconnect. Link to the Connected apps card. Give that status a different treatment from idle.

**Suggested command:** `/impeccable clarify`

### [P1] An expired consent return leaves the product

After 10 minutes the state cookie fails closed and the callback returns text/plain “This request could not be verified. Try again.” (`src/pages/auth/intervals/callback.ts:18`, `src/lib/intervals.ts:280-283`). There is no logo, no Settings link, and no “Couldn’t connect to Intervals. Try again.” The same naked 403 is what a settings post uses for a forbidden account (`src/pages/settings.astro:63-67`).

**Why it matters:** A runner who paused on the Intervals consent screen comes back to a blank error. That is the expired callback the spec names, and it does not show the specified sentence.

**Fix:** Send that return to Settings with the connect alert. Keep the plain 403 off the returning-from-Intervals path. Leave an explicit cancel silent.

**Suggested command:** `/impeccable harden`

### [P1] Operator sentences still render in the runner’s alert

“Intervals encryption is not configured.” and “API key not configured” are assigned straight to `intervalsError` (`src/lib/intervals-crypto.ts:4`, `src/lib/training.ts:2182-2187`, `src/lib/intervals.ts:1022`, `src/components/ConnectedApps.astro:63-69`). A stored connection with a missing secret stays “Connected as …” and does not become expired (`src/lib/intervals.ts:931`).

**Why it matters:** The spec forbids crypto and configuration failures in the UI. These two sentences are that leak, even though the env var name itself stays in a comment.

**Fix:** Map both to “Connecting Intervals.icu isn’t available right now. Try again later.” on connect, or “Couldn’t sync. Try again.” on sync, before they touch the page.

**Suggested command:** `/impeccable harden`

### [P2] Without OAuth, a missing encryption secret drops the button

Spec 3 is the disabled control plus that exact sentence, and the row keeps its shape. The settings page only does this when OAuth is configured (`src/pages/settings.astro:95-96`, `src/components/ConnectedApps.astro:117-131`). Otherwise the status becomes “Not available for your account” and the actions disappear (`src/lib/intervals.ts:258-263`), or the owner fallback shows an enabled Connect (`src/components/ConnectedApps.astro:105-109`).

**Why it matters:** The unavailable state is how a runner learns that connecting is temporarily impossible. Collapsing the row, or offering a Connect that then fails with “API key not configured”, teaches the wrong lesson.

**Fix:** If the card is shown, keep its shape, disable connect, and show the unavailable sentence. Do not reuse the account-gated empty state for a missing secret.

**Suggested command:** `/impeccable harden`

### [P2] Disconnect confirms the verb and not the consequence

The dialog is only “Disconnect Intervals.icu?” (`src/components/ConnectedApps.astro:94`, `src/components/ConnectedApps.astro:213`). Success is a silent return to “Not connected” (`src/lib/training.ts:2237-2239`). Nothing says logged runs stay, or that planned workouts stop arriving.

**Why it matters:** Disconnect is the one destructive confirm in this flow. The runner has to guess whether their history survives.

**Fix:** Put that consequence in the confirm, then a short “Intervals disconnected” end state.

**Suggested command:** `/impeccable clarify`

## Cognitive load

4 of 8 checks failed. That is high, and it is concentrated on recovery plus the key form. No Intervals decision itself shows more than 4 options. The settings screen, when connected, shows 7 controls across 3 cards (3 cadence choices, Save, Sync now, Disconnect, Log out).

| Check | Result | Why |
|---|---|---|
| Single focus | Fail | From the notice, the first task on screen is cadence, not reconnect (`src/pages/settings.astro:106`, `src/pages/today.astro:82`). |
| Chunking | Pass | The row is name, status, one or two actions, and at most two fields. |
| Grouping | Pass | The card holds the Intervals controls together. |
| Visual hierarchy | Fail | Expired and idle share one mist line. The notice is quieter than the lime banners around it. |
| One thing at a time | Fail | Recovery still asks for a cadence decision before the reconnect control. |
| Minimal choices | Pass | OAuth is one action. Connected is two. The key form is two fields, submit, and a help link. |
| Working memory | Fail | The key path sends the runner to another site to copy two secrets into a masked field (`src/components/ConnectedApps.astro:154-191`). The notice does not say what Settings will ask. |
| Progressive disclosure | Pass | The key form stays off the OAuth path. The unavailable sentence replaces the marketing line when that branch is actually rendered. |

## Emotional journey

The peak is the return from Intervals: a lime toast, “Intervals connected”, gone in 1.8 seconds (`src/pages/settings.astro:213-218`), then the durable “Connected as {name}”. Cancel is the right kind of quiet. Failed connect is the best valley: the alert is specific for a bad key, and the athlete id is kept while the key is not. Disconnect is colder: a browser confirm with no word about logged runs, then a silent “Not connected”. Expired access is the missed valley.

## Persona Red Flags

**Jordan (first-timer).** The first decision on Settings is Daily / Weekly / Monthly, not the calendar. If OAuth is on, the reason to connect is a gray line under an uppercase pill. If OAuth is off, **Athlete ID** and the placeholder `i704884` look like an account number they were supposed to already know. The help link opens Intervals’ settings home; the path Settings > Developer is only in the link text (`src/components/ConnectedApps.astro:183-191`). After a broken connection, **Settings** does not say that the next control is Reconnect.

**Sam (accessibility).** The unavailable reason is a `role="status"` paragraph after a `disabled` button, with no `aria-describedby` (`src/components/ConnectedApps.astro:117-131`). That button is skipped in tab order, so keyboard travel goes from Save to Log out and never lands on the explanation. The disabled label is `text-ink/70` on `bg-lime/40` (`src/components/ConnectedApps.astro:47-48`). The Today notice is not a live region, so it is easy to pass between two louder lime banners (`src/pages/today.astro:77-88`). The 403 body has no heading and no link. Placeholder `i704884` uses `placeholder:text-mist/50` (`src/components/ConnectedApps.astro:176`). Focus is saved by the global lime outline, including on inputs that set `outline-none`.

**Riley (stress tester).** Waiting out the consent screen produces a blank 403, not the try-again alert. `error=server_error` is a silent cancel. Pulling the encryption secret after a successful connect leaves “Connected as {name}” and Sync in place; Sync then prints “Intervals encryption is not configured.” Sync can be submitted twice; nothing disables the button while the post is in flight.

## Minor Observations

- Button CSS uppercases the spec strings (`src/components/ConnectedApps.astro:45-48`). The DOM text still matches.
- The import sentence sits below the button, the same size and color as “Not connected” (`src/components/ConnectedApps.astro:58`, `src/components/ConnectedApps.astro:126`).
- The key form’s “Your API key is encrypted and never shown again.” is operator reassurance (`src/lib/intervals.ts:28`).
- Today hardcodes the expired sentence with a period (`src/components/IntervalsExpiredNotice.astro:12`).
- A successful import shows no toast (`src/lib/intervals.ts:80-81`). The connect toast fades in 1.8s even though the status line remains.
- Detector: Connected apps, API key, and Athlete ID eyebrows render at 10.56px; the connect pill uses a lime glow. Those are shared with the rest of Settings, not a one-off in this row.

## Questions to Consider

- If the calendar connection dies, should Today stop and ask for a reconnect, or stay a footnote under the workout?
- Disconnect is the only destructive confirm in this flow, and it never says whether logged runs survive. What promise should that sentence make?
- The key form still talks like an operator. If OAuth is the product, should that form sound like a coach asking for a key, or stay hidden until OAuth is actually unavailable?

## Verdict

**Changes requested.** States 1, 2, 5, and 6 match. States 3 and 4 do not, and two operator sentences can still reach the alert.

Required changes:

1. When `INTERVALS_KEY_ENC_SECRET` is missing, keep the row’s shape on every connect path. The connect control stays visible and disabled, and the only explanation is “Connecting Intervals.icu isn’t available right now. Try again later.” Do not replace the row with “Not available for your account” (`src/pages/settings.astro:95-96`, `src/lib/intervals.ts:258-263`). Do not show an enabled env-fallback Connect (`src/components/ConnectedApps.astro:105-109`) that can post “API key not configured” (`src/lib/intervals.ts:1022`).
2. Do not render “Intervals encryption is not configured.” or “API key not configured” in the settings alert. Map them to the unavailable sentence on connect, or “Couldn’t sync. Try again.” on sync, before `intervalsError` is set (`src/lib/intervals-crypto.ts:4`, `src/lib/intervals.ts:1002`, `src/lib/intervals.ts:1022`, `src/lib/training.ts:2182-2187`, `src/pages/settings.astro:68-69`, `src/components/ConnectedApps.astro:63-69`).
3. An OAuth return that is not an explicit user cancel, including an expired state cookie, must land on Settings with “Couldn’t connect to Intervals. Try again.” The 10-minute state failure currently returns a bare text/plain 403 (`src/pages/auth/intervals/callback.ts:18`, `src/lib/intervals.ts:280-283`). User cancel stays silent, with no red error.
