export type InternalAssemblyFixturePreset =
  | 'benchling-gt-validated-20'
  | 'benchling-gt-validated-full'
  | 'synthetic-orthogonal-clean'
  | 'synthetic-deep-lineage'
  | 'synthetic-addgene-diverse'
  | 'synthetic-varied-stress'
  | 'synthetic-union-100'
  | 'synthetic-union-full'
  | 'synthetic-union-plus-decoys-100';

export interface InternalAssemblyFixturePresetDefinition {
  id: InternalAssemblyFixturePreset;
  label: string;
  description: string;
}

export const INTERNAL_ASSEMBLY_FIXTURE_PRESETS: InternalAssemblyFixturePresetDefinition[] = [
  {
    id: 'benchling-gt-validated-20',
    label: 'Benchling GT 20',
    description: 'First 20 validated Benchling truth products plus the pooled GT library.',
  },
  {
    id: 'benchling-gt-validated-full',
    label: 'Benchling GT Full',
    description: 'All validated Benchling truth products plus the pooled GT library.',
  },
  {
    id: 'synthetic-orthogonal-clean',
    label: 'Synthetic Clean',
    description: 'Low-homology synthetic pool; expected easy baseline.',
  },
  {
    id: 'synthetic-deep-lineage',
    label: 'Synthetic Lineage',
    description: 'Deep derived-product lineage pool with intermediate products as sources.',
  },
  {
    id: 'synthetic-addgene-diverse',
    label: 'Synthetic Addgene',
    description:
      'Broad circular synthetic products from the optional local plasmid library; external library data is not distributed.',
  },
  {
    id: 'synthetic-varied-stress',
    label: 'Synthetic Varied',
    description:
      'Varied circular synthetic products spanning length, fragment count, and GC composition.',
  },
  {
    id: 'synthetic-union-100',
    label: 'Synthetic Union 100',
    description: '100 representative synthetic products against the full pooled synthetic library.',
  },
  {
    id: 'synthetic-union-plus-decoys-100',
    label: 'Synthetic + Decoys 100',
    description: '100 synthetic products with unrelated decoy templates included.',
  },
  {
    id: 'synthetic-union-full',
    label: 'Synthetic Union Full',
    description: 'All synthetic products against the full pooled synthetic library.',
  },
];

export interface ScenarioFixtureFile {
  relativePath: string;
  name: string;
  fileKind: 'genbank' | 'snapgene' | 'fasta';
}

export interface RegisterScenarioFixtureFilesRequest {
  workspaceRoot: string;
  files: ScenarioFixtureFile[];
}

export interface SeedMissingAuthorityArchiveRequest {
  workspaceRoot: string;
  packageRelativeRoot: string;
  expectedPackageId: string;
}

export interface SeedMissingAuthorityArchiveResult {
  entityId: string;
  workspaceId: number;
  archiveEventSeq: number;
}

export const MOCLO_SCENARIO_PRESETS = {
  'cidar-moclo-red-fluorescent-tu': 'cidar',
  'cidar-moclo-mixed-route-red-fluorescent-tu': 'cidar',
  'ytk-moclo-factory-expression-cassette': 'ytk',
} as const;

export type MocloScenarioPresetId = keyof typeof MOCLO_SCENARIO_PRESETS;

export function isMocloScenarioPresetId(value: unknown): value is MocloScenarioPresetId {
  return typeof value === 'string' && Object.hasOwn(MOCLO_SCENARIO_PRESETS, value);
}

export interface MaterializeMocloScenarioKitRequest {
  workspaceRoot: string;
  presetId: MocloScenarioPresetId;
  reuseExisting?: true;
}

export interface MaterializedMocloScenarioKit {
  files: string[];
  packages: Array<{
    sourcePackageId: string;
    packageId: string;
    relativeRoot: string;
    productRelativePath: string;
  }>;
}

export interface InternalAssemblyFixtureMaterializeRequest {
  preset: InternalAssemblyFixturePreset;
  forceRecompute?: boolean;
}

export interface InternalAssemblyFixtureStatusRequest {
  preset: InternalAssemblyFixturePreset;
}

export interface InternalAssemblyFixtureStatusResult {
  preset: InternalAssemblyFixturePreset;
  label: string;
  description: string;
  outputDir: string;
  assemblyGraphPath: string;
  inputCached: boolean;
  graphCached: boolean;
  graphCache?: InternalAssemblyFixtureGraphCacheStatus;
  summary?: InternalAssemblyFixtureMaterializeResult['summary'];
}

export const CURRENT_INTERNAL_FIXTURE_GRAPH_ENGINE_ID = 'product-anchored-v4-native-physical';
export const CURRENT_INTERNAL_FIXTURE_GRAPH_MODE = 'physical-reconstruction';

export interface InternalAssemblyFixtureGraphCacheStatus {
  exists: boolean;
  loadable: boolean;
  staleReason?: string;
  engineId?: string;
  graphMode?: string;
  generatedAt?: string;
  productCount?: number;
  templateCount?: number;
  primerCount?: number;
  physicalEdges?: number;
  sourceCoverageEdges?: number;
  missingSourceCoverageNodes?: number;
  physicallyVerifiedProducts?: number;
  ambiguousPhysicalProducts?: number;
  unresolvedProducts?: number;
  missingSourceProducts?: number;
  budgetLimitedProducts?: number;
  graphHasStructuralIssues?: boolean;
  graphIntegrityWarnings?: string[];
  cycleComponentCount?: number;
  cycleAlternativeResolvableComponentCount?: number;
  cycleSequenceEquivalentAmbiguityComponentCount?: number;
  cycleMissingLineageContextComponentCount?: number;
  cycleUnresolvedComponentCount?: number;
}

export type InternalAssemblyFixtureFileRole =
  | 'product'
  | 'product-template'
  | 'template'
  | 'primer'
  | 'manifest';

export interface InternalAssemblyFixtureMaterializedFile {
  path: string;
  name: string;
  role: InternalAssemblyFixtureFileRole;
}

export interface InternalAssemblyFixtureMaterializeResult {
  version: number;
  preset: InternalAssemblyFixturePreset;
  label: string;
  description: string;
  outputDir: string;
  assemblyGraphPath: string;
  cached: boolean;
  generatedAt: string;
  files: InternalAssemblyFixtureMaterializedFile[];
  productFilePaths: string[];
  summary: {
    productCount: number;
    templateCount: number;
    primerCount: number;
  };
}
