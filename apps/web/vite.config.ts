import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  // The processed pixel-art assets are served as static files (e.g. /characters/char_manager.png).
  publicDir: fileURLToPath(new URL("../../assets/game", import.meta.url)),
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": server,
      "/socket.io": { target: server, ws: true },
    },
  },
});
