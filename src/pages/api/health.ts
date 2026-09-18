import type { APIRoute } from "astro";
import { adaptCronConfigured } from "../../lib/adapt-cron";

export const prerender = false;

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

function healthBody(): string {
  return JSON.stringify({
    ok: true,
    adaptCronConfigured: adaptCronConfigured(),
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
