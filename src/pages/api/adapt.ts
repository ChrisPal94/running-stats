import type { APIRoute } from "astro";
import { adaptRequestAuthorized, runNocturnalAdaptation } from "../../lib/adapt";

export const prerender = false;

async function run(request: Request): Promise<Response> {
  if (!process.env.ADAPT_CRON_SECRET?.trim()) {
    return new Response(JSON.stringify({ error: "ADAPT_CRON_SECRET is not set" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (!adaptRequestAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await runNocturnalAdaptation();
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => run(request);
export const GET: APIRoute = async ({ request }) => run(request);
