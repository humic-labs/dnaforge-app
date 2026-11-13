import { describe, expect, it } from 'vitest';
import { createMigrationRendererReadiness } from './renderer-readiness';

describe('migration renderer readiness', () => {
  it('waits for the installed validator rather than treating startup as failed validation', async () => {
    const owner = {};
    const gate = createMigrationRendererReadiness(() => owner);
    let completed = false;
    const wait = gate.wait(1000).then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.setReady(owner, true);
    expect(await wait).toBe(owner);
    expect(await gate.wait(1000)).toBe(owner);
  });

  it('does not accept another renderer or a readiness flag from the previous navigation', async () => {
    let owner = {};
    const oldOwner = owner;
    const gate = createMigrationRendererReadiness(() => owner);
    gate.setReady({}, true);
    await expect(gate.wait(1)).rejects.toThrow(/ready/);
    gate.setReady(owner, true);
    gate.setReady(owner, false);
    await expect(gate.wait(1)).rejects.toThrow(/ready/);
    gate.setReady(owner, true);
    owner = {};
    await expect(gate.wait(1)).rejects.toThrow(/ready/);
    gate.setReady(oldOwner, true);
    await expect(gate.wait(1)).rejects.toThrow(/ready/);
    gate.setReady(owner, true);
    expect(await gate.wait(1000)).toBe(owner);
  });
});
