import {
  parseGenBankFull,
  reverseComplement,
  serializeGenBank,
  type Annotation,
} from '@waypoint/sequence-utils';

const LENGTH = 2686;
const REVERSE_ORIGIN = 1603;

export function derivePublicPuc19ScenarioFrame(genbank: string): string {
  const parsed = parseGenBankFull(genbank);
  const featureSection = genbank.split(/^FEATURES[^\n]*$/m)[1]?.split(/^ORIGIN\s*$/m)[0];
  const locations = [...(featureSection ?? '').matchAll(/^ {5}\S+\s+(\S+)\s*$/gm)];
  if (
    !/^VERSION\s+L09137\.2\s*$/m.test(genbank) ||
    !parsed.circular ||
    parsed.length !== LENGTH ||
    parsed.sequence.length !== LENGTH ||
    !/^[ACGT]+$/i.test(parsed.sequence) ||
    locations.length !== parsed.annotations.length ||
    locations.some(
      ([, location]) => !/^(?:\d+(?:\.\.\d+)?|complement\(\d+(?:\.\.\d+)?\))$/.test(location)
    )
  ) {
    throw new Error('The public pUC19 scenario view requires the supported L09137.2 record.');
  }
  const reversed = reverseComplement(parsed.sequence.toUpperCase());
  return serializeGenBank(
    {
      ...parsed,
      name: 'pUC19',
      description:
        'Coordinate view of NCBI L09137.2; reverse complement rotated left 1603 bases. ' +
        (parsed.description ?? ''),
      sequence: reversed.slice(REVERSE_ORIGIN) + reversed.slice(0, REVERSE_ORIGIN),
      annotations: parsed.annotations.map(annotationInScenarioFrame),
    },
    { date: new Date(2002, 4, 22) }
  );
}

function annotationInScenarioFrame(annotation: Annotation): Annotation {
  if (
    !Number.isSafeInteger(annotation.start) ||
    !Number.isSafeInteger(annotation.end) ||
    annotation.start < 1 ||
    annotation.end > LENGTH ||
    annotation.start > annotation.end ||
    annotation.segments?.length ||
    ['transl_except', 'anticodon', 'rpt_unit_range'].some(
      (key) => annotation.qualifiers?.[key]?.length
    )
  ) {
    throw new Error(`Unsupported pUC19 scenario feature: ${annotation.name}`);
  }
  const qualifiers = Object.fromEntries(
    Object.entries(annotation.qualifiers ?? {}).filter(([key]) => key !== '_locationString')
  );
  const direction = annotation.direction === 0 ? 0 : annotation.direction === 1 ? -1 : 1;
  const fullSource =
    annotation.type === 'source' && annotation.start === 1 && annotation.end === LENGTH;
  const position = (base: number) =>
    ((((LENGTH - base - REVERSE_ORIGIN) % LENGTH) + LENGTH) % LENGTH) + 1;
  const start = fullSource ? 1 : position(annotation.end);
  const end = fullSource ? LENGTH : position(annotation.start);
  return {
    ...annotation,
    start,
    end,
    direction,
    qualifiers,
    ...(start > end
      ? {
          segments: [
            { start, end: LENGTH },
            { start: 1, end },
          ],
        }
      : {}),
  };
}
