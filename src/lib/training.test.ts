import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import { handleOnboardingPost } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-training-"));
process.env.AUTH_DATA_DIR = dataDir;

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedStep5Draft(userId: string): void {
  saveTrainingSnapshot({
    onboarding: [
      {
        userId,
        goal: "5k",
        raceDate: null,
        level: "beginner",
        days: ["mon", "wed", "fri"],
        baseline: { kind: "skip" },
        updatedAt: "2026-09-01T12:00:00.000Z",
      },
    ],
    plans: [],
    sessions: [],
    feedbacks: [],
    runLogs: [],
    adaptationEvents: [],
  });
}

describe("onboarding generate redirect", () => {
  it("step 5 generate with cadence redirects to /today?ready=1", async () => {
    seedStep5Draft("generate-ready");
    const formData = new FormData();
    formData.set("intent", "generate");
    formData.set("days", "mon");
    formData.set("days", "wed");
    formData.set("days", "fri");
    formData.set("feedbackCadence", "daily");

    const result = await handleOnboardingPost("generate-ready", formData);

    assert.deepEqual(result, { ok: true, redirect: "/today?ready=1" });
    assert.equal(
      loadTrainingSnapshot().plans.some((plan) => plan.userId === "generate-ready"),
      true,
    );
  });
});