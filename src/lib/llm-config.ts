export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o-mini";
/** Prior Generate feedback host. Used only for the one-release Ollama key fallback. */
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
/** Prior Generate feedback model (`OLLAMA_MODEL` in the coach tests). */
export const DEFAULT_OLLAMA_MODEL = "gemma4:31b";

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function trimmedEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** OpenAI-compatible chat config for the adapt job and Generate feedback.
 *  `ADAPT_LLM_API_KEY` uses `ADAPT_LLM_BASE_URL` / `ADAPT_LLM_MODEL`.
 *  `OLLAMA_API_KEY` is a one-release fallback and keeps the Ollama host and model
 *  unless those adapt vars are set.
 */
export function readLlmConfig(): LlmConfig | null {
  const adaptKey = trimmedEnv("ADAPT_LLM_API_KEY");
  if (adaptKey) {
    return {
      apiKey: adaptKey,
      baseUrl: withoutTrailingSlash(trimmedEnv("ADAPT_LLM_BASE_URL") || DEFAULT_LLM_BASE_URL),
      model: trimmedEnv("ADAPT_LLM_MODEL") || DEFAULT_LLM_MODEL,
    };
  }

  const ollamaKey = trimmedEnv("OLLAMA_API_KEY");
  if (!ollamaKey) return null;
  return {
    apiKey: ollamaKey,
    baseUrl: withoutTrailingSlash(trimmedEnv("ADAPT_LLM_BASE_URL") || OLLAMA_CLOUD_BASE_URL),
    model: trimmedEnv("ADAPT_LLM_MODEL") || trimmedEnv("OLLAMA_MODEL") || DEFAULT_OLLAMA_MODEL,
  };
}
