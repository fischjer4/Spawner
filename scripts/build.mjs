import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: 'dist/main.cjs', external: ['electron', 'node:sqlite'], sourcemap: true });
await build({ entryPoints: ['src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload.cjs', external: ['electron'] });
await copyFile('renderer/index.html', 'dist/index.html');
