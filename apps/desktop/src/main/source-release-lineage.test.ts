// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBuildIdentity, readDesktopSourceDescription } from './create-app-build-identity';
import { BUILD_SOURCE_GIT_EXECUTABLE } from './build-source-fingerprint';

const roots: string[] = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'fixture-lineage-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync(BUILD_SOURCE_GIT_EXECUTABLE, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Version fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  const commit = (message: string) => {
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit('Initial source');
  return { root, git, commit };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identify(root: string, sha: string) {
  return createAppBuildIdentity({
    command: 'serve',
    mode: 'development',
    version: '0.9.3',
    sourceCommit: sha,
    sourceModified: false,
    sourceDescription: readDesktopSourceDescription(root, sha),
    releaseBuild: undefined,
    buildTag: undefined,
  });
}

describe('actual Git source release ancestry', () => {
  it('derives 0.9.8 from an annotated tag while package.json remains 0.9.3', () => {
    const { root, git, commit } = repo();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.9.3' }));
    git('add', 'package.json');
    commit('Package template');
    git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v0.9.8', '-m', 'Source release');
    const sha = commit('Feature work');
    expect(identify(root, sha)).toMatchObject({
      version: `0.9.8+dev.1.g${sha.slice(0, 12)}`,
      sourceReleaseVersion: '0.9.8',
    });
  });
  it('does not adopt a newer tag on another branch or a nightly tag', () => {
    const { root, git, commit } = repo();
    git('tag', 'v0.9.8');
    git('checkout', '-b', 'other');
    commit('Unrelated release');
    git('tag', 'v99.0.0');
    git('checkout', 'main');
    const sha = commit('Local work');
    git('tag', 'v0.9.9-nightly.20261006');
    expect(identify(root, sha).version).toBe(`0.9.8+dev.1.g${sha.slice(0, 12)}`);
  });
  it('does not adopt a release tag from a merged secondary parent', () => {
    const { root, git, commit } = repo();
    git('tag', 'v0.9.8');
    git('checkout', '-b', 'other');
    commit('Another release line');
    git('tag', 'v99.0.0');
    git('checkout', 'main');
    git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'other', '-m', 'Merge changes');
    const sha = git('rev-parse', 'HEAD');
    expect(identify(root, sha).version).toBe(`0.9.8+dev.1.g${sha.slice(0, 12)}`);
  });
  it('reports missing release lineage in a real shallow clone', () => {
    const { root, git, commit } = repo();
    git('tag', 'v0.9.8');
    const sha = commit('Beyond release');
    const shallow = mkdtempSync(join(tmpdir(), 'fixture-shallow-'));
    roots.push(shallow);
    execFileSync(
      BUILD_SOURCE_GIT_EXECUTABLE,
      ['clone', '--depth=1', '--no-tags', `file://${root}`, shallow],
      { stdio: 'pipe' }
    );
    expect(identify(shallow, sha)).toMatchObject({ version: null, sourceReleaseVersion: null });
  });
  it('keeps a local build distinguishable even at an exact release tag', () => {
    const { root, git } = repo();
    git('tag', 'v0.9.8');
    const sha = git('rev-parse', 'HEAD');
    expect(identify(root, sha)).toMatchObject({
      kind: 'development',
      version: `0.9.8+dev.0.g${sha.slice(0, 12)}`,
    });
  });
  it('uses explicit unknown version when tags are unavailable, not the package template', () => {
    const { root, git } = repo();
    expect(identify(root, git('rev-parse', 'HEAD'))).toMatchObject({
      version: null,
      sourceReleaseVersion: null,
    });
  });
  it('does not hide invalid repository errors as missing tag history', () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-not-git-'));
    roots.push(root);
    expect(() => readDesktopSourceDescription(root, 'a'.repeat(40))).toThrow();
  });
  it('rejects stale describe output from a different commit', () => {
    expect(() =>
      createAppBuildIdentity({
        command: 'serve',
        mode: 'development',
        version: '0.9.3',
        sourceCommit: 'a'.repeat(40),
        sourceModified: false,
        sourceDescription: `v0.9.8-1-g${'b'.repeat(40)}`,
        releaseBuild: undefined,
        buildTag: undefined,
      })
    ).toThrow('exact build commit');
  });
});
