import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { chatReachInstructions, prepareChatReach } from '../chat-reach';

describe('prepareChatReach', () => {
  let root: string;
  let caseNumber = 0;
  let base: string;
  let appData: string;
  let chatFilesRoot: string;
  let scratchRoot: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'chat-reach-')));
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    caseNumber += 1;
    base = join(root, `case-${caseNumber}`);
    appData = join(base, 'appdata');
    scratchRoot = join(appData, 'cli-scratch');
    chatFilesRoot = join(scratchRoot, 'chats');
    projectA = join(appData, 'managed-workspaces', 'aaaa', 'repo');
    projectB = join(base, 'home', 'External data');
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
  });

  const prepare = (conversationId: string, roots: Array<{ path: string; name: string }>) =>
    prepareChatReach({
      chatFilesRoot,
      conversationId,
      roots,
      allowedRoots: [appData, join(base, 'home')],
      appDataDir: appData,
      scratchRoot,
    });

  it('reuses one folder per conversation and grants every admitted project', async () => {
    const first = await prepare('conv-1', [
      { path: projectA, name: 'My Project' },
      { path: projectB, name: 'External data' },
    ]);
    const second = await prepare('conv-1', [{ path: projectA, name: 'My Project' }]);

    expect(first.cwd).toBe(join(chatFilesRoot, 'conv-1'));
    expect(second.cwd).toBe(first.cwd);
    expect(first.writableRoots).toEqual([projectA, projectB]);
    expect(second.writableRoots).toEqual([projectA]);
    expect(await readlink(join(first.cwd, 'My Project'))).toBe(projectA);
    await expect(lstat(join(first.cwd, 'External data'))).rejects.toThrow();
  });

  it('refuses chat folders, the app data folder itself, outside paths and duplicates', async () => {
    const otherChat = join(chatFilesRoot, 'other');
    const outside = join(root, `outside-${caseNumber}`);
    await mkdir(otherChat, { recursive: true });
    await mkdir(outside, { recursive: true });
    {
      const reach = await prepare('conv-2', [
        { path: projectA, name: 'My Project' },
        { path: projectA, name: 'Duplicate' },
        { path: otherChat, name: 'Other chat' },
        { path: appData, name: 'App data' },
        { path: base, name: 'Everything' },
        { path: outside, name: 'Outside' },
        { path: join(base, 'missing'), name: 'Missing' },
        { path: 'relative/path', name: 'Relative' },
      ]);
      expect(reach.writableRoots).toEqual([projectA]);
      expect(reach.shortcuts.map((shortcut) => shortcut.name)).toEqual(['My Project']);
    }
  });

  it('follows renames, numbers duplicate names and never touches files the agent made', async () => {
    const first = await prepare('conv-3', [{ path: projectA, name: 'My Project' }]);
    await writeFile(join(first.cwd, 'Renamed'), 'agent output');
    await symlink(projectB, join(first.cwd, 'agent-link'));

    const renamed = await prepare('conv-3', [
      { path: projectA, name: 'Renamed' },
      { path: projectB, name: 'Renamed' },
    ]);

    expect(renamed.shortcuts).toEqual([
      { name: 'Renamed (2)', path: projectA },
      { name: 'Renamed (3)', path: projectB },
    ]);
    await expect(lstat(join(first.cwd, 'My Project'))).rejects.toThrow();
    expect((await lstat(join(first.cwd, 'Renamed'))).isFile()).toBe(true);
    expect(await readlink(join(first.cwd, 'agent-link'))).toBe(projectB);
    expect(await readlink(join(first.cwd, 'Renamed (2)'))).toBe(projectA);
  });

  it('cleans unsafe characters out of shortcut names', async () => {
    const reach = await prepare('conv-4', [{ path: projectA, name: '../Omnii / tracks:\u0007' }]);
    expect(reach.shortcuts[0]?.name).toBe('Omnii tracks');
  });

  it('rejects conversation identifiers that could escape the chat folder', async () => {
    await expect(prepare('../escape', [])).rejects.toThrow('chat folder identifier');
    await expect(prepare('..', [])).rejects.toThrow('chat folder identifier');
  });

  it('describes the folder and project shortcuts to the agent', async () => {
    const reach = await prepare('conv-5', [{ path: projectA, name: 'My Project' }]);
    const text = chatReachInstructions(reach);
    expect(text).toContain(reach.cwd);
    expect(text).toContain('`My Project/`');
    expect(text).toContain('/analyses/');
    expect(text).not.toContain('managed-workspaces');

    const empty = chatReachInstructions({ ...reach, shortcuts: [], writableRoots: [] });
    expect(empty).toContain('No projects are available');
  });
});
