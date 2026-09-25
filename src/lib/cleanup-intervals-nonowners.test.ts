import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { cleanupNonOwnerIntervalsRunLogs, PER_USER_INTERVALS_SINCE } from "./cleanup-intervals-nonowners.ts";
import {
  getUserById,
  insertUser,
  loadTrainingSnapshot,
  saveTrainingSnapshot,
  upsertIntervalsConnection,
} from "./db.ts";
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
    assert.equal(dry.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 2);
    assert.equal(dry.rows.find((row) => row.userId === OTHER_ID)?.email, "Runner@Example.com");
    assert.equal(dry.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(dry.rows.find((row) => row.userId === OWNER_ID)?.email, "CrisPal94@gmail.com");
    assert.equal(dry.rows.reduce((sum, row) => sum + row.wouldDelete, 0), 2);
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
    const wouldAt = lines.findIndex((line) => line.includes(`userId=${OTHER_ID}`) && line.includes("wouldDelete=2"));
    const deletedAt = lines.findIndex((line) => line.includes(`userId=${OTHER_ID}`) && line.includes("deleted=2"));
    assert.equal(wouldAt >= 0 && deletedAt > wouldAt, true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=2"), true);
    assert.equal(lines.some((line) => line.startsWith("[cleanup:intervals-nonowners] apply") && line.includes("email=")), false);
    assert.equal(lines.some((line) => line.includes("@")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);

    lines.length = 0;
    const again = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(again.aborted, false);
    assert.equal(again.rows.every((row) => row.wouldDelete === 0), true);
    assert.equal(lines.includes("[cleanup:intervals-nonowners] apply total=0"), true);
    assert.equal(
      lines.includes(`[cleanup:intervals-nonowners] apply userId=${OWNER_ID} wouldDelete=0`),
      true,
    );
    assert.equal(
      lines.includes(`[cleanup:intervals-nonowners] apply userId=${OWNER_ID} deleted=0`),
      true,
    );
    assert.equal(lines.some((line) => line.includes("email=")), false);
    assert.deepEqual(ids(), ["other-manual", "owner-intervals", "owner-manual"]);
  });

  it("leaves an account with its own connection, logs at the cutoff, and the owner untouched", () => {
    seedLogs();
    const connectedId = "cleanup-connected";
    if (!getUserById(connectedId)) {
      insertUser({
        id: connectedId,
        email: "connected@example.com",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    }
    upsertIntervalsConnection({
      userId: connectedId,
      athleteId: "i222222",
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: "v1:own-secret",
      authType: "apikey",
    });
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [],
        sessions: [],
        feedbacks: [],
        runLogs: [
          runLog("owner-intervals", OWNER_ID, "intervals"),
          runLog("owner-manual", OWNER_ID, "manual"),
          runLog("connected-old", connectedId, "intervals"),
          { ...runLog("other-old", OTHER_ID, "intervals"), createdAt: "2026-09-24T23:59:59.000Z" },
          { ...runLog("other-cutoff", OTHER_ID, "intervals"), createdAt: PER_USER_INTERVALS_SINCE },
          { ...runLog("other-after", OTHER_ID, "intervals"), createdAt: "2026-09-26T00:00:00.000Z" },
          runLog("other-manual", OTHER_ID, "manual"),
        ],
        adaptationEvents: [],
      },
      "replace",
    );
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const lines = captureLogs();
    const applied = cleanupNonOwnerIntervalsRunLogs({ apply: true });
    assert.equal(applied.aborted, false);
    assert.equal(applied.rows.find((row) => row.userId === connectedId)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === OWNER_ID)?.wouldDelete, 0);
    assert.equal(applied.rows.find((row) => row.userId === OTHER_ID)?.wouldDelete, 1);
    assert.equal(lines.some((line) => line.includes("wouldDelete=1")), true);
    assert.equal(lines.some((line) => line.includes("deleted=1")), true);
    assert.deepEqual(ids(), [
      "connected-old",
      "other-after",
      "other-cutoff",
      "other-manual",
      "owner-intervals",
      "owner-manual",
    ]);
  });

  it("honors --before and aborts on an invalid cutoff without deleting", () => {
    seedLogs();
    process.env.INTERVALS_OWNER_EMAILS = "crispal94@gmail.com";
    const before = ids();
    const kept = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: "2026-01-01T00:00:00.000Z" });
    assert.equal(kept.aborted, false);
    assert.equal(kept.rows.every((row) => row.wouldDelete === 0), true);
    assert.deepEqual(ids(), before);

    const lines = captureLogs();
    const bad = cleanupNonOwnerIntervalsRunLogs({ apply: true, before: "yesterday" });
    assert.equal(bad.aborted, true);
    assert.deepEqual(bad.rows, []);
    assert.equal(lines.some((line) => line.includes("--before") && line.includes("no RunLogs deleted")), true);
    assert.deepEqual(ids(), before);
  });
});
