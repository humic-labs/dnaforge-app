import { describe, expect, it } from 'vitest';

import type { ProviderObjectReference } from '../../shared/provider-object-reference';
import {
  resolveProviderReference,
  type ProviderBindingCandidate,
} from './provider-reference-resolver';

const INTENDED_TARGET = 'seq_DemoSeq004';
const COLLISION_TWIN = 'seq_DEMOSQ0004';

const DESTINATION = 'ws-destination';
const OTHER_WORKSPACE = 'ws-other';

function sequenceReference(
  overrides: Partial<ProviderObjectReference> = {}
): ProviderObjectReference {
  return {
    provider: 'benchling',
    stableObjectId: INTENDED_TARGET,
    objectClass: 'sequence',
    canonicalUrl: null,
    providerAccountHint: null,
    ...overrides,
  };
}

function binding(overrides: Partial<ProviderBindingCandidate> = {}): ProviderBindingCandidate {
  return {
    entityId: 'entity-intended',
    objectClass: 'sequence',
    bindingKind: 'observed',
    scope: 'workspace',
    workspaceId: DESTINATION,
    providerAccountHint: null,
    ...overrides,
  };
}

describe('resolveProviderReference — exact stable ID', () => {
  it('resolves when exactly one allowed candidate carries the exact stable ID', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding()],
      })
    ).toEqual({
      status: 'resolved',
      entityId: 'entity-intended',
      scope: 'workspace',
      evidence: 'stable_id',
    });
  });

  it('stays pending when the only candidate lives outside the allowed scopes', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding({ entityId: 'entity-hidden', workspaceId: 'ws-trashed' })],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('prefers the destination workspace over another allowed workspace', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION, OTHER_WORKSPACE],
        candidates: [
          binding({ entityId: 'entity-elsewhere', workspaceId: OTHER_WORKSPACE }),
          binding({ entityId: 'entity-local', workspaceId: DESTINATION }),
        ],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-local' });
  });

  it('reuses an exact entity in another mounted workspace when the destination has none', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION, OTHER_WORKSPACE],
        candidates: [binding({ entityId: 'entity-elsewhere', workspaceId: OTHER_WORKSPACE })],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-elsewhere', scope: 'workspace' });
  });

  it('resolves a single visible registry candidate', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        allowedRegistryEntityIds: ['registry-entity'],
        candidates: [
          binding({ entityId: 'registry-entity', scope: 'registry', workspaceId: null }),
        ],
      })
    ).toEqual({
      status: 'resolved',
      entityId: 'registry-entity',
      scope: 'registry',
      evidence: 'stable_id',
    });
  });

  it('ignores a registry candidate the user cannot currently see', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        allowedRegistryEntityIds: [],
        candidates: [
          binding({ entityId: 'registry-entity', scope: 'registry', workspaceId: null }),
        ],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });
});

describe('resolveProviderReference — deduplication and ambiguity', () => {
  it('deduplicates repeated rows for the same entity instead of reading them as ambiguity', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding(), binding(), binding()],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
  });

  it('is ambiguous when two distinct allowed entities claim the same stable ID', () => {
    const result = resolveProviderReference({
      reference: sequenceReference(),
      allowedWorkspaceIds: [OTHER_WORKSPACE, 'ws-third'],
      candidates: [
        binding({ entityId: 'entity-b', workspaceId: 'ws-third' }),
        binding({ entityId: 'entity-a', workspaceId: OTHER_WORKSPACE }),
      ],
    });
    expect(result).toEqual({
      status: 'ambiguous',
      candidateEntityIds: ['entity-a', 'entity-b'],
      reason: 'multiple_exact_candidates',
    });
  });

  it('never resolves by row order when candidates are ambiguous', () => {
    const forward = resolveProviderReference({
      reference: sequenceReference(),
      allowedWorkspaceIds: [OTHER_WORKSPACE, 'ws-third'],
      candidates: [
        binding({ entityId: 'entity-a', workspaceId: OTHER_WORKSPACE }),
        binding({ entityId: 'entity-b', workspaceId: 'ws-third' }),
      ],
    });
    const reversed = resolveProviderReference({
      reference: sequenceReference(),
      allowedWorkspaceIds: [OTHER_WORKSPACE, 'ws-third'],
      candidates: [
        binding({ entityId: 'entity-b', workspaceId: 'ws-third' }),
        binding({ entityId: 'entity-a', workspaceId: OTHER_WORKSPACE }),
      ],
    });
    expect(forward).toEqual(reversed);
    expect(forward.status).toBe('ambiguous');
  });

  it('reports a scientific-content conflict as a conflict, not as a missing import', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding({ corroborationConflict: true })],
      })
    ).toEqual({
      status: 'ambiguous',
      candidateEntityIds: ['entity-intended'],
      reason: 'identity_conflict',
    });
  });
});

