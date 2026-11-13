export interface ParsedPrimer {
  name: string;
  sequence: string;
  notes?: string;
}

export interface ParseResult {
  primers: ParsedPrimer[];
  errors: Array<{ row: number; reason: string }>;
  format: 'csv' | 'tsv';
  headerMapping: Record<string, string>;
  hadDirectionColumn: boolean;
}

const DNA_REGEX = /^[ATCGURYSWKMBDHVNatcguryswkmbdhvn\s*]+$/;
const MIN_SEQUENCE_LENGTH = 10;

const HEADER_ALIASES: Record<string, string> = {
  name: 'name',
  'primer name': 'name',
  'primer id': 'name',
  'oligo name': 'name',
  'oligo id': 'name',
  'sequence name': 'name',
  id: 'name',
  sequence: 'sequence',
  seq: 'sequence',
  'oligo sequence': 'sequence',
  oligo: 'sequence',
  'primer sequence': 'sequence',
  bases: 'sequence_alt',
  direction: 'direction',
  orientation: 'direction',
  strand: 'direction',
  description: 'notes',
  notes: 'notes',
  purpose: 'notes',
  target: 'notes',
  well: 'well',
  'well position': 'well',
  tm: 'tm',
  'melting temp': 'tm',
  'tm (50mm nacl) c': 'tm',
  'gc content': 'gc',
  'gc%': 'gc',
  purification: 'purification',
};

function detectDelimiter(text: string): ',' | '\t' {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function looksLikeDNA(value: string): boolean {
  const trimmed = value.replace(/\s/g, '').replace(/\*/g, '');
  return trimmed.length >= MIN_SEQUENCE_LENGTH && DNA_REGEX.test(trimmed);
}

function isHeaderRow(fields: string[]): boolean {
  return fields.some((f) => {
    const lower = f.trim().toLowerCase();
    return lower in HEADER_ALIASES;
  });
}

function mapHeaders(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const lower = headers[i].trim().toLowerCase();
    const canonical = HEADER_ALIASES[lower];
    if (canonical) {
      if (canonical === 'sequence_alt' && Object.values(mapping).includes('sequence')) {
        continue;
      }
      if (canonical === 'sequence_alt') {
        mapping[i] = 'sequence';
      } else {
        mapping[i] = canonical;
      }
    }
  }
  return mapping;
}

function cleanSequence(raw: string): string {
  return raw.replace(/[\s*]/g, '');
}

export function parsePrimerFile(text: string, _filename: string): ParseResult {
  if (!text || !text.trim()) {
    return {
      primers: [],
      errors: [{ row: 0, reason: 'Empty file' }],
      format: 'csv',
      headerMapping: {},
      hadDirectionColumn: false,
    };
  }

  const delimiter = detectDelimiter(text);
  const format = delimiter === '\t' ? 'tsv' : 'csv';
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return {
      primers: [],
      errors: [{ row: 0, reason: 'No data rows' }],
      format,
      headerMapping: {},
      hadDirectionColumn: false,
    };
  }

  const firstFields = parseCSVLine(lines[0], delimiter);
  const hasHeaders = isHeaderRow(firstFields);

  let columnMap: Record<number, string>;
  let dataStartIdx: number;

  if (hasHeaders) {
    columnMap = mapHeaders(firstFields);
    dataStartIdx = 1;
  } else {
    columnMap = {};
    for (let i = 0; i < firstFields.length; i++) {
      if (looksLikeDNA(firstFields[i])) {
        columnMap[i] = 'sequence';
        if (i > 0) columnMap[i - 1] = 'name';
        if (i + 1 < firstFields.length && !looksLikeDNA(firstFields[i + 1])) {
          columnMap[i + 1] = 'notes';
        }
        break;
      }
    }
    dataStartIdx = 0;
  }

  const headerMapping: Record<string, string> = {};
  for (const [idx, field] of Object.entries(columnMap)) {
    const headerName = hasHeaders ? firstFields[parseInt(idx)] : `Column ${parseInt(idx) + 1}`;
    headerMapping[headerName] = field;
  }

  const seqColIdx = Object.entries(columnMap).find(([, v]) => v === 'sequence')?.[0];
  const nameColIdx = Object.entries(columnMap).find(([, v]) => v === 'name')?.[0];
  const notesColIdx = Object.entries(columnMap).find(([, v]) => v === 'notes')?.[0];
  const hadDirectionColumn = Object.values(columnMap).includes('direction');

  if (seqColIdx === undefined) {
    return {
      primers: [],
      errors: [{ row: 0, reason: 'Could not identify sequence column' }],
      format,
      headerMapping,
      hadDirectionColumn,
    };
  }

  const primers: ParsedPrimer[] = [];
  const errors: Array<{ row: number; reason: string }> = [];

  for (let i = dataStartIdx; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i], delimiter);
    const rawSeq = fields[parseInt(seqColIdx)]?.trim() || '';
    const rawName = nameColIdx != null ? fields[parseInt(nameColIdx)]?.trim() || '' : '';
    const rawNotes = notesColIdx != null ? fields[parseInt(notesColIdx)]?.trim() : undefined;

    if (!rawSeq) continue;

    const sequence = cleanSequence(rawSeq);

    if (sequence.length < MIN_SEQUENCE_LENGTH) {
      errors.push({
        row: i + 1,
        reason: `Sequence too short (${sequence.length}bp, min ${MIN_SEQUENCE_LENGTH})`,
      });
      continue;
    }
    if (!DNA_REGEX.test(sequence)) {
      errors.push({ row: i + 1, reason: `invalid sequence characters` });
      continue;
    }

    primers.push({
      name: rawName || `Primer_${primers.length + 1}`,
      sequence,
      notes: rawNotes || undefined,
    });
  }

  return { primers, errors, format, headerMapping, hadDirectionColumn };
}
