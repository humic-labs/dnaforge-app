import { expect, it } from 'vitest';
import {
  assertInventoryActorScope,
  inventoryHasOrganizationAttribution,
} from './inventory-actor-scope';
import { inventoryPrincipalMatchesActor } from './inventory-attribution';
import {
  organizationCommands,
  organizationContext,
  organizationFixture,
  organizationTarget,
} from './inventory-organization.fixtures';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryState } from './inventory-validation';
const stockHold = {
  kind: 'reserve-quantity' as const,
  id: 'a',
  stockId: 'stock',
  quantity: { value: '1', unit: 'uL' as const },
  deadline: null,
  purpose: 'Use',
};
it('allows multiple member accounts and rejects active local or foreign-org actors', () => {
  let state = organizationCommands(organizationFixture(), [stockHold]);
  state = organizationCommands(state, [{ ...stockHold, id: 'b' }], 'bob');
  expect(() => assertInventoryActorScope(state, organizationTarget)).not.toThrow();
  expect(() => assertInventoryActorScope(state, { kind: 'project-local' })).toThrow();
  const foreign = {
    ...state,
    reservations: {
      ...state.reservations,
      a: {
        ...state.reservations.a,
        holder: { ...organizationContext().principal, orgId: 'elsewhere' },
      },
    },
  };
  expect(() => assertInventoryActorScope(foreign, organizationTarget)).toThrow();
  expect(
    applyInventoryCommandBatch(state, {
      expectedRevision: state.revision,
      commands: [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Local context',
        },
      ],
    })
  ).toMatchObject({ ok: false });
});
it('retains imported identity without making it current ownership or archive authority', () => {
  let state = organizationCommands(organizationFixture(), [stockHold]);
  const imported = {
    kind: 'imported' as const,
    source: {
      archiveSha256: `sha256:${'a'.repeat(64)}`,
      projectId: 'source',
      inventoryId: 'old',
      revision: state.revision,
    },
    principal: organizationContext().principal,
  };
  state = {
    ...state,
    reservations: { ...state.reservations, a: { ...state.reservations.a, holder: imported } },
  };
  expect(parseInventoryState(state)).toEqual(state);
  expect(() => assertInventoryActorScope(state, { kind: 'project-local' })).not.toThrow();
  expect(inventoryHasOrganizationAttribution(state)).toBe(true);
  expect(inventoryPrincipalMatchesActor(imported, organizationContext().principal)).toBe(false);
  expect(
    inventoryPrincipalMatchesActor(organizationContext().principal, {
      ...organizationContext().principal,
    })
  ).toBe(true);
  expect(
    inventoryPrincipalMatchesActor(
      organizationContext().principal,
      organizationContext('bob').principal
    )
  ).toBe(false);
  expect(
    inventoryPrincipalMatchesActor(organizationContext().principal, {
      kind: 'agent',
      identityId: 'alice',
    })
  ).toBe(false);
});
it('checks account authority target and current adoption actor separately', () => {
  const original = organizationCommands(organizationFixture(), [stockHold]);
  const state = {
    ...original,
    reservations: {
      ...original.reservations,
      a: {
        ...original.reservations.a,
        lifecycle: {
          kind: 'cancelled' as const,
          at: 100,
          reason: 'Historical explicit authority',
          authority: { ...organizationContext().authority, inventoryId: 'elsewhere' },
        },
      },
    },
  };
  expect(() => assertInventoryActorScope(state, organizationTarget)).toThrow();
  const adopted = {
    ...organizationFixture(),
    origin: {
      kind: 'archive-adoption' as const,
      source: {
        archiveSha256: `sha256:${'a'.repeat(64)}`,
        projectId: 'source',
        inventoryId: 'old',
        revision: 1,
      },
      at: 100,
      by: { kind: 'local-profile' as const, profileKey: 'local' },
    },
  };
  expect(() => assertInventoryActorScope(adopted, organizationTarget)).toThrow();
});
