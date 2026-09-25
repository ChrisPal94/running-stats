import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  COACH_FEEDBACK_INSTRUCTIONS,
  COACH_FEEDBACK_UNCONFIGURED,
  ollamaCloudConfig,
  parseCoachFeedback,
  requestCoachFeedback,
  type CoachRunContext,
} from "./ollama-feedback.ts";

const ENV_KEYS = [
  "ADAPT_LLM_API_KEY",
  "ADAPT_LLM_BASE_URL",
  "ADAPT_LLM_MODEL",
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL",
] as const;

const ENV_NAME = /OLLAMA_[A-Z0-9_]*|ADAPT_LLM_[A-Z0-9_]*|API_KEY|BASE_URL|_MODEL/;

const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const runContext: CoachRunContext = {
  plannedTitle: "Easy run · 9 km",
  plannedKm: 9,
  actualKm: 4.17,
  timeSec: 1504,
  paceSecPerKm: 361,
};

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

describe("parseCoachFeedback", () => {
  it("accepts a short summary and reason", () => {
    assert.deepEqual(
      parseCoachFeedback('{"summary":"You ran 4.2 km of a 9 km easy run.","reason":"Shorter than planned."}'),
      {
        summary: "You ran 4.2 km of a 9 km easy run.",
        reason: "Shorter than planned.",
      },
    );
  });

  it("accepts a few sentences about heart rate and cadence", () => {
    const summary =
      "You covered 4.17 km of the planned 9 km easy run. Average heart rate was 176, close to a lactate threshold of 183, which is high for easy running. Max heart rate reached 188. One-foot cadence was 89 rpm, about 178 steps per minute.";
    assert.equal(
      parseCoachFeedback(JSON.stringify({ summary, reason: "The effort was too hard for an easy day." }))?.summary,
      summary,
    );
  });

  it("rejects jargon and empty fields", () => {
    assert.equal(parseCoachFeedback('{"summary":"CTL dropped.","reason":"Because."}'), null);
    assert.equal(parseCoachFeedback('{"summary":"","reason":"Because."}'), null);
  });
});

describe("ollamaCloudConfig", () => {
  it("returns generic copy when no key is configured", () => {
    clearLlmEnv();
    assert.deepEqual(ollamaCloudConfig(), { error: COACH_FEEDBACK_UNCONFIGURED });
    assert.doesNotMatch(COACH_FEEDBACK_UNCONFIGURED, ENV_NAME);
  });
});

describe("requestCoachFeedback", () => {
  it("posts with the shared adapt LLM config and keeps the key out of the body", async () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "test-key";
    process.env.OLLAMA_API_KEY = "legacy-key";
    process.env.ADAPT_LLM_BASE_URL = "https://llm.example/v1/";
    process.env.ADAPT_LLM_MODEL = "coach-model";
    let auth = "";
    let url = "";
    let model = "";
    let instructions = "";
    const result = await requestCoachFeedback(runContext, async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body));
      model = body.model;
      instructions = body.messages[0].content;
      assert.equal(JSON.stringify(body).includes("test-key"), false);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"summary":"You ran 4.2 km of the 9 km easy run.","reason":"The logged run was shorter than planned."}',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    assert.equal(url, "https://llm.example/v1/chat/completions");
    assert.equal(auth, "Bearer test-key");
    assert.equal(model, "coach-model");
    assert.equal(instructions, COACH_FEEDBACK_INSTRUCTIONS);
    assert.match(instructions, /recommend what to change/);
    assert.match(instructions, /Do not retell the session/);
    assert.match(instructions, /step rate/);
    assert.equal(result.ok, true);
  });

  it("uses the OLLAMA_API_KEY fallback when the adapt key is unset", async () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = "legacy-key";
    process.env.ADAPT_LLM_BASE_URL = "https://ollama.com/v1";
    process.env.ADAPT_LLM_MODEL = "gemma4:31b";
    let auth = "";
    const result = await requestCoachFeedback(runContext, async (_input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"Hold the easy effort.","reason":"Keep the next run easy."}' } }],
        }),
        { status: 200 },
      );
    });
    assert.equal(auth, "Bearer legacy-key");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(JSON.stringify(result).includes("legacy-key"), false);
  });

  it("returns generic copy with no env var names when unconfigured", async () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "super-secret-adapt-key";
    process.env.OLLAMA_API_KEY = "super-secret-ollama-key";
    process.env.ADAPT_LLM_API_KEY = " ";
    process.env.OLLAMA_API_KEY = " ";
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const result = await requestCoachFeedback(runContext, async () => {
        throw new Error("should not fetch");
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error, COACH_FEEDBACK_UNCONFIGURED);
      assert.match(result.error, /Feedback isn.t available right now\. Try again later\./);
      assert.doesNotMatch(result.error, ENV_NAME);
      assert.equal(result.error.includes("super-secret"), false);
    } finally {
      console.warn = original;
    }
    const logged = warnings.join("\n");
    assert.match(logged, /ADAPT_LLM_API_KEY/);
    assert.match(logged, /OLLAMA_API_KEY/);
    assert.equal(logged.includes("super-secret"), false);
  });
});
