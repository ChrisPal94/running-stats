/**
 * Public request origin behind TLS-terminating reverse proxies (Railway, etc.).
 *
 * `request.url` can be the internal `http://…` address while the browser
 * `Origin` is the public HTTPS host. CSRF checks must use the public origin.
 */

function firstForwarded(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first || undefined;
}

function sanitizeHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  if (/[/\\\s]/.test(host) || host.includes("://")) return undefined;
  return host;
}

function forwardedProto(request: Request): string | undefined {
  const proto = firstForwarded(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  return proto === "http" || proto === "https" ? proto : undefined;
}

function originFrom(protocol: string, host: string): string | undefined {
  const href = `${protocol}://${host}`;
  if (!URL.canParse(href)) return undefined;
  return new URL(href).origin;
}

/**
 * Astro production build flag. `isProductionRuntime` calls this so a test can
 * stand in for a built server when `NODE_ENV` is unset.
 */
export const astroBuild = {
  isProd(): boolean {
    const env = import.meta.env as { PROD?: unknown } | undefined;
    return env?.PROD === true;
  },
};

/**
 * Production is `NODE_ENV=production`, or a built server (`import.meta.env.PROD`)
 * when `NODE_ENV` is neither development nor test.
 */
export function isProductionRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production") return true;
  if (nodeEnv === "development" || nodeEnv === "test") return false;
  return astroBuild.isProd();
}

/**
 * Configured public site origin (`PUBLIC_ORIGIN`, then Astro `site`).
 * Does not read `Host` or `X-Forwarded-Host`. Returns the origin only.
 */
export function configuredPublicOrigin(): string | null {
  const site = (import.meta.env as { SITE?: unknown } | undefined)?.SITE;
  const candidates = [process.env.PUBLIC_ORIGIN?.trim() ?? "", typeof site === "string" ? site.trim() : ""];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Origin for emailed links and OAuth `redirect_uri`. Uses `PUBLIC_ORIGIN`
 * (then Astro `site`). Production without that origin fails closed (`null`).
 * Dev falls back to the request origin, which may be localhost.
 */
export function requestPublicOrigin(request: Request): string | null {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  if (isProductionRuntime()) return null;
  return publicOrigin(request);
}

/** Canonical public origin (`https://host`) for this request. */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    sanitizeHost(firstForwarded(request.headers.get("x-forwarded-host"))) ||
    sanitizeHost(request.headers.get("host") ?? undefined) ||
    url.host;
  const protocol = forwardedProto(request) || url.protocol.replace(/:$/, "");
  return originFrom(protocol, host) ?? url.origin;
}

function headerOrigin(request: Request): string | undefined {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null" && URL.canParse(origin)) {
    return new URL(origin).origin;
  }

  const referer = request.headers.get("referer");
  if (!referer || !URL.canParse(referer)) return undefined;
  return new URL(referer).origin;
}

/**
 * Same-origin CSRF check using the public origin, not the internal `request.url`.
 * Missing Origin/Referer is allowed (non-browser clients). A present Origin or
 * Referer must match `publicOrigin(request)` exactly.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = headerOrigin(request);
  if (!origin) return true;
  return origin === publicOrigin(request);
}
