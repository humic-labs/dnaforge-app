import { describe, expect, it } from 'vitest';
import { upcastInventoryIncidentSnapshots } from './inventory-incident-codec-compat';
import { InventoryValidationError, parseInventoryState } from './inventory-validation';

describe('incident snapshot compatibility boundary', () => {
  it.each([
    ['scientificProductions', { sources: {} }],
    ['platePlanObservations', { sources: 1 }],
    ['platePlanObservations', { destinations: {} }],
  ] as const)('rejects malformed %s through inventory validation', (family, effects) => {
    const raw = {
      schema: 'dnaforge.inventory.v29',
      [family]: { malformed: { effects } },
    };
    expect(() => parseInventoryState(raw)).toThrow(InventoryValidationError);
  });

  it('leaves current and unknown schemas intact for their own admission', () => {
    for (const schema of ['dnaforge.inventory.v30', 'dnaforge.inventory.v31', 'unrecognized']) {
      const raw = {
        schema,
        stocks: { sample: { incidentReviewRootIds: ['retained-root'] } },
      };
      expect(upcastInventoryIncidentSnapshots(raw)).toEqual(raw);
    }
  });
});
