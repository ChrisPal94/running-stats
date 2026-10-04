import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { GET } from "../pages/api/adapt.ts";
import { adaptRunLogLine } from "./adapt-cron.ts";
import { runNocturnalAdaptation } from "./adapt.ts";
import { addDaysYmd, appTodayYmd } from "./calendar.ts";
import { getDb, insertUser, loadTrainingSnapshot, saveTrainingSnapshot, upsertIntervalsConnection } from "./db.ts";
import { encryptIntervalsApiKey } from "./intervals-crypto.ts";
import type { Feedback, Plan, RunLog, Session } from "./training.ts";

const dataDir = mkdtempSync(join(tmpdir(), "rs-adapt-fail-"));
const originalEnv = {
  AUTH_DATA_DIR: process.env.AUTH_DATA_DIR,
  INTERVALS_KEY_ENC_SECRET: process.env.INTERVALS_KEY_ENC_SECRET,
  ADAPT_LLM_API_KEY: process.env.ADAPT_LLM_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
  ADAPT_CRON_SECRET: process.env.ADAPT_CRON_SECRET,
};
const CRON_SECRET = "adapt-bearer-test-secret";
const WEEKDAY_BY_UTC = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
process.env.AUTH_DATA_DIR = dataDir;
process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 9).toString("base64");

const NOW = new Date("2026-09-24T17:00:00.000Z");
const FAILING = "adapt-fail-user";
const OK = "adapt-ok-user";

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  restoreEnv();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  process.env.AUTH_DATA_DIR = dataDir;
  process.env.INTERVALS_KEY_ENC_SECRET = Buffer.alloc(32, 9).toString("base64");
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_MODEL;
  if (originalEnv.ADAPT_CRON_SECRET === undefined) delete process.env.ADAPT_CRON_SECRET;
  else process.env.ADAPT_CRON_SECRET = originalEnv.ADAPT_CRON_SECRET;
});

function weekdayId(ymd: string): Session["weekday"] {
  return WEEKDAY_BY_UTC[new Date(`${ymd}T12:00:00.000Z`).getUTCDay()] ?? "sun";
}

function llmOff(): void {
  delete process.env.ADAPT_LLM_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_MODEL;
}

function athlete(userId: string, options: {
  connect?: boolean;
  athleteId?: string;
  today?: string;
  tomorrowKind?: string;
  email?: string;
} = {}): {
  plan: Plan;
  today: Session;
  tomorrow: Session;
  feedback: Feedback;
  log: RunLog;
} {
  const email = options.email ?? `${userId}@example.com`;
  const todayYmd = options.today ?? "2026-09-24";
  const tomorrowYmd = options.today ? addDaysYmd(todayYmd, 1) : "2026-09-25";
  insertUser({ id: userId, email, createdAt: "2026-09-01T00:00:00.000Z" });
  if (options.connect !== false) {
    upsertIntervalsConnection({
      userId,
      athleteId: options.athleteId ?? "i123456",
      connectedAt: "2026-09-01T00:00:00.000Z",
      apiKeyEnc: encryptIntervalsApiKey(`key-${userId}`, userId),
      authType: "apikey",
    });
  }
  const planId = `${userId}-plan`;
  const plan: Plan = {
    id: planId,
    userId,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    goal: "5k",
    raceDate: null,
    level: "beginner",
    days: ["thu", "fri"],
    baseline: { kind: "skip" },
    feedbackCadence: "daily",
  };
  const today: Session = {
    id: `${userId}-today`,
    planId,
    userId,
    date: todayYmd,
    weekday: options.today ? weekdayId(todayYmd) : "thu",
    weekIndex: 0,
    kind: "easy",
    title: "Easy run · 8 km",
    cue: "Keep it conversational",
    distanceKm: 8,
  };
  const tomorrow: Session = {
    id: `${userId}-tomorrow`,
    planId,
    userId,
    date: tomorrowYmd,
    weekday: options.today ? weekdayId(tomorrowYmd) : "fri",
    weekIndex: 0,
    kind: (options.tomorrowKind ?? "easy") as Session["kind"],
    title: `Easy run · 10 km ${email}`,
    cue: "Keep it conversational",
    distanceKm: 10,
  };
  const feedback: Feedback = {
    id: `${userId}-fb`,
    userId,
    planId,
    sessionId: today.id,
    kind: "skip",
    createdAt: "2026-09-24T15:00:00.000Z",
  };
  const log: RunLog = {
    id: `${userId}-log`,
    userId,
    sessionId: today.id,
    planId,
    distanceKm: 8,
    timeSec: 2400,
    paceSecPerKm: 300,
    createdAt: "2026-09-24T15:00:00.000Z",
    source: "intervals",
  };
  return { plan, today, tomorrow, feedback, log };
}

