import fs from 'node:fs';

type JsonRecord = Record<string, unknown>;

interface BenchmarkArtifact {
  source?: unknown;
  engine?: unknown;
  mode?: unknown;
  selectedCases?: unknown;
  attemptedCases?: unknown;
  stopReason?: unknown;
  summary?: unknown;
  productFirstDiagnosticsAggregate?: unknown;
  cases?: unknown;
}

const artifactPath = process.argv[2] ?? process.env.ASSEMBLY_BENCHMARK_ASSERT_ARTIFACT;

if (!artifactPath) {
  throw new Error(
    'Provide a benchmark artifact path as argv[2] or ASSEMBLY_BENCHMARK_ASSERT_ARTIFACT.'
  );
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as BenchmarkArtifact;
const summary = asRecord(artifact.summary, 'summary');
const aggregate = optionalRecord(artifact.productFirstDiagnosticsAggregate);
const v4Aggregate = optionalRecord(aggregate?.v4);
const caseRecords = arrayRecords(artifact.cases);
const failures: string[] = [];
const attemptedCases = numberValue(artifact.attemptedCases) ?? numberValue(artifact.selectedCases);

checkExpectedString(
  'source',
  stringValue(artifact.source),
  envString('ASSEMBLY_BENCHMARK_ASSERT_SOURCE')
);
checkExpectedString(
  'engine',
  stringValue(artifact.engine),
  envString('ASSEMBLY_BENCHMARK_ASSERT_ENGINE')
);
checkExpectedString(
  'mode',
  stringValue(artifact.mode),
  envString('ASSEMBLY_BENCHMARK_ASSERT_MODE')
);

const allowedStopReasons = envStringList('ASSEMBLY_BENCHMARK_ASSERT_ALLOWED_STOP_REASONS');
if (allowedStopReasons.length > 0) {
  const stopReason = stringValue(artifact.stopReason) ?? 'none';
  if (!allowedStopReasons.includes(stopReason)) {
    failures.push(
      `stopReason expected one of ${allowedStopReasons.join(', ')}, received ${stopReason}`
    );
  }
}

checkMin('cases', attemptedCases, envNumber('ASSEMBLY_BENCHMARK_ASSERT_MIN_CASES') ?? 1);
checkMax(
  'errors',
  numberValue(summary.errors),
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_ERRORS') ?? 0
);
checkMax(
  'timeouts',
  numberValue(summary.timeouts),
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_TIMEOUTS') ?? 0
);
checkMax(
  'totalTime',
  numberValue(summary.totalTime),
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_TOTAL_TIME_MS')
);

checkMinFromEnv(summary, 'biologyCorrect', 'ASSEMBLY_BENCHMARK_ASSERT_MIN_BIOLOGY');
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'biologyCorrect',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_BIOLOGY_PCT'
);
checkMinFromEnv(summary, 'templatePass', 'ASSEMBLY_BENCHMARK_ASSERT_MIN_TEMPLATE');
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'templatePass',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_TEMPLATE_PCT'
);
checkMinFromEnv(summary, 'canonicalTemplateExact', 'ASSEMBLY_BENCHMARK_ASSERT_MIN_CANONICAL');
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'canonicalTemplateExact',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_CANONICAL_PCT'
);
checkMinFromEnv(summary, 'primerExact', 'ASSEMBLY_BENCHMARK_ASSERT_MIN_PRIMER');
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'primerExact',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_PRIMER_PCT'
);
checkMinFromEnv(
  summary,
  'rankedAlternativeBiologyCorrect',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_BIOLOGY'
);
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'rankedAlternativeBiologyCorrect',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_BIOLOGY_PCT'
);
checkMinFromEnv(
  summary,
  'rankedAlternativeTemplatePass',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_TEMPLATE'
);
checkMinFromEnv(
  summary,
  'rankedAlternativePrimerExact',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_PRIMER'
);
checkMinFromEnv(
  summary,
  'totalReconstructionVerified',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RECONSTRUCTED'
);

checkMinPctFromEnv(
  summary,
  attemptedCases,
  'rankedAlternativeTemplatePass',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_TEMPLATE_PCT'
);
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'rankedAlternativePrimerExact',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RANKED_ALT_PRIMER_PCT'
);
checkMinPctFromEnv(
  summary,
  attemptedCases,
  'totalReconstructionVerified',
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_RECONSTRUCTED_PCT'
);

