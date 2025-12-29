/// <reference types="vitest" />
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
      "Cross-Origin-Embedder-Policy": "credentialless",
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
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    css: true,
    alias: {
      // Force source map generation for coverage
    },
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/vite-env.d.ts',
        'src/main.tsx',
        'src/App.tsx',
        'coverage/**',
        'dist/**',
        '**/[.]**',
        'packages/*/test?(s)/**',
        '**/*.d.ts',
        '**/virtual:*',
        '**/__x00__*',
        '**/\x00*',
        'cypress/**',
        'test?(s)/**',
        'test?(-*).?(c|m)[jt]s?(x)',
        '**/*{.,-}{test,spec}.?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/vitest.{workspace,projects}.[jt]s?(on)',
        '**/.{eslint,mocha,prettier}rc.{?(c|m)js,yml}'
      ],
    },
  },
} as any);



