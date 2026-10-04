---
target: PR #57 Settings Intervals follow-ups and signup duplicate alert
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
p2_count: 2
p3_count: 5
target_path: src/components/ConnectedApps.astro
timestamp: 2026-10-04T14:40:00Z
slug: src-components-connectedapps-astro
reviewed_head: cf1e311
reviewed_base: ccf117d
pr: 57
closes: 44
baseline_pr35_score: 29
baseline_pr47_score: 28
verdict: PASS
---

Method: dual-agent (A: bc-ad4e07fa-0448-5762-a215-54dcdfb6f11d · B: bc-c0128849-b514-5020-9f31-09797eb2112e)

Browser: headless Chrome at 390×844 against a worktree of `cf1e311`. Outbound hosts other than loopback were aborted. CLI `impeccable detect --json` on `ConnectedApps.astro`, `AuthForm.astro`, `settings.astro`, `signup.astro`, and `login.astro` returned `[]` (exit 0). `detect.js` was not injected. No user-visible overlay.

Mode: Operate. Baseline scores supplied for the trend: PR #35 Settings **29/40**, PR #47 auth follow-ups **28/40**. No `ignore.md`. No `DESIGN.md`.

## Verdict

**PASS.** No blockers. Design health **28/40** (Good, floor of the band). Trend: **29/40** (#35) → **28/40** (#47) → **28/40** (#57). This pass holds the #47 score. The athlete-ID contrast fail is gone, the four signup sentences still match, and the new confirm, toasts, and in-row errors do not stop disconnect, sync, or signup recovery.

## Design Health Score: 28/40

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Sync sets `disabled` and `aria-busy`, then a `role="status"` toast. The label stays “Sync now”, and the toast hides after 1.8s |
| 2 | Match System / Real World | 3 | Disconnect and signup copy are plain language. The dialog buttons say OK and Cancel |
| 3 | User Control and Freedom | 2 | Cancel and Escape abort Disconnect when JavaScript runs. Logout is still one path |
| 4 | Consistency and Standards | 3 | Tab names now differ by page. The reconnect helper sits under the control; Log out’s helper sits above |
| 5 | Error Prevention | 3 | The agreed confirm runs with JavaScript. With JavaScript off, Disconnect posts immediately |
| 6 | Recognition Rather Than Recall | 3 | `i123456` is now full mist. The encryption sentence is gone |
| 7 | Flexibility and Efficiency | 2 | One speed for Sync and Disconnect. Method tabs are full page loads |
| 8 | Aesthetic and Minimalist Design | 3 | “Intervals access expired” is the status and the helper under Reconnect |
| 9 | Error Recovery | 3 | The four signup sentences and their links are intact. In-row errors use `role="alert"` |
| 10 | Help and Documentation | 3 | The Developer link and the reconnect sentence are on the card. The reconnect sentence is under the lime control |
| **Total** | | **28/40** | **Good** |

## Design Specificity

The sentences belong to Stride Lab: “Your logged runs stay in Stride Lab”, `i123456`, and the lime “Intervals synced” / “Intervals disconnected” pills. Disconnect itself opens a stock browser dialog whose buttons say OK and Cancel. The signup alert is the same coral box used on Settings. What makes it specific is the sentence.

## 1. Disconnect confirm

Agreed copy, exact, including U+2019 in “won’t” (`src/lib/intervals.ts:50-51`):

`Disconnect Intervals.icu? Your logged runs stay in Stride Lab. New workouts won’t be added to your Intervals calendar.`

The control is `data-confirm` plus `window.confirm` (`src/components/ConnectedApps.astro:200-204`, `src/components/ConnectedApps.astro:239-243`).

| Check | Result |
|---|---|
| Focus | The native confirm dialog takes the interaction. Dismiss returns to Settings with Disconnect still in the DOM |
| Keyboard | `dismiss()` (Escape / Cancel) stayed on `/settings` and did not navigate |
| Destructive styling | Disconnect is the outline secondary button and turns lime on hover (`secondaryClass`, line 66). The dialog buttons are OK and Cancel |
| Copy | Matches the agreed sentence |
| Without JS | A real click posted immediately. No dialog. The page landed on `/settings?toast=intervals-disconnected` |

With JavaScript, accept navigates to that toast. Text **Intervals disconnected**. `role="status"`. No explicit `aria-live`; the accessibility tree reports `live=polite`. Ink `#05090b` on lime `#b8f52c` is **15.36:1**. After about 2.2s the toast is `hidden` and the URL is replaced with `/settings` (`src/pages/settings.astro:179-186`, 1800ms). The toast is `pointer-events-none`, so it cannot be dismissed by tapping it.

## 2. Sync now

On submit the button is `disabled`, `aria-busy="true"`, opacity **0.7**, text still **Sync now**, height **40px** (`src/components/ConnectedApps.astro:245-250`).

A held request to intervals.icu was aborted. The finished POST redirected to `/settings` with no toast query. The row then showed **Couldn’t sync. Try again.** as `role="status"`, `#ffb4aa` on the card, **10.94:1**. “Intervals synced” is the success string (`src/lib/intervals.ts:52`, `intervalsSyncToast` returns `"synced"` when `imported > 0`). This run did not import a run, so that toast was not on screen. The success toast uses the same `role="status"` pill as disconnect.

Back navigation in this headless Chrome reloaded the page (`pageshow.persisted` was false) and the button came back enabled. There is no `pageshow` handler, so a browser that restores the page from the back-forward cache can keep the button disabled. That matches the low flag. It did not reproduce here.

## 3. Encryption line

`INTERVALS_CONNECT_COPY` (“Your API key is encrypted and never shown again.”) is removed. The key form still links to “Your API key and athlete ID are in Intervals Settings > Developer.” (`src/lib/intervals.ts:60`, `src/components/ConnectedApps.astro:223-232`).

## 4. Athlete ID placeholder

`i123456` uses `placeholder:text-mist` (`src/components/ConnectedApps.astro:130-137`). Computed placeholder `rgb(181, 190, 181)` on panel `rgb(13, 20, 21)` is **9.75:1**. The old `placeholder:text-mist/50` composite is still **3.30:1** (`rgb(97, 105, 101)` on the panel). That utility remains on the API key input (`ConnectedApps.astro:121`), which has no placeholder text, so the 3.30:1 color is not on screen.

## 5. Expired OAuth helper

When reconnect is available, the lime **Reconnect** link (`href="/auth/intervals/start"`, height 40px) has `aria-describedby="intervals-reconnect-help"`. The helper is the next sibling, 8px below the link, then Disconnect (`src/components/ConnectedApps.astro:179-190`). Exact text: **Intervals access expired. Reconnect to keep your runs and plan in sync.** The status line above the buttons already says **Intervals access expired**. “Reconnect” inside the helper is text, not a second link.

## 6. Intervals errors in the row

Same-origin Intervals failures render in the card as the coral alert, `role="alert"` (implicit assertive), `#ffb4aa` (`src/components/ConnectedApps.astro:87-104`). A sync with no connection rendered **Connect Intervals.icu to import your runs.** The words “Connect Intervals.icu” are a link to `/settings#intervals` while the person is already on that row. Sampled contrast **9.85:1**.

An account-gate failure is `INTERVALS_CONNECT_UNAVAILABLE`: **Connecting Intervals.icu isn’t available right now. Try again later.** (`src/lib/intervals.ts:53-54`). `handleSettingsPost` returns that with `section: "intervals"` and `status: 403` (`src/lib/training.ts:2199`, `2241`). `applySettingsPost` renders `section === "intervals"` in the row before the plain-text 403 branch (`src/lib/settings-post.ts:74-84`). A cross-site Intervals POST is still `text/plain` 403 and does not render the row. A thrown Intervals intent uses the same “try again later” sentence, including sync and disconnect (`src/lib/training.ts:2196-2199`).

## 7. Signup duplicate alert

Built from `signupDuplicateMethods()` (`src/lib/auth-methods.ts:44-56`) and `recoverySeparator()` (`src/components/AuthForm.astro:34-38`). Password login is always first. Email link is next, only when Resend is configured. Google is last, only when OAuth is configured. `role="alert"`. Email stayed `critique-b@example.com`. Password was empty. Focused first link: **2px solid `rgb(184, 245, 44)`**, offset **4px** (`src/styles/global.css:61-64`).

| Config | Exact string | Links |
|---|---|---|
| Neither | Couldn’t create your account. If you already have one, log in. | `log in` → `/login` |
| Google only | Couldn’t create your account. If you already have one, log in or continue with Google. | `/login`, `/auth/google?from=signup` |
| Email link only | Couldn’t create your account. If you already have one, log in or sign in with an email link. | `/login`, `/login?method=link` |
| Both | Couldn’t create your account. If you already have one, log in, sign in with an email link, or continue with Google. | `/login`, `/login?method=link`, `/auth/google?from=signup` |

No email-link link when Resend is off. No Google link when Google is off. Separator spacing matches the four sentences (no double space, no space before the period).

## 8. Tablist names

When email link is configured, `/signup` is `aria-label="Sign up method"` and `/login` is `aria-label="Sign in method"` (`src/components/AuthForm.astro:31`, `src/components/AuthForm.astro:58`). When email link is off, the tablist is absent. Tabs are 32px tall.

## Settings regression

Account is unchanged. **Signs you out on all your devices.** is above **Log out**, `aria-describedby="logout-all-devices"`, button height **42px**, gap from the helper to the button **16px** (`src/pages/settings.astro:143-153`).

## Tap targets at 390px

| Control | Height |
|---|---|
| Sync now | 40px |
| Reconnect | 40px |
| Continue | 40px |
| Disconnect | 42px |
| Log out | 42px |
| Password / Email link tabs | 32px |

These clear a 24px minimum and miss 44px. Text fields with `py-3` and `text-sm` land on about 44px.

## What's Working

1. The four duplicate-signup sentences, the links, `role="alert"`, and the filled email are unchanged, and the tablist name finally says “Sign up method” on signup.
2. Athlete ID `i123456` is **9.75:1**, up from the old mist-at-50% **3.30:1**.
3. Disconnect’s agreed sentence is the confirm message, Escape cancels it, and success is the lime toast **Intervals disconnected** at **15.36:1**.

## Priority Issues

### [P2] Disconnect confirms only when JavaScript runs

**What:** With JavaScript, `window.confirm` shows the agreed sentence, and Escape / Cancel stays on Settings. Enter accepts OK. The button is not styled as destructive. With JavaScript off, the POST runs immediately (`src/components/ConnectedApps.astro:239-243`).

**Why it matters:** The warning is real for the normal path. A no-JS submit still only stops future calendar writes; logged runs stay. It is the agreed mechanism, and it is not a showstopper.

**Fix:** Keep the sentence. If no-JS must confirm too, put an explicit confirm control in the form. A custom dialog can put Cancel first and style Disconnect as destructive. `window.confirm` cannot.

**Suggested command:** `/impeccable harden`

### [P2] Sync’s pending label stays “Sync now”

**What:** The button dims to 70% and sets `aria-busy="true"` (`src/components/ConnectedApps.astro:245-250`). The visible name does not change. There is no `pageshow` reset. This headless Chrome reloaded on back, so the stuck-disabled case did not appear. The code can still leave it disabled when the back-forward cache restores the page.

**Why it matters:** A screen reader hears a busy “Sync now”. A restored page can look stuck. Both were already flagged as low.

**Fix:** While busy, set the label to `Syncing…`. On `pageshow`, clear `disabled` and `aria-busy` if the navigation was restored.

**Suggested command:** `/impeccable harden`

## Low nits

- The reconnect helper is 8px under the lime link. Log out’s helper is above its button. The status already says “Intervals access expired”.
- The success and disconnect toasts hide after 1.8s and ignore taps (`pointer-events-none`, `src/pages/settings.astro:164-186`).
- The encryption sentence is gone. The Developer link remains.
- Account-gate and thrown Intervals failures say “Connecting Intervals.icu isn’t available right now. Try again later.” A blocked account and a failed sync share that outage sentence.
- “Connect Intervals.icu” inside the row alert links to `#intervals` on the same card.
- API key still has `placeholder:text-mist/50` and no placeholder text.
- Sync, Reconnect, and Continue are 40px. Tabs are 32px.

## Persona Red Flags

**Sam.** The signup alert and the Intervals row error are `role="alert"`. Toasts are `role="status"` with implicit polite. Reconnect’s `aria-describedby` points at a real id. `aria-busy` on a button that is still named “Sync now” does not say progress. The method tabs are links with the right names and no arrow-key roving.

**Casey.** At 390px, Reconnect is the full-width lime control and the explanation is the next line. Sync and Reconnect are 40px. The toast sits at `bottom-24` and does not take taps, so the bottom nav can still receive them.

**Jordan.** The signup sentence names only the methods that work, and the tab label says “Sign up method”. OK / Cancel does not say Disconnect. “Try again later” reads as an outage.

**Riley.** JavaScript off skips the confirm. A thrown sync or disconnect uses the connect-outage sentence. Cross-site still returns plain text 403. `signedOut` was not part of this delta. The duplicate path does not turn an ordinary error string into links.

## Cognitive load

The Settings row is two actions and stays inside working memory. The duplicate-signup screen still fails single focus and minimal choices when both extra methods are on: the alert, the password form, Continue, and Continue with Google are all live. That is the same load as #47, not a new one.

## Questions to Consider

- If `window.confirm` is the agreed confirm, is the no-JS hole acceptable for a disconnect that does not delete runs?
- Should the expired-access sentence sit above Reconnect, the way the logout sentence sits above Log out?
- Should a failed sync say “Couldn’t sync” even when the failure is the account gate?
