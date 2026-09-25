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

export type IntervalsAuthType = "oauth" | "apikey";

/**
 * Per-user Intervals connection.
 * `apiKeyEnc` is AES-256-GCM ciphertext of the OAuth access token or API key.
 * Never send it to the browser. Absent when the row is an owner env-fallback
 * connection (no stored secret).
 */
export type IntervalsConnection = {
  userId: string;
  athleteId: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastSyncError?: string;
  apiKeyEnc?: string;
  needsReconnect?: boolean;
  /** Missing on legacy writes; stored and read as `apikey`. */
  authType?: IntervalsAuthType;
  scope?: string;
  athleteName?: string;
};

export type MagicTokenRecord = {
  tokenHash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
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
  feedbackCadence: string | null;
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
  feedbackCadence: string | null;
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
  source: string | null;
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

type IntervalsConnectionRow = {
  userId: string;
  athleteId: string;
  connectedAt: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  apiKeyEnc: string | null;
  needsReconnect: number | null;
  authType: string | null;
  scope: string | null;
  athleteName: string | null;
};

type MagicTokenRow = {
  tokenHash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
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
      feedbackCadence TEXT,
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
      baselineJson TEXT,
      feedbackCadence TEXT NOT NULL DEFAULT 'daily'
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
      createdAt TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
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

    CREATE TABLE IF NOT EXISTS intervals_connections (
      userId TEXT PRIMARY KEY,
      athleteId TEXT NOT NULL,
      connectedAt TEXT NOT NULL,
      lastSyncAt TEXT,
      lastSyncError TEXT,
      apiKeyEnc TEXT,
      needsReconnect INTEGER NOT NULL DEFAULT 0,
      authType TEXT NOT NULL DEFAULT 'apikey',
      scope TEXT,
      athleteName TEXT
    );

    CREATE TABLE IF NOT EXISTS magic_tokens (
      tokenHash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      usedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS plans_userId ON plans(userId);
    CREATE INDEX IF NOT EXISTS sessions_planId ON sessions(planId);
    CREATE INDEX IF NOT EXISTS sessions_userId_date ON sessions(userId, date);
    CREATE INDEX IF NOT EXISTS feedbacks_userId_sessionId ON feedbacks(userId, sessionId);
    CREATE INDEX IF NOT EXISTS run_logs_userId_sessionId ON run_logs(userId, sessionId);
    CREATE INDEX IF NOT EXISTS adaptation_events_userId_date ON adaptation_events(userId, date);
    CREATE INDEX IF NOT EXISTS magic_tokens_email_createdAt ON magic_tokens(email, createdAt);
  `);
  ensureColumn(database, "onboarding", "feedbackCadence", "TEXT");
  ensureColumn(database, "plans", "feedbackCadence", "TEXT NOT NULL DEFAULT 'daily'");
  ensureColumn(database, "run_logs", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureIntervalsConnectionColumns(database);
}

/** Idempotent. Safe to call on every open and again after the columns exist. */
export function ensureIntervalsConnectionColumns(database: DatabaseSync): void {
  ensureColumn(database, "intervals_connections", "apiKeyEnc", "TEXT");
  ensureColumn(database, "intervals_connections", "needsReconnect", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "intervals_connections", "authType", "TEXT NOT NULL DEFAULT 'apikey'");
  ensureColumn(database, "intervals_connections", "scope", "TEXT");
  ensureColumn(database, "intervals_connections", "athleteName", "TEXT");
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(database: DatabaseSync, table: string, column: string, ddl: string): void {
  if (tableColumns(database, table).has(column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
  if (row.feedbackCadence === "daily" || row.feedbackCadence === "weekly" || row.feedbackCadence === "monthly") {
    record.feedbackCadence = row.feedbackCadence;
  }
  if (row.completedAt) record.completedAt = row.completedAt;
  if (row.planId) record.planId = row.planId;
  return record;
}

function planFromRow(row: PlanRow): Plan {
  const cadence =
    row.feedbackCadence === "weekly" || row.feedbackCadence === "monthly" || row.feedbackCadence === "daily"
      ? row.feedbackCadence
      : "daily";
  const plan: Plan = {
    id: row.id,
    userId: row.userId,
    version: 1,
    createdAt: row.createdAt,
    goal: row.goal as Plan["goal"],
    raceDate: row.raceDate,
    level: row.level as Plan["level"],
    days: parseJsonValue(row.daysJson, []),
    feedbackCadence: cadence,
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
    source: row.source === "intervals" ? "intervals" : "manual",
  };
  const route = parseJsonValue<RunLog["route"]>(row.routeJson, undefined);
  if (route) log.route = route;
  return log;
}

function magicTokenFromRow(row: MagicTokenRow): MagicTokenRecord {
  const token: MagicTokenRecord = {
    tokenHash: row.tokenHash,
    email: row.email,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
  if (row.usedAt) token.usedAt = row.usedAt;
  return token;
}

function intervalsConnectionFromRow(row: IntervalsConnectionRow): IntervalsConnection {
  const connection: IntervalsConnection = {
    userId: row.userId,
    athleteId: row.athleteId,
    connectedAt: row.connectedAt,
    needsReconnect: Number(row.needsReconnect) === 1,
    authType: row.authType === "oauth" ? "oauth" : "apikey",
  };
  if (row.lastSyncAt) connection.lastSyncAt = row.lastSyncAt;
  if (row.lastSyncError) connection.lastSyncError = row.lastSyncError;
  if (row.apiKeyEnc) connection.apiKeyEnc = row.apiKeyEnc;
  if (row.scope) connection.scope = row.scope;
  if (row.athleteName) connection.athleteName = row.athleteName;
  return connection;
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
    `INSERT INTO onboarding (userId, goal, raceDate, level, daysJson, baselineJson, feedbackCadence, updatedAt, completedAt, planId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.userId,
    text(record.goal),
    raceDate,
    text(record.level),
    jsonText(record.days),
    jsonText(record.baseline),
    text(record.feedbackCadence),
    record.updatedAt,
    text(record.completedAt),
    text(record.planId),
  );
}

function insertPlanRow(plan: Plan): void {
  const cadence =
    plan.feedbackCadence === "weekly" || plan.feedbackCadence === "monthly" || plan.feedbackCadence === "daily"
      ? plan.feedbackCadence
      : "daily";
  run(
    `INSERT INTO plans (id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson, feedbackCadence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    plan.id,
    plan.userId,
    plan.version,
    plan.createdAt,
    plan.goal,
    plan.raceDate,
    plan.level,
    JSON.stringify(plan.days),
    jsonText(plan.baseline),
    cadence,
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
    `INSERT INTO run_logs (id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, routeJson, createdAt, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    log.id,
    log.userId,
    log.sessionId,
    log.planId,
    log.distanceKm,
    log.timeSec,
    log.paceSecPerKm,
    jsonText(log.route),
    log.createdAt,
    log.source === "intervals" ? "intervals" : "manual",
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

export function listUserEmails(): { id: string; email: string }[] {
  return getDb().prepare("SELECT id, email FROM users").all() as { id: string; email: string }[];
}

export function listIntervalsRunLogs(): { id: string; userId: string; createdAt: string }[] {
  return getDb()
    .prepare("SELECT id, userId, createdAt FROM run_logs WHERE source = 'intervals'")
    .all() as { id: string; userId: string; createdAt: string }[];
}

/** Users who stored their own encrypted Intervals token or API key. */
export function listIntervalsSecretUserIds(): string[] {
  const rows = getDb()
    .prepare(
      "SELECT userId FROM intervals_connections WHERE apiKeyEnc IS NOT NULL AND length(trim(apiKeyEnc)) > 0",
    )
    .all() as { userId: string }[];
  return rows.map((row) => row.userId);
}

/** Delete specific `source = intervals` RunLogs by id. Other sources stay. */
export function deleteIntervalsRunLogsByIds(ids: readonly string[]): void {
  if (ids.length === 0) return;
  withTransaction(() => {
    const remove = getDb().prepare("DELETE FROM run_logs WHERE source = 'intervals' AND id = ?");
    for (const id of ids) remove.run(id);
  });
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
        "SELECT userId, goal, raceDate, level, daysJson, baselineJson, feedbackCadence, updatedAt, completedAt, planId FROM onboarding",
      )
      .all() as OnboardingRow[]
  ).map(onboardingFromRow);
  const plans = (
    database
      .prepare(
        "SELECT id, userId, version, createdAt, goal, raceDate, level, daysJson, baselineJson, feedbackCadence FROM plans",
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
        "SELECT id, userId, sessionId, planId, distanceKm, timeSec, paceSecPerKm, routeJson, createdAt, source FROM run_logs",
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

export function getIntervalsConnection(userId: string): IntervalsConnection | null {
  const row = getDb()
    .prepare(
      `SELECT userId, athleteId, connectedAt, lastSyncAt, lastSyncError, apiKeyEnc, needsReconnect,
              authType, scope, athleteName
       FROM intervals_connections WHERE userId = ?`,
    )
    .get(userId) as IntervalsConnectionRow | undefined;
  return row ? intervalsConnectionFromRow(row) : null;
}

/**
 * `undefined` when this database has no `emailVerifiedAt` column (check does not exist).
 * `null` when the column exists and this user is not verified.
 */
export function readEmailVerifiedAt(userId: string): string | null | undefined {
  const database = getDb();
  const columns = tableColumns(database, "users");
  if (!columns.has("emailVerifiedAt")) return undefined;
  const row = database.prepare("SELECT emailVerifiedAt FROM users WHERE id = ?").get(userId) as
    | { emailVerifiedAt: string | null }
    | undefined;
  if (!row) return null;
  const value = row.emailVerifiedAt?.trim() ?? "";
  return value || null;
}

export function upsertIntervalsConnection(connection: IntervalsConnection): void {
  withTransaction(() => {
    run(
      `INSERT INTO intervals_connections (
         userId, athleteId, connectedAt, lastSyncAt, lastSyncError, apiKeyEnc, needsReconnect,
         authType, scope, athleteName
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET
         athleteId = excluded.athleteId,
         connectedAt = excluded.connectedAt,
         lastSyncAt = excluded.lastSyncAt,
         lastSyncError = excluded.lastSyncError,
         apiKeyEnc = excluded.apiKeyEnc,
         needsReconnect = excluded.needsReconnect,
         authType = excluded.authType,
         scope = excluded.scope,
         athleteName = excluded.athleteName`,
      connection.userId,
      connection.athleteId,
      connection.connectedAt,
      text(connection.lastSyncAt),
      text(connection.lastSyncError),
      text(connection.apiKeyEnc),
      connection.needsReconnect ? 1 : 0,
      connection.authType === "oauth" ? "oauth" : "apikey",
      text(connection.scope),
      text(connection.athleteName),
    );
  });
}

export function deleteIntervalsConnection(userId: string): void {
  withTransaction(() => {
    run("DELETE FROM intervals_connections WHERE userId = ?", userId);
  });
}

export function insertMagicToken(token: MagicTokenRecord): void {
  withTransaction(() => {
    run(
      `INSERT INTO magic_tokens (tokenHash, email, createdAt, expiresAt, usedAt) VALUES (?, ?, ?, ?, ?)`,
      token.tokenHash,
      token.email,
      token.createdAt,
      token.expiresAt,
      text(token.usedAt),
    );
  });
}

export function getMagicTokenByHash(tokenHash: string): MagicTokenRecord | null {
  const row = getDb()
    .prepare(
      "SELECT tokenHash, email, createdAt, expiresAt, usedAt FROM magic_tokens WHERE tokenHash = ?",
    )
    .get(tokenHash) as MagicTokenRow | undefined;
  return row ? magicTokenFromRow(row) : null;
}

export function listMagicTokensByEmail(email: string): MagicTokenRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT tokenHash, email, createdAt, expiresAt, usedAt FROM magic_tokens WHERE email = ? ORDER BY createdAt DESC",
    )
    .all(email) as MagicTokenRow[];
  return rows.map(magicTokenFromRow);
}

export function latestMagicTokenForEmail(email: string): MagicTokenRecord | null {
  const row = getDb()
    .prepare(
      "SELECT tokenHash, email, createdAt, expiresAt, usedAt FROM magic_tokens WHERE email = ? ORDER BY createdAt DESC LIMIT 1",
    )
    .get(email) as MagicTokenRow | undefined;
  return row ? magicTokenFromRow(row) : null;
}

export function markMagicTokenUsed(tokenHash: string, usedAt: string): void {
  withTransaction(() => {
    run("UPDATE magic_tokens SET usedAt = ? WHERE tokenHash = ?", usedAt, tokenHash);
  });
}

export function invalidateUnusedMagicTokens(email: string, exceptHash: string, usedAt: string): void {
  withTransaction(() => {
    run(
      "UPDATE magic_tokens SET usedAt = ? WHERE email = ? AND tokenHash != ? AND usedAt IS NULL",
      usedAt,
      email,
      exceptHash,
    );
  });
}

export function deleteMagicToken(tokenHash: string): void {
  withTransaction(() => {
    run("DELETE FROM magic_tokens WHERE tokenHash = ?", tokenHash);
  });
}

export function pruneMagicTokens(nowIso: string): void {
  const usedCutoff = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
  withTransaction(() => {
    run(
      "DELETE FROM magic_tokens WHERE expiresAt < ? OR (usedAt IS NOT NULL AND usedAt < ?)",
      nowIso,
      usedCutoff,
    );
  });
}
