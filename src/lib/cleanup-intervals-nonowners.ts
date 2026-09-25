import { deleteIntervalsRunLogsExceptUsers, listUserEmails } from "./db";
import { intervalsOwnerEmailAllowlist } from "./intervals";

export type IntervalsCleanupResult = {
  aborted: boolean;
  deletedByUser: { userId: string; count: number }[];
};

/**
 * Delete Intervals-imported RunLogs for accounts outside `INTERVALS_OWNER_EMAILS`.
 * Unset or empty allowlist aborts before any delete so the owner's rows stay put.
 */
export function cleanupNonOwnerIntervalsRunLogs(): IntervalsCleanupResult {
  const allow = intervalsOwnerEmailAllowlist();
  if (!allow) {
    console.error(
      "[cleanup:intervals-nonowners] aborted: INTERVALS_OWNER_EMAILS is unset or empty; no RunLogs deleted",
    );
    return { aborted: true, deletedByUser: [] };
  }

  const ownerIds = listUserEmails()
    .filter((user) => allow.has(user.email.trim().toLowerCase()))
    .map((user) => user.id);
  const deletedByUser = deleteIntervalsRunLogsExceptUsers(ownerIds);
  for (const row of deletedByUser) {
    console.log(`[cleanup:intervals-nonowners] deleted userId=${row.userId} count=${row.count}`);
  }
  const total = deletedByUser.reduce((sum, row) => sum + row.count, 0);
  console.log(`[cleanup:intervals-nonowners] done deleted=${total}`);
  return { aborted: false, deletedByUser };
}
