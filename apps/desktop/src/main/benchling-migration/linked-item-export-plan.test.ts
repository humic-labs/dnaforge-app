import { describe, expect, it } from 'vitest';

import type { ValidationReportV2 } from '../../shared/benchling-migration';
import { linkedItemExportPlan } from './linked-item-export-plan';

describe('linkedItemExportPlan', () => {
  it('derives a stable, sorted plan from incomplete durable recovery folders', () => {
    const first = linkedItemExportPlan('run-1', report());
    const second = linkedItemExportPlan('run-1', report());

    expect(first).toEqual(second);
    expect(first.folders).toEqual([
      expect.objectContaining({ sourceId: 'lib_a', targetCount: 2 }),
      expect.objectContaining({ sourceId: 'lib_b', targetCount: 1 }),
    ]);
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses reports without remaining linked-item folders', () => {
    expect(() => linkedItemExportPlan('run-1', report(3))).toThrow('already been recovered');
  });
});

function report(recoveredTargetCount = 1): ValidationReportV2 {
  return {
    version: 2,
    linkedItemRecovery: {
      passed: false,
      issues: [],
      evidence: {
        schema: 'dnaforge.benchling.linked-item-recovery-validation.v1',
        organizationBaseUrl: 'https://acme.benchling.com/',
        relationshipCount: 5,
        uniqueTargetCount: 5,
        folderCount: 2,
        recoveredUniqueObjectCount: 2,
        remainingUniqueObjectCount: 3,
        repairedRelationshipCount: 2,
        remainingRelationshipCount: 3,
        folders: [
          {
            sourceId: 'lib_b',
            name: 'Protocols',
            sourceUrl: 'https://acme.benchling.com/f_/Protocols-lib_b/',
            targetCount: 2,
            relationshipCount: 2,
            countsByType: { protocol: 2 },
            recoveredTargetCount,
          },
          {
            sourceId: 'lib_a',
            name: 'Registry',
            sourceUrl: 'https://acme.benchling.com/f_/Registry-lib_a/',
            targetCount: 3,
            relationshipCount: 3,
            countsByType: { notebook: 3 },
            recoveredTargetCount,
          },
        ],
        targets: [],
        attempts: [],
      },
    },
  } as unknown as ValidationReportV2;
}
