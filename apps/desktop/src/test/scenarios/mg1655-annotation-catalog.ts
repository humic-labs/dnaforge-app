import { defaultLayoutFor } from '../../features/sequence/annotation-catalog/default-layout';
import { ECOLI_K12_MG1655_ASSEMBLY } from '../../features/sequence/annotation-catalog/known-assemblies';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';

const COMPLETE_MG1655_PATH = 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb';

export function mg1655AnnotationCatalog(): AppScenario {
  const layout = defaultLayoutFor(ECOLI_K12_MG1655_ASSEMBLY.accession);
  return {
    sidecar: sidecarScenarios.fullyReady(),
    openSequenceAt: {
      filePath: COMPLETE_MG1655_PATH,
      label: 'E. coli MG1655 — annotation catalog',
      start: 4_169_001,
      end: 4_182_000,
      mapShape: 'linear',
      viewState: {
        rendererVisibility: 'map',
        ...(layout ? { annotationCatalogLayout: layout } : {}),
      },
    },
  };
}

export const MG1655_ANNOTATION_CATALOG_PRESET = {
  id: 'mg1655-annotation-catalog',
  label: 'MG1655 annotation catalog',
  description:
    'Complete E. coli MG1655 on the linear map at bases 4,169,001–4,182,000 (the tRNA–tufB operon, secE–nusG and rplKAJL, with several multi-gene transcription units) with the default promoter, terminator, and transcription unit tracks. Open Tracks on the map to switch sources and drawing styles.',
  factory: mg1655AnnotationCatalog,
  aliases: ['annotation-catalog', 'mg1655-tracks'],
  noAutoReplay: true,
  loadsAnnotationCatalogs: true,
};
