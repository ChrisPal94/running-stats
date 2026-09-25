import { isValidEmail } from "./auth";
import { getDb, openAppDatabase, withTransaction } from "./db";

const LOG = "[reassign-owner-email]";

/** Training and connection tables. Keyed by `userId`. Magic-link tokens are not in this list. */
const OWNED_TABLES = [
  ["onboarding", "onboarding"],
  ["plans", "plans"],
  ["sessions", "sessions"],
  ["feedbacks", "feedbacks"],
  ["run_logs", "runLogs"],
  ["adaptation_events", "adaptationEvents"],
  ["intervals_connections", "intervalsConnections"],
] as const;

const KNOWN_USER_TABLES = new Set<string>(OWNED_TABLES.map(([table]) => table));

export type OwnedCounts = {
  onboarding: number;
  plans: number;
  sessions: number;
  feedbacks: number;
  runLogs: number;
  adaptationEvents: number;
  intervalsConnections: number;
  /** Not blocking. Deleted with the target user when `--apply` removes that user. */
  magicTokens: number;
};

export type ReassignOwnerEmailResult = {
  aborted: boolean;
  apply: boolean;
  fromId: string | null;
  toId: string | null;
  fromEmail: string;
  toEmail: string;
};

type UserHit = {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  passwordHash: string | null;
  googleId: string | null;
};

class ReassignRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReassignRejected";
  }
}

/**
 * Point the real owner's account at the allowlisted address.
 *
 * Does not copy plans, training sessions, feedback, run logs, adaptation events,
 * onboarding, or the Intervals connection from one user to another. An existing
 * target account is deleted only when every `userId` table is empty for that id.
 * `emailVerifiedAt` is left null so the next Google sign-in (`email_verified === true`)
 * runs the unverified takeover on this same user id.
 *
 * Google is linked by `users.googleId` (provider subject), then by normalized email.
 * This script does not change `googleId`. A later sign-in verifies this row only
 * when the Google email matches the stored email: by subject if that subject is
 * already here, otherwise by email (which then stores the subject). A subject
 * match whose Google email differs signs into that user and does not set
 * `emailVerifiedAt` or edit the account that owns the Google email.
 */
export function reassignOwnerEmail(options: {
  from: string;
  to: string;
  apply?: boolean;
}): ReassignOwnerEmailResult {
  const apply = options.apply === true;
  const mode = apply ? "apply" : "dry-run";
  const opened = openAppDatabase();
  if (!apply && opened.wroteSchema) {
    console.log(
      `${LOG} note: opening the database applied a schema migration because tables or columns were missing`,
    );
  }
  const fromEmail = options.from.trim().toLowerCase();
  const toEmail = options.to.trim().toLowerCase();
  const empty: ReassignOwnerEmailResult = {
    aborted: true,
    apply,
    fromId: null,
    toId: null,
    fromEmail,
    toEmail,
  };

  if (!isValidEmail(fromEmail) || !isValidEmail(toEmail)) {
    return abort(empty, "aborted: --from and --to must be email addresses");
  }
  if (fromEmail === toEmail) {
    return abort(empty, "aborted: --from and --to are the same email after trim and lowercase");
  }

  const fromHits = findUsers(fromEmail);
  if (fromHits.length > 1) {
    return abort(empty, `aborted: ${fromHits.length} users match from email ${fromEmail}`);
  }
  const from = fromHits[0] ?? null;
  if (!from) {
    console.error(`${LOG} aborted: from user not found email=${fromEmail}`);
    console.log(`${LOG} nothing changed`);
    return empty;
  }

  const toHits = findUsers(toEmail).filter((user) => user.id !== from.id);
  if (toHits.length > 1) {
    return abort(
      { ...empty, fromId: from.id },
      `aborted: ${toHits.length} users match to email ${toEmail}`,
    );
  }
  const to = toHits[0] ?? null;
  const fromCounts = countOwned(from.id, from.email);
  const toCounts = countOwned(to?.id ?? null, toEmail);
  const deletable = to ? isDeletable(toCounts) : true;

  console.log(`${LOG} ${mode} from id=${from.id} email=${from.email} ${formatCounts(fromCounts)}`);
  console.log(
    `${LOG} ${mode} to id=${to?.id ?? "none"} email=${toEmail} ${formatCounts(toCounts)} deletable=${deletable ? "yes" : "no"}`,
  );
  console.log(
    `${LOG} ${mode} plan deleteTo=${to?.id ?? "none"} renameUser=${from.id} email ${from.email} -> ${toEmail} emailVerifiedAt=null googleId=unchanged moveRows=no`,
  );
  console.log(
    `${LOG} googleId is the provider subject. A later Google sign-in verifies user ${from.id} only when the Google email matches ${toEmail}: by this subject if it is already on that user, otherwise by the email. A subject match with a different Google email does not set emailVerifiedAt.`,
  );

  if (to && !deletable) {
    const found = blockingFound(toCounts);
    console.error(`${LOG} aborted: to user is not empty id=${to.id} email=${toEmail} ${found}`);
    console.error(`${LOG} stop and ask the dev team; do not delete rows manually`);
    console.log(`${LOG} nothing changed`);
    return { aborted: true, apply, fromId: from.id, toId: to.id, fromEmail, toEmail };
  }

  if (!apply) {
    console.log(`${LOG} dry-run: nothing changed`);
    return { aborted: false, apply: false, fromId: from.id, toId: to?.id ?? null, fromEmail, toEmail };
  }

  let deletedTokens = 0;
  try {
    withTransaction(() => {
      if (to) {
        const fresh = countOwned(to.id, toEmail);
        if (!isDeletable(fresh)) {
          throw new ReassignRejected(`to user is not empty id=${to.id} email=${toEmail} ${blockingFound(fresh)}`);
        }
        deletedTokens = Number(
          getDb().prepare("DELETE FROM magic_tokens WHERE lower(trim(email)) = ?").run(toEmail).changes,
        );
        const removed = getDb().prepare("DELETE FROM users WHERE id = ?").run(to.id);
        if (removed.changes !== 1) {
          throw new Error(`to user delete failed id=${to.id}`);
        }
      }
      const stillThere = findUsers(toEmail).filter((user) => user.id !== from.id);
      if (stillThere.length > 0) {
        throw new ReassignRejected(`to email is still in use email=${toEmail}`);
      }
      const renamed = getDb()
        .prepare("UPDATE users SET email = ?, emailVerifiedAt = NULL WHERE id = ?")
        .run(toEmail, from.id);
      if (renamed.changes !== 1) {
        throw new Error(`rename failed id=${from.id}`);
      }
    });
  } catch (error) {
    if (error instanceof ReassignRejected) {
      console.error(`${LOG} aborted: ${error.message}`);
      console.log(`${LOG} nothing changed`);
      return { aborted: true, apply: true, fromId: from.id, toId: to?.id ?? null, fromEmail, toEmail };
    }
    throw error;
  }

  if (to) {
    console.log(
      `${LOG} apply deletedTo=${to.id} magicTokens=${deletedTokens} authSessions=removed-with-user`,
    );
  }
  console.log(`${LOG} apply renamedUser=${from.id} email=${toEmail} emailVerifiedAt=null`);
  return { aborted: false, apply: true, fromId: from.id, toId: to?.id ?? null, fromEmail, toEmail };
}

