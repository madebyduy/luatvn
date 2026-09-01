import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env["LUATVN_API_ORIGIN"] ?? "http://127.0.0.1:3000";

// The UI talks to the public REST boundary. The proxy keeps development on a
// single origin so no CORS policy has to be relaxed on the API.
export default defineConfig({
  build: { outDir: "dist", sourcemap: true },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/health": { target: apiTarget },
      "/ready": { target: apiTarget },
      "/v1": { target: apiTarget },
    },
  },
});
