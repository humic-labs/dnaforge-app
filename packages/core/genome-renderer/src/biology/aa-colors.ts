import { nonStandardResidueColor, getAAColor as getSharedAAColor } from '@waypoint/sequence-utils';

const AA_COLORS: Record<string, number> = {
  A: 0xc8c8c8,
  R: 0x145aff,
  N: 0x00dcdc,
  D: 0xe60a0a,
  C: 0xe6e600,
  Q: 0x00dcdc,
  E: 0xe60a0a,
  G: 0xebebeb,
  H: 0x8282d2,
  I: 0x0f820f,
  L: 0x0f820f,
  K: 0x145aff,
  M: 0xe6e600,
  F: 0x3232aa,
  P: 0xdc9682,
  S: 0xfa9600,
  T: 0xfa9600,
  W: 0xb45ab4,
  Y: 0x3232aa,
  V: 0x0f820f,
  '*': 0xcc0000,
};

const DEFAULT_AA_COLOR = 0x9ca3af;
const STOP_COLOR = 0x9ca3af;

export function getAAColor(aa: string): number {
  return AA_COLORS[aa] ?? DEFAULT_AA_COLOR;
}

export function getCodonFillColor(
  aa: string,
  isStop: boolean,
  residue?: string,
  scheme = 'rasmol'
): number {
  if (isStop) return STOP_COLOR;

  if (residue) return Number.parseInt(nonStandardResidueColor(residue).slice(1), 16);
  return scheme === 'rasmol'
    ? (AA_COLORS[aa] ?? DEFAULT_AA_COLOR)
    : Number.parseInt(getSharedAAColor(aa, scheme).slice(1), 16);
}

export function isLightAAColor(hex: number): boolean {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

export function getAATextColor(aa: string, isStop: boolean): number {
  if (isStop) return 0xcc0000;
  const bg = AA_COLORS[aa] ?? DEFAULT_AA_COLOR;
  return isLightAAColor(bg) ? 0x222222 : 0xffffff;
}

export const CODON_FILL_ALPHA = 0.6;
