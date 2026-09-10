# Running Stats

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro with TypeScript and Tailwind CSS.

## Users

Primary users are runners who want to know what to run today, see the week at a glance, and track progress without noise. Detailed user segments remain undecided.

## Product Purpose

Running Stats is a coach AI for an adaptive training plan. One plan is shown as three views:

- **Hoy (Today):** the next session to run.
- **Plan:** the week, with no more than three sessions in focus.
- **Progreso (Progress):** a short set of progress signals.

When the plan changes, an **AdaptationEvent** explains what changed and why.

## Positioning

A training plan that adapts after every run—so you always know what to run next, and why. The landing demonstrates Hoy / Plan / Progreso plus an explainable AdaptationEvent. Distance chips are not social proof. The longer-term differentiator is the adaptive, explainable plan.

## Operating Context

Users evaluate the product on a marketing landing page, then start or return to a plan with email and password or Google. Signed-in users complete a three-step onboarding that creates Plan v1. The Hoy / Plan / Progreso app shell is still a placeholder.

## Capabilities and Constraints

- The landing includes the hero (value, CTAs, nav) and the product preview of Hoy / Plan / Progreso with an AdaptationEvent inside Today.
- English marketing and onboarding copy is provisional and must remain easy to replace.
- Activity and plan data on the landing are illustrative examples, not commercial claims. Mock values must be marked **Illustrative example**.
- The AdaptationEvent includes a visual “Why?” control. In this scope it is not interactive: no modal, no JavaScript behavior, and not a working link. It must not use underline or other look-clickable styling.
- Auth is email + password and Google (no Strava, not magic link). The stored identity is the user’s.
- After signup (email or first Google), continue to `/onboarding`. After login (email or returning Google), continue to `/today`. `/today` sends signed-in users without a plan back to onboarding.
- Onboarding is three steps (goal, level, days). Generate my plan writes onboarding answers plus Plan v1 and Sessions. No AdaptationEvent is created until the first Feedback.
- There is no live plan editing yet, and the Hoy / Plan / Progreso shell is not built.
- On ~390px widths, the hero fold must show the H1 and the primary CTA without a dedicated redesign—tighten spacing rather than inventing a new layout. Onboarding is mobile-first at the same width.
- `/signup` is a real auth page and is indexable. Landing CTAs still go to `/signup`.
- Marketing pages share basic Open Graph tags (title, description, url). Do not invent share imagery.
- The experience must be responsive and accessible.
- Future work must not fabricate testimonials, member counts, partners, awards, or performance claims.

## Brand Commitments

- Product name: Running Stats.
- Visual references supplied by the user define the athletic composition, dark palette, lime accent, and supplied background artwork.
- The supplied background must not use zoom, parallax, or scale animation.

## Evidence on Hand

- Three user-supplied visual references.
- No verified testimonials, member counts, partners, awards, or performance claims; future work must not fabricate them.

## Product Principles

- Make Hoy, Plan, and Progreso legible at a glance.
- When the plan adapts, say what changed and why (explainable AdaptationEvent).
- Let real activity metrics carry the motivation; mark mock data clearly.
- Keep the primary action unmistakable.
- Preserve speed and clarity across device sizes.

## Auth (MVP)

- Routes: `/signup`, `/login`, `/logout` (POST), `/auth/google`, `/auth/google/callback`, `/onboarding`, `/today` (shell placeholder).
- Stack: Astro 6 + Vite 7, `@astrojs/node` 10.1.x (`standalone`; 11.x needs Astro 7). Landing stays prerendered; auth and onboarding routes set `prerender = false`.
- Identity: email + scrypt password hash and/or Google account id in a local JSON store (`.data/users.json` by default). HMAC-signed `rs_session` cookie.
- Google: real OAuth redirect when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` are set. If they are missing, Continue with Google shows “Couldn’t connect to Google. Try email or try again.” Email + password still works.
- After signup (email or first Google), Continue goes to `/onboarding`. After login (email or returning Google), Continue goes to `/today`.
- Env: `AUTH_SECRET` (required in production; see `.env.example`). Optional `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `AUTH_DATA_DIR`, `AUTH_COOKIE_SECURE`.
- Build: `npm run build` still runs `astro check && astro build`. With the Node adapter, output is `dist/client` + `dist/server`. Preview with `AUTH_SECRET=... AUTH_COOKIE_SECURE=false npm run preview`, or `npm start` after build.

## Onboarding (MVP)

- Signed-in only. Logged-out visits to `/onboarding` redirect to `/signup`.
- Three steps with progress 1/3–3/3: **Goal** (5K, 10K, Half, Marathon, Just consistent; optional race date), **Level** (Beginner, Intermediate, Advanced), **Days** (M–S toggles, minimum 3). CTA **Generate my plan** creates Plan v1 + Sessions and continues to `/today`.
- Answers, plans, and sessions persist in `.data/training.json` (same `AUTH_DATA_DIR` JSON store pattern as users). No AdaptationEvent is written here.

## Security / deps (tech note)

Astro 6.x: known critical image-opt advisories; upgrade to ≥7.2.8 scheduled post-auth. Sharp pinned to 0.35.4 for libvips/libheif advisories. Do not use `npm audit fix --force` (would major-bump Astro).
