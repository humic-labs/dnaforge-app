import { describe, expect, it } from 'vitest';
import { createLimsTestBridge } from './lims-bridge-for-db';

describe('createLimsTestBridge (real engine via PlatformBridge surface)', () => {
  const oligo = (name: string, bases: string) => ({
    kind: 'oligo' as const,
    name,
    fields: {
      sequence: {
        mode: 'inline' as const,
        bases,
        topology: 'linear' as const,
        length: bases.length,
      },
      use: 'primer',
    },
  });

  it('registers, queries, and counts through the real engine', async () => {
    const { lims } = createLimsTestBridge();
    await lims.ensureSeeded();
    await lims.registerEntity(oligo('P1', 'GTAAAACGACGGCCAGT'));
    await lims.registerEntity(oligo('P2', 'CAGGAAACAGCTATGAC'));

    const rows = await lims.queryEntities({ kind: 'oligo' });
    expect(rows.map((r) => r.name).sort()).toEqual(['P1', 'P2']);

    const counts = await lims.countEntitiesByKind();
    expect(counts.oligo).toBe(2);
    expect(counts.plasmid).toBe(0);
  });

  it('drives the real revert-across-archive/restore behavior (the #1 fix)', async () => {
    const { lims } = createLimsTestBridge();
    await lims.ensureSeeded();
    const entity = await lims.registerEntity(oligo('R1', 'GTAAAACGACGGCCAGT'));
    await lims.updateEntity({ id: entity.id, name: 'R1-v2', actor: 'test' });
    await lims.archiveEntity({ id: entity.id });
    await lims.restoreEntity({ id: entity.id });

    const reverted = await lims.revertEntity({ id: entity.id });
    expect(reverted.reverted).toBe(true);
    expect(reverted.entity.name).toBe('R1-v2');
    expect(reverted.entity.tombstone).toBe(true);
  });

  it('isolates state per bridge (fresh in-memory db each time)', async () => {
    const a = createLimsTestBridge();
    await a.lims.ensureSeeded();
    await a.lims.registerEntity(oligo('only-in-a', 'GTAAAACGACGGCCAGT'));

    const b = createLimsTestBridge();
    await b.lims.ensureSeeded();
    expect((await b.lims.queryEntities({ kind: 'oligo' })).length).toBe(0);
  });
});
