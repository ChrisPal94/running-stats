export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o-mini";
/** Official Ollama host for `OLLAMA_API_KEY` (`https://ollama.com/v1`). */
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
/** Default `OLLAMA_MODEL` when unset (`gemma4:31b`). */
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
 *  Precedence: `ADAPT_LLM_API_KEY`, when set, wins and uses `ADAPT_LLM_BASE_URL`
 *  / `ADAPT_LLM_MODEL` (defaults `https://api.openai.com/v1` and `gpt-4o-mini`).
 *  Otherwise `OLLAMA_API_KEY` is the official supported path: host
 *  `https://ollama.com/v1` and `OLLAMA_MODEL` (default `gemma4:31b`), ignoring
 *  `ADAPT_LLM_BASE_URL` and `ADAPT_LLM_MODEL`.
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
    baseUrl: OLLAMA_CLOUD_BASE_URL,
    model: trimmedEnv("OLLAMA_MODEL") || DEFAULT_OLLAMA_MODEL,
  };
}
