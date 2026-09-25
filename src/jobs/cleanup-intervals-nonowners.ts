import { loadLocalEnv } from "../lib/load-env";
import { cleanupNonOwnerIntervalsRunLogs } from "../lib/cleanup-intervals-nonowners";

loadLocalEnv();

const apply = process.argv.includes("--apply");
const beforeIndex = process.argv.indexOf("--before");
const before = beforeIndex >= 0 ? (process.argv[beforeIndex + 1] ?? "") : undefined;
const result = cleanupNonOwnerIntervalsRunLogs({ apply, before });
if (result.aborted) {
  process.exitCode = 1;
}
