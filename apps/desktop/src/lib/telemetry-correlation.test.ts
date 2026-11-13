import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTelemetryCorrelationForTests,
  getTelemetryCorrelationContext,
  getTelemetryCorrelationRevision,
  setEpisodeCorrelationId,
} from './telemetry-correlation';
const A = '550e8400-e29b-41d4-a716-446655440002';
const B = '550e8400-e29b-41d4-a716-446655440003';
beforeEach(() => {
  sessionStorage.clear();
  __resetTelemetryCorrelationForTests();
});
describe('telemetry correlation history', () => {
  it('initializes one stable revision and keeps same normalized setters idempotent', () => {
    const first = getTelemetryCorrelationRevision();
    expect(getTelemetryCorrelationRevision()).toBe(first);
    setEpisodeCorrelationId(A);
    const changed = getTelemetryCorrelationRevision();
    expect(changed).toBeGreaterThan(first);
    setEpisodeCorrelationId(A.toUpperCase());
    expect(getTelemetryCorrelationRevision()).toBe(changed);
  });
  it('records away-and-back history although final opaque values match', () => {
    setEpisodeCorrelationId(A);
    const snapshot = getTelemetryCorrelationContext();
    const revision = getTelemetryCorrelationRevision();
    setEpisodeCorrelationId(B);
    setEpisodeCorrelationId(A);
    expect(getTelemetryCorrelationContext()).toEqual(snapshot);
    expect(getTelemetryCorrelationRevision()).toBe(revision + 2);
    expect(snapshot.episodeCorrelationId).toBe(A);
  });
  it('invalidates previous bindings on reset without rewinding history', () => {
    const snapshot = getTelemetryCorrelationContext();
    const revision = getTelemetryCorrelationRevision();
    __resetTelemetryCorrelationForTests();
    expect(getTelemetryCorrelationContext()).toEqual(snapshot);
    expect(getTelemetryCorrelationRevision()).toBeGreaterThan(revision);
  });
});
