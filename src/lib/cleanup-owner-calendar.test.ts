import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import {
  cleanupOwnerCalendarPlannedWorkouts,
  parseOwnerCalendarCliArgs,
} from "./cleanup-owner-calendar.ts";
import { getDb, insertUser, saveTrainingSnapshot } from "./db.ts";
import { INTERVALS_ICU_BASE_URL } from "./intervals.ts";
import type { Session, SessionKind } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-cleanup-owner-calendar-"));
process.env.AUTH_DATA_DIR = dataDir;

const ATHLETE = "i2049151";
const API_KEY = "legacy-global-key-secret";
const OWNER_ID = "cal-owner";
const OTHER_ID = "cal-other";
const OTHER_TWO_ID = "cal-other-two";
const PENDING_ID = "cal-pending";
const OWNER_EMAIL = "owner.secret@example.com";
const OTHER_EMAIL = "runner.secret@example.com";
const PENDING_EMAIL = "pending.secret@example.com";
const DAY = "2026-09-20";
const originalOwners = process.env.INTERVALS_OWNER_EMAILS;
const originalKey = process.env.INTERVALS_ICU_API_KEY;

function session(
  id: string,
  userId: string,
  title: string,
  cue: string,
  kind: SessionKind = "easy",
  date = DAY,
): Session {
  return {
    id,
    planId: `${userId}-plan`,
    userId,
    date,
    weekday: "mon",
    weekIndex: 0,
    kind,
    title,
    cue,
    distanceKm: 8,
  };
}

function seedUsers(): void {
  const rows: Array<{ id: string; email: string; emailVerifiedAt?: string }> = [
    { id: OWNER_ID, email: `  ${OWNER_EMAIL.toUpperCase()} `, emailVerifiedAt: "2026-09-02T00:00:00.000Z" },
    { id: OTHER_ID, email: OTHER_EMAIL },
    { id: OTHER_TWO_ID, email: "second.runner@example.com" },
    { id: PENDING_ID, email: PENDING_EMAIL },
  ];
  for (const row of rows) {
    const existing = getDb().prepare("SELECT id FROM users WHERE id = ?").get(row.id);
    if (existing) continue;
    insertUser({ id: row.id, email: row.email, createdAt: "2026-09-01T00:00:00.000Z", emailVerifiedAt: row.emailVerifiedAt });
  }
}

function seedSessions(sessions: Session[]): void {
  seedUsers();
  saveTrainingSnapshot(
    { onboarding: [], plans: [], sessions, feedbacks: [], runLogs: [], adaptationEvents: [] },
    "replace",
  );
}

function workout(input: {
  id?: number;
  externalId?: string;
  name?: string;
  description?: string;
  start?: string;
  category?: string;
  type?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    external_id: input.externalId,
    category: input.category ?? "WORKOUT",
    type: input.type ?? "Run",
    name: input.name ?? "Easy run · 8 km",
    description: input.description ?? "Keep it conversational",
    start_date_local: input.start ?? `${DAY}T08:00:00`,
  };
}

function captureLogs(): string[] {
  const lines: string[] = [];
  mock.method(console, "error", (line: string) => {
    lines.push(String(line));
  });
  mock.method(console, "log", (line: string) => {
    lines.push(String(line));
  });
  return lines;
}

function assertNoSecrets(lines: readonly string[]): void {
  const text = lines.join("\n");
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes(OWNER_EMAIL), false);
  assert.equal(text.includes(OTHER_EMAIL), false);
  assert.equal(text.includes(PENDING_EMAIL), false);
  assert.equal(text.toLowerCase().includes("authorization"), false);
  assert.equal(text.includes("Bearer "), false);
  assert.equal(text.includes("Basic "), false);
}

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  if (originalOwners === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
  else process.env.INTERVALS_OWNER_EMAILS = originalOwners;
  if (originalKey === undefined) delete process.env.INTERVALS_ICU_API_KEY;
  else process.env.INTERVALS_ICU_API_KEY = originalKey;
});

