import { deleteIntervalsRunLogsExceptUsers, listIntervalsRunLogCounts, listUserEmails } from "./db";
import { canUseIntervals, hasVerifiedEmail, intervalsOwnerEmailAllowlist } from "./intervals";

export type IntervalsCleanupRow = {
  userId: string;
  email: string;
  verified: boolean;
  wouldDelete: number;
};

export type IntervalsCleanupResult = {
  aborted: boolean;
  apply: boolean;
  rows: IntervalsCleanupRow[];
};

/**
 * Report Intervals RunLogs that belong to accounts that cannot use Intervals.
 * An owner is an allowlisted email with `emailVerifiedAt` set. Unverified
 * allowlisted accounts are non-owners. Default is a dry run (prints only).
 * Pass `{ apply: true }` to delete those rows.
 * An unset or empty allowlist aborts in both modes and deletes nothing.
 */
export function cleanupNonOwnerIntervalsRunLogs(
  options: { apply?: boolean } = {},
): IntervalsCleanupResult {
  const apply = options.apply === true;
  const allow = intervalsOwnerEmailAllowlist();
  if (!allow) {
    console.error(
      "[cleanup:intervals-nonowners] aborted: INTERVALS_OWNER_EMAILS is unset or empty; no RunLogs deleted",
    );
    return { aborted: true, apply, rows: [] };
  }

  const users = listUserEmails();
  const counts = new Map(listIntervalsRunLogCounts().map((row) => [row.userId, row.count]));
  const ownerIds = new Set(
    users
      .filter((user) => canUseIntervals({ email: user.email, emailVerifiedAt: user.emailVerifiedAt }))
      .map((user) => user.id),
  );

  const rows: IntervalsCleanupRow[] = users.map((user) => ({
    userId: user.id,
    email: user.email.trim(),
    verified: hasVerifiedEmail({ emailVerifiedAt: user.emailVerifiedAt }),
    wouldDelete: ownerIds.has(user.id) ? 0 : (counts.get(user.id) ?? 0),
  }));
  const known = new Set(users.map((user) => user.id));
  for (const [userId, count] of counts) {
    if (known.has(userId)) continue;
    rows.push({ userId, email: "", verified: false, wouldDelete: count });
  }
  rows.sort((a, b) => a.userId.localeCompare(b.userId));

  const mode = apply ? "apply" : "dry-run";
  for (const row of rows) {
    const verified = row.verified ? "yes" : "no";
    console.log(
      `[cleanup:intervals-nonowners] ${mode} userId=${row.userId} email=${row.email} verified=${verified} wouldDelete=${row.wouldDelete}`,
    );
  }
  const total = rows.reduce((sum, row) => sum + row.wouldDelete, 0);
  console.log(`[cleanup:intervals-nonowners] ${mode} total=${total}`);

  if (!apply) {
    console.log("[cleanup:intervals-nonowners] dry-run: nothing deleted");
    return { aborted: false, apply: false, rows };
  }

  deleteIntervalsRunLogsExceptUsers([...ownerIds]);
  return { aborted: false, apply: true, rows };
}
