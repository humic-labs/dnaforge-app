import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyShellCommand, classifyToolCall } from './tool-permission-policy';

describe('classifyToolCall', () => {
  let root: string;
  let scratchRoot: string;
  let sessionScratch: string;
  let userRoot: string;
  let managedRoot: string;
  let userRoots: string[];

  const existingUserFile = () => join(userRoot, 'design.gb');
  const existingManagedFile = () => join(managedRoot, 'notebook.md');
  const existingScratchFile = () => join(sessionScratch, 'work.txt');

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fixture-policy-'));
    scratchRoot = join(root, 'cli-scratch');
    sessionScratch = join(scratchRoot, 'session-abc');
    userRoot = join(root, 'mounted-workspace');
    managedRoot = join(root, 'managed-workspaces', 'repo-uuid');
    mkdirSync(sessionScratch, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(existingUserFile(), 'ORIGIN AAAA');
    writeFileSync(existingManagedFile(), '# notes');
    writeFileSync(existingScratchFile(), 'scratch');
    userRoots = [userRoot, managedRoot];
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const base = () => ({ cwd: sessionScratch, userRoots, scratchRoot });

  it.each([
    'Read',
    'Grep',
    'Glob',
    'LS',
    'WebFetch',
    'WebSearch',
    'TodoWrite',
    'mcp__dnaforge__get_workspace',
  ])('allows read-only / app-mediated tool %s', (toolName) => {
    expect(
      classifyToolCall({ ...base(), toolName, input: { file_path: existingUserFile() } })
    ).toBe('allow');
  });

  it('allows a NEW-file Write anywhere (creation is not destructive)', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: join(userRoot, 'brand-new.gb') },
      })
    ).toBe('allow');
  });

  it('allows Write to the agent scratch dir (its own working files)', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: join(sessionScratch, 'out.txt') },
      })
    ).toBe('allow');
  });

  it('CONFIRMS a structured write outside every user and scratch root', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: join(root, 'outside', 'new.txt') },
      })
    ).toBe('confirm-destructive-user-file');
  });

  it('allows overwriting an EXISTING file inside scratch (agent manages its own scratch)', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: existingScratchFile() },
      })
    ).toBe('allow');
  });

  it('CONFIRMS overwriting an EXISTING file under a mounted user root', () => {
    expect(
      classifyToolCall({ ...base(), toolName: 'Write', input: { file_path: existingUserFile() } })
    ).toBe('confirm-destructive-user-file');
  });

  it('CONFIRMS overwriting under the MANAGED-COPY container (managed copy is a user data root, NOT scratch)', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: existingManagedFile() },
      })
    ).toBe('confirm-destructive-user-file');
  });

  it.each(['Edit', 'MultiEdit', 'NotebookEdit'])(
    'CONFIRMS %s of an existing user file',
    (toolName) => {
      const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      expect(classifyToolCall({ ...base(), toolName, input: { [key]: existingUserFile() } })).toBe(
        'confirm-destructive-user-file'
      );
    }
  );

  it.each(['Move', 'Delete'])(
    'CONFIRMS %s of an existing user path and allows the same operation in scratch',
    (toolName) => {
      const userInput =
        toolName === 'Move'
          ? { source_path: existingUserFile(), destination_path: join(userRoot, 'moved.gb') }
          : { path: existingUserFile() };
      const scratchInput =
        toolName === 'Move'
          ? {
              source_path: existingScratchFile(),
              destination_path: join(sessionScratch, 'moved.txt'),
            }
          : { path: existingScratchFile() };

      expect(classifyToolCall({ ...base(), toolName, input: userInput })).toBe(
        'confirm-destructive-user-file'
      );
      expect(classifyToolCall({ ...base(), toolName, input: scratchInput })).toBe('allow');
    }
  );

  it.each(['Move', 'Delete'])('CONFIRMS %s outside every known root', (toolName) => {
    const outside = join(root, 'outside', 'file.txt');
    const input =
      toolName === 'Move'
        ? { source_path: outside, destination_path: `${outside}.moved` }
        : { path: outside };
    expect(classifyToolCall({ ...base(), toolName, input })).toBe('confirm-destructive-user-file');
  });

  it('CONFIRMS a write to the SECOND mounted root (proves userRoots is enumerated, not just cwd)', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Write',
        input: { file_path: existingManagedFile() },
      })
    ).toBe('confirm-destructive-user-file');
  });

  it('CONFIRMS a symlink-escape: target lexically under scratch but realpaths to a user file', () => {
    const escape = join(sessionScratch, 'escape.gb');
    symlinkSync(existingUserFile(), escape);
    expect(classifyToolCall({ ...base(), toolName: 'Write', input: { file_path: escape } })).toBe(
      'confirm-destructive-user-file'
    );
  });

  it('CONFIRMS a ".." traversal that escapes scratch into a user root', () => {
    const traversed = join(sessionScratch, '..', '..', 'mounted-workspace', 'design.gb');
    expect(
      classifyToolCall({ ...base(), toolName: 'Write', input: { file_path: traversed } })
    ).toBe('confirm-destructive-user-file');
  });

  it('classifies by canonical path across /var vs /private/var (macOS) via realpath', () => {
    const canon = realpathSync(existingScratchFile());
    expect(classifyToolCall({ ...base(), toolName: 'Edit', input: { file_path: canon } })).toBe(
      'allow'
    );
  });

  it.each([
    'curl -s https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nuccore',
    'ls -la',
    'grep -R "origin" .',
    'cat README.md',
    'rg --files | head -20',
  ])('classifies a proven read-only command honestly: %s', (command) => {
    expect(classifyShellCommand(command)).toMatchObject({
      risk: 'read-only',
      operation: 'Run read-only shell command',
    });
  });

  it.each([
    'rm -rf build',
    'truncate -s0 design.gb',
    'sed -i "" s/a/b/ design.gb',
    'sed -i.bak s/a/b/ design.gb',
    'sed --in-place=.bak s/a/b/ design.gb',
    'perl -pi.bak -e s/a/b/ design.gb',
    'dd if=/dev/null of=design.gb',
    'printf changed > design.gb',
    'curl -s https://example.test/design.gb -o design.gb',
    'curl -s https://example.test/design.gb -odesign.gb',
    'git reset --hard HEAD~1',
    'git branch -D unmerged-work',
    'find . -name "*.tmp" -delete',
  ])('classifies a destructive or overwrite-capable command honestly: %s', (command) => {
    expect(classifyShellCommand(command)).toMatchObject({ risk: 'destructive' });
  });

  it.each(['mkdir build', 'touch new-file.txt', 'npm install'])(
    'does not call ordinary mutation destructive: %s',
    (command) => {
      expect(classifyShellCommand(command).risk).not.toBe('destructive');
    }
  );

  it.each([
    "jq 'select(.score > 10)' data.json",
    "rg 'a>b' README.md",
    'ls missing 2>&1 | head -20',
  ])('does not mistake quoted comparisons or fd duplication for overwrite: %s', (command) => {
    expect(classifyShellCommand(command).risk).not.toBe('destructive');
  });

  it.each(['find . -name "*.txt"', 'find lab -type f | head -20'])(
    'keeps ordinary find listing read-only: %s',
    (command) => {
      expect(classifyShellCommand(command).risk).toBe('read-only');
    }
  );

  it.each([
    'find . -exec ./writer.sh {} \\;',
    'find . -execdir /tmp/writer.sh {} +',
    'find . -ok ./writer.sh {} \\;',
  ])("does not inherit find's read-only label for nested program launch: %s", (command) => {
    expect(classifyShellCommand(command).risk).toBe('unknown');
  });

  it('requires confirmation for nested find -exec under destructive-only supervision', () => {
    expect(
      classifyToolCall({
        ...base(),
        toolName: 'Bash',
        shellSupervision: 'destructive-only',
        input: { command: 'find . -exec ./writer.sh {} \\;' },
      })
    ).toBe('confirm-shell-command');
  });

  it.each([
    ['auto', 'curl -s https://example.test', 'allow'],
    ['auto', 'rm -rf build', 'allow'],
    ['destructive-only', 'curl -s https://example.test', 'allow'],
    ['destructive-only', 'ls -la && cat README.md', 'allow'],
    ['destructive-only', 'rm -rf build', 'confirm-shell-command'],
    ['destructive-only', 'printf changed > design.gb', 'confirm-shell-command'],
    ['destructive-only', 'dnaforge-test-wrapper --opaque-mode', 'confirm-shell-command'],
    ['always', 'curl -s https://example.test', 'confirm-shell-command'],
    ['always', 'rm -rf build', 'confirm-shell-command'],
  ] as const)(
    '%s supervision classifies `%s` as %s for Bash and ProcessStart',
    (shellSupervision, command, expected) => {
      for (const toolName of ['Bash', 'ProcessStart']) {
        expect(
          classifyToolCall({
            toolName,
            cwd: userRoot,
            userRoots,
            scratchRoot,
            shellSupervision,
            input: { command },
          })
        ).toBe(expected);
      }
    }
  );

  it.each([
    ['blastp -query in.fa -db proteins', false, 'allow'],
    ['rm -rf build', false, 'confirm-shell-command'],
    ['curl -s https://example.test', true, 'confirm-shell-command'],
  ] as const)(
    'sandboxed Auto mode classifies `%s` (unsandboxed: %s) as %s',
    (command, dangerouslyDisableSandbox, expected) => {
      expect(
        classifyToolCall({
          toolName: 'Bash',
          cwd: userRoot,
          userRoots,
          scratchRoot,
          shellSupervision: 'destructive-only',
          commandSandbox: true,
          input: { command, ...(dangerouslyDisableSandbox ? { dangerouslyDisableSandbox } : {}) },
        })
      ).toBe(expected);
    }
  );

  it('asks before every structured write in Ask mode, including new files', () => {
    for (const file_path of [join(userRoot, 'new.txt'), join(sessionScratch, 'new.txt')]) {
      expect(
        classifyToolCall({
          ...base(),
          toolName: 'Write',
          askBeforeWrites: true,
          input: { file_path, content: 'x' },
        })
      ).toBe('confirm-destructive-user-file');
    }
  });

  it('CONFIRMS a structured write with no resolvable path (fail-safe on ambiguity)', () => {
    expect(classifyToolCall({ ...base(), toolName: 'Write', input: {} })).toBe(
      'confirm-destructive-user-file'
    );
  });
});
