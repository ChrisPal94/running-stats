import type { APIRoute } from "astro";
import { adaptCronConfigured } from "../../lib/adapt-cron";

export const prerender = false;

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

/** True when `INTERVALS_WEBHOOK_SECRET` is set and non-empty after trim. Never returns the secret. */
function intervalsWebhookConfigured(): boolean {
  return Boolean(process.env.INTERVALS_WEBHOOK_SECRET?.trim());
}

function healthBody(): string {
  return JSON.stringify({
    ok: true,
    adaptCronConfigured: adaptCronConfigured(),
    intervalsWebhookConfigured: intervalsWebhookConfigured(),
  });
}

/** Railway healthcheck. Unauthenticated; no SQLite reads or writes. Never returns secrets. */
export const GET: APIRoute = () =>
  new Response(healthBody(), {
    status: 200,
    headers,
  });

export const HEAD: APIRoute = () =>
  new Response(null, {
    status: 200,
    headers,
  });