describe('resolveProviderReference — the collision twin', () => {
  it('does not resolve the intended target to the twin, which shares its name and bytes', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference({ stableObjectId: INTENDED_TARGET }),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('resolves each twin to its own entity when both are present', () => {
    const intended = resolveProviderReference({
      reference: sequenceReference({ stableObjectId: INTENDED_TARGET }),
      destinationWorkspaceId: DESTINATION,
      allowedWorkspaceIds: [DESTINATION],
      candidates: [binding({ entityId: 'entity-intended' })],
    });
    const twin = resolveProviderReference({
      reference: sequenceReference({ stableObjectId: COLLISION_TWIN }),
      destinationWorkspaceId: DESTINATION,
      allowedWorkspaceIds: [DESTINATION],
      candidates: [binding({ entityId: 'entity-twin' })],
    });
    expect(intended).toMatchObject({ entityId: 'entity-intended' });
    expect(twin).toMatchObject({ entityId: 'entity-twin' });
  });
});

describe('resolveProviderReference — identity absent or incompatible', () => {
  it('is review-required when the export carried no stable identity at all', () => {
    expect(
      resolveProviderReference({
        reference: null,
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding()],
      })
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it('is review-required when the stored identity is not an exact ID', () => {
    expect(
      resolveProviderReference({
        reference: { ...sequenceReference(), stableObjectId: 'seq_x' },
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding()],
      })
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it('never resolves across object classes', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference({ objectClass: 'notebook' }),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding({ objectClass: 'sequence' })],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });
});

describe('resolveProviderReference — reviewed mappings', () => {
  it('lets a reviewed mapping break a tie the stable ID alone cannot', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        allowedWorkspaceIds: [OTHER_WORKSPACE, 'ws-third'],
        candidates: [
          binding({ entityId: 'entity-a', workspaceId: OTHER_WORKSPACE }),
          binding({ entityId: 'entity-b', workspaceId: 'ws-third', bindingKind: 'reviewed' }),
        ],
      })
    ).toEqual({
      status: 'resolved',
      entityId: 'entity-b',
      scope: 'workspace',
      evidence: 'reviewed_mapping',
    });
  });

  it('refuses a reviewed mapping that points outside the allowed scopes', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        allowedWorkspaceIds: [DESTINATION],
        candidates: [
          binding({
            entityId: 'entity-hidden',
            workspaceId: 'ws-trashed',
            bindingKind: 'reviewed',
          }),
        ],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('reports reviewed evidence when the single match was reviewed', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding({ bindingKind: 'reviewed' })],
      })
    ).toMatchObject({ evidence: 'reviewed_mapping' });
  });
});

describe('resolveProviderReference — account hints', () => {
  it('narrows to a matching account hint when the stable ID alone is ambiguous', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference({ providerAccountHint: 'examplelab' }),
        allowedWorkspaceIds: [OTHER_WORKSPACE, 'ws-third'],
        candidates: [
          binding({
            entityId: 'entity-a',
            workspaceId: OTHER_WORKSPACE,
            providerAccountHint: 'pnciaccia',
          }),
          binding({
            entityId: 'entity-b',
            workspaceId: 'ws-third',
            providerAccountHint: 'examplelab',
          }),
        ],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-b' });
  });

  it('does not require a hint to match, because exported targets often carry none', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference({ providerAccountHint: 'examplelab' }),
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding({ providerAccountHint: null })],
      })
    ).toMatchObject({ status: 'resolved' });
  });
});

describe('resolveProviderReference — source dispositions pass through', () => {
  it('preserves an external reference with its safe URL', () => {
    expect(
      resolveProviderReference({
        reference: null,
        disposition: 'external',
        sourceUrl: 'https://benchling.com/exampleowner/f/lib_x/ent_DemoEnt1-person/edit',
      })
    ).toEqual({
      status: 'external',
      sourceUrl: 'https://benchling.com/exampleowner/f/lib_x/ent_DemoEnt1-person/edit',
    });
  });

  it('preserves a source-broken reference and its reason', () => {
    expect(
      resolveProviderReference({
        reference: null,
        disposition: 'source_broken',
        brokenReason: 'The export recorded a broken link.',
      })
    ).toEqual({ status: 'source_broken', reason: 'The export recorded a broken link.' });
  });

  it('keeps source-broken ahead of any local candidate', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        disposition: 'source_broken',
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding()],
      })
    ).toMatchObject({ status: 'source_broken' });
  });

  it('keeps external ahead of any local candidate', () => {
    expect(
      resolveProviderReference({
        reference: sequenceReference(),
        disposition: 'external',
        sourceUrl: 'https://benchling.com/x/y',
        destinationWorkspaceId: DESTINATION,
        allowedWorkspaceIds: [DESTINATION],
        candidates: [binding()],
      })
    ).toMatchObject({ status: 'external' });
  });

  it('is review-required for an external reference with no safe URL to open', () => {
    expect(
      resolveProviderReference({ reference: null, disposition: 'external', sourceUrl: null })
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it.each([
    ['a script URL', 'javascript:alert(1)'],
    ['an inline data URL', 'data:text/html,<script>alert(1)</script>'],
    ['an insecure Benchling URL', 'http://benchling.com/entry/etr_123456'],
    ['a credential-bearing URL', 'https://user:password@benchling.com/entry/etr_123456'],
    ['a lookalike host', 'https://benchling.com.attacker.example/entry/etr_123456'],
  ])('refuses %s from a hand-edited external reference', (_label, sourceUrl) => {
    expect(
      resolveProviderReference({ reference: null, disposition: 'external', sourceUrl })
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it('gives a source-broken reference a default reason rather than an empty string', () => {
    expect(
      resolveProviderReference({
        reference: null,
        disposition: 'source_broken',
        brokenReason: '  ',
      })
    ).toMatchObject({ status: 'source_broken', reason: expect.stringMatching(/broken/i) });
  });
});
