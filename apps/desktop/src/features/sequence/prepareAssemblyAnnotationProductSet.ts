import type { GenomeAssembly } from '@waypoint/genome-data';

import { platform } from '../../platform';
import {
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  assemblyAnnotationSceneScopeForRequest,
  type AssemblyReferenceAssetGenerationV1,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneSourceRequest,
  type GenomeAssemblyCapabilityReadiness,
  type IndexedGenomeInitialAnnotationMapperPolicy,
} from '../../shared/indexed-genome';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from './assembly-annotation-product-descriptor';
import { assemblyAnnotationSourceRequest } from './assembly-annotation-source-request';

export type AssemblyAnnotationProductPreparationPhase = 'reading-annotation-inventory';

export const LEGACY_PORTABLE_ANNOTATION_DATASET_VERSION =
  'resolved-annotation-v3:mapped-track-input.v1';

export interface PrepareCurrentAssemblyAnnotationProductSetOptions {
  readonly workspaceRoot: string;
  readonly themeMode: 'light' | 'dark';
  readonly policy: IndexedGenomeInitialAnnotationMapperPolicy;
  readonly expectedGeneration?: Readonly<{
    sourceFingerprint: string;
    inventoryFingerprint: string;
  }>;
  readonly onProgress?: (phase: AssemblyAnnotationProductPreparationPhase) => void;
}

export interface PreparedAssemblyAnnotationProductSet {
  readonly assembly: GenomeAssembly;
  readonly searchSource?: AssemblyAnnotationSceneReadRequest;
  readonly generation?: AssemblyReferenceAssetGenerationV1;
  readonly trackTypes?: readonly string[];
  readonly annotationProductsReadiness: GenomeAssemblyCapabilityReadiness;
  readonly searchReadiness: GenomeAssemblyCapabilityReadiness;
}

export interface PreparePortableAssemblyAnnotationProductSetOptions {
  readonly workspaceRoot: string;
  readonly themeMode: 'light' | 'dark';
  readonly policy: IndexedGenomeInitialAnnotationMapperPolicy;
  readonly trackTypes: readonly string[];
  readonly datasetVersion: string;
  readonly annotationAssetGeneration?: AssemblyReferenceAssetGenerationV1;
  readonly searchReady: boolean;
}

export async function preparePortableAssemblyAnnotationProductSet(
  assembly: GenomeAssembly,
  options: PreparePortableAssemblyAnnotationProductSetOptions
): Promise<PreparedAssemblyAnnotationProductSet> {
  const source = assemblyAnnotationSourceRequest(assembly, options.workspaceRoot);
  const searchSource =
    options.annotationAssetGeneration && source
      ? (
          await deriveAssemblyPrepackedAnnotationSceneDescriptor({
            request: {
              ...source,
              datasetVersion: options.datasetVersion,
              scope: assemblyAnnotationSceneScopeForRequest(
                'complete-assembly',
                source.chromosomes
              ),
            },
            themeMode: options.themeMode,
            policy: { trackType: 'mRNA', ...options.policy },
          })
        ).request
      : undefined;
  return {
    assembly,
    ...(searchSource ? { searchSource } : {}),
    ...(options.annotationAssetGeneration ? { generation: options.annotationAssetGeneration } : {}),
    trackTypes: Object.freeze([...options.trackTypes]),
    annotationProductsReadiness: options.annotationAssetGeneration ? 'ready' : 'pending',
    searchReadiness: options.searchReady && searchSource ? 'ready' : 'pending',
  };
}

export function assemblyHasAnnotationSource(assembly: GenomeAssembly): boolean {
  let hasAnnotation = false;
  for (const chromosome of assembly.chromosomes) {
    const hasGff = Boolean(chromosome.manifest.gffPath);
    const hasTbi = Boolean(chromosome.manifest.tbiPath);
    if (hasGff !== hasTbi) {
      throw new Error(`Assembly chromosome has a partial annotation manifest: ${chromosome.chrom}`);
    }
    hasAnnotation ||= hasGff;
  }
  return hasAnnotation;
}

export function assemblyHasCompleteSequenceSource(assembly: GenomeAssembly): boolean {
  return assembly.chromosomes.every(
    (chromosome) => Boolean(chromosome.manifest.fastaPath) && Boolean(chromosome.manifest.faiPath)
  );
}

export async function prepareCurrentAssemblyAnnotationProductSet(
  assembly: GenomeAssembly | null | undefined,
  options: PrepareCurrentAssemblyAnnotationProductSetOptions
): Promise<PreparedAssemblyAnnotationProductSet | null> {
  if (!assembly) return null;
  if (!assemblyHasAnnotationSource(assembly)) {
    const readiness = assemblyHasCompleteSequenceSource(assembly)
      ? ('not-applicable' as const)
      : ('pending' as const);
    return {
      assembly,
      annotationProductsReadiness: readiness,
      searchReadiness: readiness,
    };
  }
  const source = assemblyAnnotationSourceRequest(assembly, options.workspaceRoot);
  if (!source) return null;
  const request: AssemblyAnnotationSceneSourceRequest = {
    ...source,
    scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', source.chromosomes),
  };

  try {
    options.onProgress?.('reading-annotation-inventory');
    const seedDescriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      request,
      themeMode: options.themeMode,
      policy: { trackType: 'mRNA', ...options.policy },
    });
    const committedInventory = await platform().genome.readAssemblyAnnotationProductSetInventoryV1({
      seedProduct: options.expectedGeneration
        ? {
            ...seedDescriptor.request,
            expectedAssetGeneration: {
              contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
              sourceFingerprint: options.expectedGeneration.sourceFingerprint,
              inventoryFingerprint: options.expectedGeneration.inventoryFingerprint,
              themeMode: options.themeMode,
            },
          }
        : seedDescriptor.request,
    });

    if (committedInventory.status !== 'ready') {
      return {
        assembly,
        searchSource: seedDescriptor.request,
        annotationProductsReadiness: 'pending',
        searchReadiness: 'pending',
      };
    }
    if (
      options.expectedGeneration &&
      (committedInventory.sourceFingerprint !== options.expectedGeneration.sourceFingerprint ||
        committedInventory.inventoryFingerprint !== options.expectedGeneration.inventoryFingerprint)
    ) {
      console.error(
        '[assembly-annotation-product-set] committed product does not match reference publication',
        {
          assemblyId: assembly.assemblyId,
          themeMode: options.themeMode,
        }
      );
      return null;
    }
    return {
      assembly,
      searchSource: seedDescriptor.request,
      generation: {
        contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
        sourceFingerprint: committedInventory.sourceFingerprint,
        inventoryFingerprint: committedInventory.inventoryFingerprint,
        themeMode: options.themeMode,
      },
      trackTypes: Object.freeze([...committedInventory.trackTypes]),
      annotationProductsReadiness: 'ready',
      searchReadiness: 'ready',
    };
  } catch (error) {
    console.warn('[assembly-annotation-product-set] products remain pending', error);
    return {
      assembly,
      annotationProductsReadiness: 'pending',
      searchReadiness: 'pending',
    };
  }
}
