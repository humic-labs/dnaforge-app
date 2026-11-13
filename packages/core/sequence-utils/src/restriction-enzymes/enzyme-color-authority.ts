export const ENZYME_COLOR_PALETTE = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#0891b2',
  '#f032e6',
  '#65a30d',
  '#db2777',
  '#469990',
  '#7c3aed',
  '#9A6324',
  '#ca8a04',
  '#800000',
  '#059669',
  '#808000',
  '#c2410c',
  '#000075',
] as const;

export interface EnzymeColor {
  hex: string;
  int: number;
}

const HEX6_RE = /^[0-9a-fA-F]{6}$/;

export function hexToEnzymeColorInt(hex: string): number {
  let body = hex.startsWith('#') ? hex.slice(1) : hex;
  if (body.length === 3) {
    body = body
      .split('')
      .map((ch) => ch + ch)
      .join('');
  } else if (body.length === 8) {
    body = body.slice(0, 6);
  }
  if (!HEX6_RE.test(body)) return 0x000000;
  return Number.parseInt(body, 16);
}

export const ENZYME_COLOR_PALETTE_INT: readonly number[] =
  ENZYME_COLOR_PALETTE.map(hexToEnzymeColorInt);

export function enzymeColorAt(activeIndex: number): EnzymeColor {
  const len = ENZYME_COLOR_PALETTE.length;
  const i = ((activeIndex % len) + len) % len;
  return { hex: ENZYME_COLOR_PALETTE[i], int: ENZYME_COLOR_PALETTE_INT[i] };
}

export function enzymeColorHexAt(activeIndex: number): string {
  return enzymeColorAt(activeIndex).hex;
}

export function assignEnzymeColors(
  orderedActiveNames: readonly string[]
): Map<string, EnzymeColor> {
  const map = new Map<string, EnzymeColor>();
  orderedActiveNames.forEach((name, index) => {
    if (!map.has(name)) {
      map.set(name, enzymeColorAt(index));
    }
  });
  return map;
}
