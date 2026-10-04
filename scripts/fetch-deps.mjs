#!/usr/bin/env node
// Makes the sibling Tessera repos available under external/ so `@tessera-kit/*` packages resolve
// through the `link:` overrides in package.json before they are published to npm.
//
//   node scripts/fetch-deps.mjs            local dev: symlink ../<name> when it exists
//   node scripts/fetch-deps.mjs --ci       always clone the ref from deps.json
//   node scripts/fetch-deps.mjs --no-build skip install + build
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const ci = args.has('--ci');
const build = !args.has('--no-build');
const deps = JSON.parse(readFileSync(join(root, 'deps.json'), 'utf8'));

const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
const rows = [];

mkdirSync(join(root, 'external'), { recursive: true });

for (const [name, dep] of Object.entries(deps)) {
  const target = join(root, 'external', name);
  const sibling = join(root, '..', name);
  let mode = 'existing';

  if (!existsSync(target)) {
    if (!ci && existsSync(sibling)) {
      symlinkSync(join('..', '..', name), target, 'dir');
      mode = 'symlink';
    } else {
      run('git', ['clone', '--depth', '1', '--branch', dep.ref, dep.url, target]);
      mode = 'clone';
    }
  }

  let built = false;
  if (build) {
    run('pnpm', ['--dir', target, 'install', '--frozen-lockfile']);
    for (const pkg of dep.packages) {
      // By directory, so it works whatever the packages are called at the pinned ref; "..." also
      // builds the workspace packages the selected one depends on.
      run('pnpm', ['--filter', `{./packages/${pkg}}...`, 'build'], target);
    }
    built = true;
  }
  rows.push({ name, mode, ref: dep.ref, built });
}

console.table(rows);
