import {
  deleteIntervalsRunLogsByIds,
  listIntervalsRunLogs,
  listIntervalsSecretUserIds,
  listUserEmails,
  withTransaction,
} from "./db";
import { canUseIntervals, hasVerifiedEmail, intervalsOwnerEmailAllowlist } from "./intervals";

/** RunLogs created at or after this instant belong to per-user Intervals and are kept. */
export const PER_USER_INTERVALS_SINCE = "2026-09-25T00:00:00.000Z";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CUTOFF_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export type IntervalsCleanupRow = {
  userId: string;
  email: string;
  verified: boolean;
  wouldDelete: number;
  ids: string[];
};

export type IntervalsCleanupResult = {
  aborted: boolean;
  apply: boolean;
  rows: IntervalsCleanupRow[];
};

export type CleanupCliArgs = { ok: true; apply: boolean; before?: string } | { ok: false };

/** `--before YYYY-MM-DD` and `--before=YYYY-MM-DD`. Any other flag aborts. */
export function parseCleanupCliArgs(argv: readonly string[]): CleanupCliArgs {
  let apply = false;
  let before: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--before") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return { ok: false };
      before = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--before=")) {
      const value = arg.slice("--before=".length);
      if (!value) return { ok: false };
      before = value;
      continue;
    }
    return { ok: false };
  }
  return { ok: true, apply, before };
}

function invalidBeforeLine(): string {
  return "[cleanup:intervals-nonowners] aborted: --before must be a real YYYY-MM-DD or an ISO timestamp like 2026-09-25T00:00:00.000Z; no RunLogs deleted";
}

function futureBeforeLine(): string {
  return "[cleanup:intervals-nonowners] aborted: --before is in the future; no RunLogs deleted";
}

/** Round-trip calendar parts so 2026-02-30 does not roll into March. */
function cutoffInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): string | null {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || ms > 999) return null;
  const stamp = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const date = new Date(stamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== ms
  ) {
    return null;
  }
  return date.toISOString();
}

