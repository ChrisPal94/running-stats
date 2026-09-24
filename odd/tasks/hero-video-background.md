# Feature: Hero video background

## Goal

Replace the hero still with the supplied Grok video as the background.
No zoom, parallax, or scale animation. Copy, layout, overlays, and CTAs
stay as they are.

## Product decisions (user-approved)

- Background only; no hero redesign.
- No zoom-in/zoom-out (PRODUCT.md already bans zoom, parallax, and scale).
- Source: `grok-video-be417f90-214d-4b1c-81be-2e28c0a7ad74.mp4` (H.264,
  1136×800, ~6s, 2.6MB).
- Keep `hero-background.jpg` as the still fallback under
  `prefers-reduced-motion`.

## Tasks

- [x] 1. Add the mp4 and swap the hero background; jpg remains the
      reduced-motion / first-frame still.
      Surfaces: `src/assets/hero-background.mp4`, `src/components/Hero.astro`.
- [x] 2. Verify: no zoom/scale animation, reduced-motion still, detector
      on `Hero.astro`.

## Evidence

- Asset: `src/assets/hero-background.mp4` (2.6MB, H.264 1136×800 ~6s).
- `npm run check`: 0 errors, 0 warnings, 2 pre-existing hints in login/signup.
- Detector on `Hero.astro`: 0 findings.
- Contract: muted/autoplay/loop/playsinline, `object-cover`, `transform: none`,
  no scale/keyframes/parallax; `prefers-reduced-motion` hides `.hero-bg-video`
  and leaves the jpg still.
