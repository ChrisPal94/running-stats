import { addDaysYmd } from "./calendar";
import { listUserEmails, loadTrainingSnapshot } from "./db";
import {
  canUseIntervals,
  hasVerifiedEmail,
  INTERVALS_ICU_BASE_URL,
  INTERVALS_USER_AGENT,
  intervalsActivityDay,
  intervalsAuthorizationHeader,
  intervalsOwnerEmailAllowlist,
  normalizeIntervalsAthleteId,
} from "./intervals";
/**
 * One athlete per run. Dry-run unless `apply` is set.
 *
 *   npm run cleanup:owner-calendar -- --athlete i123456
 *   npm run cleanup:owner-calendar -- --athlete i123456 --apply
 *
 * A workout is ours only when `external_id` equals a non-owner session id.
 * `plannedRunEvent` has always required that id, so a blank `external_id` is
 * not an upload from this app.
 */
const LOG = "[cleanup:owner-calendar]";
/** Events can be dragged off the session day. The list call is not the 7-day default. */
const LIST_PAD_DAYS = 366;
/** Used when no local session dates remain, so a wiped database can still show leftovers. */
const FALLBACK_OLDEST = "2024-01-01";
const FALLBACK_NEWEST = "2028-12-31";
const FETCH_TIMEOUT_MS = 15_000;

export type OwnerCalendarCleanupResult = {
  aborted: boolean;
  apply: boolean;
  wouldDelete: number;
  deleted: number;
  alreadyDeleted: number;
  failed: number;
};

export type OwnerCalendarCliArgs =
  | { ok: true; apply: boolean; athlete: string }
  | { ok: false; message: string };

type SessionRef = {
  id: string;
  userId: string;
  date: string;
};

type CalendarWorkout = {
  id: string | null;
  externalId: string;
  date: string;
  name: string;
  category: string;
};

type PlannedDelete = {
  id: string;
  date: string;
  name: string;
  userId: string;
};

/** `--athlete i123456` and `--athlete=i123456`. Any other flag, or a second athlete, aborts. */
export function parseOwnerCalendarCliArgs(argv: readonly string[]): OwnerCalendarCliArgs {
  let apply = false;
  let athlete: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    let value: string | undefined;
    if (arg === "--athlete") {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, message: `${LOG} aborted: unknown or malformed argument; no events deleted` };
      }
      index += 1;
    } else if (arg.startsWith("--athlete=")) {
      value = arg.slice("--athlete=".length);
      if (!value) {
        return { ok: false, message: `${LOG} aborted: unknown or malformed argument; no events deleted` };
      }
    } else {
      return { ok: false, message: `${LOG} aborted: unknown or malformed argument; no events deleted` };
    }
    if (athlete !== undefined) {
      return { ok: false, message: `${LOG} aborted: --athlete must be passed once; no events deleted` };
    }
    const normalized = normalizeIntervalsAthleteId(value);
    if (!normalized) {
      return { ok: false, message: `${LOG} aborted: --athlete must be an athlete id like i123456; no events deleted` };
    }
    athlete = normalized;
  }
  if (!athlete) {
    return { ok: false, message: `${LOG} aborted: --athlete is required; no events deleted` };
  }
  return { ok: true, apply, athlete };
}

function stopped(apply: boolean, aborted: boolean): OwnerCalendarCleanupResult {
  return { aborted, apply, wouldDelete: 0, deleted: 0, alreadyDeleted: 0, failed: 0 };
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redact(value: string, secrets: readonly string[]): string {
  let out = collapse(value);
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * User id when `external_id` is a non-owner session id from `upsertPlannedRuns`.
 * A blank id is not ours. An id that matches no session is an orphan, not a delete.
 */
function nonOwnerUploadUserId(
  event: CalendarWorkout,
  sessionsById: Map<string, SessionRef>,
  ownerIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): string | null {
  if (event.category && event.category !== "WORKOUT") return null;
  const externalId = event.externalId.trim();
  if (!externalId) return null;
  const session = sessionsById.get(externalId);
  if (!session) return null;
  if (ownerIds.has(session.userId) || pendingIds.has(session.userId)) return null;
  return session.userId;
}

/** `external_id` is set and is not a session id we still have. Blank ids are not orphans. */
function orphanExternalId(event: CalendarWorkout, sessionsById: Map<string, SessionRef>): boolean {
  if (event.category && event.category !== "WORKOUT") return false;
  const externalId = event.externalId.trim();
  if (!externalId) return false;
  return !sessionsById.has(externalId);
}

function eventId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim();
  return null;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Blank only when the field is missing. A number or other id is someone else's key. */
function externalIdField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "\u0000";
}

function parseCalendarWorkouts(payload: unknown): CalendarWorkout[] | null {
  if (!Array.isArray(payload)) return null;
  const events: CalendarWorkout[] = [];
  for (const value of payload) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const start = textField(record.start_date_local);
    events.push({
      id: eventId(record.id),
      externalId: externalIdField(record.external_id),
      date: intervalsActivityDay(start) ?? "",
      name: textField(record.name),
      category: textField(record.category),
    });
  }
  return events;
}

