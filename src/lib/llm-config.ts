export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o-mini";

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function trimmedEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** OpenAI-compatible chat config for the adapt job and Generate feedback.
 *  API key: `ADAPT_LLM_API_KEY`, then `OLLAMA_API_KEY` for one release.
 *  Base URL and model: `ADAPT_LLM_BASE_URL` and `ADAPT_LLM_MODEL`.
 */
export function readLlmConfig(): LlmConfig | null {
  const apiKey = trimmedEnv("ADAPT_LLM_API_KEY") || trimmedEnv("OLLAMA_API_KEY");
  if (!apiKey) return null;
  const baseUrl = (trimmedEnv("ADAPT_LLM_BASE_URL") || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  const model = trimmedEnv("ADAPT_LLM_MODEL") || DEFAULT_LLM_MODEL;
  return { apiKey, baseUrl, model };
}
