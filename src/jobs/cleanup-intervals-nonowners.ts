import { parseCleanupCliArgs, cleanupNonOwnerIntervalsRunLogs } from "../lib/cleanup-intervals-nonowners";
import { loadLocalEnv } from "../lib/load-env";

loadLocalEnv();

const parsed = parseCleanupCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(
    "[cleanup:intervals-nonowners] aborted: unknown or malformed argument; no RunLogs deleted",
  );
  process.exitCode = 1;
} else {
  const result = cleanupNonOwnerIntervalsRunLogs({ apply: parsed.apply, before: parsed.before });
  if (result.aborted) process.exitCode = 1;
}