function listWindow(dates: readonly string[]): { oldest: string; newest: string } | null {
  const valid = dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const oldestDate = valid[0];
  const newestDate = valid[valid.length - 1];
  if (!oldestDate || !newestDate) return null;
  return {
    oldest: addDaysYmd(oldestDate, -LIST_PAD_DAYS),
    newest: addDaysYmd(newestDate, LIST_PAD_DAYS),
  };
}

async function intervalsRequest(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  method: "GET" | "DELETE",
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; message: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: intervalsAuthorizationHeader("apikey", apiKey),
        "User-Agent": INTERVALS_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return { ok: false, status: 0, message };
  }
  if (method === "DELETE") return { ok: true, status: response.status, body: null };
  if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${response.status}` };
  try {
    return { ok: true, status: response.status, body: await response.json() };
  } catch {
    return { ok: false, status: response.status, message: "response was not JSON" };
  }
}

function logRedacted(line: string, secrets: readonly string[]): void {
  console.log(redact(line, secrets));
}

/**
 * List planned workouts on one Intervals calendar and select the ones this app
 * uploaded for accounts that are not the verified owner.
 * Default is a dry run. Pass `{ apply: true }` to DELETE those events.
 * A 404 on delete counts as already deleted. An unverified allowlisted account
 * aborts `--apply` before any request, same as `cleanup:intervals-nonowners`.
 */
export async function cleanupOwnerCalendarPlannedWorkouts(
  options: { athlete: string; apply?: boolean; fetchImpl?: typeof fetch },
): Promise<OwnerCalendarCleanupResult> {
  const apply = options.apply === true;
  const athlete = normalizeIntervalsAthleteId(options.athlete);
  if (!athlete) {
    console.error(`${LOG} aborted: --athlete must be an athlete id like i123456; no events deleted`);
    return stopped(apply, true);
  }

  const allowlist = intervalsOwnerEmailAllowlist();
  if (!allowlist) {
    console.error(`${LOG} aborted: INTERVALS_OWNER_EMAILS is unset or empty; no events deleted`);
    return stopped(apply, true);
  }

  const users = listUserEmails();
  const pendingOwners = users
    .filter(
      (user) =>
        allowlist.has(user.email.trim().toLowerCase()) &&
        !hasVerifiedEmail({ emailVerifiedAt: user.emailVerifiedAt }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (apply && pendingOwners.length > 0) {
    for (const user of pendingOwners) {
      console.error(
        `${LOG} aborted: allowlisted account userId=${user.id} is not verified yet. Sign in with Google first. No events deleted.`,
      );
    }
    return stopped(true, true);
  }
  for (const user of pendingOwners) {
    console.error(
      `${LOG} warning: allowlisted account userId=${user.id} is not verified yet. --apply will abort until that account is verified.`,
    );
  }

  const ownerIds = new Set(
    users
      .filter((user) => canUseIntervals({ email: user.email, emailVerifiedAt: user.emailVerifiedAt }))
      .map((user) => user.id),
  );
  const pendingIds = new Set(pendingOwners.map((user) => user.id));
  const sessions: SessionRef[] = loadTrainingSnapshot().sessions.map((session) => ({
    id: session.id,
    userId: session.userId,
    date: session.date,
  }));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const candidateSessions = sessions.filter(
    (session) => !ownerIds.has(session.userId) && !pendingIds.has(session.userId),
  );
  if (apply && candidateSessions.length === 0) {
    console.log(`${LOG} wouldDelete=0`);
    console.log(`${LOG} deleted=0 alreadyDeleted=0`);
    return stopped(true, false);
  }

  const scanDates = (candidateSessions.length > 0 ? candidateSessions : sessions).map((session) => session.date);
  const window = listWindow(scanDates) ?? (apply ? null : { oldest: FALLBACK_OLDEST, newest: FALLBACK_NEWEST });
  if (!window) {
    console.log(`${LOG} wouldDelete=0`);
    console.log(`${LOG} deleted=0 alreadyDeleted=0`);
    return stopped(apply, false);
  }

  const apiKey = process.env.INTERVALS_ICU_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error(`${LOG} aborted: INTERVALS_ICU_API_KEY is unset or empty; no events deleted`);
    return stopped(apply, true);
  }
  const secrets = [apiKey];

  const params = new URLSearchParams({
    oldest: window.oldest,
    newest: window.newest,
    category: "WORKOUT",
  });
  const listUrl = `${INTERVALS_ICU_BASE_URL}/athlete/${encodeURIComponent(athlete)}/events?${params.toString()}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const listed = await intervalsRequest(fetchImpl, apiKey, listUrl, "GET");
  if (!listed.ok) {
    const detail = redact(listed.message, secrets);
    console.error(`${LOG} aborted: list failed status=${listed.status} ${detail}; no events deleted`);
    return stopped(apply, true);
  }
  const events = parseCalendarWorkouts(listed.body);
  if (!events) {
    console.error(`${LOG} aborted: list response was not a JSON array; no events deleted`);
    return stopped(apply, true);
  }

  const planned: PlannedDelete[] = [];
  const orphans: Array<{ id: string; date: string }> = [];
  let missingId = 0;
  for (const event of events) {
    if (orphanExternalId(event, sessionsById)) {
      if (event.id) orphans.push({ id: event.id, date: event.date || "unknown" });
      continue;
    }
    const userId = nonOwnerUploadUserId(event, sessionsById, ownerIds, pendingIds);
    if (!userId) continue;
    if (!event.id) {
      missingId += 1;
      continue;
    }
    planned.push({
      id: event.id,
      date: event.date,
      name: redact(event.name, secrets) || "Run",
      userId,
    });
  }
  planned.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  orphans.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  logRedacted(`${LOG} athlete=${athlete}`, secrets);
  for (const row of planned) {
    logRedacted(`${LOG} would-delete id=${row.id} date=${row.date} name=${row.name}`, secrets);
  }
  const counts = new Map<string, number>();
  for (const row of planned) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  for (const userId of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    logRedacted(`${LOG} userId=${userId} count=${counts.get(userId) ?? 0}`, secrets);
  }
  if (!apply && orphans.length > 0) {
    for (const orphan of orphans) {
      logRedacted(`${LOG} orphan-external-id id=${orphan.id} date=${orphan.date}`, secrets);
    }
    console.log(`${LOG} orphan-external-id count=${orphans.length}`);
  }
  if (missingId > 0) {
    console.error(`${LOG} skipped-no-id count=${missingId}`);
  }
  console.log(`${LOG} wouldDelete=${planned.length}`);

  if (!apply) {
    console.log(`${LOG} dry-run: nothing deleted`);
    return {
      aborted: false,
      apply: false,
      wouldDelete: planned.length,
      deleted: 0,
      alreadyDeleted: 0,
      failed: missingId,
    };
  }

  let deleted = 0;
  let alreadyDeleted = 0;
  let failed = missingId;
  for (const row of planned) {
    // `others=true` would also delete events created in the same batch. Leave it off.
    const url = `${INTERVALS_ICU_BASE_URL}/athlete/${encodeURIComponent(athlete)}/events/${encodeURIComponent(row.id)}`;
    const result = await intervalsRequest(fetchImpl, apiKey, url, "DELETE");
    if (!result.ok) {
      failed += 1;
      console.error(`${LOG} delete failed id=${row.id} status=${result.status}`);
      continue;
    }
    if (result.status === 404) {
      alreadyDeleted += 1;
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      failed += 1;
      console.error(`${LOG} delete failed id=${row.id} status=${result.status}`);
      continue;
    }
    deleted += 1;
  }
  console.log(`${LOG} deleted=${deleted} alreadyDeleted=${alreadyDeleted}`);
  return {
    aborted: false,
    apply: true,
    wouldDelete: planned.length,
    deleted,
    alreadyDeleted,
    failed,
  };
}
