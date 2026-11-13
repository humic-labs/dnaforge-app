import type { Primer } from './types';
import { primerIdtOrderText } from '../sequence-clipboard/public/primer-clipboard';
import type { OligoOrderType } from './oligo-modifications';
import { oligoOrderTypeFromOriginDetails } from './oligo-order-type';

function primerOrderType(primer: Primer): OligoOrderType {
  return oligoOrderTypeFromOriginDetails(primer.originDetails);
}

function csvEscape(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function exportPrimersCSV(primers: Primer[]): string {
  const header = 'Name,Sequence,Length (nt),Tm (°C),GC (%),Status';
  const rows = primers.map((p) =>
    [
      csvEscape(p.name),
      p.sequence,
      String(p.length),
      p.tm === null ? '' : String(p.tm),
      String(p.gcPercent),
      p.status,
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export function exportPrimersIDT(primers: Primer[]): string {
  const header = 'Name,Sequence,Scale,Purification';
  const rows = primers.map((p) =>
    [
      csvEscape(p.name),
      primerIdtOrderText(
        p.sequence,
        p.vendor === 'idt' ? p.modifications : null,
        primerOrderType(p)
      ),
      p.scale ?? '25 nmol',
      p.purification ?? 'Standard Desalting',
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export function exportPrimersTSV(primers: Primer[]): string {
  const header = ['Name', 'Sequence', 'Length (nt)', 'Tm (°C)', 'GC (%)', 'Status'].join('\t');
  const rows = primers.map((p) =>
    [
      p.name,
      p.sequence,
      String(p.length),
      p.tm === null ? '' : String(p.tm),
      String(p.gcPercent),
      p.status,
    ].join('\t')
  );
  return [header, ...rows].join('\n');
}
