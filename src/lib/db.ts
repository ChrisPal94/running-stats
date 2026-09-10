import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdaptationEvent,
  Feedback,
  OnboardingRecord,
  Plan,
  RunLog,
  Session,
} from "./training";

/**
 * Persistence is Node’s built-in `node:sqlite` (`DatabaseSync`).
 *
 * Chosen over `better-sqlite3` so Railway/Nixpacks does not need a native
 * compile, and the Astro Node standalone bundle does not have to externalize
 * an addon. The app already targets Node 22; 22.14+ exposes `node:sqlite`
 * without `--experimental-sqlite` (Node still prints ExperimentalWarning).
 *
 * One process-wide connection, WAL, and `enqueueWrite` keep read-modify-write
 * cycles (including `await` inside signup hashing) from interleaving.
 */

const DB_FILENAME = "app.db";
const USERS_JSON = "users.json";
const TRAINING_JSON = "training.json";

type SqlBind = string | number | null;

export type UserRecord = {
  id: string;
  email: string;
  createdAt: string;
  passwordHash?: string;
  googleId?: string;
};

export type TrainingSnapshot = {
  onboarding: OnboardingRecord[];
  plans: Plan[];
  sessions: Session[];
  feedbacks: Feedback[];
  runLogs: RunLog[];
  adaptationEvents: AdaptationEvent[];
};

type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  passwordHash: string | null;
  googleId: string | null;
};

type OnboardingRow = {
  userId: string;
  goal: string | null;
  raceDate: string | null;
  level: string | null;
  daysJson: string | null;
  baselineJson: string | null;
  updatedAt: string;
  completedAt: string | null;
  planId: string | null;
};

type PlanRow = {
  id: string;
  userId: string;
  version: number;
  createdAt: string;
  goal: string;
  raceDate: string | null;
  level: string;
  daysJson: string;
  baselineJson: string | null;
};

type SessionRow = {
  id: string;
  planId: string;
  userId: string;
  date: string;
  weekday: string;
  weekIndex: number;
  kind: string;
  title: string;
  cue: string;
  distanceKm: number;
  outcome: string | null;
  outcomeAt: string | null;
};

type FeedbackRow = {
  id: string;
  userId: string;
  planId: string;
  sessionId: string;
  kind: string;
  createdAt: string;
};

type RunLogRow = {
  id: string;
  userId: string;
  sessionId: string;
  planId: string;
  distanceKm: number;
  timeSec: number;
  paceSecPerKm: number;
  routeJson: string | null;
  createdAt: string;
};

type AdaptationEventRow = {
  id: string;
  userId: string;
  planId: string;
  sessionId: string | null;
  date: string;
  title: string;
  summary: string;
  reason: string;
  sourceDate: string | null;
  createdAt: string;
};

let db: DatabaseSync | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let txDepth = 0;

/** Same directory as the previous JSON stores (`AUTH_DATA_DIR` or `.data`). */
export function dataDir(): string {
  return process.env.AUTH_DATA_DIR?.trim() || join(process.cwd(), ".data");
}

export function dbPath(): string {
  return join(dataDir(), DB_FILENAME);
}

export function enqueueWrite<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getDb(): DatabaseSync {
  if (db) return db;

  mkdirSync(dataDir(), { recursive: true });
  const opened = new DatabaseSync(dbPath());
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA busy_timeout = 5000");
  opened.exec("PRAGMA foreign_keys = OFF");
  applySchema(opened);
  db = opened;
  try {
    importJsonIfEmpty();
  } catch (error) {
    db = null;
    try {
      opened.close();
    } catch {
      // Ignore close errors while propagating the import failure.
    }
    throw error;
  }
  return opened;
}

export function withTransaction<T>(fn: () => T): T {
  const database = getDb();
  const nested = txDepth > 0;
  txDepth += 1;
  if (!nested) database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (!nested) database.exec("COMMIT");
    return result;
  } catch (error) {
    if (!nested) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Connection may already be aborted.
      }
    }
    throw error;
  } finally {
    txDepth -= 1;
  }
}

function applySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      passwordHash TEXT,
      googleId TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS onboarding (
      userId TEXT PRIMARY KEY,
      goal TEXT,
      raceDate TEXT,
      level TEXT,
      daysJson TEXT,
      baselineJson TEXT,
      updatedAt TEXT NOT NULL,
      completedAt TEXT,
      planId TEXT
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      version INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      goal TEXT NOT NULL,
      raceDate TEXT,
      level TEXT NOT NULL,
      daysJson TEXT NOT NULL,
      baselineJson TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      planId TEXT NOT NULL,
      userId TEXT NOT NULL,
      date TEXT NOT NULL,
      weekday TEXT NOT NULL,
      weekIndex INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      cue TEXT NOT NULL,
      distanceKm REAL NOT NULL,
      outcome TEXT,
      outcomeAt TEXT
    );

    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      planId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      kind TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      planId TEXT NOT NULL,
      distanceKm REAL NOT NULL,
      timeSec INTEGER NOT NULL,
      paceSecPerKm REAL NOT NULL,
      routeJson TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adaptation_events (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      planId TEXT NOT NULL,
      sessionId TEXT,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      sourceDate TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS plans_userId ON plans(userId);
    CREATE INDEX IF NOT EXISTS sessions_planId ON sessions(planId);
    CREATE INDEX IF NOT EXISTS sessions_userId_date ON sessions(userId, date);
    CREATE INDEX IF NOT EXISTS feedbacks_userId_sessionId ON feedbacks(userId, sessionId);
    CREATE INDEX IF NOT EXISTS run_logs_userId_sessionId ON run_logs(userId, sessionId);
    CREATE INDEX IF NOT EXISTS adaptation_events_userId_date ON adaptation_events(userId, date);
  `);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function tableCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function isDbEmpty(): boolean {
  const database = getDb();
  return (
    tableCount(database, "users") +
      tableCount(database, "onboarding") +
      tableCount(database, "plans") +
      tableCount(database, "sessions") +
      tableCount(database, "feedbacks") +
      tableCount(database, "run_logs") +
      tableCount(database, "adaptation_events") ===
    0
  );
}

function readJsonFileIfExists(filename: string): unknown | undefined {
  const path = join(dataDir(), filename);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function importJsonIfEmpty(): void {
  if (!isDbEmpty()) return;

  const usersRaw = readJsonFileIfExists(USERS_JSON);
  const trainingRaw = readJsonFileIfExists(TRAINING_JSON);
  if (usersRaw === undefined && trainingRaw === undefined) return;

  const users = parseUsersJson(usersRaw);
  const training = parseTrainingJson(trainingRaw);

  withTransaction(() => {
    replaceUsers(users);
    replaceTraining(training, "replace");
  });

  console.info(
    `[db] imported ${USERS_JSON}/${TRAINING_JSON} into ${DB_FILENAME} (${users.length} user(s), ${training.plans.length} plan(s)). SQLite is now the source of truth.`,
  );
}

function parseUsersJson(raw: unknown): UserRecord[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object") return [];
  const users = (raw as { users?: unknown }).users;
  if (!Array.isArray(users)) return [];
  return users
    .map((entry) => parseUserRecord(entry))
    .filter((entry): entry is UserRecord => Boolean(entry));
}

function parseUserRecord(value: unknown): UserRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<UserRecord>;
  if (typeof record.id !== "string" || !record.id) return undefined;
  if (typeof record.email !== "string" || !record.email) return undefined;
  if (typeof record.createdAt !== "string" || !record.createdAt) return undefined;
  const user: UserRecord = {
    id: record.id,
    email: record.email,
    createdAt: record.createdAt,
  };
  if (typeof record.passwordHash === "string" && record.passwordHash) {
    user.passwordHash = record.passwordHash;
  }
  if (typeof record.googleId === "string" && record.googleId) {
    user.googleId = record.googleId;
  }
  return user;
}

function parseTrainingJson(raw: unknown): TrainingSnapshot {
  if (!raw || typeof raw !== "object") {
    return { onboarding: [], plans: [], sessions: [], feedbacks: [], runLogs: [], adaptationEvents: [] };
  }
  const parsed = raw as Partial<TrainingSnapshot>;
  return {
    onboarding: Array.isArray(parsed.onboarding) ? parsed.onboarding : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [],
    runLogs: Array.isArray(parsed.runLogs) ? parsed.runLogs : [],
    adaptationEvents: Array.isArray(parsed.adaptationEvents) ? parsed.adaptationEvents : [],
  };
}

function text(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonValue<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function userFromRow(row: UserRow): UserRecord {
  const user: UserRecord = {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt,
  };
  if (row.passwordHash) user.passwordHash = row.passwordHash;
  if (row.googleId) user.googleId = row.googleId;
  return user;
}

function onboardingFromRow(row: OnboardingRow): OnboardingRecord {
  const record: OnboardingRecord = {
    userId: row.userId,
    updatedAt: row.updatedAt,
  };
  if (row.goal) record.goal = row.goal as OnboardingRecord["goal"];
  if (row.raceDate !== null) record.raceDate = row.raceDate;
  else if (row.goal) record.raceDate = null;
  if (row.level) record.level = row.level as OnboardingRecord["level"];
  const days = parseJsonValue<OnboardingRecord["days"]>(row.daysJson, undefined);
  if (days) record.days = days;
  const baseline = parseJsonValue<OnboardingRecord["baseline"]>(row.baselineJson, undefined);
  if (baseline) record.baseline = baseline;
  if (row.completedAt) record.completedAt = row.completedAt;
  if (row.planId) record.planId = row.planId;
  return record;
}

function planFromRow(row: PlanRow): Plan {
  const plan: Plan = {
    id: row.id,
    userId: row.userId,
    version: 1,
    createdAt: row.createdAt,
    goal: row.goal as Plan["goal"],
    raceDate: row.raceDate,
    level: row.level as Plan["level"],
    days: parseJsonValue(row.daysJson, []),
  };
  const baseline = parseJsonValue<Plan["baseline"]>(row.baselineJson, undefined);
  if (baseline) plan.baseline = baseline;
  return plan;
}

function sessionFromRow(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    planId: row.planId,
    userId: row.userId,
    date: row.date,
    weekday: row.weekday as Session["weekday"],
    weekIndex: row.weekIndex,
    kind: row.kind as Session["kind"],
    title: row.title,
    cue: row.cue,
    distanceKm: row.distanceKm,
  };
  if (row.outcome === "done" || row.outcome === "skipped") session.outcome = row.outcome;
  if (row.outcomeAt) session.outcomeAt = row.outcomeAt;
  return session;
}

function feedbackFromRow(row: FeedbackRow): Feedback {
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    sessionId: row.sessionId,
    kind: row.kind as Feedback["kind"],
    createdAt: row.createdAt,
  };
}

function runLogFromRow(row: RunLogRow): RunLog {
  const log: RunLog = {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    planId: row.planId,
    distanceKm: row.distanceKm,
    timeSec: row.timeSec,
    paceSecPerKm: row.paceSecPerKm,
    createdAt: row.createdAt,
  };
  const route = parseJsonValue<RunLog["route"]>(row.routeJson, undefined);
  if (route) log.route = route;
  return log;
}

function adaptationFromRow(row: AdaptationEventRow): AdaptationEvent {
  const event: AdaptationEvent = {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    date: row.date,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    createdAt: row.createdAt,
  };
  if (row.sessionId) event.sessionId = row.sessionId;
  if (row.sourceDate) event.sourceDate = row.sourceDate;
  return event;
}

function run(sql: string, ...params: SqlBind[]): void {
  getDb().prepare(sql).run(...params);
}

function insertUserRow(user: UserRecord): void {
  run(
    `INSERT INTO users (id, email, createdAt, passwordHash, googleId) VALUES (?, ?, ?, ?, ?)`,
    user.id,
    user.email,
    user.createdAt,
    text(user.passwordHash),
    text(user.googleId),
  );
}

function insertOnboardingRow(record: OnboardingRecord): void {
  const raceDate =
    record.raceDate === undefined ? null : record.raceDate === null ? null : record.raceDate;
  run(
    `INSERT INTO onboarding (userId, goal, raceDate, level, daysJson, baselineJson, updatedAt, completedAt, planId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.userId,
    text(record.goal),
    raceDate,
    text(record.level),
    jsonText(record.days),
    jsonText(record.baseline),
    record.updatedAt,
    text(record.completedAt),
    text(record.planId),
  );
}

