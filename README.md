# Stride Lab

Astro + SQLite training app. Product behavior is in `PRODUCT.md`. Railway deploy is in `DEPLOY.md`.

## Environment

Copy `.env.example` to `.env`. Variable names match deploy.

`INTERVALS_OWNER_EMAILS` is the comma-separated list of account emails allowed to use the shared Intervals.icu key (`INTERVALS_ICU_API_KEY`). Matching is case-insensitive and ignores whitespace around each address. If this variable is unset or empty, no account can connect, sync, or read Intervals data (fail closed). Production must set:

```
INTERVALS_OWNER_EMAILS=crispal94@gmail.com
```

After that variable is set in production, remove Intervals imports that landed on other accounts. On the Railway web service (the one with the `.data` volume), run `npm run cleanup:intervals-nonowners` first (dry run: prints counts, deletes nothing), then `npm run cleanup:intervals-nonowners -- --apply`. If the variable is unset or empty, both modes delete nothing. See `DEPLOY.md`.

## Design review

UI PRs run Impeccable's critique before UX PASS. Outputs go to `.impeccable/critique/`.

The skill Cursor loads is vendored at `.cursor/skills/impeccable/` (`skill-v4.3.1`, commit `cd12f8660e2dde57b9615c8a6b8ea674101f9cfc`). See `SOURCE.md` there. Impeccable reads `PRODUCT.md` as product context.