function abort(result: ReassignOwnerEmailResult, message: string): ReassignOwnerEmailResult {
  console.error(`${LOG} ${message}`);
  console.log(`${LOG} nothing changed`);
  return result;
}

function findUsers(normalized: string): UserHit[] {
  return getDb()
    .prepare(
      `SELECT id, email, emailVerifiedAt, passwordHash, googleId
       FROM users
       WHERE lower(trim(email)) = ?`,
    )
    .all(normalized) as UserHit[];
}

function countOwned(userId: string | null, email: string): OwnedCounts & { other: { table: string; count: number }[] } {
  const counts: OwnedCounts & { other: { table: string; count: number }[] } = {
    onboarding: 0,
    plans: 0,
    sessions: 0,
    feedbacks: 0,
    runLogs: 0,
    adaptationEvents: 0,
    intervalsConnections: 0,
    magicTokens: countMagicTokens(email),
    other: [],
  };
  if (!userId) return counts;

  const byLabel: Record<(typeof OWNED_TABLES)[number][1], keyof OwnedCounts> = {
    onboarding: "onboarding",
    plans: "plans",
    sessions: "sessions",
    feedbacks: "feedbacks",
    runLogs: "runLogs",
    adaptationEvents: "adaptationEvents",
    intervalsConnections: "intervalsConnections",
  };
  for (const [table, label] of OWNED_TABLES) {
    counts[byLabel[label]] = countUserRows(table, userId);
  }
  for (const table of otherUserTables()) {
    const count = countUserRows(table, userId);
    counts.other.push({ table, count });
  }
  return counts;
}

function otherUserTables(): string[] {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const names: string[] = [];
  for (const row of rows) {
    if (KNOWN_USER_TABLES.has(row.name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) continue;
    const columns = getDb().prepare(`PRAGMA table_info(${row.name})`).all() as { name: string }[];
    if (columns.some((column) => column.name === "userId")) names.push(row.name);
  }
  names.sort();
  return names;
}

function countUserRows(table: string, userId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE userId = ?`).get(userId) as {
    n: number;
  };
  return Number(row.n);
}

function countMagicTokens(email: string): number {
  const normalized = email.trim().toLowerCase();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM magic_tokens WHERE lower(trim(email)) = ?")
    .get(normalized) as { n: number };
  return Number(row.n);
}

function isDeletable(counts: OwnedCounts & { other: { count: number }[] }): boolean {
  return (
    counts.onboarding === 0 &&
    counts.plans === 0 &&
    counts.sessions === 0 &&
    counts.feedbacks === 0 &&
    counts.runLogs === 0 &&
    counts.adaptationEvents === 0 &&
    counts.intervalsConnections === 0 &&
    counts.other.every((row) => row.count === 0)
  );
}

function blockingFound(counts: OwnedCounts & { other: { table: string; count: number }[] }): string {
  const parts: string[] = [];
  const named: [keyof OwnedCounts, string][] = [
    ["onboarding", "onboarding"],
    ["plans", "plans"],
    ["sessions", "sessions"],
    ["feedbacks", "feedbacks"],
    ["runLogs", "runLogs"],
    ["adaptationEvents", "adaptationEvents"],
    ["intervalsConnections", "intervalsConnections"],
  ];
  for (const [key, label] of named) {
    if (counts[key] > 0) parts.push(`${label}=${counts[key]}`);
  }
  for (const row of counts.other) {
    if (row.count > 0) parts.push(`${row.table}=${row.count}`);
  }
  return parts.join(" ");
}

function formatCounts(counts: OwnedCounts & { other: { table: string; count: number }[] }): string {
  const parts = [
    `onboarding=${counts.onboarding}`,
    `plans=${counts.plans}`,
    `sessions=${counts.sessions}`,
    `feedbacks=${counts.feedbacks}`,
    `runLogs=${counts.runLogs}`,
    `adaptationEvents=${counts.adaptationEvents}`,
    `intervalsConnections=${counts.intervalsConnections}`,
    `magicTokens=${counts.magicTokens}`,
  ];
  for (const row of counts.other) parts.push(`${row.table}=${row.count}`);
  return parts.join(" ");
}
