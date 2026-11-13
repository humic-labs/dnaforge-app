import { recomputeDesignPrimerTms } from './algorithms/recompute-design-primer-tms';
import type { TmModel } from './algorithms/tm-model';
import { scheduleDraftedPrimerTmRefinement, useDesignStore } from './store';
import { createAppTmCalculator, useSettingsStore } from '../junction-workbench/public/settings';

function polymeraseForModel(model: TmModel): string | null {
  return model.kind === 'neb' ? model.prodcode : null;
}

export function applyDesignPcrTmModel(designId: string, model: TmModel): boolean {
  useSettingsStore.getState().setTmModel(model);
  const design = useDesignStore.getState().designs[designId];
  if (!design) return false;
  const polymerase = polymeraseForModel(model);
  const nextDesign = {
    ...design,
    pcrPolymerase: polymerase,
    designPrimers: recomputeDesignPrimerTms(
      design.designPrimers,
      createAppTmCalculator(polymerase)
    ),
    version: design.version + 1,
    updatedAt: new Date(),
  };
  return useDesignStore.getState().commitWorkbenchDesign(designId, nextDesign, design.version);
}

export function refreshDesignPrimerTmsFromSettings(designId: string): void {
  const design = useDesignStore.getState().designs[designId];
  if (!design || design.designPrimers.length === 0) return;
  const nextPrimers = recomputeDesignPrimerTms(
    design.designPrimers,
    createAppTmCalculator(design.pcrPolymerase)
  );
  useDesignStore.setState((state) => {
    const current = state.designs[designId];
    if (!current || current.version !== design.version) return state;
    return {
      designs: {
        ...state.designs,
        [designId]: { ...current, designPrimers: nextPrimers },
      },
    };
  });
  scheduleDraftedPrimerTmRefinement(designId);
}

export function resetDesignPcrTmSettingsToDefaults(designId: string): boolean {
  useSettingsStore.getState().resetPrimerTmSettings();
  const design = useDesignStore.getState().designs[designId];
  if (!design) return false;
  const nextDesign = {
    ...design,
    pcrPolymerase: null,
    primerDesignConstraints: undefined,
    designPrimers: recomputeDesignPrimerTms(design.designPrimers, createAppTmCalculator(null)),
    version: design.version + 1,
    updatedAt: new Date(),
  };
  return useDesignStore.getState().commitWorkbenchDesign(designId, nextDesign, design.version);
}
