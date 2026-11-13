// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { userMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import { useToastStore } from './toast-store';

const privateDetails = [
  'platform.trackViews.list is not available in the hosted browser runtime.',
  'UCSC tracks: VITE_API_URL is not set',
  'The server returned an unapproved explanation.',
  'd012d35b-e286-49ce-9246-d278135da2b5',
];

describe('public notification boundary', () => {
  afterEach(() => useToastStore.getState().clearToasts());

  it.each(privateDetails)('rejects runtime text outside the catalog: %s', (detail) => {
    Reflect.apply(useToastStore.getState().addToast, undefined, [detail, 'error', 0]);
    expect(useToastStore.getState().toasts[0].message).toBe(userMessage('operation.failed'));
  });

  it('rejects raw rich-notice text and progress text', () => {
    Reflect.apply(useToastStore.getState().addRichToast, undefined, [
      {
        message: privateDetails[0],
        type: 'error',
        duration: 0,
        progress: { value: 20, label: privateDetails[1] },
      },
    ]);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: userMessage('operation.failed'),
      progress: { value: 20, label: userMessage('operation.attention') },
    });
  });

  it('rejects an unexpected Error without reading its private message', () => {
    const failure = new Error(privateDetails[0]);
    Object.defineProperty(failure, 'message', {
      get: () => {
        throw new Error('The public notice must not read private text.');
      },
    });
    Reflect.apply(useToastStore.getState().addToast, undefined, [failure, 'error', 0]);
    expect(useToastStore.getState().toasts[0].message).toBe(userMessage('operation.failed'));
  });

  it('renders the existing catalog reference after serialization', () => {
    const message = JSON.parse(JSON.stringify(userMessagePayload('tracks.unavailable')));
    Reflect.apply(useToastStore.getState().addToast, undefined, [message, 'error', 0]);
    expect(useToastStore.getState().toasts[0].message).toBe(userMessage('tracks.unavailable'));
  });

  it('keeps approved names in serialized catalog templates', () => {
    const message = JSON.parse(
      JSON.stringify(
        userMessagePayload('notice.opened-value', { value0: userMessageValue('Human beta globin') })
      )
    );
    Reflect.apply(useToastStore.getState().addToast, undefined, [message, 'success', 0]);
    expect(useToastStore.getState().toasts[0].message).toBe('Opened Human beta globin.');
  });
});
