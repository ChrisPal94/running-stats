/**
 * Remove planned workouts this app uploaded onto the owner's Intervals calendar
 * for other accounts, before per-user Intervals. Christian's own planned
 * workouts, and anything this app did not create, stay.
 *
 * Dry-run by default. Prints each match as `id`, `date`, and `name`, plus
 * `userId` counts. No emails, API keys, or tokens.
 *
 *   npm run cleanup:owner-calendar -- --athlete i123456
 *   npm run cleanup:owner-calendar -- --athlete=i123456 --apply
 *
 * `--athlete` is required (one Intervals athlete id, like i123456). There is
 * no all-athletes mode. `--apply` is the only flag that deletes. A second
 * `--apply` deletes 0. A 404 on delete counts as already deleted.
 *
 * Uses `INTERVALS_ICU_API_KEY` against that athlete. Aborts when
 * `INTERVALS_OWNER_EMAILS` is unset or an allowlisted account has no
 * `emailVerifiedAt`, same guard as `cleanup:intervals-nonowners`.
 */
import { cleanupOwnerCalendarPlannedWorkouts, parseOwnerCalendarCliArgs } from "../lib/cleanup-owner-calendar";
import { loadLocalEnv } from "../lib/load-env";

loadLocalEnv();

const parsed = parseOwnerCalendarCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exitCode = 1;
} else {
  const result = await cleanupOwnerCalendarPlannedWorkouts({
    apply: parsed.apply,
    athlete: parsed.athlete,
  });
  if (result.aborted || result.failed > 0) process.exitCode = 1;
}
