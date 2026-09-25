# Feature: Adapt LLM falls back to the coach feedback credentials

## Goal

The nocturnal adaptation reads `ADAPT_LLM_API_KEY` only. The coach feedback
reads `OLLAMA_API_KEY` + `OLLAMA_MODEL`. Two names for one secret, so rotating
the Ollama key means editing two variables, and forgetting one fails silently.

Make the adaptation fall back to the coach feedback credentials, so a single
Ollama key serves both features. Same behaviour when `ADAPT_LLM_*` is set.

## Product decisions (user-approved)

- Fall back to `OLLAMA_API_KEY` + `OLLAMA_MODEL` at `https://ollama.com/v1`.
- An explicit `ADAPT_LLM_*` trio still wins, so an OpenAI-compatible endpoint
  keeps working unchanged.
- The fallback needs **both** the key and the model, because
  `ollamaCloudConfig` treats a missing model as unconfigured.
- Do not duplicate the secret into Railway. No new environment variable.

## Routing

- TDD: off. Runner: `npm test` (`tsx --test src/lib/*.test.ts`).
- Task 1: inline (one file, mechanical).
- Task 2: inline (new test file, no new infrastructure).
- Task 3: verify checks, both surfaces, and the resolver's precedence.
- Delivery: `ask-on-risk`.

## Tasks

- [x] 1. Add `adaptLlmConfig()` with the `ADAPT_LLM_*` → `OLLAMA_*` precedence
      and rewire `llmConfigured()` and `callLlmOnce()` to use it.
      Surfaces: `src/lib/adapt.ts`.
      Route: inline.
- [x] 2. Cover the resolver: `ADAPT_LLM_*` wins, fallback needs key **and**
      model, base URL is Ollama Cloud in the fallback path, and no credentials
      means unconfigured.
      Surfaces: `src/lib/adapt-llm.test.ts`.
      Route: `gentle-ai-worker`.
- [x] 3. Verify `npm test`, `npm run check`, `astro build`, and the served HTML.
      Route: inline.

## Notes

- `llmConfigured()` and `callLlmOnce()` had **no test coverage** before this.
- Ollama already accepts `response_format: { type: "json_object" }`; proven by
  `ollama-feedback.ts:91` in production, so the adapt payload needs no change.
- `ollama-feedback.ts` imports only `load-env`, so importing
  `OLLAMA_CLOUD_BASE_URL` into `adapt.ts` cannot create an import cycle. Both
  modules call `loadLocalEnv()` at import time, and `adapt.ts` already imports
  `intervals.ts`, which does the same.

## Evidence

- `npm test` 124/124 (was 118; six new cases).
- `npm run check` 0 errors / 0 warnings / 2 pre-existing hints.
- `astro build` complete.
- Local server after restart: `/api/health` 200, `/` 200, `/login` 200,
  `/onboarding` 302 → `/login`.
- Tests never read `process.env`. Importing `adapt.ts` triggers
  `loadLocalEnv()`, so every case passes an explicit object literal; otherwise
  the developer's real `.env` would leak into the assertions.
- `adaptLlmConfig` takes an optional env record defaulting to `process.env`, so
  it stays pure and testable, matching the `adaptCronConfigured(secret)` style.
- The `ollama-feedback.ts` import is cycle-free: that module imports only
  `load-env`, and both it and `intervals.ts` already call `loadLocalEnv()` at
  import time.
- Not verified in production: the nocturnal job has not run with a plan yet, so
  the fallback has never been exercised against the real Ollama endpoint.

## Work-unit commits

- `e4e5d33` fix(adapt): let the nocturnal LLM fall back to the coach credentials
