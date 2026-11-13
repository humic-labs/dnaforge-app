/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveProviderReference } = vi.hoisted(() => ({
  mockResolveProviderReference: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    benchlingMigration: { resolveProviderReference: mockResolveProviderReference },
  }),
}));

import {
  dispatchOpenExactCatalogEntity,
  resolveImportedProviderReferenceDestination,
} from './native-entity-links';
import { claimReferenceIntent, type ReferenceIntent } from '../entity-ref/reference-workflow';

const INPUT = {
  stableObjectId: 'seq_DemoSeq1',
  objectClass: 'sequence' as const,
  href: 'https://benchling.com/examplelab/f/lib_DemoLib1-registry/seq_DemoSeq1-pdemo666/edit',
  label: 'pDEMO666',
  owningRoot: '/lab/caspian',
};

beforeEach(() => {
  mockResolveProviderReference.mockReset();
});

describe('exact catalog entity dispatch', () => {
  it('preserves the selected catalog id and owning workspace in the open event', () => {
    const listener = vi.fn();
    window.addEventListener('waypoint:open-entity', listener);

    expect(
      dispatchOpenExactCatalogEntity({
        entityId: 'repo-beta::puc19',
        label: 'pUC19',
        owningRoot: '/ws/beta',
      })
    ).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          entityType: 'native-catalog-exact',
          entityId: 'repo-beta::puc19',
          label: 'pUC19',
          owningRoot: '/ws/beta',
        },
      })
    );

    window.removeEventListener('waypoint:open-entity', listener);
  });
});

describe('acknowledged exact catalog opens', () => {
  it('reports an absent owning handler as refusal, not a completed open', () => {
    const onResult = vi.fn();
    expect(
      dispatchOpenExactCatalogEntity({
        entityId: 'repo::page',
        label: 'Private',
        owningRoot: '/private/root',
        onResult,
      })
    ).toBe(false);
    expect(onResult).toHaveBeenCalledWith({ kind: 'failure', reason: 'handler_unavailable' });
  });

  it('waits for the claiming owner and settles its callback at most once', () => {
    const onResult = vi.fn();
    let acknowledge: ReferenceIntent | undefined;
    const listener = (event: Event) => {
      acknowledge = claimReferenceIntent(event) ?? undefined;
    };
    window.addEventListener('waypoint:open-entity', listener);
    try {
      expect(
        dispatchOpenExactCatalogEntity({
          entityId: 'repo::page',
          label: 'Private',
          owningRoot: '/private/root',
          onResult,
        })
      ).toBe(true);
      expect(onResult).not.toHaveBeenCalled();
      expect(acknowledge?.finish).toBeTypeOf('function');
      const outcome = {
        kind: 'document',
        result: {
          status: 'presented',
          tabId: 'page',
          panelId: 'main',
          tabType: 'page',
          disposition: 'created',
          content: 'ready',
        },
      } satisfies Parameters<ReferenceIntent['finish']>[0];
      acknowledge?.finish(outcome);
      acknowledge?.finish(outcome);
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith(outcome);
    } finally {
      window.removeEventListener('waypoint:open-entity', listener);
    }
  });
});

describe('imported provider reference destination', () => {
  it('returns the native destination when the workspace holds the exact object', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: {
        status: 'resolved',
        entityId: 'caspian::sequence-pdemo666',
        scope: 'workspace',
        evidence: 'stable_id',
      },
      target: null,
    });

    await expect(resolveImportedProviderReferenceDestination(INPUT)).resolves.toEqual({
      kind: 'native',
      detail: {
        entityId: 'caspian::sequence-pdemo666',
        label: 'pDEMO666',
        owningRoot: '/lab/caspian',
      },
    });
  });

  it('returns Benchling when the exact object is not imported', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });

    await expect(resolveImportedProviderReferenceDestination(INPUT)).resolves.toEqual({
      kind: 'benchling',
      url: INPUT.href,
    });
  });

  it('returns Benchling without IPC when the notebook has no owning workspace', async () => {
    await expect(
      resolveImportedProviderReferenceDestination({ ...INPUT, owningRoot: null })
    ).resolves.toEqual({ kind: 'benchling', url: INPUT.href });
    expect(mockResolveProviderReference).not.toHaveBeenCalled();
  });

  it('refuses to present an unsafe fallback as a Benchling destination', async () => {
    mockResolveProviderReference.mockRejectedValue(new Error('offline'));

    await expect(
      resolveImportedProviderReferenceDestination({
        ...INPUT,
        href: 'https://example.com/not-benchling',
      })
    ).resolves.toEqual({ kind: 'none' });
  });

  it('matches click behavior by falling back to a safe Benchling URL after an IPC error', async () => {
    mockResolveProviderReference.mockRejectedValue(new Error('offline'));

    await expect(resolveImportedProviderReferenceDestination(INPUT)).resolves.toEqual({
      kind: 'benchling',
      url: INPUT.href,
    });
  });
});
