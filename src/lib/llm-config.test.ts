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
  it("prefers ADAPT_LLM_API_KEY over the Ollama key and OLLAMA_MODEL", () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "  adapt-key  ";
    process.env.OLLAMA_API_KEY = "ollama-key";
    process.env.ADAPT_LLM_BASE_URL = "  https://llm.example/v1/  ";
    process.env.ADAPT_LLM_MODEL = "  coach-model  ";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    assert.deepEqual(readLlmConfig(), {
      apiKey: "adapt-key",
      baseUrl: "https://llm.example/v1",
      model: "coach-model",
    });
  });

  it("uses the OpenAI defaults when only ADAPT_LLM_API_KEY is set", () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "adapt-key";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    assert.deepEqual(readLlmConfig(), {
      apiKey: "adapt-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  it("uses the ollama base URL and OLLAMA_MODEL when only OLLAMA_API_KEY is set", () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = " legacy-key ";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    assert.equal(process.env.ADAPT_LLM_BASE_URL, undefined);
    assert.deepEqual(readLlmConfig(), {
      apiKey: "legacy-key",
      baseUrl: "https://ollama.com/v1",
      model: "gemma4:31b",
    });
  });

  it("ignores adapt URL and model when the key is only OLLAMA_API_KEY", () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = "legacy-key";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    process.env.ADAPT_LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.ADAPT_LLM_MODEL = "gpt-4o-mini";
    assert.equal(process.env.ADAPT_LLM_API_KEY, undefined);
    assert.deepEqual(readLlmConfig(), {
      apiKey: "legacy-key",
      baseUrl: "https://ollama.com/v1",
      model: "gemma4:31b",
    });
  });

  it("keeps gemma4:31b when OLLAMA_MODEL is unset even if adapt URL and model are set", () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = "legacy-key";
    process.env.ADAPT_LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.ADAPT_LLM_MODEL = "gpt-4o-mini";
    assert.deepEqual(readLlmConfig(), {
      apiKey: "legacy-key",
      baseUrl: "https://ollama.com/v1",
      model: "gemma4:31b",
    });
  });

  it("returns null when both keys are missing or blank", () => {
    clearLlmEnv();
    assert.equal(readLlmConfig(), null);
    process.env.ADAPT_LLM_API_KEY = "   ";
    process.env.OLLAMA_API_KEY = "";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    assert.equal(readLlmConfig(), null);
  });
});
