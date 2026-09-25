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

function captureLogs(): string[] {
  const lines: string[] = [];
  mock.method(console, "error", (line: string) => {
    lines.push(line);
  });
  mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  return lines;
}

describe("cleanupNonOwnerIntervalsRunLogs", () => {
  it("aborts without deleting when INTERVALS_OWNER_EMAILS is unset or empty", () => {
    seedLogs();
    const before = ids();
    for (const value of [undefined, "", "   ", ",", " , "]) {
      for (const apply of [false, true]) {
        if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
        else process.env.INTERVALS_OWNER_EMAILS = value;
        const lines = captureLogs();
        const result = cleanupNonOwnerIntervalsRunLogs({ apply });
        assert.equal(result.aborted, true);
        assert.equal(result.apply, apply);
        assert.deepEqual(result.rows, []);
        assert.equal(lines.some((line) => line.includes("aborted") && line.includes("unset or empty")), true);
        assert.equal(lines.some((line) => line.includes("wouldDelete=")), false);
        mock.restoreAll();
      }
    }
    assert.deepEqual(ids(), before);
  });

  it("dry run reports per-user counts and --apply deletes only non-owner intervals RunLogs", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "CRISPAL94@gmail.com";
    const before = ids();
    const lines = captureLogs();

    const dry = cleanupNonOwnerIntervalsRunLogs();
    assert.equal(dry.aborted, false);
    assert.equal(dry.apply, false);
    assert.deepEqual(dry.rows, [
      { userId: OTHER_ID, email: "Runner@Example.com", wouldDelete: 2 },
      { userId: OWNER_ID, email: "CrisPal94@gmail.com", wouldDelete: 0 },
    ]);
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] dry-run userId=${OTHER_ID} email=Runner@Example.com wouldDelete=2`,
      ),
      true,
    );
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] dry-run userId=${OWNER_ID} email=CrisPal94@gmail.com wouldDelete=0`,
      ),
      true,
    );
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run total=2"), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] dry-run: nothing deleted"), true);
    assert.deepEqual(ids(), before);

    lines.length = 0;
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.apply, true);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(applied.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=2"), true);
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] apply userId=${OTHER_ID} email=Runner@Example.com deleted=2`,
      ),
      true,
    );
    assert.equal(lines.some((line) => line.includes("wouldDelete=")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);

    lines.length = 0;
    const again = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(again.aborted, false);
    assert.equal(again.rows.every((row) => row.wouldDelete === 0), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=0"), true);
    assert.equal(
      lines.includes(
        `[cleanup:intervals-nonowners] apply userId=${OWNER_ID} email=CrisPal94@gmail.com deleted=0`,
      ),
      true,
    );
    assert.equal(lines.some((line) => line.includes("wouldDelete=")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);
  });
});
