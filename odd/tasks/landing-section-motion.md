# Feature: Landing section motion

## Goal

Give Product and How it works authored motion. Hero stays as-is (video
background, no zoom). No generic fade-up on every heading.

## Motion thesis

- Focal moment: the product preview assembles as one plan / three views.
  Today arrives first (the next run), then Plan, then Progress. The
  AdaptationEvent chip is the last beat: the plan moved.
- Continuity: How it works is a three-step timeline (Start → Run → Adapt).
  Lime hairlines draw left-to-right; sibling stagger capped at ~240ms.
- Feedback: existing PrimaryCta hover lift. No extra hover theater.
- Budget: CSS only plus a few lines of IntersectionObserver. No new
  deps. Transform / opacity / clip-path only. Content visible if JS
  fails (`land-pending` is added by script, never in markup). Honor
  global `prefers-reduced-motion`. No parallax, no ken-burns, no layout
  property animation.

## Product decisions (user-approved)

- Animate the other landing sections (not the hero).
- Identity preserved: Chakra Petch, ink/panel/lime, copy unchanged.

## Tasks

- [x] 1. Product assembly: Today → Plan → Progress + AdaptationEvent last
      beat. Surfaces: `src/components/Product.astro`, `src/styles/global.css`,
      `src/pages/index.astro`.
- [x] 2. How it works timeline: lime hairline draw + 3-step stagger ≤240ms.
      Surfaces: `src/components/HowItWorks.astro`, `src/styles/global.css`.
- [x] 3. Verify: detector on changed files, `npm run check`, reduced-motion
      path, JS-off still shows content.

## Evidence

- `npm run check`: 0 errors, 0 warnings, 2 pre-existing hints.
- Detector on the four landing files: 0 findings.
- Hero.astro untouched. Copy unchanged. Markup never starts with
  `land-pending`. Reduced-motion block intact.
