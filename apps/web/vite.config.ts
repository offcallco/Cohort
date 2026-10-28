import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = `http://127.0.0.1:${process.env.COHORT_PORT ?? "7700"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      // Git smart HTTP, so clone URLs copied from the dev UI work too.
      "^/[^/]+/[^/]+/(info/refs|git-upload-pack|git-receive-pack)": server,
    },
  },
});
