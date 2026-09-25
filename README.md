# Stride Lab

Astro + SQLite training app. Product behavior is in `PRODUCT.md`. Railway deploy is in `DEPLOY.md`.

## Environment

Copy `.env.example` to `.env`. Variable names match deploy.

`INTERVALS_OWNER_EMAILS` is the comma-separated list of account emails allowed to use the shared Intervals.icu key (`INTERVALS_ICU_API_KEY`). Matching is case-insensitive and ignores whitespace around each address. If this variable is unset or empty, no account can connect, sync, or read Intervals data (fail closed). Production must set:

```
INTERVALS_OWNER_EMAILS=crispal94@gmail.com
```

After that variable is set in production, remove Intervals imports that landed on other accounts. On the Railway web service (the one with the `.data` volume): `npm run cleanup:intervals-nonowners`. If the variable is unset or empty, the script deletes nothing. See `DEPLOY.md`.
