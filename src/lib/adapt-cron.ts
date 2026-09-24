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
};

/** Short ops summary for `/api/adapt` and the CLI cron loop. Counts only; no user PII. */
export function adaptRunLogLine(result: AdaptRunCounts): string {
  return `[adapt] run processed=${result.processed} written=${result.written} skipped=${result.skipped} patched=${result.patched} llmFailed=${result.llmFailed} uploaded=${result.uploaded} uploadFailed=${result.uploadFailed}`;
}
