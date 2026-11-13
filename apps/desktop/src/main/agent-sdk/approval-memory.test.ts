import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createApprovalMemory, createJsonAlwaysAllowStore } from './approval-memory';

const root = mkdtempSync(join(tmpdir(), 'approval-memory-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('approval memory', () => {
  const rule = { key: 'command:blastn', label: 'blastn commands' };

  it('keeps "this chat" answers to that chat and ignores once, deny and stop', () => {
    const memory = createApprovalMemory({ load: () => [], save: () => undefined });
    for (const choice of ['once', 'deny', 'stop'] as const) memory.remember(choice, 'a', rule);
    expect(memory.allows('a', rule.key)).toBe(false);
    memory.remember('chat', 'a', rule);
    expect(memory.allows('a', rule.key)).toBe(true);
    expect(memory.allows('b', rule.key)).toBe(false);
    expect(memory.allows(null, rule.key)).toBe(false);
  });

  it('saves "always" answers for every chat and survives a restart', () => {
    const file = join(root, 'always.json');
    createApprovalMemory(createJsonAlwaysAllowStore(file), () => 7).remember('always', 'a', rule);
    const reopened = createApprovalMemory(createJsonAlwaysAllowStore(file));
    expect(reopened.allows('another-chat', rule.key)).toBe(true);
    expect(reopened.alwaysRules()).toEqual([
      {
        ...rule,
        enabled: true,
        createdAt: 7,
        catalogMessage: { key: 'approval.commandScope', values: { programs: 'blastn' } },
      },
    ]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('ignores a damaged list and a switched-off rule', () => {
    const memory = createApprovalMemory({
      load: () => [{ ...rule, enabled: false, createdAt: 1 }],
      save: () => undefined,
    });
    expect(memory.allows('a', rule.key)).toBe(false);
    expect(createJsonAlwaysAllowStore(join(root, 'missing.json')).load()).toEqual([]);
  });
});