function resolveCutoff(before: string | undefined): { cutoff: string } | { error: "invalid" | "future" } {
  if (before === undefined) return { cutoff: PER_USER_INTERVALS_SINCE };
  let cutoff: string | null = null;
  const dateOnly = DATE_ONLY.exec(before);
  if (dateOnly) {
    cutoff = cutoffInstant(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  } else {
    const iso = CUTOFF_ISO.exec(before);
    if (iso) {
      const fraction = iso[7] ?? "";
      const ms = fraction ? Number(fraction.padEnd(3, "0")) : 0;
      cutoff = cutoffInstant(
        Number(iso[1]),
        Number(iso[2]),
        Number(iso[3]),
        Number(iso[4]),
        Number(iso[5]),
        Number(iso[6]),
        ms,
      );
    }
  }
  if (!cutoff) return { error: "invalid" };
  if (Date.parse(cutoff) > Date.now()) return { error: "future" };
  return { cutoff };
}

function pendingOwnerAbortLine(userId: string): string {
  return `[cleanup:intervals-nonowners] aborted: allowlisted account userId=${userId} is not verified yet. Sign in with Google first. No RunLogs deleted.`;
}

function pendingOwnerWarningLine(userId: string): string {
  return `[cleanup:intervals-nonowners] warning: allowlisted account userId=${userId} is not verified yet. --apply will abort until that account is verified.`;
}

/**
 * Report old shared-key Intervals RunLogs that are safe to remove.
 * An owner is an allowlisted email with `emailVerifiedAt` set (`canUseIntervals`).
 * An allowlisted account with no `emailVerifiedAt` is a pending owner: dry-run
 * warns and omits them; `--apply` aborts and deletes nothing. An allowlisted
 * email with no account does not abort.
 * A row is eligible only when source is intervals, the account is not an owner
 * and not a pending owner, the account has no encrypted token or API key, and
 * `createdAt` is strictly before the cutoff. Default cutoff is `PER_USER_INTERVALS_SINCE`.
 * Default is a dry run. Pass `{ apply: true }` to delete the eligible rows.
 * An unset or empty allowlist, an impossible or non-round-trippable `--before`,
 * or a future cutoff aborts and deletes nothing.
 */
export function cleanupNonOwnerIntervalsRunLogs(
  options: { apply?: boolean; before?: string } = {},
): IntervalsCleanupResult {
  const apply = options.apply === true;
  const resolved = resolveCutoff(options.before);
  if ("error" in resolved) {
    console.error(resolved.error === "future" ? futureBeforeLine() : invalidBeforeLine());
    return { aborted: true, apply, rows: [] };
  }
  const cutoff = resolved.cutoff;

  const allowlist = intervalsOwnerEmailAllowlist();
  if (!allowlist) {
    console.error(
      "[cleanup:intervals-nonowners] aborted: INTERVALS_OWNER_EMAILS is unset or empty; no RunLogs deleted",
    );
    return { aborted: true, apply, rows: [] };
  }

  const cutoffMs = Date.parse(cutoff);
  const users = listUserEmails();
  const usersById = new Map(users.map((user) => [user.id, user]));
  const pendingOwners = users
    .filter(
      (user) =>
        allowlist.has(user.email.trim().toLowerCase()) &&
        !hasVerifiedEmail({ emailVerifiedAt: user.emailVerifiedAt }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (apply && pendingOwners.length > 0) {
    for (const user of pendingOwners) console.error(pendingOwnerAbortLine(user.id));
    return { aborted: true, apply: true, rows: [] };
  }
  for (const user of pendingOwners) console.error(pendingOwnerWarningLine(user.id));
  const pendingIds = new Set(pendingOwners.map((user) => user.id));

  const secretUsers = new Set(listIntervalsSecretUserIds());
  const idsByUser = new Map<string, string[]>();

  for (const log of listIntervalsRunLogs()) {
    if (pendingIds.has(log.userId)) continue;
    const user = usersById.get(log.userId);
    if (user && canUseIntervals({ email: user.email, emailVerifiedAt: user.emailVerifiedAt })) continue;
    if (secretUsers.has(log.userId)) continue;
    const createdMs = Date.parse(log.createdAt);
    if (!Number.isFinite(createdMs) || createdMs >= cutoffMs) continue;
    const ids = idsByUser.get(log.userId) ?? [];
    ids.push(log.id);
    idsByUser.set(log.userId, ids);
  }

  const rows: IntervalsCleanupRow[] = users
    .filter((user) => !pendingIds.has(user.id))
    .map((user) => ({
      userId: user.id,
      email: user.email.trim(),
      verified: hasVerifiedEmail({ emailVerifiedAt: user.emailVerifiedAt }),
      wouldDelete: idsByUser.get(user.id)?.length ?? 0,
      ids: idsByUser.get(user.id) ?? [],
    }));
  const known = new Set(users.map((user) => user.id));
  for (const [userId, ids] of idsByUser) {
    if (known.has(userId)) continue;
    rows.push({ userId, email: "", verified: false, wouldDelete: ids.length, ids });
  }
  rows.sort((a, b) => a.userId.localeCompare(b.userId));

  for (const row of rows) {
    if (apply) {
      console.log(
        `[cleanup:intervals-nonowners] apply userId=${row.userId} wouldDelete=${row.wouldDelete}`,
      );
    } else {
      const verified = row.verified ? "yes" : "no";
      console.log(
        `[cleanup:intervals-nonowners] dry-run userId=${row.userId} email=${row.email} verified=${verified} wouldDelete=${row.wouldDelete}`,
      );
    }
  }

  const total = rows.reduce((sum, row) => sum + row.wouldDelete, 0);
  if (!apply) {
    console.log(`[cleanup:intervals-nonowners] dry-run total=${total}`);
    console.log("[cleanup:intervals-nonowners] dry-run: nothing deleted");
    return { aborted: false, apply: false, rows };
  }

  const deletedByUser = new Map<string, number>();
  withTransaction(() => {
    for (const row of rows) deletedByUser.set(row.userId, deleteIntervalsRunLogsByIds(row.ids));
  });
  let deletedTotal = 0;
  for (const row of rows) {
    const deleted = deletedByUser.get(row.userId) ?? 0;
    deletedTotal += deleted;
    console.log(`[cleanup:intervals-nonowners] apply userId=${row.userId} deleted=${deleted}`);
  }
  console.log(`[cleanup:intervals-nonowners] apply total=${deletedTotal}`);
  return { aborted: false, apply: true, rows };
}
