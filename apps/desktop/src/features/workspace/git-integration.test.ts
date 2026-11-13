// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer };
    if (e.stderr?.toString().includes('does not have any commits')) return '';
    throw err;
  }
}

const SAMPLE_GENBANK = `LOCUS       pTest                   20 bp    DNA     circular
DEFINITION  Test plasmid.
FEATURES             Location/Qualifiers
     CDS             5..15
                     /label="TestGene"
ORIGIN
        1 atcgatcgat cgatcgatcg
//
`;

const EDITED_GENBANK = `LOCUS       pTest                   23 bp    DNA     circular
DEFINITION  Test plasmid.
FEATURES             Location/Qualifiers
     CDS             5..18
                     /label="TestGene"
ORIGIN
        1 atcgatcgat cccgatcgat cga
//
`;

describe('Git integration (real repo)', () => {
  let repoDir: string;
  let filePath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'waypoint-git-test-'));
    git('init', repoDir);
    git('config user.email "test@test.com"', repoDir);
    git('config user.name "Test"', repoDir);

    filePath = join(repoDir, 'test.gb');
    writeFileSync(filePath, SAMPLE_GENBANK);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('gitRepoRoot: finds repo root from file path', () => {
    const root = git('rev-parse --show-toplevel', repoDir);
    const normalize = (p: string) => p.replace(/^\/private/, '');
    expect(normalize(root)).toBe(normalize(repoDir));
  });

  it('gitFileLog: returns empty for untracked file', () => {
    const log = git('log --format=%H --follow -20 -- test.gb', repoDir).trim();
    expect(log).toBe('');
  });

  it('gitFileLog: returns empty for staged-but-uncommitted file', () => {
    git('add test.gb', repoDir);
    const log = git('log --format=%H --follow -20 -- test.gb', repoDir).trim();
    expect(log).toBe('');
  });

  it('auto-commit baseline: gitCommitFile creates first commit for staged file', () => {
    git('add test.gb', repoDir);

    git('add -- test.gb', repoDir);
    git('commit -m "Initial version" -- test.gb', repoDir);

    const log = git('log --format=%H --follow -20 -- test.gb', repoDir).trim();
    expect(log).not.toBe('');
    const commitCount = log.split('\n').filter(Boolean).length;
    expect(commitCount).toBe(1);
  });

  it('after baseline commit, edits produce a diff', () => {
    git('add test.gb', repoDir);
    git('commit -m "Initial version" -- test.gb', repoDir);

    writeFileSync(filePath, EDITED_GENBANK);

    const status = git('status --short -- test.gb', repoDir);
    expect(status).toContain('M');

    const diff = git('diff -- test.gb', repoDir);
    expect(diff).toContain('ccc');
  });

  it('gitShowCommit: retrieves file content at a specific commit', () => {
    git('add test.gb', repoDir);
    git('commit -m "Initial version" -- test.gb', repoDir);
    const hash = git('log --format=%H -1 -- test.gb', repoDir);

    writeFileSync(filePath, EDITED_GENBANK);

    const relPath = git('ls-files --full-name -- test.gb', repoDir);
    const content = git(`show ${hash}:${relPath}`, repoDir);
    expect(content).toContain('atcgatcgat cgatcgatcg');
    expect(content).not.toContain('ccc');
  });

  it('gitRevertFile: reverts to index (staged version)', () => {
    git('add test.gb', repoDir);

    writeFileSync(filePath, EDITED_GENBANK);

    expect(readFileSync(filePath, 'utf-8')).toContain('ccc');

    git('checkout -- test.gb', repoDir);

    const reverted = readFileSync(filePath, 'utf-8');
    expect(reverted).toContain('atcgatcgat cgatcgatcg');
    expect(reverted).not.toContain('ccc');
  });

  it('gitRevertFile: reverts to HEAD after commit', () => {
    git('add test.gb', repoDir);
    git('commit -m "Initial version" -- test.gb', repoDir);

    writeFileSync(filePath, EDITED_GENBANK);
    expect(readFileSync(filePath, 'utf-8')).toContain('ccc');

    git('checkout -- test.gb', repoDir);

    const reverted = readFileSync(filePath, 'utf-8');
    expect(reverted).not.toContain('ccc');
  });

  it('full workflow: baseline → edit → commit → diff against baseline', () => {
    git('add test.gb', repoDir);
    git('commit -m "Initial version" -- test.gb', repoDir);
    const baselineHash = git('log --format=%H -1 -- test.gb', repoDir);

    writeFileSync(filePath, EDITED_GENBANK);

    git('add -- test.gb', repoDir);
    git('commit -m "Added insertion" -- test.gb', repoDir);
    const editHash = git('log --format=%H -1 -- test.gb', repoDir);

    expect(editHash).not.toBe(baselineHash);

    const relPath = git('ls-files --full-name -- test.gb', repoDir);
    const baselineContent = git(`show ${baselineHash}:${relPath}`, repoDir);
    const editContent = git(`show ${editHash}:${relPath}`, repoDir);

    expect(baselineContent).toContain('atcgatcgat cgatcgatcg');
    expect(baselineContent).not.toContain('ccc');
    expect(editContent).toContain('ccc');

    const log = git('log --format=%H --follow -20 -- test.gb', repoDir);
    expect(log.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
