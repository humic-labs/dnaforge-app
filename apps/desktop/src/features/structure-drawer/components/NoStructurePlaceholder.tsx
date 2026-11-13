import type { StructureMoleculeType } from '../types/structure-drawer';

interface NoStructurePlaceholderProps {
  moleculeType?: StructureMoleculeType;
  onPredictStructure?: () => void;
}

export function NoStructurePlaceholder({
  moleculeType = 'protein',
  onPredictStructure,
}: NoStructurePlaceholderProps) {
  const copy = noStructureCopy(moleculeType);

  return (
    <div
      data-testid="no-structure-placeholder"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <div className="text-3xl text-fg-subtle">∅</div>
      <div className="text-sm font-medium text-fg">{copy.title}</div>
      <div className="max-w-xs text-xs text-fg-muted">{copy.description}</div>
      {moleculeType === 'protein' && onPredictStructure && (
        <button
          type="button"
          data-testid="no-structure-predict"
          onClick={onPredictStructure}
          className="mt-1 rounded border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-muted"
        >
          Predict structure
        </button>
      )}
    </div>
  );
}

function noStructureCopy(moleculeType: StructureMoleculeType): {
  title: string;
  description: string;
} {
  if (moleculeType === 'rna') {
    return {
      title: 'No RNA structure available',
      description:
        'We could not find a matching RNA polymer entity in PDB by sequence search. AlphaFold DB does not provide RNA predictions, so there is no protein-style fallback for this annotation.',
    };
  }
  if (moleculeType === 'dna') {
    return {
      title: 'No DNA structure available',
      description:
        'We could not find a matching DNA polymer entity in PDB by sequence search. AlphaFold DB does not provide DNA predictions, so there is no protein-style fallback for this annotation.',
    };
  }
  return {
    title: 'No structure available',
    description:
      "We couldn't find a matching structure in PDB, AlphaFold DB, or via UniProt cross-reference. You can predict one with a compute provider.",
  };
}
