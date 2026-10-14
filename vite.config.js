import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const host = new URL(
  process.env.SHOPIFY_APP_URL || process.env.APP_URL || "http://localhost",
).hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host,
    port: Number(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host, ".trycloudflare.com"],
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  // Don't add @vitejs/plugin-react here: the React Router plugin already injects
  // React Refresh, and a second copy breaks client hydration.
  plugins: [reactRouter()],
  build: {
    assetsInlineLimit: 0,
  },
});
