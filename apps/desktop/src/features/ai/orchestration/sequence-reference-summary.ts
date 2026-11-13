const SUMMARY_FIELDS = [
  'start',
  'end',
  'length',
  'parentLength',
  'wraps',
  'topology',
  'strand',
  'lengthIsCodonMultiple',
  'lengthModThree',
  'gcPercentWholeSelection',
  'gcComputed',
  'gcSpansHeterogeneous',
  'restrictionSitesComputed',
  'motifsComputed',
  'disjoint',
  'regionCount',
  'featureType',
  'lengthBp',
  'proteinLengthAa',
  'translationAvailable',
  'translTable',
  'format',
  'moleculeType',
  'featureCount',
  'functionalGistIsInferred',
] as const;

export function summarizeSequenceReference(
  descriptor: Record<string, unknown>,
  refId: string
): Record<string, unknown> {
  if (
    !['sequence_region', 'annotation', 'whole_entity'].includes(String(descriptor.kind)) ||
    new TextEncoder().encode(JSON.stringify(descriptor)).byteLength <= 4096
  )
    return descriptor;

  const measured =
    descriptor.measured && typeof descriptor.measured === 'object'
      ? (descriptor.measured as Record<string, unknown>)
      : {};
  const summary = Object.fromEntries(
    SUMMARY_FIELDS.flatMap<[string, unknown]>((key) => {
      const value = measured[key];
      if (value === null || typeof value === 'boolean' || typeof value === 'number')
        return [[key, value]];
      if (typeof value === 'string') return [[key, value.slice(0, 120)]];
      return [];
    })
  );
  const detailCounts = Object.fromEntries(
    Object.entries(measured)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).length])
  );
  const locator = descriptor.locator as Record<string, unknown> | undefined;
  return {
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    label: typeof descriptor.label === 'string' ? descriptor.label.slice(0, 200) : undefined,
    locator: { documentId: locator?.documentId, refId },
    coordinateSystem: descriptor.coordinateSystem,
    sourceVersion: descriptor.sourceVersion,
    measured: { ...summary, boundaryFlags: measured.boundaryFlags },
    bases: descriptor.kind === 'whole_entity' ? 'never' : 'not_included',
    fetch: descriptor.fetch,
    promptSummary: {
      detailCounts,
      fullDescriptorResource: `waypoint://selection/${refId}`,
      note: 'Per-feature details are omitted from this prompt summary. Use selection tools with locator.refId for the exact selection; the resource retains the full descriptor.',
    },
  };
}
