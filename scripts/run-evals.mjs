import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (!env.AI_GATEWAY_API_KEY) {
  await build({ entryPoints: ['scripts/eval-credentials.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/eval-credentials.cjs', external: ['electron', 'node:sqlite'] });
  const credentials = await new Promise((res, reject) => {
    const reader = spawn(electron, ['dist/eval-credentials.cjs'], { env, stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
    let privateData = '';
    reader.stdio[3].on('data', chunk => { privateData += chunk.toString(); });
    reader.on('error', reject);
    reader.on('exit', code => {
      if (code !== 0) return reject(new Error('Saved credentials are unavailable.'));
      try { res(JSON.parse(privateData)); } catch { reject(new Error('Could not read the saved connection.')); }
    });
  });
  env.AI_GATEWAY_API_KEY = credentials.gateway;
  env.SPAWNER_EVAL_SETTINGS = JSON.stringify(credentials.settings);
}
await mkdir('evals/results', { recursive: true });
const args = process.argv.slice(2);
if (!args.length) args.push('run');
const child = spawn(process.execPath, [resolve('evals/node_modules/evalite/dist/bin.js'), ...args], { cwd: resolve('evals'), env, stdio: 'inherit' });
child.on('error', () => { console.error('Install eval dependencies with npm ci --prefix evals.'); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
