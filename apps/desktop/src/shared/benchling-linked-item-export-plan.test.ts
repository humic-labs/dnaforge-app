// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION,
  parseBenchlingLinkedItemExportPlan,
} from './benchling-linked-item-export-plan';

const PLAN_ID = 'a'.repeat(64);

function validPlan() {
  return {
    version: BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION,
    kind: 'linked_item_export' as const,
    planId: PLAN_ID,
    runId: 'run-1',
    organizationBaseUrl: 'https://acme.benchling.com/',
    folders: [
      {
        sourceId: 'lib_abc',
        name: 'Registry',
        sourceUrl: 'https://acme.benchling.com/f_/Registry-lib_abc/',
        targetCount: 202,
      },
    ],
  };
}

describe('Benchling linked-item export plan', () => {
  it('accepts an exact provider-neutral plan', () => {
    expect(parseBenchlingLinkedItemExportPlan(validPlan())).toEqual(validPlan());
  });

  it('rejects arbitrary hosts, unknown keys, and duplicate folder IDs', () => {
    expect(() =>
      parseBenchlingLinkedItemExportPlan({
        ...validPlan(),
        organizationBaseUrl: 'https://example.com/',
      })
    ).toThrow('HTTPS Benchling URL');
    expect(() => parseBenchlingLinkedItemExportPlan({ ...validPlan(), injected: true })).toThrow(
      'Unexpected export plan keys'
    );
    const folder = validPlan().folders[0];
    expect(() =>
      parseBenchlingLinkedItemExportPlan({ ...validPlan(), folders: [folder, folder] })
    ).toThrow('folder IDs must be unique');
  });

  it('requires every folder URL to stay inside the selected tenant route', () => {
    expect(() =>
      parseBenchlingLinkedItemExportPlan({
        ...validPlan(),
        folders: [
          {
            ...validPlan().folders[0],
            sourceUrl: 'https://other.benchling.com/f_/Registry-lib_abc/',
          },
        ],
      })
    ).toThrow('must belong to organizationBaseUrl');
  });
});
