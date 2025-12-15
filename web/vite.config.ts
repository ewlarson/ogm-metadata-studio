import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// Vite config for a static React SPA suitable for GitHub Pages / Vercel.
export default defineConfig({
  plugins: [
    react(),
    // Plugin to set correct MIME type for WASM files
    {
      name: "wasm-mime-type",
      configureServer(server) {
        // Handle WASM files with correct MIME type
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.wasm')) {
            // Set the correct MIME type before any other processing
            res.setHeader('Content-Type', 'application/wasm');
            // Also set CORS headers if needed
            res.setHeader('Access-Control-Allow-Origin', '*');
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Ensure WASM files are handled correctly
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".wasm")) {
            return "assets/[name][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  base: "./",
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
    fs: {
      // Allow serving files from outside the project root
      allow: [".."],
    },
    // Ensure WASM files are served with correct MIME type
    middlewareMode: false,
  },
  // Configure public directory serving
  publicDir: "public",
});


