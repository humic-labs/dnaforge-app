import { RawAtom, RawStructure, SSRange, StructureParseError } from './types';

interface Table {
  fields: string[];
  rows: (string | null)[][];
}

/** Tokenise CIF text: handles quoted values, ;-delimited text fields and comments. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(';')) {
      const buf = [line.substring(1)];
      i++;
      while (i < lines.length && !lines[i].startsWith(';')) buf.push(lines[i++]);
      tokens.push('\u0000' + buf.join('\n').trim()); // \0 marks a quoted value
      continue;
    }
    let p = 0;
    const n = line.length;
    while (p < n) {
      const c = line[p];
      if (c === ' ' || c === '\t') {
        p++;
        continue;
      }
      if (c === '#') break;
      if (c === "'" || c === '"') {
        // A quote closes only when followed by whitespace or end of line.
        let q = p + 1;
        while (q < n && !(line[q] === c && (q + 1 === n || line[q + 1] === ' ' || line[q + 1] === '\t'))) q++;
        tokens.push('\u0000' + line.substring(p + 1, q));
        p = q + 1;
        continue;
      }
      let q = p;
      while (q < n && line[q] !== ' ' && line[q] !== '\t') q++;
      tokens.push(line.substring(p, q));
      p = q;
    }
  }
  return tokens;
}

const value = (tok: string): string | null => {
  if (tok.charCodeAt(0) === 0) return tok.substring(1);
  return tok === '?' || tok === '.' ? null : tok;
};

/** Parse the first data block into category tables (only categories in `wanted`). */
function parseTables(text: string, wanted: Set<string>): Map<string, Table> {
  const tokens = tokenize(text);
  const tables = new Map<string, Table>();
  let i = 0;
  let blocks = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('data_')) {
      if (++blocks > 1) break;
      i++;
      continue;
    }
    if (t === 'loop_') {
      i++;
      const fields: string[] = [];
      let cat = '';
      while (i < tokens.length && tokens[i].startsWith('_')) {
        const [c, f] = tokens[i].substring(1).split('.');
        cat = c;
        fields.push(f);
        i++;
      }
      const rows: (string | null)[][] = [];
      const keep = wanted.has(cat);
      while (i < tokens.length) {
        const tk = tokens[i];
        if (tk.charCodeAt(0) !== 0 && (tk.startsWith('_') || tk === 'loop_' || tk.startsWith('data_'))) break;
        if (rows.length === 0 || rows[rows.length - 1].length === fields.length) rows.push([]);
        rows[rows.length - 1].push(keep ? value(tk) : null);
        i++;
      }
      if (keep) {
        if (rows.length && rows[rows.length - 1].length !== fields.length) {
          throw new StructureParseError(`mmCIF loop _${cat}: value count does not match field count`);
        }
        tables.set(cat, { fields, rows });
      }
      continue;
    }
    if (t.startsWith('_')) {
      const [cat, f] = t.substring(1).split('.');
      const v = i + 1 < tokens.length ? value(tokens[i + 1]) : null;
      if (wanted.has(cat)) {
        let tb = tables.get(cat);
        if (!tb) tables.set(cat, (tb = { fields: [], rows: [[]] }));
        tb.fields.push(f);
        tb.rows[0].push(v);
      }
      i += 2;
      continue;
    }
    i++;
  }
  return tables;
}

function getter(tb: Table) {
  const idx = new Map(tb.fields.map((f, k) => [f, k]));
  return (row: (string | null)[], ...names: string[]) => {
    for (const n of names) {
      const k = idx.get(n);
      if (k !== undefined && row[k] !== null) return row[k] as string;
    }
    return null;
  };
}

