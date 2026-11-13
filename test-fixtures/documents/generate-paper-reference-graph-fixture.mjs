import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('./paper-reference-graph-synthetic.pdf', import.meta.url));

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function textStream(lines) {
  return [
    'BT',
    ...lines.flatMap(({ fontSize, text, x, y }) => [
      `/F1 ${fontSize} Tf`,
      `1 0 0 1 ${x} ${y} Tm`,
      `(${escapePdfText(text)}) Tj`,
    ]),
    'ET',
  ].join('\n');
}

const page = textStream([
  { fontSize: 18, text: 'DNAForge Paper Reference Graph Fixture', x: 72, y: 720 },
  {
    fontSize: 11,
    text: 'Deterministic synthetic evidence. No network lookup is intended.',
    x: 72,
    y: 696,
  },
  { fontSize: 15, text: 'Publication identity', x: 72, y: 650 },
  {
    fontSize: 12,
    text: 'This paper is identified as PMCID PMC999999999999.',
    x: 72,
    y: 620,
  },
  { fontSize: 15, text: 'Methods', x: 72, y: 560 },
  {
    fontSize: 12,
    text: 'The upstream method was adapted from doi:10.5555/dnaforge.reference.fixture.',
    x: 72,
    y: 530,
  },
]);

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
];

let pdf = '%PDF-1.4\n% deterministic DNAForge fixture\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}

const xrefOffset = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (const offset of offsets.slice(1)) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

writeFileSync(destination, pdf, 'binary');
