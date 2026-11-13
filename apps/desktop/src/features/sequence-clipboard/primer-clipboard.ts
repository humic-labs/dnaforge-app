import {
  parseIdtOligoNotation,
  serializeIdtOligoOrderNotation,
} from '../primers/public/oligo-modifications';
import type { OligoOrderType } from '../primers/public/oligo-modifications';

export function primerIdtOrderText(
  sequence: string,
  notation?: string | null,
  orderType: OligoOrderType = 'dna'
): string {
  const candidate = notation?.trim() ? notation : sequence;
  const parsed = parseIdtOligoNotation(candidate, { orderType });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);
  if (parsed.bases.toUpperCase() !== sequence.trim().toUpperCase()) {
    throw new Error('IDT notation natural bases do not match the primer sequence.');
  }
  return serializeIdtOligoOrderNotation(candidate, orderType);
}

export function primerNaturalBasesText(
  notation: string,
  orderType: OligoOrderType = 'dna'
): string {
  const parsed = parseIdtOligoNotation(notation, { orderType });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);
  return parsed.bases;
}

export async function writePrimerNaturalBasesClipboard(
  notation: string,
  orderType: OligoOrderType = 'dna'
): Promise<void> {
  const text = primerNaturalBasesText(notation, orderType);
  await navigator.clipboard.writeText(text);
}

export async function writePrimerIdtOrderClipboard(
  sequence: string,
  notation?: string | null,
  orderType: OligoOrderType = 'dna'
): Promise<void> {
  await navigator.clipboard.writeText(primerIdtOrderText(sequence, notation, orderType));
}
