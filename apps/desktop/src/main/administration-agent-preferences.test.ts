// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { AdministrationOwner, type AdministrationOwnerDependencies } from './administration-owner';
import {
  administrationSettingsPatchSchema,
  type AdministrationSettings,
} from '../shared/administration';

it('retains editable agent guidance across owners and rejects a stale preference overwrite', async () => {
  let saved: Partial<AdministrationSettings> = {};
  const deps: AdministrationOwnerDependencies = {
    storage: {
      readSettings: () => structuredClone(saved),
      writeSettings: (values, keys) => {
        saved = { ...saved, ...Object.fromEntries(keys.map((key) => [key, values[key]])) };
      },
      readAction: () => null,
      writeAction: () => {},
    },
    account: async () => null,
    prepareShare: vi.fn(),
    publishShare: vi.fn(),
    migration: async () => null,
    actOnMigration: vi.fn(),
    requestApproval: vi.fn(),
    beginHandoff: vi.fn(),
    observeHandoff: vi.fn(),
  };
  const owner = new AdministrationOwner(deps);
  const before = await owner.execute({ operation: { kind: 'inspect-settings' } }, () => {});
  if (before.kind !== 'settings') throw Error('Missing settings');
  const patch = {
    molecularAgentInstructions: 'Overview plus evidence detail.',
    rememberedAgentPreferences: 'Keep RNA purple.',
  };
  const changed = await owner.execute(
    {
      operation: {
        kind: 'update-settings',
        expectedRevision: before.snapshot.revision,
        patch,
      },
    },
    () => {}
  );
  expect(changed.kind).toBe('settings');
  expect(saved).toMatchObject(patch);
  const stale = await owner.execute(
    {
      operation: {
        kind: 'update-settings',
        expectedRevision: before.snapshot.revision,
        patch: { rememberedAgentPreferences: 'An outdated competing preference.' },
      },
    },
    () => {}
  );
  expect(stale).toMatchObject({ kind: 'failed', code: 'STALE_ADMINISTRATION_SETTINGS' });
  const restored = await new AdministrationOwner(deps).execute(
    { operation: { kind: 'inspect-settings' } },
    () => {}
  );
  expect(restored).toMatchObject({
    kind: 'settings',
    snapshot: { values: patch, persistence: 'saved' },
  });
  expect(deps.requestApproval).not.toHaveBeenCalled();
});

it('bounds remembered instructions and permits explicit clearing', () => {
  expect(
    administrationSettingsPatchSchema.safeParse({ rememberedAgentPreferences: '' }).success
  ).toBe(true);
  expect(
    administrationSettingsPatchSchema.safeParse({ rememberedAgentPreferences: 'x'.repeat(16_001) })
      .success
  ).toBe(false);
});
