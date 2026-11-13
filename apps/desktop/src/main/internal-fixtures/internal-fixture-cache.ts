import fs from 'node:fs';
import path from 'node:path';

import {
  CURRENT_INTERNAL_FIXTURE_GRAPH_ENGINE_ID,
  CURRENT_INTERNAL_FIXTURE_GRAPH_MODE,
  INTERNAL_ASSEMBLY_FIXTURE_PRESETS,
  type InternalAssemblyFixtureGraphCacheStatus,
  type InternalAssemblyFixtureMaterializeResult,
  type InternalAssemblyFixtureMaterializedFile,
  type InternalAssemblyFixturePreset,
  type InternalAssemblyFixtureStatusRequest,
  type InternalAssemblyFixtureStatusResult,
} from '../../shared/internal-fixtures';

export function getInternalAssemblyFixtureLibraryStatus(
  request: InternalAssemblyFixtureStatusRequest
): InternalAssemblyFixtureStatusResult {
  const definition = getInternalAssemblyFixturePresetDefinition(request.preset);
  const outputDir = getInternalAssemblyFixtureOutputDir(request.preset);
  const assemblyGraphPath = getInternalAssemblyFixtureGraphPath(outputDir);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = readManifest(request.preset, manifestPath);
  const graphCache = readAssemblyGraphCacheStatus(assemblyGraphPath);

  return {
    preset: request.preset,
    label: definition.label,
    description: definition.description,
    outputDir,
    assemblyGraphPath,
    inputCached: manifest.inputCached,
    graphCached: graphCache.exists,
    graphCache,
    summary: manifest.summary,
  };
}

export function getInternalAssemblyFixtureOutputDir(preset: InternalAssemblyFixturePreset): string {
  const repoRoot = findRepoRoot(process.cwd());
  return path.join(repoRoot, 'tmp', 'adjacency-graph-internal-fixtures', preset);
}

export function getInternalAssemblyFixtureGraphPath(outputDir: string): string {
  return path.join(outputDir, 'assembly-graph-output.json');
}

export function getInternalAssemblyFixturePresetDefinition(preset: InternalAssemblyFixturePreset) {
  const definition = INTERNAL_ASSEMBLY_FIXTURE_PRESETS.find((candidate) => candidate.id === preset);
  if (!definition) throw new Error(`Unknown internal assembly fixture preset: ${preset}`);
  return definition;
}

function readManifest(
  preset: InternalAssemblyFixturePreset,
  manifestPath: string
): {
  inputCached: boolean;
  summary?: InternalAssemblyFixtureMaterializeResult['summary'];
} {
  if (!fs.existsSync(manifestPath)) return { inputCached: false };

  try {
    const parsed = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8')
    ) as Partial<InternalAssemblyFixtureMaterializeResult>;
    if (parsed.preset !== preset) return { inputCached: false };
    if (!Array.isArray(parsed.files) || !isSummary(parsed.summary)) {
      return { inputCached: false };
    }

    const files = parsed.files.filter(isMaterializedFile);
    const inputCached = files.length > 0 && files.every((file) => fs.existsSync(file.path));
    return { inputCached, summary: parsed.summary };
  } catch {
    return { inputCached: false };
  }
}

function isMaterializedFile(value: unknown): value is InternalAssemblyFixtureMaterializedFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InternalAssemblyFixtureMaterializedFile>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    (candidate.role === 'product' ||
      candidate.role === 'product-template' ||
      candidate.role === 'template' ||
      candidate.role === 'primer' ||
      candidate.role === 'manifest')
  );
}

function isSummary(value: unknown): value is InternalAssemblyFixtureMaterializeResult['summary'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InternalAssemblyFixtureMaterializeResult['summary']>;
  return (
    typeof candidate.productCount === 'number' &&
    typeof candidate.templateCount === 'number' &&
    typeof candidate.primerCount === 'number'
  );
}

