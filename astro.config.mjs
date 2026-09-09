import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      // @tailwindcss/vite spreads resolve into createResolver(); Vite 8/rolldown
      // rejects configs that omit this field.
      tsconfigPaths: true,
    },
  },
});
