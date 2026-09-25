/** True when `ADAPT_CRON_SECRET` is set and non-empty after trim. Never returns the secret. */
export function adaptCronConfigured(
  secret: string | undefined = process.env.ADAPT_CRON_SECRET,
): boolean {
  return Boolean(secret?.trim());
}

export type AdaptRunCounts = {
  processed: number;
  written: number;
  skipped: number;
  patched: number;
  llmFailed: number;
  uploaded: number;
  uploadFailed: number;
  /** Users skipped for Intervals because they have no usable connection. Count only. */
  noConnection?: number;
  /** Accounts whose stored Intervals access must be reconnected. Count only. */
  reconnect?: number;
};

/** Short ops summary for `/api/adapt` and the CLI cron loop. Counts only; no user PII. */
export function adaptRunLogLine(result: AdaptRunCounts): string {
  const noConnection = result.noConnection ?? 0;
  const reconnect = result.reconnect ?? 0;
  return `[adapt] run processed=${result.processed} written=${result.written} skipped=${result.skipped} patched=${result.patched} llmFailed=${result.llmFailed} uploaded=${result.uploaded} uploadFailed=${result.uploadFailed} noConnection=${noConnection} reconnect=${reconnect}`;
}
