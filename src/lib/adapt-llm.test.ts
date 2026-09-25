import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptLlmConfig } from "./adapt.ts";

describe("adaptLlmConfig", () => {
  it("prefers ADAPT_LLM_API_KEY over the Ollama credentials and strips a trailing slash from the base URL", () => {
    assert.deepEqual(
      adaptLlmConfig({
        ADAPT_LLM_API_KEY: "adapt-key",
        ADAPT_LLM_BASE_URL: "https://example.test/v1/",
        ADAPT_LLM_MODEL: "gpt-5",
        OLLAMA_API_KEY: "ollama-key",
        OLLAMA_MODEL: "llama3",
      }),
      { apiKey: "adapt-key", baseUrl: "https://example.test/v1", model: "gpt-5" },
    );
  });

  it("falls back to the OpenAI defaults when only ADAPT_LLM_API_KEY is set", () => {
    assert.deepEqual(adaptLlmConfig({ ADAPT_LLM_API_KEY: "adapt-key" }), {
      apiKey: "adapt-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  it("falls back to the Ollama cloud endpoint when only the Ollama credentials are set", () => {
    assert.deepEqual(
      adaptLlmConfig({ OLLAMA_API_KEY: "ollama-key", OLLAMA_MODEL: "llama3" }),
      { apiKey: "ollama-key", baseUrl: "https://ollama.com/v1", model: "llama3" },
    );
  });

  it("requires both an Ollama key and model, rejecting whitespace-only values", () => {
    assert.equal(adaptLlmConfig({ OLLAMA_API_KEY: "ollama-key" }), null);
    assert.equal(adaptLlmConfig({ OLLAMA_MODEL: "llama3" }), null);
    assert.equal(adaptLlmConfig({ OLLAMA_API_KEY: "   ", OLLAMA_MODEL: "llama3" }), null);
    assert.equal(adaptLlmConfig({ OLLAMA_API_KEY: "ollama-key", OLLAMA_MODEL: "   " }), null);
  });

  it("returns null when no credentials are set at all", () => {
    assert.equal(adaptLlmConfig({}), null);
  });

  it("treats a whitespace-only ADAPT_LLM_API_KEY as unset and falls through to Ollama", () => {
    assert.deepEqual(
      adaptLlmConfig({ ADAPT_LLM_API_KEY: "   ", OLLAMA_API_KEY: "ollama-key", OLLAMA_MODEL: "llama3" }),
      { apiKey: "ollama-key", baseUrl: "https://ollama.com/v1", model: "llama3" },
    );
  });
});