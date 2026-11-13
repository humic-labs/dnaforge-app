import { describe, expect, it } from 'vitest';
import { userMessage, userMessagePayload } from '@waypoint/user-messages';
import type { ImportReviewReceipt } from '../../shared/import-review';
import { importReceiptMessage, sequenceRegistrationFailureMessage } from './import-user-messages';

const diagnostics = [
  'platform.trackViews.list is not available in the hosted browser runtime',
  'UCSC tracks: VITE_API_URL is not set',
  'Error: private server detail\n at service (private-file.ts:2:3)',
];

describe('public import receipt messages', () => {
  it('does not invent successful counts without a receipt', () => {
    expect(importReceiptMessage(undefined)).toBe(userMessage('registry.receipt.unconfirmed'));
  });

  it.each(diagnostics)('keeps private detail out of a saved partial outcome: %s', (diagnostic) => {
    const receipt: ImportReviewReceipt = {
      changed: true,
      artifactPaths: ['sequence/product.gb'],
      sourcePath: 'sequence.gb',
      imported: 0,
      skipped: 0,
      failed: 1,
      partialEffects: [diagnostic],
      userMessagePayload: userMessagePayload('registry.receipt.registrationFailed'),
    };
    const wire = JSON.parse(JSON.stringify(receipt));
    const displayed = importReceiptMessage(wire);
    expect(displayed).toContain('0 entities, 0 links, 0 skipped');
    expect(displayed).toContain(userMessage('registry.receipt.registrationFailed'));
    expect(displayed).not.toContain(diagnostic);
    expect(wire).toEqual(receipt);
    expect(wire.partialEffects).toEqual([diagnostic]);
    expect(wire.artifactPaths).toEqual(['sequence/product.gb']);
  });

  it.each([true, false, 'unknown'] as const)(
    'contains old or malformed receipts without changing %s',
    (changed) => {
      const receipt = JSON.parse(
        JSON.stringify({
          changed,
          artifactPaths: ['saved.gb'],
          imported: 2,
          skipped: 1,
          failed: 1,
          partialEffects: [diagnostics[0]],
          userMessagePayload: { key: 'VITE_API_URL' },
        })
      );
      const displayed = importReceiptMessage(receipt, false);
      expect(displayed).toContain('2 entities, 1 skipped');
      expect(displayed).toContain(
        userMessage(
          changed === true ? 'registry.receipt.savedIncomplete' : 'registry.receipt.unconfirmed'
        )
      );
      expect(displayed).not.toContain('VITE_API_URL');
      expect(displayed).not.toContain('platform.trackViews.list');
      expect(receipt.changed).toBe(changed);
    }
  );

  it('preserves the ordinary successful counts', () => {
    const receipt: ImportReviewReceipt = {
      changed: true,
      artifactPaths: ['a.gb'],
      imported: 3,
      insertedLinks: 2,
      skipped: 1,
      failed: 0,
    };
    expect(importReceiptMessage(receipt)).toBe('3 entities, 2 links, 1 skipped');
    expect(importReceiptMessage(receipt, false)).toBe('3 entities, 1 skipped');
  });

  it('uses approved registration guidance after wire serialization', () => {
    const wire = JSON.parse(
      JSON.stringify({
        reason: diagnostics[1],
        userMessagePayload: userMessagePayload('registry.receipt.sequencePackageMissing'),
      })
    );
    expect(sequenceRegistrationFailureMessage(wire)).toBe(
      userMessage('registry.receipt.sequencePackageMissing')
    );
    expect(wire.reason).toBe(diagnostics[1]);
    expect(sequenceRegistrationFailureMessage({})).toBe(
      userMessage('registry.receipt.registrationFailed')
    );
  });
});
