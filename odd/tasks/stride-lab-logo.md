# Feature: Stride Lab logo

## Goal

The product name is **Stride Lab**. Replace the lime SVG runner and
"Running Stats" wordmark with the supplied mark, without the black
starry background. Repo/package name stays `running-stats`.

## Product decisions (user-approved)

- App name: Stride Lab.
- Source mark: `/Users/christian/Downloads/1GRpy (1).jpg` (same as
  `1GRpy.jpg`). Knock out the black background.
- Do not invent share/OG imagery.
- **lockup** in compact chrome: neon runner + the STRIDE LAB wordmark
  from the image, pulled together so it fits. Not the old uppercase
  type, and not the runner alone.

## Routing

- TDD: off (no project/session TDD config). Runner: `node --test`.
  Ordinary checks: `npm run check`, `npm test`.
- Task 1: inline (mechanical image extract).
- Tasks 2–3: delegated `gentle-ai-worker` (multi-file write).
- Task 4: delegated `gentle-ai-verify`.
- Delivery: `ask-on-risk`.

## Tasks

- [x] 1. Knock out the black background; extract runner and wordmark.
      Favicon from the runner.
      Surfaces: `src/assets/brand/logo-runner.png`,
      `src/assets/brand/logo-wordmark.png`,
      `src/assets/brand/favicon.png`.
      Route: inline.
- [x] 2. BrandLogo in Header, AppShell, and onboarding.
      Surfaces: `src/components/BrandLogo.astro`,
      `src/components/Header.astro`, `src/layouts/AppShell.astro`,
      `src/pages/onboarding.astro`, `src/layouts/BaseLayout.astro`.
      Route: `gentle-ai-worker`. Parent reverted a drive-by
      `try/catch` around `new URL(request.url)` in
      `finishMagicLink` (out of scope for the rename).
- [x] 3. Rename user-facing "Running Stats" to "Stride Lab" in titles,
      magic-link copy, PRODUCT.md, and the magic-link tests. Leave
      critique snapshots and the git remote name alone.
      Surfaces: `src/pages/*.astro`, `src/lib/magic-link.ts`,
      `src/lib/magic-link.test.ts`, `PRODUCT.md`, `DEPLOY.md`,
      `.env.example`.
      Route: `gentle-ai-worker`.
- [x] 4. Verify: detector on chrome files, `npm run check`, magic-link
      tests.
      Route: `gentle-ai-verify`.

## Evidence

- Worker: BrandLogo lockup (runner h-9 + wordmark h-8), favicon,
  titles, magic-link copy. Drive-by `finishMagicLink` try/catch
  reverted by parent.
- Parent fix: BrandLogo frontmatter `<>` fragment failed `astro
  build` (`PARSE_ERROR`) and 500'd every page. Images now sit in
  both template branches. Re-verify: `astro build` complete;
  `npm run check` 0 errors / 0 warnings.
- Verify (`gentle-ai-verify`): `npm test` 118/118; `npm run check`
  0 errors / 0 warnings / 2 pre-existing unused-import hints;
  no unexpected user-facing "Running Stats".
- Live HTML (localhost:4321): `/` and `/login` 200, titles and
  lockup images present, no "Running Stats". No browser-tool
  visual pass.
- Work-unit commits:
  - `6cad559` feat(brand): show the Stride Lab lockup in chrome
  - `d60357c` feat(brand): rename user-facing Running Stats to Stride Lab