/** Parse a PDBx/mmCIF file (first data block, first model). Uses author chain/residue numbering. */
export function parseMMCIF(text: string, fallbackId = 'structure'): RawStructure {
  const tables = parseTables(text, new Set(['atom_site', 'struct_conf', 'struct_sheet_range', 'struct', 'entry']));
  const as = tables.get('atom_site');
  if (!as || as.rows.length === 0) throw new StructureParseError('mmCIF file has no _atom_site records.');
  const g = getter(as);
  const notes: string[] = [];
  const atoms: RawAtom[] = [];
  let firstModel: string | null = null;
  const models = new Set<string>();
  for (const r of as.rows) {
    const model = g(r, 'pdbx_PDB_model_num') ?? '1';
    models.add(model);
    if (firstModel === null) firstModel = model;
    if (model !== firstModel) continue;
    const x = parseFloat(g(r, 'Cartn_x') ?? '');
    const y = parseFloat(g(r, 'Cartn_y') ?? '');
    const z = parseFloat(g(r, 'Cartn_z') ?? '');
    const seqStr = g(r, 'auth_seq_id', 'label_seq_id');
    const resSeq = seqStr === null ? NaN : parseInt(seqStr, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new StructureParseError('mmCIF _atom_site contains invalid coordinates.');
    }
    const name = g(r, 'auth_atom_id', 'label_atom_id') ?? '';
    atoms.push({
      record: g(r, 'group_PDB') === 'HETATM' ? 'HETATM' : 'ATOM',
      name,
      altLoc: g(r, 'label_alt_id') ?? '',
      resName: g(r, 'auth_comp_id', 'label_comp_id') ?? 'UNK',
      chainId: g(r, 'auth_asym_id', 'label_asym_id') ?? '',
      resSeq: Number.isFinite(resSeq) ? resSeq : 0,
      iCode: g(r, 'pdbx_PDB_ins_code') ?? '',
      x,
      y,
      z,
      occupancy: parseFloat(g(r, 'occupancy') ?? '1') || 1,
      bFactor: parseFloat(g(r, 'B_iso_or_equiv') ?? '0') || 0,
      element: (g(r, 'type_symbol') ?? name.charAt(0)).toUpperCase(),
    });
  }
  if (models.size > 1) notes.push(`File contains ${models.size} models; only model ${firstModel} is used.`);

  const ssRanges: SSRange[] = [];
  const conf = tables.get('struct_conf');
  if (conf) {
    const c = getter(conf);
    for (const r of conf.rows) {
      const type = c(r, 'conf_type_id') ?? '';
      if (!type.startsWith('HELX')) continue;
      ssRanges.push({
        type: 'H',
        start: { chainId: c(r, 'beg_auth_asym_id', 'beg_label_asym_id') ?? '', resSeq: parseInt(c(r, 'beg_auth_seq_id', 'beg_label_seq_id') ?? '0', 10), iCode: c(r, 'pdbx_beg_PDB_ins_code') ?? '' },
        end: { chainId: c(r, 'end_auth_asym_id', 'end_label_asym_id') ?? '', resSeq: parseInt(c(r, 'end_auth_seq_id', 'end_label_seq_id') ?? '0', 10), iCode: c(r, 'pdbx_end_PDB_ins_code') ?? '' },
      });
    }
  }
  const sheet = tables.get('struct_sheet_range');
  if (sheet) {
    const c = getter(sheet);
    for (const r of sheet.rows) {
      ssRanges.push({
        type: 'E',
        start: { chainId: c(r, 'beg_auth_asym_id', 'beg_label_asym_id') ?? '', resSeq: parseInt(c(r, 'beg_auth_seq_id', 'beg_label_seq_id') ?? '0', 10), iCode: c(r, 'pdbx_beg_PDB_ins_code') ?? '' },
        end: { chainId: c(r, 'end_auth_asym_id', 'end_label_asym_id') ?? '', resSeq: parseInt(c(r, 'end_auth_seq_id', 'end_label_seq_id') ?? '0', 10), iCode: c(r, 'pdbx_end_PDB_ins_code') ?? '' },
      });
    }
  }
  const entry = tables.get('entry');
  const struct = tables.get('struct');
  const id = (entry && getter(entry)(entry.rows[0], 'id')) || fallbackId;
  const title = (struct && getter(struct)(struct.rows[0], 'title')) || '';
  return { id, title, format: 'mmcif', atoms, ssRanges, notes };
}