function readAssemblyGraphCacheStatus(
  assemblyGraphPath: string
): InternalAssemblyFixtureGraphCacheStatus {
  if (!fs.existsSync(assemblyGraphPath)) return { exists: false, loadable: false };

  try {
    const metadata = readGraphRunMetadata(assemblyGraphPath);
    if (!metadata) {
      return {
        exists: true,
        loadable: false,
        staleReason: 'missing cache metadata',
      };
    }

    const loadable =
      metadata.engineId === CURRENT_INTERNAL_FIXTURE_GRAPH_ENGINE_ID &&
      metadata.graphMode === CURRENT_INTERNAL_FIXTURE_GRAPH_MODE;
    const staleReason = loadable
      ? undefined
      : `expected ${CURRENT_INTERNAL_FIXTURE_GRAPH_ENGINE_ID} ${CURRENT_INTERNAL_FIXTURE_GRAPH_MODE}, found ${metadata.engineId} ${metadata.graphMode}`;

    return {
      exists: true,
      loadable,
      staleReason,
      engineId: metadata.engineId,
      graphMode: metadata.graphMode,
      generatedAt: metadata.generatedAt,
      productCount: metadata.productCount,
      templateCount: metadata.templateCount,
      primerCount: metadata.primerCount,
      physicalEdges: metadata.physicalEdges,
      sourceCoverageEdges: metadata.sourceCoverageEdges,
      missingSourceCoverageNodes: metadata.missingSourceCoverageNodes,
      physicallyVerifiedProducts: metadata.productStatusSummary?.physicallyVerifiedProducts,
      ambiguousPhysicalProducts: metadata.productStatusSummary?.ambiguousPhysicalProducts,
      unresolvedProducts: metadata.productStatusSummary?.unresolvedProducts,
      missingSourceProducts: metadata.productStatusSummary?.missingSourceProducts,
      budgetLimitedProducts: metadata.productStatusSummary?.budgetLimitedProducts,
      graphHasStructuralIssues: metadata.graphIntegrity?.hasStructuralIssues,
      graphIntegrityWarnings: metadata.graphIntegrity?.warnings,
      cycleComponentCount: metadata.graphIntegrity?.cycleComponentCount,
      cycleAlternativeResolvableComponentCount:
        metadata.graphIntegrity?.cycleAlternativeResolvableComponentCount,
      cycleSequenceEquivalentAmbiguityComponentCount:
        metadata.graphIntegrity?.cycleSequenceEquivalentAmbiguityComponentCount,
      cycleMissingLineageContextComponentCount:
        metadata.graphIntegrity?.cycleMissingLineageContextComponentCount,
      cycleUnresolvedComponentCount: metadata.graphIntegrity?.cycleUnresolvedComponentCount,
    };
  } catch (err) {
    return {
      exists: true,
      loadable: false,
      staleReason:
        err instanceof Error
          ? `unreadable cache metadata: ${err.message}`
          : 'unreadable cache metadata',
    };
  }
}

function readGraphRunMetadata(assemblyGraphPath: string): GraphRunMetadata | null {
  const sidecarPath = graphMetadataSidecarPath(assemblyGraphPath);
  if (fs.existsSync(sidecarPath)) {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as unknown;
    return isGraphRunMetadata(parsed) ? parsed : null;
  }

  const parsed = JSON.parse(fs.readFileSync(assemblyGraphPath, 'utf8')) as {
    runMetadata?: unknown;
  };
  return isGraphRunMetadata(parsed.runMetadata) ? parsed.runMetadata : null;
}

function graphMetadataSidecarPath(assemblyGraphPath: string): string {
  return `${assemblyGraphPath}.metadata.json`;
}

interface GraphRunMetadata {
  engineId: string;
  graphMode: string;
  generatedAt?: string;
  productCount?: number;
  templateCount?: number;
  primerCount?: number;
  physicalEdges?: number;
  sourceCoverageEdges?: number;
  missingSourceCoverageNodes?: number;
  productStatusSummary?: {
    physicallyVerifiedProducts?: number;
    ambiguousPhysicalProducts?: number;
    unresolvedProducts?: number;
    missingSourceProducts?: number;
    budgetLimitedProducts?: number;
  };
  graphIntegrity?: {
    hasStructuralIssues?: boolean;
    warnings?: string[];
    cycleComponentCount?: number;
    cycleAlternativeResolvableComponentCount?: number;
    cycleSequenceEquivalentAmbiguityComponentCount?: number;
    cycleMissingLineageContextComponentCount?: number;
    cycleUnresolvedComponentCount?: number;
  };
}

function isGraphRunMetadata(value: unknown): value is GraphRunMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.engineId === 'string' && typeof candidate.graphMode === 'string';
}

function findRepoRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  if (path.basename(resolved) === 'desktop' && path.basename(path.dirname(resolved)) === 'apps') {
    return path.resolve(resolved, '../..');
  }
  return resolved;
}
