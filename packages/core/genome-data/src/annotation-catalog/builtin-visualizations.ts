import { visualizationId } from './ids';
import type { AnnotationVisualizationDefinition } from './visualizations';

export const BUILTIN_ANNOTATION_VISUALIZATIONS: readonly AnnotationVisualizationDefinition[] =
  Object.freeze([
    {
      id: visualizationId('promoter-arrow'),
      label: 'Bent arrows',
      description:
        'A bent arrow at each transcription start, pointing the way transcription runs, with the promoter window and any −10 box underneath.',
      accepts: ['promoter', 'tss'],
    },
    {
      id: visualizationId('terminator-hairpin'),
      label: 'Hairpins',
      description:
        'A stem-loop at each intrinsic terminator, a bracket for Rho-dependent termination, and a plain T for terminators of unknown type.',
      accepts: ['terminator'],
    },
    {
      id: visualizationId('transcription-unit-arrows'),
      label: 'Unit arrows',
      description:
        'One arrow per transcription unit, stacked when units overlap, with its genes drawn as colored blocks inside.',
      accepts: ['transcription_unit'],
    },
    {
      id: visualizationId('position-ticks'),
      label: 'Ticks',
      description:
        'A compact tick at each start or end point, taller for higher scores. Heights compare scores only within one source, and every tick is the same height when a source has no scores.',
      accepts: ['tss', 'promoter', 'terminator'],
    },
    {
      id: visualizationId('interval-boxes'),
      label: 'Boxes',
      description: 'Plain strand-aware boxes. Works for any kind.',
      accepts: ['promoter', 'terminator', 'transcription_unit', 'tss'],
    },
  ]);
