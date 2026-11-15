import type {
  InventoryDimension,
  InventoryDimensions,
  InventoryGeometry,
  InventoryPhysicalConfiguration,
} from './inventory-configuration-types';
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
export function unknownInventoryGeometry(): InventoryGeometry {
  const dimensions = (): InventoryDimensions => ({
    width: { kind: 'unknown' },
    height: { kind: 'unknown' },
    depth: { kind: 'unknown' },
  });
  return { external: dimensions(), usable: dimensions() };
}
export function emptyInventoryPhysicalConfiguration(): InventoryPhysicalConfiguration {
  return {
    revision: 0,
    typeVersionId: null,
    metadata: Object.create(null),
    geometryOverride: null,
    orientation: { kind: 'unknown' },
    unavailablePositions: Object.create(null),
    recipe: null,
  };
}
export function normalizeInventoryDimension(input: InventoryDimension): InventoryDimension {
  if (input.kind === 'unknown') return { kind: 'unknown' };
  if (
    !['mm', 'cm', 'in'].includes(input.unit) ||
    typeof input.value !== 'string' ||
    input.value.length > 128 ||
    !decimalPattern.test(input.value)
  )
    throw new TypeError('A dimension requires bounded non-negative exact decimal length.');
  const [whole, fraction = ''] = input.value.split('.');
  let value =
    BigInt(whole + fraction) * (input.unit === 'cm' ? 10n : input.unit === 'in' ? 254n : 1n);
  let scale = fraction.length + (input.unit === 'in' ? 1 : 0);
  while (scale > 0 && value % 10n === 0n) {
    value /= 10n;
    scale--;
  }
  const digits = value.toString().padStart(scale + 1, '0');
  const rendered = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  if (rendered.length > 128)
    throw new TypeError('The canonical dimension exceeds supported range.');
  return { kind: 'known', value: rendered, unit: 'mm' };
}
export function normalizeInventoryGeometry(input: InventoryGeometry): InventoryGeometry {
  const normalize = (value: InventoryDimensions): InventoryDimensions => ({
    width: normalizeInventoryDimension(value.width),
    height: normalizeInventoryDimension(value.height),
    depth: normalizeInventoryDimension(value.depth),
  });
  return { external: normalize(input.external), usable: normalize(input.usable) };
}
function exceeds(child: InventoryDimension, parent: InventoryDimension): boolean {
  if (child.kind !== 'known' || parent.kind !== 'known') return false;
  const a = normalizeInventoryDimension(child),
    b = normalizeInventoryDimension(parent);
  if (a.kind !== 'known' || b.kind !== 'known') return false;
  const [aw, af = ''] = a.value.split('.'),
    [bw, bf = ''] = b.value.split('.');
  const scale = Math.max(af.length, bf.length);
  return BigInt(aw + af.padEnd(scale, '0')) > BigInt(bw + bf.padEnd(scale, '0'));
}
export function inventoryGeometryExceeds(
  child: InventoryDimensions,
  parent: InventoryDimensions,
  turns: 0 | 1 | 2 | 3
): boolean {
  const rotated =
    turns % 2 ? { width: child.depth, height: child.height, depth: child.width } : child;
  return (
    exceeds(rotated.width, parent.width) ||
    exceeds(rotated.height, parent.height) ||
    exceeds(rotated.depth, parent.depth)
  );
}

export function inventoryOrientedDimensions(
  value: InventoryDimensions,
  orientation: import('./inventory-configuration-types').InventoryOrientation
): readonly InventoryDimensions[] {
  if (orientation.kind === 'known')
    return [
      orientation.quarterTurns % 2
        ? { width: value.depth, height: value.height, depth: value.width }
        : value,
    ];
  const { width: w, height: h, depth: d } = value;
  return [
    { width: w, height: h, depth: d },
    { width: w, height: d, depth: h },
    { width: h, height: w, depth: d },
    { width: h, height: d, depth: w },
    { width: d, height: w, depth: h },
    { width: d, height: h, depth: w },
  ];
}
