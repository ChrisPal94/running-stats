import { listIntervalsSecretUserIds } from "./db.ts";
import { syncIntervalsForUser } from "./training.ts";

/**
 * Bulk Intervals.icu sync for `POST /api/intervals-sync` (the evening poll at
 * 20:30 America/Guayaquil, before the 21:00 adapt). Syncs every user that
 * stored its own encrypted Intervals token/key so the adapt already has
 * tonight's run log even if the activity webhook missed it.
 */

/** Result of one per-user Intervals sync, as returned by `syncIntervalsForUser`. */
export type IntervalsSyncResult = Awaited<ReturnType<typeof syncIntervalsForUser>>;

export type IntervalsBulkSyncDeps = {
  sync?: (userId: string) => Promise<IntervalsSyncResult>;
  listUserIds?: () => string[];
};

export type IntervalsBulkSyncResult = {
  /** Users attempted (the size of the user list). */
  processed: number;
  /** Sum of `imported` across successful syncs. */
  imported: number;
  /** Syncs that threw or returned `{ ok: false }`. Never aborts the loop. */
  failed: number;
  /** Sum of `skippedNoSession` across successful syncs. */
  skippedNoSession: number;
};

/**
 * Syncs each connected user in order, isolating failures: a thrown sync or a
 * `{ ok: false }` result counts as failed and never aborts the rest. Logs one
 * summary line with counts only — never tokens, athlete ids, or emails.
 */
export async function syncAllIntervalsUsers(
  deps: IntervalsBulkSyncDeps = {},
): Promise<IntervalsBulkSyncResult> {
  const sync = deps.sync ?? syncIntervalsForUser;
  const listUserIds = deps.listUserIds ?? listIntervalsSecretUserIds;

  const userIds = listUserIds();
  let imported = 0;
  let failed = 0;
  let skippedNoSession = 0;
  for (const userId of userIds) {
    try {
      const result = await sync(userId);
      if (!result.ok) {
        failed += 1;
        continue;
      }
      imported += result.imported;
      skippedNoSession += result.skippedNoSession;
    } catch {
      failed += 1;
    }
  }

  const result = { processed: userIds.length, imported, failed, skippedNoSession };
  console.log(`[intervals] sync-all processed=${result.processed} imported=${result.imported} failed=${result.failed}`);
  return result;
}