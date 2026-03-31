import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require('../gitnexus/package.json');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __REQUIRED_NODE_VERSION__: JSON.stringify(gitnexusPkg.engines.node.replace(/[>=^~\s]/g, '')),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
      // Fix for Rollup failing to resolve this deep import from @langchain/anthropic
      '@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(
        __dirname,
        'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs',
      ),
      // Fix for mermaid d3-color prototype crash on Vercel (known issue with mermaid 10.9.0+ and Vite)
      mermaid: path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Proxy /api requests to the GitNexus backend server so the web UI
    // can auto-detect and connect to it at the same origin (no CORS issues,
    // no manual URL entry needed).
    proxy: {
      '/api': {
        target: 'http://localhost:4747',
        changeOrigin: true,
      },
    },
    // Allow serving files from node_modules
    fs: {
      allow: ['..'],
    },
  },
});
