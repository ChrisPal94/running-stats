import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/auth";
import { startGoogleOAuth } from "../../../lib/google-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const existing = await getCurrentUser(cookies);
  if (existing) {
    return redirect("/today");
  }

  const { location } = startGoogleOAuth(request, cookies);
  return redirect(location);
};
