import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planTags, releasablePackages, versionCommit } from './release-tags.mjs';

const script = new URL('./release-tags.mjs', import.meta.url).pathname;
const repos = [];

// CI runners have no git identity, and commits and annotated tags need one.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A throwaway git repository with a commit helper. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-tags-'));
  repos.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
  git('init', '--quiet', '--initial-branch=main');
  const write = (path, data) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(
      join(dir, path),
      typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '--message', message);
    return git('rev-parse', 'HEAD');
  };
  const pkg = (dirName, fields) => write(`packages/${dirName}/package.json`, fields);
  return { dir, git, write, commit, pkg };
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('releasablePackages', () => {
  it('lists public packages with a version, as name@version', () => {
    const r = repo();
    r.pkg('core', { name: '@kit/core', version: '0.2.0' });
    r.pkg('internal', { name: '@kit/internal', version: '1.0.0', private: true });
    r.pkg('fresh', { name: '@kit/fresh', version: '0.0.0' });
    expect(releasablePackages(r.dir)).toEqual([
      {
        name: '@kit/core',
        version: '0.2.0',
        manifest: 'packages/core/package.json',
        tag: '@kit/core@0.2.0',
      },
    ]);
  });

  it('uses v<version> for the root package of an app', () => {
    const r = repo();
    r.write('package.json', { name: 'server', version: '1.4.0', private: true });
    expect(releasablePackages(r.dir, { root: true })).toEqual([
      { name: 'server', version: '1.4.0', manifest: 'package.json', tag: 'v1.4.0' },
    ]);
  });
});

describe('versionCommit and planTags', () => {
  it('tags the commit that set each version, not the latest commit', () => {
    const r = repo();
    r.pkg('core', { name: '@kit/core', version: '0.1.0' });
    r.pkg('transport', { name: '@kit/transport', version: '0.1.0' });
    const initial = r.commit('initial');
    r.git('tag', '--annotate', 'v0.1.0', '--message', 'v0.1.0');
    r.write('packages/core/src.js', 'export {};');
    r.commit('feat(core): something');
    r.pkg('core', { name: '@kit/core', version: '0.2.0', description: 'changed later' });
    const release = r.commit('Version Packages');
    r.pkg('core', { name: '@kit/core', version: '0.2.0', description: 'changed again' });
    r.commit('docs: description');

    expect(versionCommit(r.dir, 'packages/core/package.json', '0.2.0')).toBe(release);
    expect(versionCommit(r.dir, 'packages/transport/package.json', '0.1.0')).toBe(initial);
    expect(planTags(r.dir, { since: 'v0.1.0' })).toEqual({
      create: [{ tag: '@kit/core@0.2.0', commit: release }],
      skipped: [{ tag: '@kit/transport@0.1.0', reason: 'released before v0.1.0' }],
    });
  });

  it('skips versions that already have their tag', () => {
    const r = repo();
    r.pkg('core', { name: '@kit/core', version: '0.3.0' });
    r.commit('release');
    r.git('tag', '@kit/core@0.3.0');
    expect(planTags(r.dir)).toEqual({
      create: [],
      skipped: [{ tag: '@kit/core@0.3.0', reason: 'already tagged' }],
    });
  });

  it('follows a version that went away and came back to the latest run only', () => {
    const r = repo();
    r.pkg('core', { name: '@kit/core', version: '1.0.0' });
    r.commit('one');
    r.pkg('core', { name: '@kit/core', version: '1.1.0-next.0' });
    r.commit('prerelease');
    r.pkg('core', { name: '@kit/core', version: '1.0.0' });
    const back = r.commit('revert the prerelease');
    expect(versionCommit(r.dir, 'packages/core/package.json', '1.0.0')).toBe(back);
  });
});

describe('the command', () => {
  const run = (dir, ...args) =>
    execFileSync('node', [join(dir, 'scripts/release-tags.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });

  it('creates annotated tags, and is a no-op the second time', () => {
    const r = repo();
    r.write('scripts/release-tags.mjs', readFileSync(script, 'utf8'));
    r.write('package.json', { name: 'server', version: '0.2.0', private: true });
    const release = r.commit('chore: release 0.2.0');

    expect(run(r.dir, '--root', '--dry-run')).toContain('would tag     v0.2.0');
    expect(r.git('tag', '--list')).toBe('');

    expect(run(r.dir, '--root')).toContain(`tag     v0.2.0 → ${release.slice(0, 7)}`);
    expect(r.git('cat-file', '-t', 'v0.2.0')).toBe('tag');
    expect(r.git('rev-list', '-n', '1', 'v0.2.0')).toBe(release);

    expect(run(r.dir, '--root')).toContain('No new versions to tag.');
  });

  it('fails clearly when --since does not exist', () => {
    const r = repo();
    r.write('scripts/release-tags.mjs', readFileSync(script, 'utf8'));
    r.commit('initial');
    expect(() => run(r.dir, '--since', 'v9.9.9')).toThrow(
      /--since v9.9.9 is not a commit or tag here/,
    );
  });
});
