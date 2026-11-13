import { describe, expect, it } from 'vitest';
import {
  pickPreferredRegisteredRoute,
  type RegisteredRouteCandidate,
} from './assistant-route-policy';

type SyntheticSelection = { opaqueId: string; payload: number };

function candidate(
  opaqueId: string,
  availability: RegisteredRouteCandidate<SyntheticSelection>['availability'],
  payload: number
): RegisteredRouteCandidate<SyntheticSelection> {
  return { selection: { opaqueId, payload }, availability };
}

describe('router-agnostic first-run route policy', () => {
  it('returns the first ready registered route without inspecting its identity', () => {
    const routes = [candidate('alpha', 'ready', 11), candidate('beta', 'ready', 22)];

    expect(pickPreferredRegisteredRoute(routes)).toEqual(routes[0].selection);
  });

  it('ranks every ready route above every route requiring setup', () => {
    const routes = [
      candidate('listed-first', 'setup-required', 11),
      candidate('works-now', 'ready', 22),
    ];

    expect(pickPreferredRegisteredRoute(routes)).toEqual(routes[1].selection);
  });

  it('uses stable registry order when only setup-required routes can be used', () => {
    const routes = [
      candidate('first-setup', 'setup-required', 11),
      candidate('second-setup', 'setup-required', 22),
    ];

    expect(pickPreferredRegisteredRoute(routes)).toEqual(routes[0].selection);
  });

  it('does not select pending or unavailable routes', () => {
    expect(
      pickPreferredRegisteredRoute([
        candidate('pending', 'pending', 11),
        candidate('unavailable', 'unavailable', 22),
      ])
    ).toBeNull();
  });
});
