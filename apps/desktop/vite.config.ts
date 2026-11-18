import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and does not want Vite to clear the terminal
// (it prints its own startup messages there).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Keep the dependency cache inside the project instead of node_modules:
  // sandboxed dev runs are not allowed to bulk-delete files there.
  cacheDir: ".vite-cache",
  server: {
    port: 1420,
    strictPort: true,
  },
});
