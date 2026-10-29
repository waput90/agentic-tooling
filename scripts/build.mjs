import { build } from 'esbuild';
await build({
  entryPoints: ['electron/main.ts', 'electron/backend.ts', 'electron/copilot-worker.ts'],
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
