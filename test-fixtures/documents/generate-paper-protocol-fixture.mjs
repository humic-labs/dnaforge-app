import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('./paper-protocol-synthetic.pdf', import.meta.url));

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

const pageOne = textStream([
  { fontSize: 18, text: 'DNAForge Paper-to-Protocol Fixture', x: 72, y: 720 },
  { fontSize: 11, text: 'A deterministic synthetic methods paper for behavioral tests.', x: 72, y: 696 },
  { fontSize: 15, text: 'Protein Purification', x: 72, y: 650 },
  {
    fontSize: 12,
    text: 'Cells were lysed in 20 mM Tris at 4 C and centrifuged for 30 min.',
    x: 72,
    y: 620,
  },
  { fontSize: 12, text: 'The cleared lysate was retained on ice.', x: 72, y: 598 },
  { fontSize: 15, text: 'Library Construction', x: 72, y: 540 },
  { fontSize: 12, text: 'Primer sequences are listed in Supplementary Table S3.', x: 72, y: 510 },
  {
    fontSize: 12,
    text: 'The PCR cycling program was performed as described in reference 23.',
    x: 72,
    y: 488,
  },
]);

const pageTwo = textStream([
  { fontSize: 18, text: 'Supplementary Table S3', x: 72, y: 720 },
  { fontSize: 12, text: 'Primer pExample_F was used at 10 uM.', x: 72, y: 680 },
  { fontSize: 12, text: 'Primer pExample_R was used at 10 uM.', x: 72, y: 658 },
]);

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(pageOne)} >>\nstream\n${pageOne}\nendstream`,
  `<< /Length ${Buffer.byteLength(pageTwo)} >>\nstream\n${pageTwo}\nendstream`,
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
