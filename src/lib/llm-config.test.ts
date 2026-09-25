import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readLlmConfig } from "./llm-config.ts";

const ENV_KEYS = [
  "ADAPT_LLM_API_KEY",
  "ADAPT_LLM_BASE_URL",
  "ADAPT_LLM_MODEL",
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL",
] as const;

const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearLlmEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("readLlmConfig", () => {
  it("prefers ADAPT_LLM_API_KEY and the shared base URL and model", () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "  adapt-key  ";
    process.env.OLLAMA_API_KEY = "ollama-key";
    process.env.ADAPT_LLM_BASE_URL = "  https://llm.example/v1/  ";
    process.env.ADAPT_LLM_MODEL = "  coach-model  ";
    process.env.OLLAMA_MODEL = "ignored-model";
    assert.deepEqual(readLlmConfig(), {
      apiKey: "adapt-key",
      baseUrl: "https://llm.example/v1",
      model: "coach-model",
    });
  });

  it("falls back to OLLAMA_API_KEY and the default base URL and model", () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = " legacy-key ";
    assert.deepEqual(readLlmConfig(), {
      apiKey: "legacy-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  it("returns null when both keys are missing or blank", () => {
    clearLlmEnv();
    assert.equal(readLlmConfig(), null);
    process.env.ADAPT_LLM_API_KEY = "   ";
    process.env.OLLAMA_API_KEY = "";
    assert.equal(readLlmConfig(), null);
  });
});
