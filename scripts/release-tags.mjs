// Creates the git tags for released versions, so nobody has to tag by hand.
//
//   node scripts/release-tags.mjs [--since <ref>] [--push] [--dry-run]
//       one tag per public package in packages/*: `<name>@<version>`, the format changesets uses
//   node scripts/release-tags.mjs --root [--since <ref>] [--push] [--dry-run]
//       one tag for the repository's own package.json: `v<version>` (an app such as tessera-server)
//
// Each tag goes on the commit that set the version (for a changesets release, the merged
// "Version Packages" commit), not on whatever commit the workflow happens to run for. A version
// that already has its tag is skipped, so the script can run on every push to main. Versions set
// at or before `--since` (the last tag made by hand) are left alone, and so is 0.0.0.
// Tags are annotated, like the existing v0.1.0. `--push` pushes the new ones to origin.
//
// This file is copied verbatim into the kit repositories and tessera-server. Change it here first.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Runs git in `cwd` and returns its trimmed output. */
function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function gitOk(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * The packages that get tags: `packages/*` minus private ones (default), or the repository's
 * own package.json (`root`).
 *
 * @returns {{ name: string, version: string, manifest: string, tag: string }[]}
 */
export function releasablePackages(repo, { root = false } = {}) {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  if (root) {
    const pkg = read(join(repo, 'package.json'));
    return pkg.version
      ? [{ name: pkg.name, version: pkg.version, manifest: 'package.json', tag: `v${pkg.version}` }]
      : [];
  }
  const dir = join(repo, 'packages');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = read(path);
    if (pkg.private || !pkg.name || !pkg.version || pkg.version === '0.0.0') continue;
    out.push({
      name: pkg.name,
      version: pkg.version,
      manifest: relative(repo, path).split('\\').join('/'),
      tag: `${pkg.name}@${pkg.version}`,
    });
  }
  return out;
}

/**
 * The commit that set the current version: walking back through the commits that touched the
 * manifest, the oldest one in the unbroken run that still has this version.
 */
export function versionCommit(repo, manifest, version) {
  const commits = git(repo, ['log', '--format=%H', 'HEAD', '--', manifest])
    .split('\n')
    .filter(Boolean);
  let found;
  for (const commit of commits) {
    let at;
    try {
      at = JSON.parse(git(repo, ['show', `${commit}:${manifest}`])).version;
    } catch {
      break;
    }
    if (at !== version) break;
    found = commit;
  }
  return found;
}

/**
 * Works out which tags to create.
 *
 * @returns {{ create: { tag: string, commit: string }[], skipped: { tag: string, reason: string }[] }}
 */
export function planTags(repo, { root = false, since } = {}) {
  const create = [];
  const skipped = [];
  for (const pkg of releasablePackages(repo, { root })) {
    if (gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${pkg.tag}`])) {
      skipped.push({ tag: pkg.tag, reason: 'already tagged' });
      continue;
    }
    const commit = versionCommit(repo, pkg.manifest, pkg.version);
    if (!commit) {
      skipped.push({ tag: pkg.tag, reason: 'no commit sets this version' });
      continue;
    }
    if (since && gitOk(repo, ['merge-base', '--is-ancestor', commit, since])) {
      skipped.push({ tag: pkg.tag, reason: `released before ${since}` });
      continue;
    }
    create.push({ tag: pkg.tag, commit });
  }
  return { create, skipped };
}

function main(argv) {
  const args = new Set(argv.filter((a) => a.startsWith('--')));
  const sinceAt = argv.indexOf('--since');
  const since = sinceAt === -1 ? undefined : argv[sinceAt + 1];
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dryRun = args.has('--dry-run');

  if (since && !gitOk(repo, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`])) {
    throw new Error(
      `--since ${since} is not a commit or tag here; fetch tags first (git fetch --tags)`,
    );
  }
  const { create, skipped } = planTags(repo, { root: args.has('--root'), since });
  for (const { tag, reason } of skipped) console.log(`skip    ${tag} (${reason})`);
  if (create.length === 0) {
    console.log('No new versions to tag.');
    return;
  }
  for (const { tag, commit } of create) {
    console.log(`${dryRun ? 'would tag' : 'tag'}     ${tag} → ${commit.slice(0, 7)}`);
    if (!dryRun) git(repo, ['tag', '--annotate', tag, commit, '--message', tag]);
  }
  if (args.has('--push') && !dryRun) {
    git(repo, ['push', 'origin', ...create.map(({ tag }) => `refs/tags/${tag}`)], {
      stdio: 'inherit',
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
