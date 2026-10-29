import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
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
await build({
  entryPoints: ['electron/confirmation-preload.ts'],
  outfile: 'dist-electron/confirmation-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await copyFile('electron/confirmation.html', 'dist-electron/confirmation.html');
