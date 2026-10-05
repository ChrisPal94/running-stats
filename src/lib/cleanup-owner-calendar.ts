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
import { presentSession, type SessionKind } from "./training";

/**
 * One athlete per run. Dry-run unless `apply` is set.
 *
 *   npm run cleanup:owner-calendar -- --athlete i123456
 *   npm run cleanup:owner-calendar -- --athlete i123456 --apply
 */
const LOG = "[cleanup:owner-calendar]";
const UPLOAD_KINDS: readonly SessionKind[] = ["easy", "intervals", "tempo", "long"];
/** `plannedRunEvent` always writes this local time. */
const UPLOAD_LOCAL_TIME = "T08:00:00";
/** Events can be dragged off the session day. The list call is not the 7-day default. */
const LIST_PAD_DAYS = 366;
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
  title: string;
};

type CalendarWorkout = {
  id: string | null;
  externalId: string;
  date: string;
  name: string;
  description: string;
  category: string;
  type: string;
  startDateLocal: string;
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

/** Title prefix `presentSession` writes, e.g. `Easy run · `. */
function uploadTitlePrefix(kind: SessionKind): string {
  const title = presentSession(kind, 8).title;
  const marker = " · ";
  const at = title.indexOf(marker);
  return at === -1 ? title : title.slice(0, at + marker.length);
}

/**
 * Name and cue written by `upsertPlannedRuns` via `presentSession`.
 * Returns the exact title, or null when the name is not that upload.
 */
function adaptUploadTitle(name: string, description: string): string | null {
  const normalizedName = collapse(name);
  const normalizedDescription = collapse(description);
  for (const kind of UPLOAD_KINDS) {
    const prefix = uploadTitlePrefix(kind);
    if (!normalizedName.startsWith(prefix)) continue;
    const kmText = normalizedName.slice(prefix.length);
    if (!/^\d+ km$/.test(kmText)) continue;
    const km = Number(kmText.slice(0, -" km".length));
    const presented = presentSession(kind, km);
    if (presented.title !== normalizedName) continue;
    if (collapse(presented.cue) !== normalizedDescription) continue;
    return presented.title;
  }
  return null;
}

function uploadedAtEight(startDateLocal: string, date: string): boolean {
  const raw = startDateLocal.trim();
  const prefix = `${date}${UPLOAD_LOCAL_TIME}`;
  if (!raw.startsWith(prefix)) return false;
  const rest = raw.slice(prefix.length);
  return rest === "" || /^[Z.+-]/.test(rest);
}

/**
 * User id of a non-owner session this calendar event belongs to.
 * `external_id` is the session id `upsertPlannedRuns` sends. A foreign id never matches.
 * A blank `external_id` can still match the upload's name prefix, cue, and 08:00 local
 * time, and only when that title and date belong to exactly one non-owner and to no owner.
 */
export function legacyNonOwnerUploadUserId(
  event: CalendarWorkout,
  sessionsById: Map<string, SessionRef>,
  sessions: readonly SessionRef[],
  ownerIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): string | null {
  if (event.category && event.category !== "WORKOUT") return null;
  const externalId = event.externalId.trim();
  if (externalId) {
    const session = sessionsById.get(externalId);
    if (!session) return null;
    if (ownerIds.has(session.userId) || pendingIds.has(session.userId)) return null;
    return session.userId;
  }

  const title = adaptUploadTitle(event.name, event.description);
  if (!title || !event.date) return null;
  if (event.type.trim().toLowerCase() !== "run") return null;
  if (!uploadedAtEight(event.startDateLocal, event.date)) return null;
  const same = sessions.filter((session) => session.date === event.date && collapse(session.title) === title);
  if (same.some((session) => ownerIds.has(session.userId) || pendingIds.has(session.userId))) return null;
  const userIds = [...new Set(same.map((session) => session.userId))];
  if (userIds.length !== 1) return null;
  return userIds[0] ?? null;
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
    const date = intervalsActivityDay(start) ?? "";
    events.push({
      id: eventId(record.id),
      externalId: externalIdField(record.external_id),
      date,
      name: textField(record.name),
      description: textField(record.description),
      category: textField(record.category),
      type: textField(record.type),
      startDateLocal: start,
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
    title: session.title,
  }));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const candidateSessions = sessions.filter(
    (session) => !ownerIds.has(session.userId) && !pendingIds.has(session.userId),
  );
  if (candidateSessions.length === 0) {
    console.log(`${LOG} wouldDelete=0`);
    if (!apply) console.log(`${LOG} dry-run: nothing deleted`);
    else console.log(`${LOG} deleted=0 alreadyDeleted=0`);
    return stopped(apply, false);
  }

  const apiKey = process.env.INTERVALS_ICU_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error(`${LOG} aborted: INTERVALS_ICU_API_KEY is unset or empty; no events deleted`);
    return stopped(apply, true);
  }
  const secrets = [apiKey];

  const window = listWindow(candidateSessions.map((session) => session.date));
  if (!window) {
    console.log(`${LOG} wouldDelete=0`);
    if (!apply) console.log(`${LOG} dry-run: nothing deleted`);
    else console.log(`${LOG} deleted=0 alreadyDeleted=0`);
    return stopped(apply, false);
  }

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
  let missingId = 0;
  for (const event of events) {
    const userId = legacyNonOwnerUploadUserId(event, sessionsById, sessions, ownerIds, pendingIds);
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

  logRedacted(`${LOG} athlete=${athlete}`, secrets);
  for (const row of planned) {
    logRedacted(`${LOG} would-delete id=${row.id} date=${row.date} name=${row.name}`, secrets);
  }
  const counts = new Map<string, number>();
  for (const row of planned) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  for (const userId of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    logRedacted(`${LOG} userId=${userId} count=${counts.get(userId) ?? 0}`, secrets);
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
