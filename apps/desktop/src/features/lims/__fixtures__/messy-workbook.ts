import * as XLSX from 'xlsx';

export const STRAINS_ROWS: string[][] = [
  ['MG1655', 'F- lambda- ilvG- rfb-50 rph-1', 'Escherichia coli'],
  ['W3110', 'F- lambda- IN(rrnD-rrnE)1 rph-1', 'Escherichia coli'],
  ['DH5alpha', 'fhuA2 Delta(argF-lacZ)U169 phoA glnV44 recA1', 'Escherichia coli'],
  ['DH10B', 'F- endA1 recA1 galE15 galK16 nupG rpsL', 'Escherichia coli'],
  ['BL21(DE3)', 'F- ompT hsdSB(rB- mB-) gal dcm (DE3)', 'Escherichia coli'],
  ['BL21-AI', 'F- ompT hsdSB(rB- mB-) gal dcm araB::T7RNAP-tetA', 'Escherichia coli'],
  ['Rosetta(DE3)', 'F- ompT hsdSB gal dcm (DE3) pRARE', 'Escherichia coli'],
  ['C41(DE3)', 'F- ompT hsdSB(rB- mB-) gal dcm (DE3)', 'Escherichia coli'],
  ['C43(DE3)', 'F- ompT hsdSB(rB- mB-) gal dcm (DE3)', 'Escherichia coli'],
  ['JM109', 'endA1 recA1 gyrA96 thi hsdR17 relA1', 'Escherichia coli'],
  ['XL1-Blue', 'recA1 endA1 gyrA96 thi-1 hsdR17 supE44', 'Escherichia coli'],
  ['TOP10', 'F- mcrA Delta(mrr-hsdRMS-mcrBC) araD139', 'Escherichia coli'],
  ['NEB5alpha', 'fhuA2 Delta(argF-lacZ)U169 recA1 endA1', 'Escherichia coli'],
  ['MDS42', 'reduced-genome MG1655 derivative', 'Escherichia coli'],
  ['Nissle1917', 'serotype O6:K5:H1 probiotic isolate', 'Escherichia coli'],
  ['W1485', 'F+ lambda- rph-1', 'Escherichia coli'],
  ['HB101', 'F- hsdS20 recA13 ara-14 proA2 lacY1', 'Escherichia coli'],
  ['MC1061', 'araD139 Delta(ara-leu)7696 galE15 galK16', 'Escherichia coli'],
  ['BW25113', 'lacIq rrnB3 DeltalacZ4787 hsdR514', 'Escherichia coli'],
  ['K-12', 'wild-type reference', 'Escherichia coli'],
  ['S288C', 'MATalpha SUC2 gal2 mal2 mel flo1 flo8-1', 'Saccharomyces cerevisiae'],
  ['BY4741', 'MATa his3-1 leu2-0 met15-0 ura3-0', 'Saccharomyces cerevisiae'],
  ['BY4742', 'MATalpha his3-1 leu2-0 lys2-0 ura3-0', 'Saccharomyces cerevisiae'],
  ['W303', 'MATa leu2-3 ura3-1 trp1-1 his3-11 ade2-1', 'Saccharomyces cerevisiae'],
  ['CEN.PK113-7D', 'MATa MAL2-8c SUC2 prototroph', 'Saccharomyces cerevisiae'],
  ['SK1', 'MATa homozygous rapid-sporulation isolate', 'Saccharomyces cerevisiae'],
  ['FY4', 'prototrophic S288C derivative', 'Saccharomyces cerevisiae'],
  ['RM11-1a', 'MATa vineyard natural isolate', 'Saccharomyces cerevisiae'],
  ['Sigma1278b', 'MATa filamentous-growth background', 'Saccharomyces cerevisiae'],
  ['D273-10B', 'petite-negative respiratory reference', 'Saccharomyces cerevisiae'],
  ['AB1380', 'MATa YAC host psi+ ade2-1 can1-100', 'Saccharomyces cerevisiae'],
  ['JD52', 'MATa trp1 ura3 lys2 leu2 his3', 'Saccharomyces cerevisiae'],
  ['Y187', 'MATalpha two-hybrid reporter strain', 'Saccharomyces cerevisiae'],
  ['AH109', 'MATa two-hybrid reporter strain', 'Saccharomyces cerevisiae'],
];

