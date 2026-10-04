import { timingSafeEqual } from "node:crypto";
import { syncIntervalsForUser } from "./training.ts";

/**
 * Payload helpers for `POST /api/intervals-webhook` (Intervals.icu activity
 * webhooks, cookbook format: `{ secret, events: [{ athlete_id, type, ... }] }`).
 *
 * Activity webhooks are NOT delivered for Strava-sourced activities — that is an
 * Intervals.icu limit, not something this code detects or works around.
 */

const OAUTH_ATHLETE_ID = /^i\d{1,12}$/;
const ACTIVITY_EVENT_TYPES = new Set(["ACTIVITY_UPLOADED", "ACTIVITY_ANALYZED"]);

export type IntervalsWebhookSyncResult = Awaited<ReturnType<typeof syncIntervalsForUser>>;

export type WebhookSyncOutcome = {
  status: 200 | 500;
  body: Record<string, unknown>;
};

export type WebhookLookup = (athleteId: string) => string | null;
export type WebhookSync = (userId: string) => Promise<IntervalsWebhookSyncResult>;

/** True only when `INTERVALS_WEBHOOK_SECRET` is set and non-blank. */
export function intervalsWebhookConfigured(): boolean {
  return Boolean(process.env.INTERVALS_WEBHOOK_SECRET?.trim());
}

/**
 * Compares the body `secret` field to `INTERVALS_WEBHOOK_SECRET`. Never log the
 * provided value. Not configured counts as unauthorized.
 */
export function webhookSecretAuthorized(provided: unknown): boolean {
  const secret = process.env.INTERVALS_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Normalizes a webhook athlete id to the stored OAuth form (`i` + digits). */
export function normalizeWebhookAthleteId(value: unknown): string | null {
  let raw = "";
  if (typeof value === "number" && Number.isFinite(value)) raw = String(Math.trunc(value));
  else if (typeof value === "string") raw = value.trim();
  else return null;
  if (/^\d{1,12}$/.test(raw)) raw = `i${raw}`;
  if (!OAUTH_ATHLETE_ID.test(raw)) return null;
  return raw;
}

/** Body is a webhook payload only when it is a JSON object. */
export function webhookBodyIsObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/**
 * Distinct normalized athlete ids from `ACTIVITY_UPLOADED` / `ACTIVITY_ANALYZED`
 * events, in first-seen order. Every other event type (including
 * `CALENDAR_UPDATED`) is ignored. A malformed body yields no ids.
 */
export function collectWebhookEventAthleteIds(body: unknown): string[] {
  if (!webhookBodyIsObject(body)) return [];
  const events = body.events;
  if (!Array.isArray(events)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string" || !ACTIVITY_EVENT_TYPES.has(record.type)) continue;
    const athleteId = normalizeWebhookAthleteId(record.athlete_id);
    if (!athleteId || seen.has(athleteId)) continue;
    seen.add(athleteId);
    ids.push(athleteId);
  }
  return ids;
}

function resolveWebhookUsers(body: unknown, lookup: WebhookLookup): string[] {
  const userIds: string[] = [];
  const seen = new Set<string>();
  for (const athleteId of collectWebhookEventAthleteIds(body)) {
    const userId = lookup(athleteId);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    userIds.push(userId);
  }
  return userIds;
}

/**
 * Syncs each matched (distinct) user once. Any thrown sync is caught so the
 * process survives; one failure or a thrown sync means the response says the
 * whole webhook should be retried by Intervals (500).
 */
export async function runWebhookSyncs(
  body: unknown,
  lookup: WebhookLookup,
  sync: WebhookSync,
): Promise<WebhookSyncOutcome> {
  const userIds = resolveWebhookUsers(body, lookup);
  if (userIds.length === 0) {
    return { status: 200, body: { ignored: true } };
  }

  let imported = 0;
  let skippedNoSession = 0;
  let skippedManual = 0;
  let pendingChoices = 0;
  let failed = false;
  for (const userId of userIds) {
    let result: IntervalsWebhookSyncResult;
    try {
      result = await sync(userId);
    } catch {
      failed = true;
      continue;
    }
    if (!result.ok) {
      failed = true;
      continue;
    }
    imported += result.imported;
    skippedNoSession += result.skippedNoSession;
    skippedManual += result.skippedManual;
    pendingChoices += result.pendingChoices.length;
  }

  if (failed) {
    return { status: 500, body: { ok: false, error: "Intervals sync failed" } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      imported,
      skippedNoSession,
      skippedManual,
      pendingChoices,
      synced: userIds.length,
    },
  };
}