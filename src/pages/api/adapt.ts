import type { APIRoute } from "astro";
import { adaptCronConfigured, adaptRunLogLine } from "../../lib/adapt-cron";
import { adaptRequestAuthorized, runNocturnalAdaptation } from "../../lib/adapt";

export const prerender = false;

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/api/adapt";
  }
}

async function run(request: Request): Promise<Response> {
  if (!adaptCronConfigured()) {
    console.warn("[adapt] ADAPT_CRON_SECRET is not set");
    return new Response(JSON.stringify({ error: "ADAPT_CRON_SECRET is not set" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (!adaptRequestAuthorized(request)) {
    console.warn(`[adapt] unauthorized ${request.method} ${requestPath(request)}`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await runNocturnalAdaptation();
  console.log(adaptRunLogLine(result));
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => run(request);
export const GET: APIRoute = async ({ request }) => run(request);