export function buildStrainsUnderTitleSheet(): string[][] {
  return [
    ['Supplementary Table S3 — Strains', '', ''],
    ['', '', ''],
    ['Strain', 'Genotype', 'Organism'],
    ...STRAINS_ROWS.map((row) => [...row]),
  ];
}

const DNA_BASES = 'ACGT';

function fakeSequence(seed: number, length: number): string {
  let out = '';
  let n = seed * 2654435761;
  for (let i = 0; i < length; i += 1) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    out += DNA_BASES[(n >>> (i % 24)) % 4];
  }
  return out;
}

export function buildHeaderlessOligoSheet(): string[][] {
  const rows: string[][] = [];
  const cols = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 34; i += 1) {
    const well = `${cols[i % cols.length]}${Math.floor(i / cols.length) + 1}`;
    rows.push([well, `oligo-${i + 1}`, fakeSequence(i + 1, 22)]);
  }
  return rows;
}

export function buildSideBySideSheet(): string[][] {
  return [
    ['Strain', 'Genotype', '', 'Plasmid', 'Marker'],
    ['MG1655', 'wild-type', '', 'pUC19', 'ampR'],
    ['DH5alpha', 'recA1 endA1', '', 'pET28a', 'kanR'],
    ['BL21(DE3)', 'lon ompT', '', 'pACYC184', 'cmR'],
    ['TOP10', 'mcrA background', '', 'pBAD33', 'cmR'],
  ];
}

function buildTinyPrimerSheet(): string[][] {
  return [
    ['Name', 'Sequence'],
    ['tiny-fwd-1', 'ACGTACGTACGT'],
  ];
}

const METADATA_NAMES = ['Readme', 'Notes', 'Legend', 'About', 'Metadata', 'Index', 'Toc'];

interface NamedSheet {
  name: string;
  aoa: string[][];
}

function buildNoiseSheets(): NamedSheet[] {
  const sheets: NamedSheet[] = [];
  for (let i = 0; i < 183; i += 1) {
    const bucket = i % 4;
    if (bucket === 0) {
      sheets.push({ name: `Blank${i}`, aoa: [['']] });
    } else if (bucket === 1) {
      const stem = METADATA_NAMES[i % METADATA_NAMES.length];
      sheets.push({
        name: `${stem}${i}`,
        aoa: [
          ['This sheet documents the column legend and provenance notes for downstream reviewers.'],
        ],
      });
    } else if (bucket === 2) {
      sheets.push({
        name: `KeyVals${i}`,
        aoa: [
          ['Author', 'Jane Q. Researcher'],
          [
            'Project',
            'This dataset was assembled for the  import-wizard demonstration workbook.',
          ],
          ['Version', '1'],
        ],
      });
    } else {
      sheets.push({ name: `Sparse${i}`, aoa: [['n/a', '-']] });
    }
  }
  return sheets;
}

export function build187SheetWorkbook(): ArrayBuffer {
  const ordered: NamedSheet[] = [
    { name: 'Strains', aoa: buildStrainsUnderTitleSheet() },
    { name: 'Oligos', aoa: buildHeaderlessOligoSheet() },
    { name: 'SideBySide', aoa: buildSideBySideSheet() },
    { name: 'TinyPrimers', aoa: buildTinyPrimerSheet() },
    ...buildNoiseSheets(),
  ];

  const workbook = XLSX.utils.book_new();
  for (const { name, aoa } of ordered) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), name);
  }

  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as
    | ArrayBuffer
    | Uint8Array;
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
