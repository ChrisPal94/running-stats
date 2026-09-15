import type { APIRoute } from "astro";

export const prerender = false;

const body = JSON.stringify({ ok: true });
const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

/** Railway healthcheck. Unauthenticated; no SQLite reads or writes. */
export const GET: APIRoute = () =>
  new Response(body, {
    status: 200,
    headers,
  });

export const HEAD: APIRoute = () =>
  new Response(null, {
    status: 200,
    headers,
  });