describe("parseOwnerCalendarCliArgs", () => {
  it("requires one athlete id and rejects unknown flags", () => {
    assert.equal(parseOwnerCalendarCliArgs([]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--apply"]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--athlete"]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--athlete="]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--athlete", "not-an-id"]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--athlete", "i1", "--athlete", "i2"]).ok, false);
    assert.equal(parseOwnerCalendarCliArgs(["--bogus"]).ok, false);
    const parsed = parseOwnerCalendarCliArgs(["--athlete=i2049151", "--apply"]);
    assert.deepEqual(parsed, { ok: true, apply: true, athlete: "i2049151" });
    const spaced = parseOwnerCalendarCliArgs(["--apply", "--athlete", " i99 "]);
    assert.deepEqual(spaced, { ok: true, apply: true, athlete: "i99" });
  });
});

describe("cleanupOwnerCalendarPlannedWorkouts", () => {
  const ownerSession = "owner-session";
  const otherSession = "other-session";
  const tempoSession = "other-tempo";

  function baseSessions(): Session[] {
    return [
      session(ownerSession, OWNER_ID, "Easy run · 8 km", "Keep it conversational"),
      session(otherSession, OTHER_ID, "Easy run · 8 km", "Keep it conversational"),
      session(tempoSession, OTHER_ID, "Tempo · 10 km", "Comfortably hard, controlled", "tempo", "2026-09-22"),
    ];
  }

  it("aborts without a request when the owner allowlist is unset or the athlete id is invalid", async () => {
    seedSessions(baseSessions());
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    };
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.INTERVALS_OWNER_EMAILS;
      else process.env.INTERVALS_OWNER_EMAILS = value;
      process.env.INTERVALS_ICU_API_KEY = API_KEY;
      const lines = captureLogs();
      const result = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, fetchImpl });
      assert.equal(result.aborted, true);
      assert.equal(result.deleted, 0);
      assert.equal(lines.some((line) => line.includes("unset or empty")), true);
      assertNoSecrets(lines);
      mock.restoreAll();
    }
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    const lines = captureLogs();
    const invalid = await cleanupOwnerCalendarPlannedWorkouts({
      athlete: "../i1",
      apply: true,
      fetchImpl,
    });
    assert.equal(invalid.aborted, true);
    assert.equal(invalid.deleted, 0);
    assert.equal(calls.length, 0);
    assert.equal(lines.some((line) => line.includes("no events deleted")), true);
  });

  it("aborts --apply before any request when an allowlisted account is not verified", async () => {
    seedSessions([
      ...baseSessions(),
      session("pending-session", PENDING_ID, "Long run · 12 km", "Easy pace, finish with something left", "long"),
    ]);
    process.env.INTERVALS_OWNER_EMAILS = `${OWNER_EMAIL},${PENDING_EMAIL}`;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    };
    const lines = captureLogs();
    const result = await cleanupOwnerCalendarPlannedWorkouts({
      athlete: ATHLETE,
      apply: true,
      fetchImpl,
    });
    assert.equal(result.aborted, true);
    assert.equal(result.deleted, 0);
    assert.equal(calls, 0);
    assert.equal(lines.some((line) => line.includes(`userId=${PENDING_ID}`) && line.includes("not verified")), true);
    assert.equal(lines.some((line) => line.includes("No events deleted")), true);
    assertNoSecrets(lines);
  });

  it("does not DELETE without --apply, and never selects a foreign or owner workout", async () => {
    seedSessions(baseSessions());
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    const foreignId = 9001;
    const ownerEventId = 9002;
    const legacyId = 9003;
    const handMadeId = 9004;
    const calls: Array<{ url: string; method: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? "",
      });
      return new Response(
        JSON.stringify([
          workout({ id: legacyId, externalId: otherSession, name: `Renamed ${API_KEY} run` }),
          workout({ id: ownerEventId, externalId: ownerSession }),
          workout({
            id: foreignId,
            externalId: "other-app-workout",
            name: "Easy run · 8 km",
            description: "Keep it conversational",
          }),
          workout({ id: handMadeId, name: "Park loops", description: "easy", start: `${DAY}T07:00:00`, externalId: "" }),
          { ...workout({ id: 9005, name: "Easy run · 8 km" }), external_id: 424242 },
        ]),
        { status: 200 },
      );
    };
    const lines = captureLogs();
    const result = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, fetchImpl });
    assert.equal(result.aborted, false);
    assert.equal(result.apply, false);
    assert.equal(result.wouldDelete, 1);
    assert.equal(result.deleted, 0);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`/athlete/${ATHLETE}/events\\?`));
    assert.match(calls[0].url, /category=WORKOUT/);
    assert.equal(calls[0].url.startsWith(INTERVALS_ICU_BASE_URL), true);
    assert.equal(calls[0].authorization.startsWith("Basic "), true);
    assert.equal(calls[0].authorization.includes(API_KEY), false);
    assert.equal(
      lines.some((line) => line.includes(`would-delete id=${legacyId} date=${DAY} name=Renamed [redacted] run`)),
      true,
    );
    assert.equal(lines.some((line) => line.includes(`userId=${OTHER_ID} count=1`)), true);
    assert.equal(lines.some((line) => line.includes("wouldDelete=1")), true);
    assert.equal(lines.some((line) => line.includes("dry-run: nothing deleted")), true);
    assert.equal(lines.some((line) => line.includes(String(foreignId))), false);
    assert.equal(lines.some((line) => line.includes(String(ownerEventId))), false);
    assert.equal(lines.some((line) => line.includes(String(handMadeId))), false);
    assert.equal(lines.some((line) => line.includes("9005")), false);
    assert.equal(lines.some((line) => line.includes("424242")), false);
    assertNoSecrets(lines);
  });

  it("deletes only the non-owner upload on --apply, including a blank external id that matches the upload name", async () => {
    seedSessions(baseSessions());
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    const legacyId = 9101;
    const namedId = 9102;
    const foreignId = 9103;
    const timeline: string[] = [];
    const lines = captureLogs();
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      if (method === "DELETE") {
        assert.equal(lines.some((line) => line.includes("would-delete")), true);
        assert.equal(lines.some((line) => line.includes("deleted=")), false);
      }
      timeline.push(`${method} ${url}`);
      if (method === "DELETE") return new Response(null, { status: 200 });
      return new Response(
        JSON.stringify([
          workout({ id: legacyId, externalId: otherSession }),
          workout({
            id: namedId,
            externalId: "",
            name: "Tempo · 10 km",
            description: "Comfortably hard, controlled",
            start: "2026-09-22T08:00:00",
          }),
          workout({ id: foreignId, externalId: "garmin-fit-1", name: "Tempo · 10 km", description: "Comfortably hard, controlled", start: "2026-09-22T08:00:00" }),
        ]),
        { status: 200 },
      );
    };
    const result = await cleanupOwnerCalendarPlannedWorkouts({
      athlete: ATHLETE,
      apply: true,
      fetchImpl,
    });
    assert.equal(lines.filter((line) => line.includes("would-delete")).length, 2);
    assert.equal(result.deleted, 2);
    assert.equal(result.alreadyDeleted, 0);
    assert.equal(result.failed, 0);
    const deletes = timeline.filter((entry) => entry.startsWith("DELETE "));
    assert.deepEqual(
      deletes.map((entry) => entry.split("/").at(-1)),
      [String(legacyId), String(namedId)],
    );
    assert.equal(deletes.some((entry) => entry.includes(String(foreignId))), false);
    assert.equal(timeline.findIndex((entry) => entry.startsWith("DELETE ")) > timeline.findIndex((entry) => entry.startsWith("GET ")), true);
    assert.equal(lines.findIndex((line) => line.includes("would-delete")) < lines.findIndex((line) => line.includes("deleted=")), true);
    assert.equal(lines.some((line) => line.includes(`userId=${OTHER_ID} count=2`)), true);
    assertNoSecrets(lines);
  });

  it("does not use the name prefix when that day also belongs to the owner or to two other accounts", async () => {
    seedSessions([
      ...baseSessions(),
      session("other-two-tempo", OTHER_TWO_ID, "Long run · 14 km", "Easy pace, finish with something left", "long", "2026-09-23"),
      session("other-long", OTHER_ID, "Long run · 14 km", "Easy pace, finish with something left", "long", "2026-09-23"),
      session("owner-tempo", OWNER_ID, "Tempo · 10 km", "Comfortably hard, controlled", "tempo", "2026-09-22"),
    ]);
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "DELETE") calls.push(String(input));
      return new Response(
        JSON.stringify([
          workout({
            id: 9201,
            externalId: "",
            name: "Tempo · 10 km",
            description: "Comfortably hard, controlled",
            start: "2026-09-22T08:00:00",
          }),
          workout({
            id: 9202,
            externalId: "",
            name: "Long run · 14 km",
            description: "Easy pace, finish with something left",
            start: "2026-09-23T08:00:00",
          }),
        ]),
        { status: 200 },
      );
    };
    captureLogs();
    const result = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, apply: true, fetchImpl });
    assert.equal(result.wouldDelete, 0);
    assert.equal(result.deleted, 0);
    assert.equal(calls.length, 0);
  });

  it("treats a 404 on delete as already deleted, including a second --apply", async () => {
    seedSessions(baseSessions());
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    let deletes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") {
        deletes += 1;
        return new Response("missing", { status: 404 });
      }
      return new Response(JSON.stringify([workout({ id: 9301, externalId: otherSession })]), { status: 200 });
    };
    const firstLines = captureLogs();
    const first = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, apply: true, fetchImpl });
    assert.equal(first.aborted, false);
    assert.equal(first.deleted, 0);
    assert.equal(first.alreadyDeleted, 1);
    assert.equal(first.failed, 0);
    assert.equal(firstLines.some((line) => line.includes("deleted=0 alreadyDeleted=1")), true);
    mock.restoreAll();
    const secondLines = captureLogs();
    const second = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, apply: true, fetchImpl });
    assert.equal(second.deleted, 0);
    assert.equal(second.alreadyDeleted, 1);
    assert.equal(second.failed, 0);
    assert.equal(deletes, 2);
    assert.equal(secondLines.some((line) => line.includes("deleted=0 alreadyDeleted=1")), true);
    assertNoSecrets(firstLines);
    assertNoSecrets(secondLines);
  });

  it("deletes 0 on a second --apply after the event is gone", async () => {
    seedSessions(baseSessions());
    process.env.INTERVALS_OWNER_EMAILS = OWNER_EMAIL;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    let listed = [workout({ id: 9401, externalId: otherSession })];
    let deletes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") {
        deletes += 1;
        listed = [];
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify(listed), { status: 200 });
    };
    captureLogs();
    const first = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, apply: true, fetchImpl });
    assert.equal(first.deleted, 1);
    mock.restoreAll();
    captureLogs();
    const second = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, apply: true, fetchImpl });
    assert.equal(second.wouldDelete, 0);
    assert.equal(second.deleted, 0);
    assert.equal(second.alreadyDeleted, 0);
    assert.equal(deletes, 1);
  });

  it("omits a pending owner's upload on dry-run and does not warn with an email", async () => {
    seedSessions([
      ...baseSessions(),
      session("pending-session", PENDING_ID, "Long run · 12 km", "Easy pace, finish with something left", "long"),
    ]);
    process.env.INTERVALS_OWNER_EMAILS = `${OWNER_EMAIL}, ${PENDING_EMAIL}`;
    process.env.INTERVALS_ICU_API_KEY = API_KEY;
    const deletes: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "DELETE") deletes.push("delete");
      return new Response(
        JSON.stringify([
          workout({ id: 9501, externalId: otherSession }),
          workout({ id: 9502, externalId: "pending-session", name: "Long run · 12 km" }),
        ]),
        { status: 200 },
      );
    };
    const lines = captureLogs();
    const result = await cleanupOwnerCalendarPlannedWorkouts({ athlete: ATHLETE, fetchImpl });
    assert.equal(result.aborted, false);
    assert.equal(result.wouldDelete, 1);
    assert.equal(deletes.length, 0);
    assert.equal(lines.some((line) => line.includes(`userId=${PENDING_ID}`) && line.includes("warning")), true);
    assert.equal(lines.some((line) => line.includes("id=9502")), false);
    assertNoSecrets(lines);
  });
});

describe("cleanup:owner-calendar cli", () => {
  it("exits 1 for a missing athlete or an unknown flag and does not delete", () => {
    const spawnCli = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/jobs/cleanup-owner-calendar.ts", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, AUTH_DATA_DIR: dataDir },
        encoding: "utf8",
      });
    for (const args of [[], ["--apply"], ["--bogus"], ["--athlete", "nope"]]) {
      const result = spawnCli(args);
      assert.equal(result.status, 1);
      assert.match(`${result.stderr}`, /no events deleted/);
      assert.equal(`${result.stdout}${result.stderr}`.includes(API_KEY), false);
    }
  });
});
