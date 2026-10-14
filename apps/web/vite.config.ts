import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { packageDirsOf, renderNotices } from '../../scripts/lib/third-party-notices.mjs';

/**
 * Emits dist/third-party-notices.txt: the licence texts of every npm package with code or assets in the build
 * (React, the router, icons, and the @fontsource fonts under the OFL). No dependency: it reads the bundle's module
 * ids and the original paths of emitted assets, then the packages' own licence files.
 */
function thirdPartyNotices(): Plugin {
  return {
    name: 'agentdrop-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = new Set<string>(this.getModuleIds());
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') for (const id of item.moduleIds) files.add(id);
        else for (const name of item.originalFileNames ?? []) files.add(name);
      }
      const dirs = packageDirsOf(files, import.meta.dirname);
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-notices.txt',
        source: renderNotices(dirs, { product: 'The AgentDrop dashboard' }),
      });
    },
  };
}

const api = process.env.VITE_API_URL ?? 'http://127.0.0.1:3210';

export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyNotices()],
  resolve: {
    alias: { '@agentdrop/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/v1': { target: api, changeOrigin: false },
      '/health': { target: api, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fonts ship as files: the CSP allows fonts from this origin only, so a small font inlined as a data: URL would
    // be blocked in production. Other small assets keep Vite's default inlining.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
