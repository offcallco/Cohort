import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.COHORT_PORT ?? "7700";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
