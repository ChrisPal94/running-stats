import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as coachFeedback from "./ollama-feedback.ts";
import {
  COACH_FEEDBACK_INSTRUCTIONS,
  COACH_FEEDBACK_UNAVAILABLE,
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

const LEAKED_FEEDBACK_COPY = [
  /ollama/i,
  /api key/i,
  /_api_key/i,
  /adapt_llm_/i,
  /_base_url/i,
  /_model\b/i,
];

function exportedCoachFeedbackCopy(): string[] {
  const copies: string[] = [];
  for (const [name, value] of Object.entries(coachFeedback)) {
    if (!name.startsWith("COACH_FEEDBACK_")) continue;
    if (typeof value === "string") copies.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") copies.push(item);
      }
    }
  }
  return copies;
}

function assertNoLeakedFeedbackCopy(copy: string): void {
  for (const pattern of LEAKED_FEEDBACK_COPY) {
    assert.doesNotMatch(copy, pattern);
  }
}

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

describe("coach feedback user copy", () => {
  it("does not mention ollama, an api key, or an env var name", () => {
    const copies = exportedCoachFeedbackCopy();
    assert.ok(copies.includes(COACH_FEEDBACK_UNAVAILABLE));
    assert.ok(copies.includes(COACH_FEEDBACK_UNCONFIGURED));
    assert.ok(copies.includes(COACH_FEEDBACK_INSTRUCTIONS));
    for (const copy of copies) assertNoLeakedFeedbackCopy(copy);
    assert.equal(COACH_FEEDBACK_UNAVAILABLE, "Couldn’t generate feedback. Try again.");
    assert.equal(COACH_FEEDBACK_UNCONFIGURED, "Feedback isn’t available right now. Try again later.");
  });
});

describe("ollamaCloudConfig", () => {
  it("returns generic copy when no key is configured", () => {
    clearLlmEnv();
    assert.deepEqual(ollamaCloudConfig(), { error: COACH_FEEDBACK_UNCONFIGURED });
    assertNoLeakedFeedbackCopy(COACH_FEEDBACK_UNCONFIGURED);
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

  it("uses OLLAMA_API_KEY when ADAPT_LLM_API_KEY is unset", async () => {
    clearLlmEnv();
    process.env.OLLAMA_API_KEY = "legacy-key";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    let auth = "";
    let url = "";
    let model = "";
    const result = await requestCoachFeedback(runContext, async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      model = JSON.parse(String(init?.body)).model;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"Hold the easy effort.","reason":"Keep the next run easy."}' } }],
        }),
        { status: 200 },
      );
    });
    assert.equal(process.env.ADAPT_LLM_BASE_URL, undefined);
    assert.equal(url, "https://ollama.com/v1/chat/completions");
    assert.equal(model, "gemma4:31b");
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
      assertNoLeakedFeedbackCopy(result.error);
      assert.equal(result.error.includes("super-secret"), false);
    } finally {
      console.warn = original;
    }
    const logged = warnings.join("\n");
    assert.match(logged, /OLLAMA_API_KEY/);
    assert.match(logged, /ADAPT_LLM_API_KEY/);
    assert.equal(/fallback/i.test(logged), false);
    assert.equal(logged.includes("super-secret"), false);
  });

  it("shows the generic retry copy for auth, HTTP, and LLM failures and logs the reason", async () => {
    clearLlmEnv();
    process.env.ADAPT_LLM_API_KEY = "super-secret-adapt-key";
    process.env.ADAPT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.ADAPT_LLM_MODEL = "coach-model";
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const denied = await requestCoachFeedback(runContext, async () => {
        return new Response("unauthorized super-secret-adapt-key", { status: 401 });
      });
      const failed = await requestCoachFeedback(runContext, async () => {
        return new Response("unavailable", { status: 503 });
      });
      const offline = await requestCoachFeedback(runContext, async () => {
        throw new Error("connect failed super-secret-adapt-key");
      });
      const unusable = await requestCoachFeedback(runContext, async () => {
        return new Response("not-json", { status: 200 });
      });
      for (const result of [denied, failed, offline, unusable]) {
        assert.equal(result.ok, false);
        if (result.ok) continue;
        assert.equal(result.error, COACH_FEEDBACK_UNAVAILABLE);
        assertNoLeakedFeedbackCopy(result.error);
        assert.equal(result.error.includes("super-secret-adapt-key"), false);
      }
    } finally {
      console.warn = original;
    }
    const logged = warnings.join("\n");
    assert.match(logged, /401 from provider/);
    assert.match(logged, /503 from provider/);
    assert.match(logged, /connect failed \[redacted\]/);
    assert.match(logged, /not usable feedback/);
    assert.equal(logged.includes("super-secret-adapt-key"), false);
  });
});
