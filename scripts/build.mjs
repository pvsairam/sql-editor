// Zero-dependency build: compiles the extension host and the webview with tsc.
// Usage: node scripts/build.mjs [--watch] [--test]
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const haveVscodeTypes = existsSync(join(root, 'node_modules', '@types', 'vscode'));
const hostConfig = haveVscodeTypes ? 'tsconfig.json' : 'tsconfig.offline.json';
const args = new Set(process.argv.slice(2));

function tsc(project, extra = []) {
  const r = spawnSync(process.execPath, [tscBin, '-p', project, ...extra], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(tscBin)) {
  console.error('TypeScript not found. Run `npm install` first.');
  process.exit(1);
}
if (!haveVscodeTypes && !existsSync(join(root, 'typings', 'vscode.d.ts'))) {
  console.error('Neither @types/vscode nor typings/vscode.d.ts found. Run `npm install`.');
  process.exit(1);
}

if (args.has('--watch')) {
  for (const p of [hostConfig, 'webview/tsconfig.json']) {
    spawn(process.execPath, [tscBin, '-p', p, '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' });
  }
} else {
  rmSync(join(root, 'out'), { recursive: true, force: true });
  rmSync(join(root, 'media', 'webview'), { recursive: true, force: true });
  tsc(hostConfig);
  if (existsSync(join(root, 'webview', 'src')) && readdirSync(join(root, 'webview', 'src')).some((f) => f.endsWith('.ts'))) {
    tsc('webview/tsconfig.json');
  }
  console.log('build ok');
  if (args.has('--test')) {
    rmSync(join(root, '.test-out'), { recursive: true, force: true });
    tsc('tsconfig.test.json');
    mkdirSync(join(root, '.test-out'), { recursive: true });
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '.test-out/test/*.test.js'], { cwd: root, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
