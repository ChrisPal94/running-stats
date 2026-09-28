# Feature: Brand image weight

## Goal

Serve the Stride Lab lockup at its display size, and store the source
PNGs at 3x that size. Same look. Less page weight and less repo weight.
Favicon stays. No palette compression (banding risk on the neon glow).
No git history rewrite.

## Product decisions (user-approved)

- Scope **B**: `width`/`height`/`densities` on `<Image>`, then re-export
  runner and wordmark at 3x display size.
- Not C: no pngquant / palette.
- Display: runner `h-10` (40px), wordmark `h-9` (36px).
- 3x sources: runner 142×120, wordmark 268×108.

## Routing

- TDD: off. Runner: `node --test`.
  Ordinary checks: `npm run check`, `npm test`, `astro build`.
- Task 1: inline (one file, mechanical Image props).
- Task 2: inline (binary resize with project `sharp`).
- Task 3: verify both template branches plus a pixel-diff at display size.
- Delivery: `ask-on-risk`.

## Tasks

- [x] 1. Pass display `width`/`height` and `densities={[1, 2, 3]}` to
      both BrandLogo `<Image>` branches.
      Surfaces: `src/components/BrandLogo.astro`.
      Route: inline.
- [x] 2. Re-export runner and wordmark sources at 3x display size.
      Surfaces: `src/assets/brand/logo-runner.png`,
      `src/assets/brand/logo-wordmark.png`.
      Route: inline.
- [x] 3. Verify: HTML image params, emitted webp bytes, pixel-diff at
      display size, `npm run check`, `npm test`, `/` and `/onboarding`,
      `astro build`.
      Route: inline.

## Evidence

- Baseline (main `58bde7c`): runner source 417,600 B / 491×414;
  wordmark 50,149 B / 487×196. Served webp at intrinsic:
  runner 31,660 B, wordmark 9,402 B.
- After task 1, `/` and `/onboarding` 200 with `w=47&h=40` /
  `w=89&h=36` and srcset 1x/2x/3x. No leftover `w=491` / `w=487`.
- After task 2: runner 29,294 B / 142×120; wordmark 20,541 B /
  268×108; both keep alpha. Display-size MAE ~6 / ~4 (0–255);
  alpha MAE 1.7 / 0.7; side-by-side at 8× nearest is
  indistinguishable. Max RGB 255 is near-transparent glow pixels.
- `npm run check` 0 errors / 0 warnings / 2 pre-existing hints.
- `npm test` 118/118.
- `astro build` complete. Emitted lockup webps:
  runner 2.4 / 7.7 / 13.5 KiB (1x/2x/3x), wordmark 2.5 / 5.6 /
  8.9 KiB. 1x page lockup ~4.9 KiB vs ~40 KiB before.

## Work-unit commits

- `8096560` perf(brand): emit BrandLogo at display size
- `b4a5d81` perf(brand): store lockup sources at 3x display size
