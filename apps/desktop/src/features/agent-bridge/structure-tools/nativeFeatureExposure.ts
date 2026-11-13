import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Vec2, Vec3, Vec4 } from 'molstar/lib/mol-math/linear-algebra';
import { Bond, Unit, type StructureElement } from 'molstar/lib/mol-model/structure';
import type { Representation } from 'molstar/lib/mol-repr/representation';
import type { StructureRepresentationState } from 'molstar/lib/mol-repr/structure/representation';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';

export const FEATURE_EXPOSURE_SAMPLE_BUDGET = 512;
export const FEATURE_EXPOSURE_NOTES =
  'Informational native picking at deterministically sampled selected atom centers. Matching picks identify physical atoms owned by this group; surface/cartoon picks can identify owner atoms without drawing those atoms individually. Other picks describe frontmost pickable geometry, not an opaque-occlusion verdict. Transparent, fogged or unpickable geometry may be skipped; padding can pick nearby pixels. Representation transparency flags do not measure sampled fragment opacity. No pick does not establish missing geometry. Sample bounds cover sampled centers only. This does not measure color distinction, label legibility, complete feature visibility or scientific readability.';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function nativeFeatureExposure(
  plugin: MolstarPlugin,
  selections: readonly { loci: StructureElement.Loci }[],
  sampleLimit = 64
): Record<string, unknown> {
  const counts = {
    matchingFeature: 0,
    otherAtoms: 0,
    otherGeometry: 0,
    noPick: 0,
    outsideViewport: 0,
    clipped: 0,
    invalidCoordinate: 0,
    pickError: 0,
  };
  const canvas = plugin.canvas3d;
  const result = {
    status: 'unavailable',
    selectedAtomCount: selections.reduce(
      (sum, { loci }) =>
        sum +
        loci.elements.reduce(
          (n, entry) => n + (Unit.isAtomic(entry.unit) ? OrderedSet.size(entry.indices) : 0),
          0
        ),
      0
    ),
    nonAtomicElementCount: selections.reduce(
      (sum, { loci }) =>
        sum +
        loci.elements.reduce(
          (n, entry) => n + (Unit.isAtomic(entry.unit) ? 0 : OrderedSet.size(entry.indices)),
          0
        ),
      0
    ),
    sampledAtomCount: 0,
    sampleLimit,
    counts,
    matchingSampleAtomCount: 0,
    picksFromRepresentationsWithTransparency: 0,
  };
  const unavailable = (reason: string) => ({ ...result, reason });
  if (!canvas?.camera?.project || !canvas.identify || !canvas.getLoci)
    return unavailable('Native camera projection/picking is unavailable.');
  if (canvas.webgl.isContextLost) return unavailable('Native WebGL context is lost.');
  if (canvas.props.camera.stereo.name !== 'off')
    return unavailable('Stereo camera projection is not supported by this readback.');
  const viewport = canvas.camera.viewport,
    ratio = canvas.webgl.pixelRatio;
  const bufferHeight = canvas.webgl.gl.drawingBufferHeight;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    !Number.isFinite(bufferHeight) ||
    ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return unavailable('Native viewport dimensions are unavailable.');

  let transparentGeometryPresent = false,
    unpickableGeometryPresent = false;
  let customClippingPresent = false,
    geometryCount = 0;
  for (const cell of plugin.state?.data?.cells?.values() ?? []) {
    const repr = cell.obj?.data?.repr as Representation.Any | undefined;
    if (!repr) continue;
    const objects = repr.renderObjects.filter(
      (o) => o.state.visible && o.values.drawCount.ref.value > 0
    );
    if (!objects.length) continue;
    geometryCount += objects.length;
    const state = repr.state as StructureRepresentationState;
    if (
      (state.transform && state.transform.some((value, i) => value !== identity[i])) ||
      (state.unitTransforms && !state.unitTransforms.isIdentity)
    )
      return unavailable(
        'Representation-only transforms are not supported by atom-center projection.'
      );
    transparentGeometryPresent ||= objects.some(
      (o) =>
        (o.values.uAlpha?.ref.value ?? 1) < 1 ||
        o.values.dTransparency?.ref.value === true ||
        ('dXrayShaded' in o.values && o.values.dXrayShaded.ref.value !== 'off')
    );
    unpickableGeometryPresent ||= objects.some((o) => !o.state.pickable || o.state.colorOnly);
    customClippingPresent ||=
      !!repr.props.clip?.objects?.length || !!state.clipping?.layers?.length;
  }
  if (!geometryCount) return unavailable('No visible native geometry has a positive draw count.');
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1)
    return unavailable('The bounded scene sampling budget is exhausted.');

  const keys = new WeakMap<Unit, string>();
  const unitKey = (unit: Unit) => {
    let key = keys.get(unit);
    if (!key) {
      key = `${unit.model.id}:${JSON.stringify(Array.from(unit.conformation.operator.matrix))}`;
      keys.set(unit, key);
    }
    return key;
  };
  const atomsByUnit = new Map<string, Set<number>>();
  const entries: Array<{ unit: Unit.Atomic; indices: OrderedSet; offset: number }> = [];
  let offset = 0;
  for (const { loci } of selections)
    for (const entry of loci.elements) {
      const count = OrderedSet.size(entry.indices);
      if (!Unit.isAtomic(entry.unit)) continue;
      entries.push({ unit: entry.unit, indices: entry.indices, offset });
      offset += count;
      const key = unitKey(entry.unit),
        atoms = atomsByUnit.get(key) ?? new Set<number>();
      OrderedSet.forEach(entry.indices, (i) => atoms.add(entry.unit.elements[i]));
      atomsByUnit.set(key, atoms);
    }
  if (!result.selectedAtomCount)
    return unavailable('The feature has no selected atomic coordinates.');

  const count = Math.min(sampleLimit, result.selectedAtomCount);
  const position = Vec3(),
    projected = Vec4(),
    representationPicks: Record<string, number> = {};
  let bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (let sample = 0, entryIndex = 0; sample < count; sample++) {
    const slot =
      count === 1
        ? Math.floor(result.selectedAtomCount / 2)
        : Math.floor((sample * (result.selectedAtomCount - 1)) / (count - 1));
    while (entryIndex + 1 < entries.length && entries[entryIndex + 1].offset <= slot) entryIndex++;
    const entry = entries[entryIndex];
    const atom = entry.unit.elements[OrderedSet.getAt(entry.indices, slot - entry.offset)];
    result.sampledAtomCount++;
    try {
      entry.unit.conformation.position(atom, position);
      canvas.camera.project(projected, position);
      if (![...position, ...projected].every(Number.isFinite)) {
        counts.invalidCoordinate++;
        continue;
      }
      if (projected[3] <= 0 || projected[2] < 0 || projected[2] > 1) {
        counts.clipped++;
        continue;
      }
      if (
        projected[0] < viewport.x ||
        projected[1] < viewport.y ||
        projected[0] >= viewport.x + viewport.width ||
        projected[1] >= viewport.y + viewport.height
      ) {
        counts.outsideViewport++;
        continue;
      }
      const x = projected[0] / ratio,
        y = (bufferHeight - projected[1]) / ratio;
      if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
      const pick = canvas.identify(Vec2.create(x, y));
      if (!pick) {
        counts.noPick++;
        continue;
      }
      const hit = canvas.getLoci(pick.id),
        repr = hit.repr;
      const label = repr?.label ?? 'Unknown';
      representationPicks[label] = (representationPicks[label] ?? 0) + 1;
      if (
        repr &&
        ((repr.props.alpha ?? 1) * (repr.state.alphaFactor ?? 1) < 1 ||
          repr.state.transparency?.layers?.some((layer) => layer.value > 0) ||
          ['on', 'inverted', true].includes(repr.props.xrayShaded))
      )
        result.picksFromRepresentationsWithTransparency++;
      const loci = hit.loci.kind === 'bond-loci' ? Bond.toStructureElementLoci(hit.loci) : hit.loci;
      if (loci.kind !== 'element-loci') {
        counts.otherGeometry++;
        continue;
      }
      let pickedCount = 0,
        matches = true,
        sampleMatches = false,
        atomicOnly = true;
      for (const picked of loci.elements)
        OrderedSet.forEach(picked.indices, (i) => {
          pickedCount++;
          atomicOnly &&= Unit.isAtomic(picked.unit);
          const physicalUnit = unitKey(picked.unit),
            element = picked.unit.elements[i];
          matches &&= Unit.isAtomic(picked.unit) && !!atomsByUnit.get(physicalUnit)?.has(element);
          sampleMatches ||= physicalUnit === unitKey(entry.unit) && element === atom;
        });
      if (!pickedCount) counts.noPick++;
      else if (!atomicOnly) counts.otherGeometry++;
      else if (matches) {
        counts.matchingFeature++;
        if (sampleMatches) result.matchingSampleAtomCount++;
      } else counts.otherAtoms++;
    } catch {
      counts.pickError++;
    }
  }
  return {
    ...result,
    status: 'sampled',
    sampledCenterBoundsCss: bounds,
    representationPicks,
    viewport: { ...viewport },
    cameraSnapshot: canvas.camera.getSnapshot?.() ?? null,
    pickSettings: {
      alphaThreshold: canvas.props.renderer.pickingAlphaThreshold,
      nativePaddingSetting: canvas.props.pickPadding,
      pixelRatio: ratio,
    },
    transparentGeometryPresent,
    unpickableGeometryPresent,
    customClippingPresent,
  };
}
