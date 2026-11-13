import { atomicUnitFixture } from '@/test/fixtures/molstar-unit';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { OrderedSet, SortedArray } from 'molstar/lib/mol-data/int';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';
import { describe, expect, it, vi } from 'vitest';
import { nativeFeatureExposure } from './nativeFeatureExposure';

const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function selected(positions: number[][], physicalCopy = matrix) {
  const unit = atomicUnitFixture({
    kind: 0,
    elements: SortedArray.ofBounds(0, positions.length),
    conformation: {
      operator: { matrix: Mat4.fromArray(Mat4(), physicalCopy, 0) },
      position: (i: number, out: number[]) => {
        positions[i].forEach((v, axis) => {
          out[axis] = v;
        });
        return out;
      },
    },
  });
  return {
    loci: StructureElement.Loci(Structure.Empty, [
      { unit, indices: OrderedSet.ofBounds(0, positions.length) },
    ]),
  };
}
function native(picked?: ReturnType<typeof selected>) {
  const repr = {
    label: 'Spacefill',
    props: { alpha: 1 },
    state: { transform: matrix, transparency: { layers: [] } },
    renderObjects: [
      {
        state: { visible: true, pickable: true },
        values: { drawCount: { ref: { value: 30 } }, uAlpha: { ref: { value: 1 } } },
      },
    ],
  };
  const identify = vi.fn(() => (picked ? { id: { objectId: 1 } } : undefined));
  const plugin = molstarPluginFixture({
    state: { data: { cells: new Map([['geometry', { obj: { data: { repr } } }]]) } },
    canvas3d: {
      camera: {
        viewport: { x: 0, y: 0, width: 200, height: 200 },
        project: (out: number[], point: number[]) => {
          point.forEach((v, axis) => {
            out[axis] = v;
          });
          out[3] = 1;
          return out;
        },
      },
      webgl: { isContextLost: false, pixelRatio: 2, gl: { drawingBufferHeight: 200 } },
      props: {
        camera: { stereo: { name: 'off' } },
        renderer: { pickingAlphaThreshold: 0.5 },
        pickPadding: 3,
        pickScale: 0.25,
      },
      identify,
      getLoci: () => ({ loci: picked?.loci, repr }),
    },
  });
  return { plugin, identify, repr };
}

describe('native feature exposure readback', () => {
  it('projects actual centers into CSS pick coordinates and accepts physical atoms across unit objects', () => {
    const feature = selected([[40, 60, 0.5]]),
      picked = selected([[40, 60, 0.5]]);
    const { plugin, identify } = native(picked);
    expect(nativeFeatureExposure(plugin, [feature])).toMatchObject({
      status: 'sampled',
      selectedAtomCount: 1,
      sampledAtomCount: 1,
      counts: { matchingFeature: 1, otherAtoms: 0 },
    });
    expect(identify).toHaveBeenCalledWith([20, 70]);
  });
  it('counts another physical copy as front geometry, while preserving transparent-picking limits', () => {
    const copy = [...matrix];
    copy[12] = 10;
    const { plugin, repr } = native(selected([[40, 60, 0.5]], copy));
    repr.props.alpha = 0.3;
    expect(nativeFeatureExposure(plugin, [selected([[40, 60, 0.5]])])).toMatchObject({
      counts: { matchingFeature: 0, otherAtoms: 1 },
      picksFromRepresentationsWithTransparency: 1,
      pickSettings: { alphaThreshold: 0.5, nativePaddingSetting: 3 },
    });
  });
  it('separates viewport, depth clipping, absent picks and unavailable native geometry', () => {
    const { plugin, identify } = native();
    expect(
      nativeFeatureExposure(plugin, [
        selected([
          [210, 60, 0.5],
          [40, 60, 2],
          [40, 60, 0.5],
        ]),
      ])
    ).toMatchObject({ counts: { outsideViewport: 1, clipped: 1, noPick: 1 } });
    expect(identify).toHaveBeenCalledTimes(1);
    expect(nativeFeatureExposure({} as MolstarPlugin, [])).toMatchObject({ status: 'unavailable' });
    const coarsePick = selected([[40, 60, 0.5]]);
    Object.assign(coarsePick.loci.elements[0].unit, { kind: 1 });
    expect(
      nativeFeatureExposure(native(coarsePick).plugin, [selected([[40, 60, 0.5]])])
    ).toMatchObject({
      counts: { otherGeometry: 1, otherAtoms: 0 },
    });
  });
  it('samples deterministically across the selection within the assigned budget', () => {
    const feature = selected(Array.from({ length: 1000 }, (_, i) => [i % 100, 60, 0.5]));
    const { plugin, identify } = native(feature);
    const result = nativeFeatureExposure(plugin, [feature], 8);
    expect(result).toMatchObject({
      selectedAtomCount: 1000,
      sampledAtomCount: 8,
      sampleLimit: 8,
      counts: { matchingFeature: 8 },
    });
    expect(identify).toHaveBeenCalledTimes(8);
    expect(identify.mock.calls[0]?.[0]).toEqual([0, 70]);
    expect(identify.mock.calls[7]?.[0]).toEqual([49.5, 70]);
  });
});
