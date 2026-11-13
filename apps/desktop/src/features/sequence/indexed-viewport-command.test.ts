// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  normalizeIndexedViewportForPersistence,
  projectIndexedAssemblyLiveViewport,
  projectIndexedLiveViewport,
  projectIndexedViewportCommand,
  takeIndexedViewportCommand,
} from './indexed-viewport-command';

describe('persisted genome viewport roundoff', () => {
  it('keeps exact endpoints through repeated camera readback and save cycles', () => {
    let saved = { start0: 1_950_303_672, end0: 1_950_305_675 };
    for (let cycle = 0; cycle < 12; cycle += 1) {
      saved = normalizeIndexedViewportForPersistence(
        {
          start: saved.start0 + 2 ** -22,
          end: saved.end0 + 2 ** -22,
        },
        3_088_269_832
      )!;
      expect(saved).toEqual({ start0: 1_950_303_672, end0: 1_950_305_675 });
    }
  });

  it('preserves real fractional and one-base movements', () => {
    const start = 1_950_303_672;
    const end = 1_950_305_675;
    expect(
      normalizeIndexedViewportForPersistence(
        { start: start - 0.01, end: end + 0.01 },
        3_088_269_832
      )
    ).toEqual({ start0: start - 1, end0: end + 1 });
    expect(
      normalizeIndexedViewportForPersistence({ start: start + 1, end: end + 1 }, 3_088_269_832)
    ).toEqual({ start0: start + 1, end0: end + 1 });
    expect(normalizeIndexedViewportForPersistence({ start: 10.2, end: 19.8 }, 100)).toEqual({
      start0: 10,
      end0: 20,
    });
  });
});

describe('takeIndexedViewportCommand', () => {
  it('applies start0 0 once and ignores the same command id', () => {
    const command = { id: 1, chrom: 'chrI', start0: 0, end0: 100 };
    expect(takeIndexedViewportCommand(null, command)).toEqual({
      chrom: 'chrI',
      start0: 0,
      end0: 100,
    });
    expect(takeIndexedViewportCommand(1, command)).toBeNull();
  });

  it('rejects empty, reversed, and negative intervals', () => {
    expect(takeIndexedViewportCommand(null, { id: 1, chrom: '', start0: 0, end0: 10 })).toBeNull();
    expect(
      takeIndexedViewportCommand(null, { id: 1, chrom: 'chrI', start0: 10, end0: 10 })
    ).toBeNull();
    expect(
      takeIndexedViewportCommand(null, { id: 1, chrom: 'chrI', start0: 20, end0: 10 })
    ).toBeNull();
    expect(
      takeIndexedViewportCommand(null, { id: 1, chrom: 'chrI', start0: -1, end0: 10 })
    ).toBeNull();
  });

  it('maps a non-anchor chromosome between local and assembly-global coordinates', () => {
    const assembly = {
      chromosomes: [
        { chrom: 'chrI', length: 100 },
        { chrom: 'chrII', length: 200 },
      ],
    };
    expect(
      projectIndexedViewportCommand({ chrom: 'chrII', start0: 0, end0: 50 }, assembly)
    ).toEqual({ chrom: 'chrII', start: 100, end: 150 });
    expect(projectIndexedLiveViewport('chrII', { start: 100, end: 150 }, assembly)).toEqual({
      chrom: 'chrII',
      start0: 0,
      end0: 50,
    });
    expect(projectIndexedAssemblyLiveViewport({ start: 100, end: 150 }, assembly)).toEqual({
      chrom: 'chrII',
      start0: 0,
      end0: 50,
    });
  });

  it('refuses an unknown chromosome or a camera that crosses its boundary', () => {
    const assembly = { chromosomes: [{ chrom: 'chrI', length: 100 }] };
    expect(
      projectIndexedViewportCommand({ chrom: 'chrII', start0: 0, end0: 50 }, assembly)
    ).toBeNull();
    expect(projectIndexedLiveViewport('chrI', { start: 90, end: 110 }, assembly)).toBeNull();
  });

  it('projects machine-precision spillover at a chromosome end without changing the global camera', () => {
    const assembly = {
      chromosomes: [
        { chrom: 'chr1', length: 248_956_422 },
        { chrom: 'chr2', length: 242_193_529 },
      ],
    };
    const camera = { start: 248_954_422.00000003, end: 248_956_422.00000003 };
    const original = { ...camera };
    expect(projectIndexedAssemblyLiveViewport(camera, assembly)).toEqual({
      chrom: 'chr1',
      start0: camera.start,
      end0: 248_956_422,
    });
    expect(camera).toEqual(original);
    expect(
      projectIndexedAssemblyLiveViewport(
        { start: 248_956_421.99999997, end: 248_958_422 },
        assembly
      )
    ).toEqual({
      chrom: 'chr2',
      start0: 0,
      end0: 2_000,
    });
    expect(
      projectIndexedAssemblyLiveViewport({ ...camera, end: 248_956_422.1 }, assembly)
    ).toBeNull();
  });
});
