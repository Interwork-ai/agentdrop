import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const webRequire = createRequire(resolve(repo, 'apps/web/package.json'));
const { build, createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const { default: tailwind } = await import(pathToFileURL(webRequire.resolve('@tailwindcss/vite')).href);
const config = {
  configFile: false,
  root: here,
  base: './',
  plugins: [react(), tailwind()],
  resolve: {
    alias: Object.fromEntries(
      [
        'react',
        'react-dom',
        'lucide-react',
        '@tanstack/react-query',
        'react-router',
        '@fontsource-variable/manrope',
        '@fontsource/ibm-plex-mono',
      ].map((name) => [name, resolve(repo, 'apps/web/node_modules', name)]),
    ),
    dedupe: ['react', 'react-dom', '@tanstack/react-query', 'react-router'],
  },
  build: { outDir: resolve(repo, 'tmp/readme-demo/site'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4391, strictPort: true, fs: { allow: [repo] } },
};
if (process.argv.includes('--serve')) {
  const server = await createServer(config);
  await server.listen();
  console.log('Demo preview: http://127.0.0.1:4391');
} else await build(config);
