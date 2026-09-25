import { readLlmConfig } from "./llm-config";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

export const COACH_FEEDBACK_TITLE = "Feedback";
export const COACH_FEEDBACK_UNAVAILABLE = "Couldn’t generate feedback. Try again.";
export const COACH_FEEDBACK_UNAUTHORIZED = "Ollama rejected the API key.";
export const COACH_FEEDBACK_UNCONFIGURED = "Feedback isn’t available right now. Try again later.";

const LLM_UNCONFIGURED_LOG =
  "[feedback] LLM is not configured; ADAPT_LLM_API_KEY is unset and the OLLAMA_API_KEY fallback is unset";

const TIMEOUT_MS = 25_000;
const JARGON = /\b(CTL|ATL|TSB)\b/i;

export const COACH_FEEDBACK_INSTRUCTIONS =
  'Return only JSON: {"summary":string,"reason":string}. summary: 3 to 5 sentences that recommend what to change next time. Do not retell the session. Do not open by stating the distance, the time, or that the run was shorter or longer. Use the numbers only to justify the advice. Heart rate: when averageHr and lthr are present, easy or long running should stay near or under 85% of lthr. If averageHr is above that, tell them to slow the next easy run until heart rate drops. If it is already under that, tell them to hold that effort. For an intervals or tempo title, a higher heart rate can fit the session; say whether maxHr sat near lthr and what to keep or ease next time. Stride: cadenceRpm is one-foot cadence. stepRateSpm is the full step rate. Coach the stride from step rate, not from a guessed stride length. Under about 170 steps per minute, tell them to take slightly quicker, shorter steps. From 170 to 180, tell them to keep that stride. If heart rate or step rate is missing, say that cue cannot be given until the number is in the session. Do not invent missing numbers. reason: one sentence with the single next-run action. Do not change the plan and do not prescribe a new workout. Clear provisional English. No CTL/ATL/TSB jargon.';

export type CoachRunContext = {
  plannedTitle: string;
  plannedKm: number;
  actualKm: number;
  timeSec: number;
  paceSecPerKm: number;
  averageHr?: number | null;
  maxHr?: number | null;
  lthr?: number | null;
  athleteMaxHr?: number | null;
  restingHr?: number | null;
  /** Intervals running cadence is one foot. Step rate is about twice this. */
  cadenceRpm?: number | null;
  stepRateSpm?: number | null;
};

export type CoachFeedback = {
  summary: string;
  reason: string;
};

export type OllamaCloudConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export function ollamaCloudConfig(): OllamaCloudConfig | { error: string } {
  const config = readLlmConfig();
  if (!config) return { error: COACH_FEEDBACK_UNCONFIGURED };
  return config;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseCoachFeedback(raw: string): CoachFeedback | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? oneLine(record.summary) : "";
  const reason = typeof record.reason === "string" ? oneLine(record.reason) : "";
  if (!summary || !reason) return null;
  if (summary.length > 700 || reason.length > 280) return null;
  if (JARGON.test(summary) || JARGON.test(reason)) return null;
  return { summary, reason };
}

export async function requestCoachFeedback(
  context: CoachRunContext,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; feedback: CoachFeedback } | { ok: false; error: string }> {
  const config = ollamaCloudConfig();
  if ("error" in config) {
    console.warn(LLM_UNCONFIGURED_LOG);
    return { ok: false, error: config.error };
  }

  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: COACH_FEEDBACK_INSTRUCTIONS,
        },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response) return { ok: false, error: COACH_FEEDBACK_UNAVAILABLE };
  if (response.status === 401) return { ok: false, error: COACH_FEEDBACK_UNAUTHORIZED };
  if (!response.ok) return { ok: false, error: COACH_FEEDBACK_UNAVAILABLE };
  const body = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = body?.choices?.[0]?.message?.content;
  const feedback = content ? parseCoachFeedback(content) : null;
  if (!feedback) return { ok: false, error: COACH_FEEDBACK_UNAVAILABLE };
  return { ok: true, feedback };
}