checkRequiredCaseValues('method', envStringList('ASSEMBLY_BENCHMARK_ASSERT_REQUIRE_METHODS'));
checkRequiredCaseValues(
  'benchmarkFamily',
  envStringList('ASSEMBLY_BENCHMARK_ASSERT_REQUIRE_FAMILIES')
);

const maxCaseDuration = maxCaseNumber(['durationMs']);
checkMax(
  'max case durationMs',
  maxCaseDuration,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_CASE_DURATION_MS')
);

if (envFlag('ASSEMBLY_BENCHMARK_ASSERT_REQUIRE_GRAPH_SUMMARY')) {
  const missingGraphSummary =
    caseRecords.length === 0
      ? (attemptedCases ?? 1)
      : caseRecords.filter(
          (record) => !optionalRecord(getPath(record, ['graphSummary', 'integrity']))
        ).length;
  checkMax('cases missing graphSummary.integrity', missingGraphSummary, 0);
}

const graphStructuralIssueCases = caseRecords.filter(
  (record) =>
    booleanValue(getPath(record, ['graphSummary', 'integrity', 'hasStructuralIssues'])) === true
).length;
checkMax(
  'graph structural issue cases',
  graphStructuralIssueCases,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_STRUCTURAL_ISSUE_CASES')
);
checkCaseMetricMax(
  'graph missing physical edge endpoints',
  ['graphSummary', 'integrity', 'missingPhysicalEdgeEndpointCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_MISSING_PHYSICAL_EDGE_ENDPOINTS'
);
checkCaseMetricMax(
  'graph missing alternative edge endpoints',
  ['graphSummary', 'integrity', 'missingAlternativeEdgeEndpointCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_MISSING_ALTERNATIVE_EDGE_ENDPOINTS'
);
checkCaseMetricMax(
  'graph missing lineage edge endpoints',
  ['graphSummary', 'integrity', 'missingLineageEdgeEndpointCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_MISSING_LINEAGE_EDGE_ENDPOINTS'
);
checkCaseMetricMax(
  'graph missing source coverage edge endpoints',
  ['graphSummary', 'integrity', 'missingSourceCoverageEdgeEndpointCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_MISSING_SOURCE_COVERAGE_EDGE_ENDPOINTS'
);
checkCaseMetricMax(
  'graph physical self edges',
  ['graphSummary', 'integrity', 'selfPhysicalEdgeCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_SELF_PHYSICAL_EDGES'
);
checkCaseMetricMax(
  'graph alternative self edges',
  ['graphSummary', 'integrity', 'selfAlternativeEdgeCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_SELF_ALTERNATIVE_EDGES'
);
checkCaseMetricMax(
  'graph invalid product set nodes',
  ['graphSummary', 'integrity', 'invalidProductSetNodeCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_INVALID_PRODUCT_SET_NODES'
);
checkCaseMetricMax(
  'graph unresolved cycle components',
  ['graphSummary', 'integrity', 'cycleUnresolvedComponentCount'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_UNRESOLVED_CYCLE_COMPONENTS'
);
checkCaseMetricMax(
  'graph reconstruction options',
  ['graphSummary', 'reconstructionOptions'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_RECONSTRUCTION_OPTIONS'
);
checkCaseMetricMin(
  'graph reconstruction options',
  ['graphSummary', 'reconstructionOptions'],
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_GRAPH_RECONSTRUCTION_OPTIONS'
);
if (envFlag('ASSEMBLY_BENCHMARK_ASSERT_REQUIRE_GRAPH_SEMANTICS')) {
  const missingGraphSemantics =
    caseRecords.length === 0
      ? (attemptedCases ?? 1)
      : caseRecords.filter(
          (record) => !optionalRecord(getPath(record, ['graphSummary', 'semantic']))
        ).length;
  checkMax('cases missing graphSummary.semantic', missingGraphSemantics, 0);
}
checkCasePredicateMax(
  'graph semantic violation cases',
  (record) =>
    (numberValue(getPath(record, ['graphSummary', 'semantic', 'violationCount'])) ?? 0) > 0,
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_GRAPH_SEMANTIC_VIOLATION_CASES'
);
checkCasePredicateMin(
  'graph physical edge cases',
  (record) => (numberValue(getPath(record, ['graphSummary', 'physicalEdges'])) ?? 0) > 0,
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_GRAPH_PHYSICAL_EDGE_CASES'
);
checkCasePredicateMin(
  'graph physical reconstruction option cases',
  (record) =>
    (numberValue(getPath(record, ['graphSummary', 'physicalReconstructionOptions'])) ?? 0) > 0,
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_GRAPH_PHYSICAL_OPTION_CASES'
);
checkCasePredicateMin(
  'graph physically verified status cases',
  (record) =>
    (numberValue(
      getPath(record, ['graphSummary', 'productStatusSummary', 'physicallyVerifiedProducts'])
    ) ?? 0) > 0,
  'ASSEMBLY_BENCHMARK_ASSERT_MIN_GRAPH_PHYSICALLY_VERIFIED_STATUS_CASES'
);

checkV4Max('rawEndpoints', 'ASSEMBLY_BENCHMARK_ASSERT_MAX_RAW_ENDPOINTS');
checkV4MaxPerCase('rawEndpoints', 'ASSEMBLY_BENCHMARK_ASSERT_MAX_RAW_ENDPOINTS_PER_CASE');
checkV4Max('compactedEndpoints', 'ASSEMBLY_BENCHMARK_ASSERT_MAX_COMPACTED_ENDPOINTS');
checkV4MaxPerCase(
  'compactedEndpoints',
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_COMPACTED_ENDPOINTS_PER_CASE'
);
checkV4Max('nativePhysicalDurationMs', 'ASSEMBLY_BENCHMARK_ASSERT_MAX_NATIVE_PHYSICAL_MS');
checkV4MaxPerCase(
  'nativePhysicalDurationMs',
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_NATIVE_PHYSICAL_MS_PER_CASE'
);
checkV4Max('endpointScaleSeedHits', 'ASSEMBLY_BENCHMARK_ASSERT_MAX_ENDPOINT_SCALE_SEED_HITS');
checkV4MaxPerCase(
  'endpointScaleSeedHits',
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_ENDPOINT_SCALE_SEED_HITS_PER_CASE'
);
checkV4Max(
  'endpointScaleIntervalsEmitted',
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_ENDPOINT_SOURCE_INTERVALS'
);
checkV4MaxPerCase(
  'endpointScaleIntervalsEmitted',
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_ENDPOINT_SOURCE_INTERVALS_PER_CASE'
);

checkCaseMetricMax(
  'PCR endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativePcr', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_PCR_ENDPOINT_PAIRS_CONSIDERED'
);
checkCaseMetricMaxPerCase(
  'PCR endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativePcr', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_PCR_ENDPOINT_PAIRS_CONSIDERED_PER_CASE'
);
checkCaseMetricMax(
  'dPCR endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINT_PAIRS_CONSIDERED'
);
checkCaseMetricMaxPerCase(
  'dPCR endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINT_PAIRS_CONSIDERED_PER_CASE'
);
checkCaseMetricMax(
  'dPCR endpoints projected',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'primerEndpointsProjected'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINTS_PROJECTED'
);
checkCaseMetricMaxPerCase(
  'dPCR endpoints projected',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'primerEndpointsProjected'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINTS_PROJECTED_PER_CASE'
);
checkCaseMetricMax(
  'dPCR endpoints accepted',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'primerEndpoints'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINTS_ACCEPTED'
);
checkCaseMetricMaxPerCase(
  'dPCR endpoints accepted',
  ['diagnostics', 'productFirst', 'stage2', 'nativeDigestedPcr', 'primerEndpoints'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_DPCR_ENDPOINTS_ACCEPTED_PER_CASE'
);
checkCaseMetricMax(
  'restriction digest endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativeRestrictionDigest', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_RD_ENDPOINT_PAIRS_CONSIDERED'
);
checkCaseMetricMaxPerCase(
  'restriction digest endpoint pairs considered',
  ['diagnostics', 'productFirst', 'stage2', 'nativeRestrictionDigest', 'endpointPairsConsidered'],
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_RD_ENDPOINT_PAIRS_CONSIDERED_PER_CASE'
);

if (envFlag('ASSEMBLY_BENCHMARK_ASSERT_REQUIRE_PRODUCT_STATUS')) {
  const missingProductStatus =
    caseRecords.length === 0
      ? (attemptedCases ?? 1)
      : caseRecords.filter((record) => !stringValue(getPath(record, ['productStatus', 'status'])))
          .length;
  checkMax('cases missing productStatus.status', missingProductStatus, 0);
}

const productStatuses = countCaseValues(['productStatus', 'status']);
checkMin(
  'physical product statuses',
  (productStatuses['exact-physical'] ?? 0) + (productStatuses['ambiguous-physical'] ?? 0),
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MIN_PHYSICAL_STATUS')
);
checkMax(
  'budget-limited product statuses',
  productStatuses['budget-limited'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_BUDGET_LIMITED')
);
checkCasePredicateMax(
  'budget-limited product status flags',
  (record) => booleanValue(getPath(record, ['productStatus', 'budgetLimited'])) === true,
  'ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_BUDGET_LIMITED_FLAGS'
);
checkMax(
  'missing-source product statuses',
  productStatuses['missing-source'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_MISSING_SOURCE')
);
checkMax(
  'missing-intermediate product statuses',
  productStatuses['missing-intermediate'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_MISSING_INTERMEDIATE')
);
checkMax(
  'source-exact product statuses',
  productStatuses['source-exact'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_SOURCE_EXACT')
);
checkMax(
  'source-partial product statuses',
  productStatuses['source-partial'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_SOURCE_PARTIAL')
);
checkMax(
  'unsupported-biology product statuses',
  productStatuses['unsupported-biology'] ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_UNSUPPORTED_BIOLOGY')
);
checkMax(
  'unresolved product statuses',
  productStatuses.unresolved ?? 0,
  envNumber('ASSEMBLY_BENCHMARK_ASSERT_MAX_PRODUCT_STATUS_UNRESOLVED')
);

if (failures.length > 0) {
  console.error(`[assembly-benchmark-assert] FAILED ${artifactPath}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  [
    `[assembly-benchmark-assert] OK ${artifactPath}`,
    `source=${stringValue(artifact.source) ?? 'unknown'}`,
    `engine=${stringValue(artifact.engine) ?? 'unknown'}`,
    `cases=${attemptedCases ?? 'unknown'}`,
    `biology=${numberValue(summary.biologyCorrect) ?? 'n/a'}`,
    `rankedAltBiology=${numberValue(summary.rankedAlternativeBiologyCorrect) ?? 'n/a'}`,
    `rawEndpoints=${numberValue(v4Aggregate?.rawEndpoints) ?? 'n/a'}`,
    `compactedEndpoints=${numberValue(v4Aggregate?.compactedEndpoints) ?? 'n/a'}`,
    `maxCaseMs=${maxCaseDuration ?? 'n/a'}`,
    `errors=${numberValue(summary.errors) ?? 'n/a'}`,
    `timeouts=${numberValue(summary.timeouts) ?? 'n/a'}`,
  ].join(' ')
);

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new Error(`Benchmark artifact is missing object field: ${label}`);
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function arrayRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): JsonRecord[] => {
    const record = optionalRecord(item);
    return record ? [record] : [];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summaryNumber(summary: JsonRecord, field: string): number | undefined {
  const aliases: Record<string, string[]> = {
    templatePass: ['ambiguityAwarePass', 'ambiguityAwareTemplatePass', 'primaryPass'],
    canonicalTemplateExact: ['canonicalNameExact', 'canonicalNameExactPass'],
    rankedAlternativeTemplatePass: [
      'rankedAlternativeAmbiguityAwarePass',
      'rankedAlternativeAmbiguityAwareTemplatePass',
      'rankedAlternativePrimaryPass',
    ],
    rankedAlternativeCanonicalTemplateExact: [
      'rankedAlternativeCanonicalNameExact',
      'rankedAlternativeCanonicalNameExactPass',
    ],
    rankedAlternativePrimerExact: ['rankedAlternativePrimerExactPass'],
    primerExact: ['primerExactPass'],
  };
  for (const key of [field, ...(aliases[field] ?? [])]) {
    const value = numberValue(summary[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envStringList(name: string): string[] {
  return (
    envString(name)
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

function envFlag(name: string): boolean {
  const value = envString(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getPath(record: JsonRecord | undefined, pathParts: readonly string[]): unknown {
  let current: unknown = record;
  for (const part of pathParts) {
    const currentRecord = optionalRecord(current);
    if (!currentRecord) return undefined;
    current = currentRecord[part];
  }
  return current;
}

function sumCaseNumber(pathParts: readonly string[]): number | undefined {
  let found = false;
  let total = 0;
  for (const record of caseRecords) {
    const value = numberValue(getPath(record, pathParts));
    if (value === undefined) continue;
    found = true;
    total += value;
  }
  return found ? total : undefined;
}

function maxCaseNumber(pathParts: readonly string[]): number | undefined {
  let found = false;
  let max = 0;
  for (const record of caseRecords) {
    const value = numberValue(getPath(record, pathParts));
    if (value === undefined) continue;
    found = true;
    max = Math.max(max, value);
  }
  return found ? max : undefined;
}

function countCaseValues(pathParts: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of caseRecords) {
    const value = stringValue(getPath(record, pathParts));
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countCasesWhere(predicate: (record: JsonRecord) => boolean): number | undefined {
  if (caseRecords.length === 0) return undefined;
  let count = 0;
  for (const record of caseRecords) {
    if (predicate(record)) count += 1;
  }
  return count;
}

function checkExpectedString(
  label: string,
  actual: string | undefined,
  expected: string | undefined
): void {
  if (!expected) return;
  if (actual !== expected)
    failures.push(`${label} expected ${expected}, received ${actual ?? 'missing'}`);
}

function checkMin(label: string, actual: number | undefined, minimum: number | undefined): void {
  if (minimum === undefined) return;
  if (actual === undefined || actual < minimum) {
    failures.push(`${label} expected >= ${minimum}, received ${actual ?? 'missing'}`);
  }
}

function checkMax(label: string, actual: number | undefined, maximum: number | undefined): void {
  if (maximum === undefined) return;
  if (actual === undefined || actual > maximum) {
    failures.push(`${label} expected <= ${maximum}, received ${actual ?? 'missing'}`);
  }
}

function checkMaxPerCase(
  label: string,
  actual: number | undefined,
  denominator: number | undefined,
  maximum: number | undefined
): void {
  if (maximum === undefined) return;
  if (actual === undefined || denominator === undefined || denominator <= 0) {
    failures.push(`${label} per case expected <= ${maximum}, received missing`);
    return;
  }
  const perCase = actual / denominator;
  if (perCase > maximum) {
    failures.push(`${label} per case expected <= ${maximum}, received ${perCase}`);
  }
}

function checkMinFromEnv(summary: JsonRecord, field: string, envName: string): void {
  checkMin(field, summaryNumber(summary, field), envNumber(envName));
}

function checkV4Max(field: string, envName: string): void {
  checkMax(`v4.${field}`, numberValue(v4Aggregate?.[field]), envNumber(envName));
}

function checkV4MaxPerCase(field: string, envName: string): void {
  checkMaxPerCase(
    `v4.${field}`,
    numberValue(v4Aggregate?.[field]),
    attemptedCases,
    envNumber(envName)
  );
}

function checkCaseMetricMax(label: string, pathParts: readonly string[], envName: string): void {
  checkMax(label, sumCaseNumber(pathParts), envNumber(envName));
}

function checkCaseMetricMaxPerCase(
  label: string,
  pathParts: readonly string[],
  envName: string
): void {
  checkMaxPerCase(label, sumCaseNumber(pathParts), attemptedCases, envNumber(envName));
}

function checkCaseMetricMin(label: string, pathParts: readonly string[], envName: string): void {
  checkMin(label, sumCaseNumber(pathParts), envNumber(envName));
}

function checkCasePredicateMin(
  label: string,
  predicate: (record: JsonRecord) => boolean,
  envName: string
): void {
  checkMin(label, countCasesWhere(predicate), envNumber(envName));
}

function checkCasePredicateMax(
  label: string,
  predicate: (record: JsonRecord) => boolean,
  envName: string
): void {
  checkMax(label, countCasesWhere(predicate), envNumber(envName));
}

function checkRequiredCaseValues(field: string, requiredValues: readonly string[]): void {
  if (requiredValues.length === 0) return;
  if (caseRecords.length === 0) {
    failures.push(`${field} coverage requires serialized cases`);
    return;
  }
  const presentValues = new Set(
    caseRecords
      .map((record) => stringValue(record[field]))
      .filter((value): value is string => !!value)
  );
  for (const requiredValue of requiredValues) {
    if (!presentValues.has(requiredValue)) {
      failures.push(
        `${field} coverage expected ${requiredValue}, present ${[...presentValues].join(', ') || 'none'}`
      );
    }
  }
}

function checkMinPctFromEnv(
  summary: JsonRecord,
  denominator: number | undefined,
  field: string,
  envName: string
): void {
  const minPct = envNumber(envName);
  if (minPct === undefined) return;
  if (denominator === undefined || denominator <= 0) {
    failures.push(`${field} percent threshold requires attemptedCases > 0`);
    return;
  }
  const minimum = Math.ceil((denominator * minPct) / 100);
  checkMin(field, summaryNumber(summary, field), minimum);
}
