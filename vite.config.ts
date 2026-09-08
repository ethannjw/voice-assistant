import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: process.env.VPP_E2E_HMR_PORT ? { port: Number(process.env.VPP_E2E_HMR_PORT) } : undefined,
    proxy: {
      "/api": "http://localhost:8787"
    }
  },
  build: {
    outDir: "dist/client"
  }
});
