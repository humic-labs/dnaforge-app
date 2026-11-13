import { describe, expect, it } from 'vitest';
import {
  UPSTREAM_PROTOCOL_CLIENT_REQUEST_METHODS,
  UPSTREAM_PROTOCOL_SERVER_NOTIFICATION_METHODS,
  UPSTREAM_PROTOCOL_SERVER_REQUEST_METHODS,
  isKnownUpstreamClientRequestMethod,
  isKnownUpstreamServerNotificationMethod,
  isKnownUpstreamServerRequestMethod,
} from './methods';

describe('upstream protocol method inventory', () => {
  it('describes known upstream protocol methods without implying authorization', () => {
    expect(UPSTREAM_PROTOCOL_CLIENT_REQUEST_METHODS).toContain('fs/writeFile');
    expect(UPSTREAM_PROTOCOL_SERVER_REQUEST_METHODS).toContain('item/tool/call');
    expect(UPSTREAM_PROTOCOL_SERVER_NOTIFICATION_METHODS).toContain('turn/completed');
    expect(isKnownUpstreamClientRequestMethod('fs/writeFile')).toBe(true);
    expect(isKnownUpstreamServerRequestMethod('item/tool/call')).toBe(true);
    expect(isKnownUpstreamServerNotificationMethod('turn/completed')).toBe(true);
    expect(isKnownUpstreamClientRequestMethod('dnaforge/not-real')).toBe(false);
  });
});
