import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import type { EncodedMolecule } from '../../shared/encoded-molecule';
import type { MolecularCatalogMatch } from '../../shared/molecular-catalog';
import { openCatalogStructure, MOLECULAR_CATALOG_CHANGED } from './molecular-catalog';

export function SavedMolecularStructures({
  molecule,
  onUse,
}: {
  molecule: EncodedMolecule;
  onUse?: (observationId: string, chainKey: string) => Promise<void>;
}) {
  const [matches, setMatches] = useState<MolecularCatalogMatch[]>([]);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<string>();
  useEffect(() => {
    let current = true;
    setMatches([]);
    setError(undefined);
    const refresh = () => {
      void platform()
        .molecularCatalog.list({ molecule, limit: 50 })
        .then((rows) => {
          if (current) setMatches(rows);
        })
        .catch((e) => {
          if (current) setError(toUserMessage(e, 'structure.failed'));
        });
    };
    refresh();
    window.addEventListener(MOLECULAR_CATALOG_CHANGED, refresh);
    return () => {
      current = false;
      window.removeEventListener(MOLECULAR_CATALOG_CHANGED, refresh);
    };
  }, [molecule.kind, molecule.sequence]);
  if (!matches.length && !error) return null;
  return (
    <section
      aria-label="Saved structures for this molecule"
      className="border-b border-border px-3 py-2 text-xs"
    >
      <div className="mb-1 font-medium">Saved structures</div>
      {error && (
        <div role="alert" className="text-danger">
          {toUserMessage(error, 'structure.failed')}
        </div>
      )}
      {matches.flatMap(({ observation, chains }) =>
        chains
          .filter((chain) => chain.mappedCount > 0 && chain.relationship !== 'unresolved')
          .map((chain) => {
            const key = `${observation.id}:${chain.key}`;
            return (
              <button
                type="button"
                key={key}
                disabled={!!opening}
                className="mb-1 flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-bg-muted"
                onClick={() => {
                  setOpening(key);
                  setError(undefined);
                  void (
                    onUse
                      ? onUse(observation.id, chain.key)
                      : openCatalogStructure(observation.id, chain.key)
                  )
                    .catch((e) => setError(toUserMessage(e, 'structure.failed')))
                    .finally(() => setOpening(undefined));
                }}
              >
                <span>
                  {observation.label} · {chain.authAsymId || chain.labelAsymId}
                  {chains.some((item) => item.modelIndex > 0)
                    ? ` · model ${chain.modelNumber}`
                    : ''}
                  {chain.blockIndex ? ` · block ${chain.blockIndex + 1}` : ''}
                  {chain.relationship !== 'exact'
                    ? ` · ${chain.relationship === 'partial' ? 'partial sequence' : 'similar sequence'} · ${chain.mappedCount} mapped residues${chain.mismatchCount ? ` · ${chain.mismatchCount} differences` : ''}`
                    : ''}
                </span>
                <span className="ml-2 text-text-muted">
                  {opening === key
                    ? 'Opening…'
                    : observation.sourceKind === 'prediction'
                      ? 'Prediction'
                      : 'Imported'}
                </span>
              </button>
            );
          })
      )}
    </section>
  );
}
