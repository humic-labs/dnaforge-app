// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  parseOrganizationRegistryRecordDetailsRequest,
  parseOrganizationRegistryClaimPreparationRequest,
  parseOrganizationRegistryClaimRequest,
  parseOrganizationRegistryConfigurationRequest,
  parseOrganizationRegistryMutationRequest,
  parseOrganizationRegistryConflictResolutionRequest,
} from './org-registry-sync';

const MUTATION_ID = '51000000-0000-0000-0000-000000000001';

describe('organization Registry IPC input', () => {
  it('requires the displayed access generation and accepts no renderer-supplied record authority', () => {
    const request = {
      entityId: '10000000-0000-4000-8000-000000000001',
      expectedAccessGeneration: 'home-v1:reviewed-scope',
    };
    expect(
      parseOrganizationRegistryRecordDetailsRequest({
        ...request,
        accountId: 'renderer-account',
        entity: { fields: { forged: true } },
        homeWorkspaceId: 'renderer-home',
      })
    ).toEqual(request);
    for (const expectedAccessGeneration of [null, '', ' scope ', 'x'.repeat(257)]) {
      expect(() =>
        parseOrganizationRegistryRecordDetailsRequest({
          ...request,
          expectedAccessGeneration,
        })
      ).toThrow('expectedAccessGeneration');
    }
    expect(() =>
      parseOrganizationRegistryRecordDetailsRequest({
        ...request,
        entityId: 'display-name',
      })
    ).toThrow('entityId');
  });
  it('accepts only reviewed source identity and strips renderer-supplied authority', () => {
    const request = {
      entityId: '10000000-0000-4000-8000-000000000001',
      schemaId: '20000000-0000-4000-8000-000000000001',
      schemaRevisionId: '30000000-0000-4000-8000-000000000001',
      mutationId: MUTATION_ID,
      sourceRevision: 'a'.repeat(64),
    };
    expect(
      parseOrganizationRegistryClaimRequest({
        ...request,
        payload: { id: 'different-id', homeWorkspaceId: 'unverified' },
      })
    ).toEqual(request);
    expect(() =>
      parseOrganizationRegistryClaimPreparationRequest({
        ...request,
        entityId: 'historical-unresolved-identity',
      })
    ).toThrow('entityId');
    expect(() =>
      parseOrganizationRegistryClaimRequest({
        ...request,
        sourceRevision: '',
      })
    ).toThrow('sourceRevision');
  });
  it('accepts bounded Registry configuration and mutation requests', () => {
    expect(
      parseOrganizationRegistryConfigurationRequest({
        defaultPrefix: 'SMITH',
        defaultPadWidth: 6,
        schemes: [{ entityKind: 'strain', prefix: 'STR', padWidth: 5 }],
      })
    ).toEqual({
      defaultPrefix: 'SMITH',
      defaultPadWidth: 6,
      schemes: [{ entityKind: 'strain', prefix: 'STR', padWidth: 5 }],
    });

    expect(
      parseOrganizationRegistryMutationRequest({
        mutationId: MUTATION_ID,
        operation: 'placement.add',
        payload: { entityId: 'entity-1', workspaceId: 'workspace-1', path: '/samples/1' },
      })
    ).toEqual({
      mutationId: MUTATION_ID,
      operation: 'placement.add',
      payload: { entityId: 'entity-1', workspaceId: 'workspace-1', path: '/samples/1' },
    });
  });

  it('rejects unknown operations, invalid identifiers, and oversized or malformed configuration', () => {
    expect(() =>
      parseOrganizationRegistryMutationRequest({
        mutationId: 'not-a-uuid',
        operation: 'entity.delete',
        payload: {},
      })
    ).toThrow('mutationId');
    expect(() =>
      parseOrganizationRegistryMutationRequest({
        mutationId: MUTATION_ID,
        operation: 'entity.delete',
        payload: {},
      })
    ).toThrow('operation');
    expect(() =>
      parseOrganizationRegistryConfigurationRequest({
        defaultPrefix: 'lowercase',
        defaultPadWidth: 200,
        schemes: [],
      })
    ).toThrow('defaultPrefix');
    expect(() =>
      parseOrganizationRegistryConfigurationRequest({
        defaultPrefix: 'VALID',
        defaultPadWidth: 1,
        schemes: [],
      })
    ).toThrow('from 2 through 12');
  });

  it('accepts only explicit local-conflict outcomes', () => {
    expect(
      parseOrganizationRegistryConflictResolutionRequest({
        conflictId: '61000000-0000-0000-0000-000000000001',
        resolution: 'use_remote',
      })
    ).toEqual({
      conflictId: '61000000-0000-0000-0000-000000000001',
      resolution: 'use_remote',
    });
    expect(() =>
      parseOrganizationRegistryConflictResolutionRequest({
        conflictId: '61000000-0000-0000-0000-000000000001',
        resolution: 'merge_silently',
      })
    ).toThrow('resolution');
  });
});
