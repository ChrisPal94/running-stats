import type { APIRoute } from "astro";
import { postAuthPath } from "../../../lib/app-session";
import { getCurrentUser } from "../../../lib/auth";
import { startGoogleOAuth } from "../../../lib/google-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const existing = await getCurrentUser(cookies);
  if (existing) {
    return redirect(await postAuthPath(existing.id));
  }

  const { location } = startGoogleOAuth(request, cookies);
  return redirect(location);
};
