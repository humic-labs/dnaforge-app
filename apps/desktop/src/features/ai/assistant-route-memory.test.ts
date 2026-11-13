import { describe, expect, it } from 'vitest';
import {
  parseRememberedAssistantRoute,
  serializeRememberedAssistantRoute,
} from './assistant-route-memory';

type SyntheticRoute = {
  kind: 'synthetic-router';
  id: string;
  options: { mode: string; nested: { budget: number } };
};

function restoreSyntheticRoute(value: unknown): SyntheticRoute | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SyntheticRoute>;
  if (candidate.kind !== 'synthetic-router' || typeof candidate.id !== 'string') return null;
  if (!candidate.options || typeof candidate.options !== 'object') return null;
  return value as SyntheticRoute;
}

describe('router-agnostic assistant route memory', () => {
  const route: SyntheticRoute = {
    kind: 'synthetic-router',
    id: 'future-host',
    options: { mode: 'deliberate', nested: { budget: 37 } },
  };

  it('round-trips an arbitrary route without knowing its kind or fields', () => {
    const encoded = serializeRememberedAssistantRoute(route);

    expect(JSON.parse(encoded)).toEqual({ version: 1, selection: route });
    expect(parseRememberedAssistantRoute(encoded, restoreSyntheticRoute)).toEqual(route);
  });

  it('accepts the pre-envelope raw JSON format through the same injected registry decoder', () => {
    expect(parseRememberedAssistantRoute(JSON.stringify(route), restoreSyntheticRoute)).toEqual(
      route
    );
  });

  it('returns null when the registry rejects a retired or unknown route', () => {
    const encoded = serializeRememberedAssistantRoute(route);

    expect(parseRememberedAssistantRoute(encoded, () => null)).toBeNull();
  });

  it.each([
    null,
    '',
    '{broken',
    JSON.stringify({ version: 2, selection: route }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, selection: null }),
  ])('rejects malformed or unsupported memory payload %j', (value) => {
    expect(parseRememberedAssistantRoute(value, restoreSyntheticRoute)).toBeNull();
  });
});
