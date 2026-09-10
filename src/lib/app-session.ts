import type { AstroCookies } from "astro";
import { getCurrentUser, type AuthUser } from "./auth";
import { getPlanForUser, type Plan } from "./training";

export type AppSession =
  | { ok: true; user: AuthUser; plan: Plan }
  | { ok: false; redirect: string };

export async function requireAppSession(cookies: AstroCookies): Promise<AppSession> {
  const user = await getCurrentUser(cookies);
  if (!user) return { ok: false, redirect: "/login" };
  const plan = await getPlanForUser(user.id);
  if (!plan) return { ok: false, redirect: "/onboarding" };
  return { ok: true, user, plan };
}

export async function postAuthPath(userId: string): Promise<"/today" | "/onboarding"> {
  const plan = await getPlanForUser(userId);
  return plan ? "/today" : "/onboarding";
}

export function userInitial(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  const letter = local.charAt(0);
  return letter ? letter.toUpperCase() : "?";
}
