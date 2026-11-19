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
  const inspectGuidance = (current: AdministrationOwner) =>
    current.execute({ operation: { kind: 'inspect-structure-guidance' } }, () => {});
  expect(await inspectGuidance(owner)).toEqual({
    kind: 'structure-guidance',
    guidance: {
      defaultVersion: 1,
      source: 'default',
      instructions: before.snapshot.values.molecularAgentInstructions,
    },
  });
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
  const relaunched = new AdministrationOwner(deps);
  const restored = await relaunched.execute(
    { operation: { kind: 'inspect-settings' } },
    () => {}
  );
  expect(restored).toMatchObject({
    kind: 'settings',
    snapshot: { values: patch, persistence: 'saved' },
  });
  expect(await inspectGuidance(relaunched)).toEqual({
    kind: 'structure-guidance',
    guidance: {
      defaultVersion: 1,
      source: 'override',
      instructions: patch.molecularAgentInstructions,
    },
  });
  if (restored.kind !== 'settings') throw Error('Missing restored settings');
  await relaunched.execute(
    {
      operation: {
        kind: 'update-settings',
        expectedRevision: restored.snapshot.revision,
        patch: { molecularAgentInstructions: '' },
      },
    },
    () => {}
  );
  expect(await inspectGuidance(new AdministrationOwner(deps))).toMatchObject({
    kind: 'structure-guidance',
    guidance: { source: 'override', instructions: '' },
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
