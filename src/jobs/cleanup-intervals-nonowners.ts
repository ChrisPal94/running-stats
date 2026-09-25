import { loadLocalEnv } from "../lib/load-env";
import { cleanupNonOwnerIntervalsRunLogs } from "../lib/cleanup-intervals-nonowners";

loadLocalEnv();

const result = cleanupNonOwnerIntervalsRunLogs();
if (result.aborted) {
  process.exitCode = 1;
}
