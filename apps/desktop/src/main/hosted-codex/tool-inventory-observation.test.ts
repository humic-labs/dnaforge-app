import { describe, expect, it } from 'vitest';
import {
  copyHostedToolInventoryObservation,
  observeHostedToolInventory,
  copyHostedToolInventorySummary,
  readHostedToolInventorySummary,
  type HostedToolInventoryCounts,
} from './tool-inventory-observation';

const counts: HostedToolInventoryCounts = {
  projectionSequence: 0,
  authorizationCatalogDefinitionCount: 300,
  registeredChildDefinitionCount: 17,
  childOfferedDefinitionCount: 17,
  gatewayBaseDefinitionCount: 16,
  gatewayForwardedDefinitionCount: 24,
  retainedDefinitionCount: 8,
  maxRetainedDefinitionCount: 8,
  acceptedDiscoveryPageCount: 1,
  lastAcceptedDiscoveryPageDefinitionCount: 8,
  maxAcceptedDiscoveryPageDefinitionCount: 8,
};

describe('content-free Hosted tool inventory observations', () => {
  it('copies numeric facts and local binding only, without capping the full authorization catalog at128', () => {
    const unsafe = {
      ...counts,
      prompt: 'PRIVATE PROMPT',
      arguments: { token: 'PRIVATE TOKEN' },
      schema: { description: 'PRIVATE SCHEMA' },
      requestSequence: 999,
      status: 'invalid',
    };
    const observation = observeHostedToolInventory(7, unsafe);
    expect(observation).toEqual({ ...counts, status: 'observed', requestSequence: 7 });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE');
    expect(copyHostedToolInventoryObservation({ ...observation, input: 'PRIVATE' })).toEqual(
      observation
    );
  });
  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    'PRIVATE CONTENT',
    null,
    undefined,
  ])('retains invalid numeric observations as content-free invalid status: %s', (value) => {
    const observed = copyHostedToolInventoryObservation({
      ...counts,
      status: 'observed',
      requestSequence: 0,
      retainedDefinitionCount: value,
    });
    expect(observed).toEqual({ status: 'invalid' });
    expect(JSON.stringify(observed)).not.toContain('PRIVATE');
  });
  it('preserves explicit incomplete and invalid states without guessed zero counts', () => {
    expect(copyHostedToolInventoryObservation({ status: 'incomplete', prompt: 'PRIVATE' })).toEqual(
      { status: 'incomplete' }
    );
    expect(copyHostedToolInventoryObservation({ status: 'invalid', prompt: 'PRIVATE' })).toEqual({
      status: 'invalid',
    });
    expect(copyHostedToolInventoryObservation({ status: 'observed', requestSequence: 0 })).toEqual({
      status: 'invalid',
    });
  });
  it.each([...Object.keys(counts), 'requestSequence'])(
    'validates the request count field %s before constructing typed output',
    (field) => {
      expect(
        copyHostedToolInventoryObservation({
          ...counts,
          status: 'observed',
          requestSequence: 0,
          [field]: -1,
        })
      ).toEqual({ status: 'invalid' });
    }
  );
  it('does not normalize a measured over-limit count into a passing bound', () => {
    expect(observeHostedToolInventory(0, { ...counts, retainedDefinitionCount: 33 })).toMatchObject(
      {
        status: 'observed',
        retainedDefinitionCount: 33,
      }
    );
  });
  it('copies final producer totals without carrying transient definitions or content', () => {
    const summary = copyHostedToolInventorySummary({
      ...counts,
      status: 'observed',
      projectionCount: 2,
      prompt: 'PRIVATE',
      tools: ['PRIVATE TOOL NAME'],
    });
    expect(summary).toEqual({
      status: 'observed',
      projectionCount: 2,
      authorizationCatalogDefinitionCount: 300,
      registeredChildDefinitionCount: 17,
      retainedDefinitionCount: 8,
      maxRetainedDefinitionCount: 8,
      acceptedDiscoveryPageCount: 1,
      lastAcceptedDiscoveryPageDefinitionCount: 8,
      maxAcceptedDiscoveryPageDefinitionCount: 8,
    });
    expect(copyHostedToolInventorySummary({ status: 'observed', projectionCount: 2 })).toEqual({
      status: 'invalid',
    });
    expect(copyHostedToolInventorySummary({ status: 'incomplete' })).toEqual({
      status: 'incomplete',
    });
  });
  it('isolates missing and throwing final producer reads without guessed zeros or private errors', () => {
    expect(readHostedToolInventorySummary(() => undefined)).toEqual({ status: 'incomplete' });
    expect(
      readHostedToolInventorySummary(() => {
        throw new Error('PRIVATE FAILURE');
      })
    ).toEqual({ status: 'invalid' });
  });
  it.each([
    'projectionCount',
    'authorizationCatalogDefinitionCount',
    'registeredChildDefinitionCount',
    'retainedDefinitionCount',
    'maxRetainedDefinitionCount',
    'acceptedDiscoveryPageCount',
    'lastAcceptedDiscoveryPageDefinitionCount',
    'maxAcceptedDiscoveryPageDefinitionCount',
  ])('validates the summary count field %s before constructing typed output', (field) => {
    for (const invalid of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      'PRIVATE',
      null,
      undefined,
    ]) {
      expect(
        copyHostedToolInventorySummary({
          ...counts,
          status: 'observed',
          projectionCount: 2,
          [field]: invalid,
        })
      ).toEqual({ status: 'invalid' });
    }
  });
});
