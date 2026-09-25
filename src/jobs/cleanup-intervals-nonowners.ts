import { loadLocalEnv } from "../lib/load-env";
import { cleanupNonOwnerIntervalsRunLogs } from "../lib/cleanup-intervals-nonowners";

loadLocalEnv();

const apply = process.argv.includes("--apply");
const result = cleanupNonOwnerIntervalsRunLogs({ apply });
if (result.aborted) {
  process.exitCode = 1;
}
