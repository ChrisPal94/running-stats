import {
  deleteIntervalsRunLogsByIds,
  listIntervalsRunLogs,
  listIntervalsSecretUserIds,
  listUserEmails,
} from "./db";
import { canUseIntervals, intervalsOwnerEmailAllowlist } from "./intervals";

/** RunLogs created at or after this instant belong to per-user Intervals and are kept. */
export const PER_USER_INTERVALS_SINCE = "2026-09-25T00:00:00.000Z";

const CUTOFF_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type IntervalsCleanupRow = {
  userId: string;
  email: string;
  wouldDelete: number;
  ids: string[];
};

export type IntervalsCleanupResult = {
  aborted: boolean;
  apply: boolean;
  rows: IntervalsCleanupRow[];
};

function resolveCutoff(before: string | undefined): string | null {
  if (before === undefined) return PER_USER_INTERVALS_SINCE;
  if (!CUTOFF_ISO.test(before) || !Number.isFinite(Date.parse(before))) return null;
  return before;
}

/**
 * Report old shared-key Intervals RunLogs that are safe to remove.
 * A row is eligible only when source is intervals, the account is not an owner
 * (`canUseIntervals` is false), the account has no encrypted token or API key,
 * and `createdAt` is strictly before the cutoff.
 * Default cutoff is `PER_USER_INTERVALS_SINCE`. Pass `before` (ISO) to override.
 * Default is a dry run. Pass `{ apply: true }` to delete the eligible rows.
 * An unset or empty allowlist, or an invalid cutoff, aborts and deletes nothing.
 */
export function cleanupNonOwnerIntervalsRunLogs(
  options: { apply?: boolean; before?: string } = {},
): IntervalsCleanupResult {
  const apply = options.apply === true;
  const cutoff = resolveCutoff(options.before);
  if (!cutoff) {
    console.error(
      "[cleanup:intervals-nonowners] aborted: --before must be an ISO timestamp like 2026-09-25T00:00:00.000Z; no RunLogs deleted",
    );
    return { aborted: true, apply, rows: [] };
  }

  if (!intervalsOwnerEmailAllowlist()) {
    console.error(
      "[cleanup:intervals-nonowners] aborted: INTERVALS_OWNER_EMAILS is unset or empty; no RunLogs deleted",
    );
    return { aborted: true, apply, rows: [] };
  }

  const cutoffMs = Date.parse(cutoff);
  const users = listUserEmails();
  const usersById = new Map(users.map((user) => [user.id, user]));
  const secretUsers = new Set(listIntervalsSecretUserIds());
  const idsByUser = new Map<string, string[]>();

  for (const log of listIntervalsRunLogs()) {
    const user = usersById.get(log.userId);
    if (user && canUseIntervals({ email: user.email })) continue;
    if (secretUsers.has(log.userId)) continue;
    const createdMs = Date.parse(log.createdAt);
    if (!Number.isFinite(createdMs) || createdMs >= cutoffMs) continue;
    const ids = idsByUser.get(log.userId) ?? [];
    ids.push(log.id);
    idsByUser.set(log.userId, ids);
  }

  const rows: IntervalsCleanupRow[] = users.map((user) => ({
    userId: user.id,
    email: user.email.trim(),
    wouldDelete: idsByUser.get(user.id)?.length ?? 0,
    ids: idsByUser.get(user.id) ?? [],
  }));
  const known = new Set(users.map((user) => user.id));
  for (const [userId, ids] of idsByUser) {
    if (known.has(userId)) continue;
    rows.push({ userId, email: "", wouldDelete: ids.length, ids });
  }
  rows.sort((a, b) => a.userId.localeCompare(b.userId));

  for (const row of rows) {
    if (apply) {
      console.log(
        `[cleanup:intervals-nonowners] apply userId=${row.userId} wouldDelete=${row.wouldDelete}`,
      );
    } else {
      console.log(
        `[cleanup:intervals-nonowners] dry-run userId=${row.userId} email=${row.email} wouldDelete=${row.wouldDelete}`,
      );
    }
  }

  const total = rows.reduce((sum, row) => sum + row.wouldDelete, 0);
  if (!apply) {
    console.log(`[cleanup:intervals-nonowners] dry-run total=${total}`);
    console.log("[cleanup:intervals-nonowners] dry-run: nothing deleted");
    return { aborted: false, apply: false, rows };
  }

  deleteIntervalsRunLogsByIds(rows.flatMap((row) => row.ids));
  for (const row of rows) {
    console.log(`[cleanup:intervals-nonowners] apply userId=${row.userId} deleted=${row.wouldDelete}`);
  }
  console.log(`[cleanup:intervals-nonowners] apply total=${total}`);
  return { aborted: false, apply: true, rows };
}
