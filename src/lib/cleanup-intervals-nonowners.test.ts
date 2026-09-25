import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { cleanupNonOwnerIntervalsRunLogs } from "./cleanup-intervals-nonowners.ts";
import { getUserById, insertUser, loadTrainingSnapshot, saveTrainingSnapshot } from "./db.ts";
import type { RunLog } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-cleanup-intervals-"));
process.env.AUTH_DATA_DIR = dataDir;

const OWNER_ID = "cleanup-owner";
const OTHER_ID = "cleanup-other";
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;

function runLog(id: string, userId: string, source: "intervals" | "manual"): RunLog {
  return {
    id,
    userId,
    sessionId: `${id}-session`,
    planId: `${userId}-plan`,
    distanceKm: 5,
    timeSec: 1800,
    paceSecPerKm: 360,
    createdAt: "2026-09-01T00:00:00.000Z",
    source,
  };
}

function seedLogs(): void {
  if (!getUserById(OWNER_ID)) {
    insertUser({
      id: OWNER_ID,
      email: "  CrisPal94@gmail.com ",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  if (!getUserById(OTHER_ID)) {
    insertUser({
      id: OTHER_ID,
      email: "Runner@Example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: [],
      sessions: [],
      feedbacks: [],
      runLogs: [
        runLog("owner-intervals", OWNER_ID, "intervals"),
        runLog("owner-manual", OWNER_ID, "manual"),
        runLog("other-intervals-a", OTHER_ID, "intervals"),
        runLog("other-intervals-b", OTHER_ID, "intervals"),
        runLog("other-manual", OTHER_ID, "manual"),
      ],
      adaptationEvents: [],
    },
    "replace",
  );
}

function ids(): string[] {
  return loadTrainingSnapshot()
    .runLogs.map((entry) => entry.id)
    .sort();
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
});

describe("cleanupNonOwnerIntervalsRunLogs", () => {
  it("aborts without deleting when INTERVALS_OWNER_EMAILS is unset or empty", () => {
    seedLogs();
    const before = ids();
    for (const value of [undefined, "", "   ", ",", " , "]) {
      if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
      else process.env.INTERVALS_OWNER_EMAILS = value;
      const lines: string[] = [];
      mock.method(console, "error", (line: string) => {
        lines.push(line);
      });
      mock.method(console, "log", (line: string) => {
        lines.push(line);
      });
      const result = cleanupNonOwnerIntervalsRunLogs();
      assert.equal(result.aborted, true);
      assert.deepEqual(result.deletedByUser, []);
      assert.equal(lines.some((line) => line.includes("aborted") && line.includes("unset or empty")), true);
      assert.equal(lines.some((line) => line.includes("deleted userId=")), false);
      mock.restoreAll();
    }
    assert.deepEqual(ids(), before);
  });

  it("deletes only non-owner intervals RunLogs and is safe to run again", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "CRISPAL94@gmail.com";
    const lines: string[] = [];
    mock.method(console, "log", (line: string) => {
      lines.push(line);
    });
    mock.method(console, "error", () => {});

    const result = cleanupNonOwnerIntervalsRunLogs();
    assert.equal(result.aborted, false);
    assert.deepEqual(result.deletedByUser, [{ userId: OTHER_ID, count: 2 }]);
    assert.equal(lines.includes(`[cleanup:intervals-nonowners] deleted userId=${OTHER_ID} count=2`), true);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);

    lines.length = 0;
    const again = cleanupNonOwnerIntervalsRunLogs();
    assert.equal(again.aborted, false);
    assert.deepEqual(again.deletedByUser, []);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] done deleted=0"), true);
    assert.equal(lines.some((line) => line.includes("deleted userId=")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);
  });
});
