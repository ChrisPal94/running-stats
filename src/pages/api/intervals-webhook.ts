import type { APIRoute } from "astro";
import { getIntervalsConnectionByAthleteId } from "../../lib/db";
import {
  intervalsWebhookConfigured,
  runWebhookSyncs,
  webhookBodyIsObject,
  webhookSecretAuthorized,
} from "../../lib/intervals-webhook";
import { syncIntervalsForUser } from "../../lib/training";

export const prerender = false;

async function run(request: Request): Promise<Response> {
  if (!intervalsWebhookConfigured()) {
    console.warn("[intervals] INTERVALS_WEBHOOK_SECRET is not set");
    return new Response(JSON.stringify({ error: "INTERVALS_WEBHOOK_SECRET is not set" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.warn("[intervals] webhook invalid payload");
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!webhookBodyIsObject(body)) {
    console.warn("[intervals] webhook invalid payload");
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // The secret arrives in the JSON body (Intervals cookbook). Never logged.
  if (!webhookSecretAuthorized(body.secret)) {
    console.warn("[intervals] webhook unauthorized");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Lookup failures (unknown athletes) look exactly like ignored events: 200,
  // and logs never name athlete ids.
  const outcome = await runWebhookSyncs(body, (athleteId) => {
    const connection = getIntervalsConnectionByAthleteId(athleteId);
    return connection?.userId ?? null;
  }, syncIntervalsForUser);
  console.log(
    `[intervals] webhook status=${outcome.status} events=${outcome.body.synced ?? 0} imported=${outcome.body.imported ?? 0}`,
  );
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => run(request);