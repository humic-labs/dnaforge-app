import { expect, it, vi } from 'vitest';
import { beginIndexedGenomeOpen } from './indexed-genome-lifecycle-telemetry';

vi.mock('../../lib/analytics', () => ({
  getAnalyticsCaptureGeneration: () => 0,
  isAnalyticsCaptureReady: () => false,
  trackRendererEvent: () => false,
}));

function authority() {
  let ms = 100;
  let id = 0;
  let generation = 1;
  let ready = true;
  const receipts: Record<string, unknown>[] = [];
  return {
    receipts,
    now: () => ms,
    newId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    captureGeneration: () => generation,
    captureReady: () => ready,
    track: (_event: string, properties: Record<string, unknown>) => {
      receipts.push(properties);
      return true;
    },
    advance: (next: number) => {
      ms = next;
    },
    changeAuthority: (next: boolean) => {
      ready = next;
      generation += 1;
    },
  };
}

it('separates physical presentation from readiness and rejects superseded acknowledgements', () => {
  const clock = authority();
  const open = beginIndexedGenomeOpen('open', clock);
  open.firstViewportPresented();
  clock.advance(125);
  open.coordinateReady();
  open.coordinateReady();
  clock.advance(150);
  open.firstViewportPresented();
  open.firstViewportPresented();
  clock.advance(170);
  open.acceptViewport(1);
  clock.advance(180);
  open.acceptViewport(2);
  open.viewportPresented(1);
  clock.advance(200);
  open.viewportPresented(2);
  open.acceptViewport(2);
  open.viewportPresented(2);
  open.end({ outcome: 'cancelled', reason: 'closed' });

  expect(
    clock.receipts.map(({ genome_stage, occurred_at_ms }) => [genome_stage, occurred_at_ms])
  ).toEqual([
    ['open_accepted', 100],
    ['coordinate_ready', 125],
    ['first_viewport_presented', 150],
    ['viewport_accepted', 170],
    ['viewport_superseded', 180],
    ['viewport_accepted', 180],
    ['viewport_presented', 200],
  ]);
  const [start, , , oldViewport, superseded, nextViewport, presented] = clock.receipts;
  expect(start.operation_id).not.toBe(start.genome_generation_id);
  expect(superseded.viewport_operation_id).toBe(oldViewport.viewport_operation_id);
  expect(presented.viewport_operation_id).toBe(nextViewport.viewport_operation_id);
  expect(presented.viewport_operation_id).not.toBe(oldViewport.viewport_operation_id);
  expect(presented.viewport_started_at_ms).toBe(180);
  expect(presented.genome_started_at_ms).toBe(100);
  expect(presented.operation_id).toBe(start.operation_id);
  expect(presented.genome_generation_id).toBe(start.genome_generation_id);
});

it('settles a closed open once and excludes events across consent or identity changes', () => {
  const clock = authority();
  const open = beginIndexedGenomeOpen('open', clock);
  open.coordinateReady();
  open.acceptViewport(1);
  open.end({ outcome: 'cancelled', reason: 'closed' });
  open.end({ outcome: 'failed', reason: 'renderer' });
  open.viewportPresented(1);
  open.firstViewportPresented();

  expect(clock.receipts.map(({ genome_stage }) => genome_stage)).toEqual([
    'open_accepted',
    'coordinate_ready',
    'viewport_accepted',
    'open_cancelled',
    'viewport_cancelled',
  ]);
  const [original] = clock.receipts;
  const reopened = beginIndexedGenomeOpen('reopen', clock);
  expect(clock.receipts.at(-1)?.operation_id).not.toBe(original.operation_id);
  expect(clock.receipts.at(-1)?.genome_generation_id).not.toBe(original.genome_generation_id);
  clock.changeAuthority(false);
  reopened.coordinateReady();
  clock.changeAuthority(true);
  reopened.firstViewportPresented();
  expect(clock.receipts).toHaveLength(6);
  clock.changeAuthority(false);
  const restored = beginIndexedGenomeOpen('restored', clock);
  clock.changeAuthority(true);
  restored.coordinateReady();
  restored.firstViewportPresented();
  expect(clock.receipts).toHaveLength(6);
});
