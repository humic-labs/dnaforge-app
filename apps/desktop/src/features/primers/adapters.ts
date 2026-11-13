import type { PrimerDisplay, OligoMismatch } from '@waypoint/workspace-editor';
import { reverseComplement } from '@waypoint/sequence-utils';
import { LIBRARY_PRIMER_COLOR } from './types';
import type { DbBoundPrimerRow } from './types';
import {
  IDT_MODIFICATION_CATALOG,
  displayIdtToken,
  parseIdtOligoNotation,
  type ParsedIdtOligoNotation,
} from './oligo-modifications';
import { oligoOrderTypeFromOriginDetails } from './oligo-order-type';

export function oligoToPrimerModificationMarkers(
  parsedOligo: ParsedIdtOligoNotation | null
): PrimerDisplay['modificationMarkers'] {
  if (parsedOligo?.errors.length !== 0 || !parsedOligo.composition) return undefined;
  return parsedOligo.composition.modifications.map((modification) => ({
    token: displayIdtToken(modification.vendorCode),
    label:
      IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === modification.vendorCode)
        ?.label ?? modification.vendorCode,
    placement: modification.placement,
    behavior: modification.behavior,
    anchor: modification.anchor,
  }));
}

export function savedPrimerModificationMarkers(primer: {
  vendor: string | null;
  modifications: string | null;
  originDetails: unknown;
}): PrimerDisplay['modificationMarkers'] {
  return oligoToPrimerModificationMarkers(
    primer.vendor?.toLowerCase() === 'idt' && primer.modifications
      ? parseIdtOligoNotation(primer.modifications, {
          orderType: oligoOrderTypeFromOriginDetails(primer.originDetails),
          enforceVendorConstraints: false,
        })
      : null
  );
}

function computeMismatches(primerSequence: string, referenceAtBinding: string): OligoMismatch[] {
  const mismatches: OligoMismatch[] = [];
  const len = Math.min(primerSequence.length, referenceAtBinding.length);

  for (let i = 0; i < len; i++) {
    if (primerSequence[i].toUpperCase() !== referenceAtBinding[i].toUpperCase()) {
      mismatches.push({
        position: i,
        oligoBase: primerSequence[i],
        templateBase: referenceAtBinding[i],
      });
    }
  }

  return mismatches;
}

export function dbPrimerToPrimerDisplay(
  row: DbBoundPrimerRow,
  referenceSequence?: string,
  options: { circular?: boolean } = {}
): PrimerDisplay {
  const start = row.binding_start ?? 0;
  const end = row.binding_end ?? 0;

  const direction: 'forward' | 'reverse' = row.strand === -1 ? 'reverse' : 'forward';

  let mismatches: OligoMismatch[] | undefined;
  const spansOrigin = start > end;
  const bindingLength = spansOrigin
    ? referenceSequence != null
      ? referenceSequence.length - start + end
      : row.sequence.length
    : end - start;
  const overhangLength = Math.max(0, row.sequence.length - Math.max(0, bindingLength));
  const canCompute =
    referenceSequence != null && start < referenceSequence.length && (start < end || spansOrigin);
  if (canCompute) {
    let refSlice: string;
    if (spansOrigin) {
      refSlice = referenceSequence.slice(start) + referenceSequence.slice(0, end);
    } else {
      refSlice = referenceSequence.slice(start, end);
    }
    if (direction === 'reverse') {
      refSlice = reverseComplement(refSlice);
    }
    const rawMismatches = computeMismatches(row.sequence.slice(overhangLength), refSlice).map(
      (mismatch) => ({ ...mismatch, position: mismatch.position + overhangLength })
    );

    if (direction === 'reverse' && rawMismatches.length > 0) {
      const primerLen = row.sequence.length;
      mismatches = rawMismatches.map((mm) => ({
        ...mm,
        position: primerLen - 1 - mm.position,
      }));
    } else {
      mismatches = rawMismatches;
    }
  }

  const modificationMarkers = savedPrimerModificationMarkers({
    vendor: row.vendor,
    modifications: row.modifications,
    originDetails: row.origin_details,
  });
  const bound = row.binding_start != null && row.binding_end != null;
  const fullStart = bound && direction === 'forward' ? start - overhangLength : start;
  const fullEnd = bound && direction === 'reverse' ? end + overhangLength : end;
  const sequenceLength = referenceSequence?.length ?? 0;
  const circular = options.circular ?? spansOrigin;
  const wrap = (position: number) =>
    circular && sequenceLength > 0 && (position < 0 || position > sequenceLength)
      ? ((position % sequenceLength) + sequenceLength) % sequenceLength
      : position;

  return {
    id: row.binding_id,
    sourcePrimerId: row.id,
    name: row.name,
    bases: row.sequence,
    ...(modificationMarkers && modificationMarkers.length > 0 ? { modificationMarkers } : {}),
    start: wrap(fullStart),
    end: wrap(fullEnd),
    direction,
    tm: row.tm ?? 0,
    gc: row.gc_percent ?? 0,
    mismatches,
    overhangLength,
    pbsColor: LIBRARY_PRIMER_COLOR,
  };
}
