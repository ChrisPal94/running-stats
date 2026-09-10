import node from "@astrojs/node";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  adapter: node({
    mode: "standalone",
  }),
  security: {
    checkOrigin: true,
    // Trust X-Forwarded-Proto / X-Forwarded-Host from Railway (and similar
    // TLS-terminating proxies). Without this, Astro ignores those headers and
    // CSRF compares the browser HTTPS Origin to the internal `http://…` URL
    // (403 Cross-site POST form submissions are forbidden). CSRF still requires
    // Origin to match the reconstructed public origin — not an arbitrary site.
    allowedDomains: [{}],
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      // @tailwindcss/vite spreads resolve into createResolver(); Vite 8/rolldown
      // rejects configs that omit this field.
      tsconfigPaths: true,
    },
  },
});
