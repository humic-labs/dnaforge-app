import { afterEach, describe, expect, it, vi } from 'vitest';
import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useToastStore } from './toast-store';

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../lib/analytics', () => ({ trackRendererEvent: capture }));

describe('displayed notification diagnostics', () => {
  afterEach(() => {
    useToastStore.getState().clearToasts();
    capture.mockReset();
  });

  it('records all eight displayed failures without messages or notebook keys', () => {
    for (let index = 0; index < 8; index++) {
      useToastStore.getState().addRichToast({
        definition: 'native-notebook-load-failed',
        key: 'PRIVATE_NOTEBOOK',
        message: userMessageWithValues('notice.opened-value', {
          value0: userMessageValue('PRIVATE_CONTENT'),
        }),
      });
    }
    expect(capture).toHaveBeenCalledTimes(8);
    const observations = capture.mock.calls.map(([event, properties]) => ({ event, properties }));
    expect(new Set(observations.map(({ properties }) => properties.notification_id)).size).toBe(8);
    for (const { event, properties } of observations) {
      expect(event).toBe('user_notification_observed');
      expect(properties).toMatchObject({
        feature_area: 'reliability',
        notification_definition: 'native-notebook-load-failed',
        notification_variant: 'default',
        notification_severity: 'error',
      });
    }
    expect(JSON.stringify(observations)).not.toMatch(/PRIVATE|message|key/);
  });

  it('does not report catalog previews as user failures', () => {
    useToastStore
      .getState()
      .addRichToast({ definition: 'native-notebook-load-failed', preview: true });
    expect(capture).not.toHaveBeenCalled();
  });
});
