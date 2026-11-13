import {
  molecularViewSchema,
  validateMolecularViewCoordinates,
  type MolecularView,
} from '../page/public/embeds/structure3d/molecularView';
import { measurementColor } from '../page/public/embeds/structure3d/residueMeasurement';

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!
  );

async function checked(view: MolecularView) {
  const parsed = molecularViewSchema.parse(view);
  await validateMolecularViewCoordinates(parsed);
  return parsed;
}

export async function inspectionFigureSvg(input: MolecularView): Promise<string> {
  const view = await checked(input);
  const measurement = view.measurements?.find((item) => item.id === view.activeMeasurementId);
  const lines = [
    view.caption,
    ...(view.source.comparison
      ? [
          `Reference model: ${view.source.comparison.reference.title}; original chain ${view.source.comparison.reference.chainId}.`,
          `Allele model: ${view.source.comparison.alternate.title}; original chain ${view.source.comparison.alternate.chainId}.`,
          `Rigid alignment: ${view.source.comparison.alignment.pairs.length} unchanged alpha-carbon pairs; RMS deviation ${view.source.comparison.alignment.rmsd.toFixed(3)} Å.`,
          'Only selected protein chains are shown. Missing atoms are not reconstructed; models are not a simulated transition.',
        ]
      : []),
    ...(view.source.prediction
      ? [
          `Predicted with ${view.source.prediction.toolId} on ${view.source.prediction.provider}; job ${view.source.prediction.remoteId}.`,
          `Prediction input protein SHA-256: ${view.source.prediction.proteinSequenceSha256}`,
        ]
      : []),
    ...(measurement
      ? [
          `Source: ${measurement.source.label}`,
          `Input revision: ${measurement.source.revision}`,
          ...(measurement.derivation
            ? [
                `log2(after frequency / before frequency), normalized over supplied rows; pseudocount ${measurement.derivation.pseudocount}.`,
              ]
            : []),
          ...(measurement.variantEvidence
            ? [
                measurement.variantEvidence.kind === 'vcf-allele-fraction'
                  ? 'Maximum single-allele fraction per residue; overlapping read counts are not summed.'
                  : `Signed maximum absolute log2(after fraction / before fraction); pseudocount ${measurement.variantEvidence.pseudocount}.`,
                `Variant filters: ${measurement.variantEvidence.filter}; consequences: ${measurement.variantEvidence.effect}. Missing evidence remains unknown.`,
              ]
            : []),
        ]
      : []),
    `Coordinates SHA-256: ${view.coordinates.sha256}`,
  ]
    .filter(Boolean)
    .flatMap((line) => line.match(/.{1,110}(?:\s|$)|.{1,110}/g) ?? []);
  const legendY = 820;
  const footerY = measurement ? legendY + 150 : legendY;
  const height = footerY + lines.length * 24 + 40;
  let legend = '';
  if (measurement) {
    const [low, high] = measurement.scale.domain;
    const log = measurement.scale.transform === 'log10';
    const stops = Array.from({ length: 257 }, (_, i) => {
      const value = log
        ? 10 ** (Math.log10(low) + (i / 256) * (Math.log10(high) - Math.log10(low)))
        : low + (i / 256) * (high - low);
      return `<stop offset="${i / 256}" stop-color="${measurementColor(measurement, value)}"/>`;
    }).join('');
    legend = `<defs><linearGradient id="measurement-colors">${stops}</linearGradient></defs>
      <text x="60" y="${legendY}" font-size="24">${xml(measurement.name)}</text>
      <text x="60" y="${legendY + 28}">${xml(measurement.units || 'value')} · ${measurement.scale.transform}</text>
      <rect x="60" y="${legendY + 44}" width="900" height="18" fill="url(#measurement-colors)"/>
      <text x="60" y="${legendY + 90}">${low}</text>
      <text x="960" y="${legendY + 90}" text-anchor="end">${high}</text>
      <rect x="1000" y="${legendY + 44}" width="18" height="18" fill="${measurement.scale.missingColor}"/>
      <text x="1028" y="${legendY + 60}">No measurement</text>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${height}" viewBox="0 0 1400 ${height}">
  <title>${xml(view.title)}</title>
  <metadata id="dnaforge-molecular-view">${xml(JSON.stringify(view))}</metadata>
  <rect width="1400" height="${height}" fill="white"/>
  <g font-family="Arial, sans-serif" font-size="18" fill="#111827">
    <text x="60" y="48" font-size="28">${xml(view.title)}</text>
    <image x="60" y="72" width="1280" height="710" href="${view.preview}" preserveAspectRatio="xMidYMid meet"/>
    ${legend}
    ${lines.map((line, index) => `<text x="60" y="${footerY + index * 24}">${xml(line.trim())}</text>`).join('\n')}
  </g>
</svg>\n`;
}

const csvCell = (value: string | number | null | undefined) => {
  if (value == null) return '';
  const text = String(value);
  const safe = typeof value === 'string' && /^[=+@\t\r-]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function inspectionMeasurementsCsv(input: MolecularView): Promise<string> {
  const view = await checked(input);
  const rows: Array<Array<string | number | null | undefined>> = [
    [
      'measurement_id',
      'measurement',
      'protein_sequence_sha256',
      'source',
      'analysis_id',
      'input_revision',
      'units',
      'residue',
      'value',
      'value_status',
      'color',
      'scale',
      'domain_low',
      'domain_high',
      'before_count',
      'after_count',
      'pseudocount',
      'coordinate_sha256',
    ],
  ];
  for (const measurement of view.measurements ?? []) {
    const counts = new Map(measurement.derivation?.counts.map((row) => [row.residue, row]));
    for (const point of measurement.values)
      rows.push([
        measurement.id,
        measurement.name,
        measurement.proteinSequenceSha256,
        measurement.source.label,
        measurement.source.analysisId,
        measurement.source.revision,
        measurement.units,
        point.residue,
        point.value,
        point.value === null ? 'missing' : 'measured',
        measurementColor(measurement, point.value),
        measurement.scale.transform,
        ...measurement.scale.domain,
        counts.get(point.residue)?.before,
        counts.get(point.residue)?.after,
        measurement.derivation?.pseudocount ?? measurement.variantEvidence?.pseudocount,
        view.coordinates.sha256,
      ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