type Athlete = ReturnType<typeof athlete>;

function saveAthletes(rows: Athlete[]): void {
  saveTrainingSnapshot(
    {
      onboarding: [],
      plans: rows.map((row) => row.plan),
      sessions: rows.flatMap((row) => [row.today, row.tomorrow]),
      feedbacks: rows.map((row) => row.feedback),
      runLogs: rows.map((row) => row.log),
      adaptationEvents: [],
    },
    "replace",
  );
}

function captureConsole(): string[] {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  mock.method(console, "error", sink);
  mock.method(console, "warn", sink);
  mock.method(console, "log", sink);
  return lines;
}

function assertNoUserData(text: string, seeds: string[]): void {
  for (const seed of seeds) {
    assert.equal(text.includes(seed), false);
  }
}

const COUNT_KEYS = [
  "processed",
  "written",
  "skipped",
  "patched",
  "llmFailed",
  "uploaded",
  "uploadFailed",
  "noConnection",
  "reconnect",
] as const;

async function callAdapt(authorization?: string): Promise<Response> {
  process.env.ADAPT_CRON_SECRET = CRON_SECRET;
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  const request = new Request("https://stride.test/api/adapt", { method: "GET", headers });
  return GET({ request } as Parameters<typeof GET>[0]);
}

function installFetch(failAthlete?: string): string[] {
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (!url.startsWith("https://intervals.icu/")) {
      const error = new Error("offline fixture blocked a network call");
      error.name = "OfflineFixture";
      throw error;
    }
    if (failAthlete && url.includes(`/athlete/${failAthlete}/`)) {
      const error = new Error("socket hang up");
      error.name = "NetworkError";
      throw error;
    }
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return urls;
}

