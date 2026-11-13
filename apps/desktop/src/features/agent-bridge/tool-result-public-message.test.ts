// @vitest-environment node

import { expect, it } from 'vitest';
import { renderUserMessagePayload, userMessagePayload } from '@waypoint/user-messages';
import { assertToolOperationResult, toolFailure } from './tool-result';

it('keeps diagnostic detail separate from the public failure payload', () => {
  const failure = toolFailure({
    code: 'PRIVATE_NATIVE_FAILURE',
    error: 'platform.trackViews.list is not available in the hosted browser runtime.',
    retriable: false,
    stateChanged: false,
    partialEffects: [],
    userMessagePayload: userMessagePayload('tracks.loadFailed'),
  });
  expect(() => assertToolOperationResult(failure)).not.toThrow();
  expect(renderUserMessagePayload(failure.userMessagePayload!)).toBe(
    'We couldn’t load genome tracks. Try again.'
  );
  expect(failure.error).toContain('platform.trackViews.list');
  expect(() =>
    assertToolOperationResult({
      ...failure,
      userMessagePayload: { key: 'PRIVATE_FAILURE', message: failure.error },
    })
  ).toThrow();
});
