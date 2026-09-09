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

Users evaluate the product on a marketing landing page before entering the tracking experience. The full application workflow, auth, and app shell remain undecided.

## Capabilities and Constraints

- The landing includes the hero (value, CTAs, nav) and the product preview of Hoy / Plan / Progreso with an AdaptationEvent inside Today.
- English marketing copy is provisional and must remain easy to replace.
- Activity and plan data on the landing are illustrative examples, not commercial claims. Mock values must be marked **Illustrative example**.
- The AdaptationEvent includes a visual “Why?” control. In this scope it is not interactive: no modal, no JavaScript behavior, and not a working link. It must not use underline or other look-clickable styling.
- There is no interactive app behavior yet (no auth, no shell, no live plan edits).
- On ~390px widths, the hero fold must show the H1 and the primary CTA without a dedicated redesign—tighten spacing rather than inventing a new layout.
- `/signup` is a placeholder until real auth exists and must send `noindex`.
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
