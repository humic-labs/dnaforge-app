// @vitest-environment node

import { expect, it } from 'vitest';
import { toUserMessage, userMessage, withUserMessage } from '@waypoint/user-messages';
import { variantMessageKey } from './variant-user-messages';

it('uses known source failure codes without displaying private server detail', () => {
  const failure = withUserMessage(
    new Error('private sourceIdentity and chromosome table detail'),
    variantMessageKey('VARIANT_SOURCE_ASSEMBLY_MISMATCH')
  );
  expect(toUserMessage(failure)).toBe(userMessage('variant.assemblyMismatch'));
  expect(failure.message).toContain('sourceIdentity');
  expect(variantMessageKey('VARIANT_SOURCE_CHANGED')).toBe('variant.sourceChanged');
  expect(variantMessageKey('toString', 'variant.preparationFailed')).toBe(
    'variant.preparationFailed'
  );
  expect(variantMessageKey('unknown private code')).toBe('variant.queryFailed');
});