function watchDb(
  onRun?: (sql: string, args: unknown[], run: (...args: unknown[]) => unknown) => unknown,
): { sql: string[]; restore: () => void } {
  const database = getDb();
  const sql: string[] = [];
  const originalExec = database.exec.bind(database);
  const originalPrepare = database.prepare.bind(database);
  database.exec = ((source: string) => {
    sql.push(source);
    return originalExec(source);
  }) as typeof database.exec;
  if (onRun) {
    database.prepare = ((statementSql: string) => {
      const statement = originalPrepare(statementSql);
      const run = statement.run.bind(statement) as (...args: unknown[]) => unknown;
      return new Proxy(statement, {
        get(target, prop, receiver) {
          if (prop !== "run") {
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
          return (...args: unknown[]) => onRun(statementSql, args, run);
        },
      });
    }) as typeof database.prepare;
  }
  return {
    sql,
    restore() {
      database.exec = originalExec;
      database.prepare = originalPrepare;
    },
  };
}

function distanceOf(sessionId: string): number | undefined {
  return loadTrainingSnapshot().sessions.find((session) => session.id === sessionId)?.distanceKm;
}

function hasEvent(userId: string): boolean {
  return loadTrainingSnapshot().adaptationEvents.some((event) => event.userId === userId);
}

describe("adapt account failure", { concurrency: false }, () => {
  it("counts a thrown account as skipped and still adapts the other account", async () => {
    delete process.env.ADAPT_LLM_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    const failing = athlete(FAILING);
    const ok = athlete(OK);
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [failing.plan, ok.plan],
        sessions: [failing.today, failing.tomorrow, ok.today, ok.tomorrow],
        feedbacks: [failing.feedback, ok.feedback],
        runLogs: [failing.log, ok.log],
        adaptationEvents: [],
      },
      "replace",
    );

    const lines: string[] = [];
    mock.method(console, "error", (line: string) => {
      lines.push(String(line));
    });
    const loadRunEffort = mock.fn(async (userId: string) => {
      if (userId === FAILING) throw new Error("effort down");
      return null;
    });
    const upsertPlannedRuns = mock.fn(async () => ({ uploaded: 1, failed: 0 }));

    const result = await runNocturnalAdaptation(NOW, { loadRunEffort, upsertPlannedRuns });

    assert.equal(result.processed, 2);
    assert.equal(result.written, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.patched, 1);
    assert.match(adaptRunLogLine(result), /skipped=1/);
    assert.equal(adaptRunLogLine(result).includes(FAILING), false);
    assert.equal(lines.some((line) => line.includes("[intervals] adapt account failed")), true);

    const snapshot = loadTrainingSnapshot();
    assert.equal(snapshot.adaptationEvents.some((event) => event.userId === FAILING), false);
    assert.equal(snapshot.adaptationEvents.some((event) => event.userId === OK), true);
    assert.equal(snapshot.sessions.find((session) => session.id === `${FAILING}-tomorrow`)?.distanceKm, 10);
    assert.equal(snapshot.sessions.find((session) => session.id === `${OK}-tomorrow`)?.distanceKm, 8);
    assert.equal(upsertPlannedRuns.mock.calls.length, 1);
  });

  it("returns 200 when planDecisions throws for one of three accounts", async () => {
    llmOff();
    const today = appTodayYmd();
    const badId = "adapt-plan-bad";
    const okA = "adapt-plan-a";
    const okB = "adapt-plan-b";
    const badEmail = "leak-plan@example.com";
    const rows = [
      athlete(okA, { today, athleteId: "i910001", email: "plan-a@example.com" }),
      athlete(badId, {
        today,
        athleteId: "i910002",
        email: badEmail,
        tomorrowKind: "not-a-kind",
      }),
      athlete(okB, { today, athleteId: "i910003", email: "plan-b@example.com" }),
    ];
    saveAthletes(rows);
    const lines = captureConsole();
    const urls = installFetch();
    const watched = watchDb();
    const seeds = [badId, okA, okB, badEmail, "plan-a@example.com", "plan-b@example.com", "key-adapt-plan"];
    try {
      const response = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), [...COUNT_KEYS].sort());
      assert.equal(body.processed, 3);
      assert.equal(body.written, 2);
      assert.equal(body.skipped, 1);
      assert.equal(body.patched, 2);
      assert.equal(body.uploaded, 2);
      assert.equal(body.uploadFailed, 0);
      assertNoUserData(JSON.stringify(body), [...seeds, "TypeError", "not-a-kind"]);
      assert.equal(hasEvent(badId), false);
      assert.equal(hasEvent(okA), true);
      assert.equal(hasEvent(okB), true);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(distanceOf(`${okA}-tomorrow`), 8);
      assert.equal(distanceOf(`${okB}-tomorrow`), 8);
      assert.equal(urls.some((url) => url.includes("/athlete/i910002/events/bulk")), false);
      assert.equal(urls.some((url) => url.includes("/athlete/i910001/events/bulk")), true);
      assert.equal(urls.some((url) => url.includes("/athlete/i910003/events/bulk")), true);
      assert.equal(watched.sql.filter((source) => source.includes("BEGIN")).length, 2);
      assert.equal(watched.sql.filter((source) => source === "COMMIT").length, 2);
      assert.equal(watched.sql.filter((source) => source === "ROLLBACK").length, 0);

      const again = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(again.status, 200);
      const second = (await again.json()) as { written: number };
      assert.equal(second.written, 0);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(hasEvent(badId), false);

      const logged = lines.join("\n");
      assert.match(logged, /\[intervals\] adapt account failed TypeError/);
      assertNoUserData(logged, [...seeds, "not-a-kind", CRON_SECRET]);
    } finally {
      watched.restore();
    }
  });

  it("returns 200 when the commit throws for one of three accounts", async () => {
    llmOff();
    const today = appTodayYmd();
    const badId = "adapt-commit-bad";
    const okA = "adapt-commit-a";
    const okB = "adapt-commit-b";
    const badEmail = "leak-commit@example.com";
    saveAthletes([
      athlete(okA, { today, athleteId: "i910011", email: "commit-a@example.com" }),
      athlete(badId, { today, athleteId: "i910012", email: badEmail }),
      athlete(okB, { today, athleteId: "i910013", email: "commit-b@example.com" }),
    ]);
    const lines = captureConsole();
    const urls = installFetch();
    const watched = watchDb((sql, args, run) => {
      if (sql.includes("INSERT INTO sessions") && args[0] === `${badId}-tomorrow` && args[9] === 8) {
        const error = new Error(`commit ${badEmail} secret-message`);
        error.name = "CommitFailed";
        throw error;
      }
      return run(...args);
    });
    const seeds = [badId, okA, okB, badEmail, "commit-a@example.com", "commit-b@example.com", "secret-message"];
    try {
      const response = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, number>;
      assert.equal(body.processed, 3);
      assert.equal(body.written, 2);
      assert.equal(body.skipped, 1);
      assert.equal(body.patched, 2);
      assert.equal(body.uploaded, 2);
      assert.equal(hasEvent(badId), false);
      assert.equal(hasEvent(okA), true);
      assert.equal(hasEvent(okB), true);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(distanceOf(`${okA}-tomorrow`), 8);
      assert.equal(distanceOf(`${okB}-tomorrow`), 8);
      assert.equal(urls.some((url) => url.includes("/athlete/i910012/events/bulk")), false);
      assert.equal(watched.sql.filter((source) => source.includes("BEGIN")).length, 3);
      assert.equal(watched.sql.filter((source) => source === "COMMIT").length, 2);
      assert.equal(watched.sql.filter((source) => source === "ROLLBACK").length, 1);
      assertNoUserData(JSON.stringify(body), [...seeds, "CommitFailed", CRON_SECRET]);

      const again = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { written: number }).written, 0);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(hasEvent(badId), false);
      const logged = lines.join("\n");
      assert.match(logged, /\[intervals\] adapt account failed CommitFailed/);
      assertNoUserData(logged, seeds);
    } finally {
      watched.restore();
    }
  });

  it("rolls back a mid-commit failure so the session and event stay unchanged", async () => {
    llmOff();
    const today = appTodayYmd();
    const badId = "adapt-mid-bad";
    const okA = "adapt-mid-a";
    const okB = "adapt-mid-b";
    const badEmail = "leak-mid@example.com";
    const attempted: number[] = [];
    saveAthletes([
      athlete(okA, { today, athleteId: "i910021", email: "mid-a@example.com" }),
      athlete(badId, { today, athleteId: "i910022", email: badEmail }),
      athlete(okB, { today, athleteId: "i910023", email: "mid-b@example.com" }),
    ]);
    const lines = captureConsole();
    const urls = installFetch();
    const watched = watchDb((sql, args, run) => {
      if (sql.includes("INSERT INTO sessions") && args[0] === `${badId}-tomorrow`) {
        attempted.push(Number(args[9]));
      }
      if (sql.includes("INSERT INTO adaptation_events") && args[1] === badId) {
        const error = new Error(`mid-commit ${badEmail} secret-message`);
        error.name = "MidCommitError";
        throw error;
      }
      return run(...args);
    });
    const seeds = [badId, okA, okB, badEmail, "mid-a@example.com", "mid-b@example.com", "secret-message"];
    try {
      const response = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, number>;
      assert.equal(body.processed, 3);
      assert.equal(body.written, 2);
      assert.equal(body.skipped, 1);
      assert.equal(body.uploaded, 2);
      assert.equal(attempted.includes(8), true);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(hasEvent(badId), false);
      assert.equal(distanceOf(`${okA}-tomorrow`), 8);
      assert.equal(distanceOf(`${okB}-tomorrow`), 8);
      assert.equal(hasEvent(okA), true);
      assert.equal(hasEvent(okB), true);
      assert.equal(urls.some((url) => url.includes("/athlete/i910022/events/bulk")), false);
      assert.equal(watched.sql.filter((source) => source.includes("BEGIN")).length, 3);
      assert.equal(watched.sql.filter((source) => source === "COMMIT").length, 2);
      assert.equal(watched.sql.filter((source) => source === "ROLLBACK").length, 1);
      assertNoUserData(JSON.stringify(body), [...seeds, "MidCommitError"]);

      const again = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { written: number }).written, 0);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(hasEvent(badId), false);
      const logged = lines.join("\n");
      assert.match(logged, /\[intervals\] adapt account failed MidCommitError/);
      assertNoUserData(logged, seeds);
    } finally {
      watched.restore();
    }
  });

  it("adapts the other accounts when one has invalid data and one is disconnected", async () => {
    llmOff();
    const today = appTodayYmd();
    const badId = "adapt-invalid";
    const disconnectedId = "adapt-disconnected";
    const okId = "adapt-connected";
    saveAthletes([
      athlete(badId, {
        today,
        athleteId: "i910031",
        email: "invalid-data@example.com",
        tomorrowKind: "not-a-kind",
      }),
      athlete(disconnectedId, {
        today,
        connect: false,
        email: "disconnected@example.com",
      }),
      athlete(okId, { today, athleteId: "i910033", email: "connected@example.com" }),
    ]);
    const lines = captureConsole();
    const urls = installFetch();
    const seeds = [
      badId,
      disconnectedId,
      okId,
      "invalid-data@example.com",
      "disconnected@example.com",
      "connected@example.com",
    ];
    try {
      const response = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, number>;
      assert.equal(body.processed, 3);
      assert.equal(body.written, 2);
      assert.equal(body.skipped, 1);
      assert.equal(body.uploaded, 1);
      assert.equal(body.noConnection, 1);
      assert.equal(hasEvent(badId), false);
      assert.equal(distanceOf(`${badId}-tomorrow`), 10);
      assert.equal(hasEvent(disconnectedId), true);
      assert.equal(distanceOf(`${disconnectedId}-tomorrow`), 8);
      assert.equal(hasEvent(okId), true);
      assert.equal(distanceOf(`${okId}-tomorrow`), 8);
      assert.equal(urls.some((url) => url.includes("/athlete/i910033/events/bulk")), true);
      assert.equal(urls.some((url) => url.includes("i910031")), false);
      assertNoUserData(JSON.stringify(body), seeds);

      const again = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { written: number }).written, 0);
      assertNoUserData(lines.join("\n"), seeds);
    } finally {
      mock.restoreAll();
    }
  });

  it("keeps adapting other accounts when Intervals is unreachable", async () => {
    llmOff();
    const today = appTodayYmd();
    const unreachable = "adapt-unreachable";
    const okA = "adapt-reach-a";
    const okB = "adapt-reach-b";
    saveAthletes([
      athlete(unreachable, { today, athleteId: "i910041", email: "unreachable@example.com" }),
      athlete(okA, { today, athleteId: "i910042", email: "reach-a@example.com" }),
      athlete(okB, { today, athleteId: "i910043", email: "reach-b@example.com" }),
    ]);
    const lines = captureConsole();
    const urls = installFetch("i910041");
    const seeds = [
      unreachable,
      okA,
      okB,
      "unreachable@example.com",
      "reach-a@example.com",
      "reach-b@example.com",
      "key-adapt-",
    ];
    try {
      const response = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, number>;
      assert.equal(body.processed, 3);
      assert.equal(body.written, 3);
      assert.equal(body.skipped, 0);
      assert.equal(body.uploaded, 2);
      assert.equal(body.uploadFailed, 1);
      assert.equal(distanceOf(`${unreachable}-tomorrow`), 8);
      assert.equal(hasEvent(unreachable), true);
      assert.equal(distanceOf(`${okA}-tomorrow`), 8);
      assert.equal(distanceOf(`${okB}-tomorrow`), 8);
      assert.equal(urls.every((url) => url.startsWith("https://intervals.icu/")), true);
      assert.equal(urls.some((url) => url.includes("/athlete/i910041/events/bulk")), true);
      assertNoUserData(JSON.stringify(body), [...seeds, "socket hang up", "NetworkError"]);

      const again = await callAdapt(`Bearer ${CRON_SECRET}`);
      assert.equal(again.status, 200);
      const second = (await again.json()) as { written: number; uploaded: number };
      assert.equal(second.written, 0);
      assert.equal(second.uploaded, 0);
      assertNoUserData(lines.join("\n"), seeds);
    } finally {
      mock.restoreAll();
    }
  });

  it("GET with a Bearer token returns 200 and an empty run leaks nothing", async () => {
    llmOff();
    saveTrainingSnapshot(
      {
        onboarding: [],
        plans: [],
        sessions: [],
        feedbacks: [],
        runLogs: [],
        adaptationEvents: [],
      },
      "replace",
    );
    installFetch();
    const lines = captureConsole();
    process.env.ADAPT_CRON_SECRET = CRON_SECRET;
    const denied = await GET({
      request: new Request("https://stride.test/api/adapt", { method: "GET" }),
    } as Parameters<typeof GET>[0]);
    assert.equal(denied.status, 401);
    const deniedText = await denied.text();
    assert.equal(deniedText.includes(CRON_SECRET), false);

    const response = await callAdapt(`Bearer ${CRON_SECRET}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, number>;
    assert.equal(body.processed, 0);
    assert.equal(body.written, 0);
    assert.equal(body.skipped, 0);
    assert.equal(JSON.stringify(body).includes(CRON_SECRET), false);
    assertNoUserData(lines.join("\n"), [CRON_SECRET]);
  });
});
