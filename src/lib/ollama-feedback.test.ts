import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  COACH_FEEDBACK_INSTRUCTIONS,
  COACH_FEEDBACK_KEY_MISSING,
  COACH_FEEDBACK_MODEL_MISSING,
  ollamaCloudConfig,
  parseCoachFeedback,
  requestCoachFeedback,
} from "./ollama-feedback.ts";

const previous = {
  key: process.env.OLLAMA_API_KEY,
  model: process.env.OLLAMA_MODEL,
};

afterEach(() => {
  if (previous.key === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = previous.key;
  if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = previous.model;
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
  it("requires the cloud key and model name", () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_MODEL;
    assert.deepEqual(ollamaCloudConfig(), { error: COACH_FEEDBACK_KEY_MISSING });
    process.env.OLLAMA_API_KEY = "test-key";
    assert.deepEqual(ollamaCloudConfig(), { error: COACH_FEEDBACK_MODEL_MISSING });
  });
});

describe("requestCoachFeedback", () => {
  it("posts to Ollama cloud and keeps the key out of the body", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    let auth = "";
    let url = "";
    let model = "";
    let instructions = "";
    const result = await requestCoachFeedback(
      {
        plannedTitle: "Easy run · 9 km",
        plannedKm: 9,
        actualKm: 4.17,
        timeSec: 1504,
        paceSecPerKm: 361,
      },
      async (input, init) => {
        url = String(input);
        auth = new Headers(init?.headers).get("authorization") ?? "";
        const body = JSON.parse(String(init?.body));
        model = body.model;
        instructions = body.messages[0].content;
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
      },
    );
    assert.equal(url, "https://ollama.com/v1/chat/completions");
    assert.equal(auth, "Bearer test-key");
    assert.equal(model, "gemma4:31b");
    assert.equal(instructions, COACH_FEEDBACK_INSTRUCTIONS);
    assert.match(instructions, /recommend what to change/);
    assert.match(instructions, /Do not retell the session/);
    assert.match(instructions, /step rate/);
    assert.equal(result.ok, true);
  });
});