function insertPlanRow(plan: Plan): void {
  run(
    `INSERT INTO plans (id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    plan.id,
    plan.userId,
    plan.version,
    plan.createdAt,
    plan.goal,
    plan.raceDate,
    plan.level,
    JSON.stringify(plan.days),
    jsonText(plan.baseline),
  );
}

function insertSessionRow(session: Session): void {
  run(
    `INSERT INTO sessions (id, planId, userId, date, weekday, weekIndex, kind, title, cue, distanceKm, outcome, outcomeAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.id,
    session.planId,
    session.userId,
    session.date,
    session.weekday,
    session.weekIndex,
    session.kind,
    session.title,
    session.cue,
    session.distanceKm,
    text(session.outcome),
    text(session.outcomeAt),
  );
}

function insertFeedbackRow(feedback: Feedback): void {
  run(
    `INSERT INTO feedbacks (id, userId, planId, sessionId, kind, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    feedback.id,
    feedback.userId,
    feedback.planId,
    feedback.sessionId,
    feedback.kind,
    feedback.createdAt,
  );
}

function insertRunLogRow(log: RunLog): void {
  run(
    `INSERT INTO run_logs (id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, routeJson, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    log.id,
    log.userId,
    log.sessionId,
    log.planId,
    log.distanceKm,
    log.timeSec,
    log.paceSecPerKm,
    jsonText(log.route),
    log.createdAt,
  );
}

function insertAdaptationRow(event: AdaptationEvent): void {
  run(
    `INSERT INTO adaptation_events (id, userId, planId, sessionId, date, title, summary, reason, sourceDate, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.userId,
    event.planId,
    text(event.sessionId),
    event.date,
    event.title,
    event.summary,
    event.reason,
    text(event.sourceDate),
    event.createdAt,
  );
}

function replaceUsers(users: UserRecord[]): void {
  getDb().exec("DELETE FROM users");
  for (const user of users) insertUserRow(user);
}

function replaceTraining(
  data: TrainingSnapshot,
  adaptationEvents: "preserve" | "replace",
): void {
  const database = getDb();
  database.exec("DELETE FROM onboarding");
  database.exec("DELETE FROM plans");
  database.exec("DELETE FROM sessions");
  database.exec("DELETE FROM feedbacks");
  database.exec("DELETE FROM run_logs");
  if (adaptationEvents === "replace") {
    database.exec("DELETE FROM adaptation_events");
  }

  for (const record of data.onboarding) insertOnboardingRow(record);
  for (const plan of data.plans) insertPlanRow(plan);
  for (const session of data.sessions) insertSessionRow(session);
  for (const feedback of data.feedbacks) insertFeedbackRow(feedback);
  for (const log of data.runLogs) insertRunLogRow(log);
  if (adaptationEvents === "replace") {
    for (const event of data.adaptationEvents) insertAdaptationRow(event);
  }
}

export function getUserById(id: string): UserRecord | null {
  const row = getDb()
    .prepare("SELECT id, email, createdAt, passwordHash, googleId FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function getUserByEmail(email: string): UserRecord | null {
  const row = getDb()
    .prepare("SELECT id, email, createdAt, passwordHash, googleId FROM users WHERE email = ?")
    .get(email) as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function getUserByGoogleId(googleId: string): UserRecord | null {
  const row = getDb()
    .prepare("SELECT id, email, createdAt, passwordHash, googleId FROM users WHERE googleId = ?")
    .get(googleId) as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function insertUser(user: UserRecord): void {
  withTransaction(() => insertUserRow(user));
}

export function setUserGoogleId(userId: string, googleId: string): void {
  withTransaction(() => {
    run("UPDATE users SET googleId = ? WHERE id = ?", googleId, userId);
  });
}

export function loadTrainingSnapshot(): TrainingSnapshot {
  const database = getDb();
  const onboarding = (
    database
      .prepare(
        "SELECT userId, goal, raceDate, level, daysJson, baselineJson, updatedAt, completedAt, planId FROM onboarding",
      )
      .all() as OnboardingRow[]
  ).map(onboardingFromRow);
  const plans = (
    database
      .prepare(
        "SELECT id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson FROM plans",
      )
      .all() as PlanRow[]
  ).map(planFromRow);
  const sessions = (
    database
      .prepare(
        "SELECT id, planId, userId, date, weekday, weekIndex, kind, title, cue, distanceKm, outcome, outcomeAt FROM sessions",
      )
      .all() as SessionRow[]
  ).map(sessionFromRow);
  const feedbacks = (
    database
      .prepare("SELECT id, userId, planId, sessionId, kind, createdAt FROM feedbacks")
      .all() as FeedbackRow[]
  ).map(feedbackFromRow);
  const runLogs = (
    database
      .prepare(
        "SELECT id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, routeJson, createdAt FROM run_logs",
      )
      .all() as RunLogRow[]
  ).map(runLogFromRow);
  const adaptationEvents = (
    database
      .prepare(
        "SELECT id, userId, planId, sessionId, date, title, summary, reason, sourceDate, createdAt FROM adaptation_events",
      )
      .all() as AdaptationEventRow[]
  ).map(adaptationFromRow);

  return { onboarding, plans, sessions, feedbacks, runLogs, adaptationEvents };
}

/** Persist training rows. `preserve` leaves AdaptationEvents untouched (shell writes). */
export function saveTrainingSnapshot(
  data: TrainingSnapshot,
  adaptationEvents: "preserve" | "replace" = "preserve",
): void {
  withTransaction(() => replaceTraining(data, adaptationEvents));
}
