import type { ReactNode } from 'react';
import { useDesignStore } from '../../design/public/store';
import type { SequenceDesign } from '../../design/public/types';
import { Button } from '../../../shared/components/Button';
import { assemblyDraftControls } from '../assembly-draft-controls';

export function AssemblyRecipeStrip({
  design,
  mix,
  readout,
  tools,
  actions,
}: {
  design: SequenceDesign;
  mix?: ReactNode;
  readout?: ReactNode;
  tools?: ReactNode;
  actions?: ReactNode;
}) {
  const draftAssembly = useDesignStore((s) => s.draftAssembly);
  const clearDraftAssembly = useDesignStore((s) => s.clearDraftAssembly);
  const { canDraft, canClear, label } = assemblyDraftControls(design);

  return (
    <div data-testid="assembly-review-controls" className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <div
          data-testid="assembly-construct-bar"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          {mix}
          {tools}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {readout}
          {actions}
          {canDraft && (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              data-testid="draft-assembly-button"
              onClick={() => draftAssembly(design.id)}
              title={`${label} the assembly from the current parts`}
            >
              {label}
            </Button>
          )}
          {canClear && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="clear-assembly-draft-button"
              onClick={() => clearDraftAssembly(design.id)}
              title="Remove drafted primers, junctions, and highlights; keep the parts"
            >
              {}
              Clear draft
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
