import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/auth";
import { intervalsCsrfDeniedResponse } from "../../../lib/intervals";
import { clearIntervalsOAuthState, finishIntervalsOAuth } from "../../../lib/intervals-oauth";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const user = await getCurrentUser(cookies);
  if (!user) {
    clearIntervalsOAuthState(cookies);
    return redirect("/login");
  }
  try {
    const result = await finishIntervalsOAuth(request, cookies, user.id);
    if (result.kind === "connected") return redirect("/settings?toast=intervals-connected");
    if (result.kind === "cancelled") return redirect("/settings");
    if (result.kind === "csrf") return intervalsCsrfDeniedResponse();
    return redirect("/settings?toast=intervals-error");
  } catch {
    console.error("[intervals] oauth callback failed");
    clearIntervalsOAuthState(cookies);
    return redirect("/settings?toast=intervals-error");
  }
};
