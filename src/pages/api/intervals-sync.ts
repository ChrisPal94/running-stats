import type { APIRoute } from "astro";
import { adaptRequestAuthorized } from "../../lib/adapt";
import { adaptCronConfigured } from "../../lib/adapt-cron";
import { syncAllIntervalsUsers } from "../../lib/intervals-sync-all";

export const prerender = false;

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/api/intervals-sync";
  }
}

async function run(request: Request): Promise<Response> {
  if (!adaptCronConfigured()) {
    console.warn("[intervals-sync] ADAPT_CRON_SECRET is not set");
    return new Response(JSON.stringify({ error: "ADAPT_CRON_SECRET is not set" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (!adaptRequestAuthorized(request)) {
    console.warn(`[intervals-sync] unauthorized ${request.method} ${requestPath(request)}`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Per-account failures are isolated inside the bulk runner; 500 means the
  // runner itself threw before the loop.
  try {
    const result = await syncAllIntervalsUsers();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    console.error("[intervals-sync] bulk sync crashed before the per-user loop");
    return new Response(JSON.stringify({ ok: false, error: "Intervals bulk sync failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

export const POST: APIRoute = async ({ request }) => run(request);
export const GET: APIRoute = async ({ request }) => run(request);