import { useEffect, useState } from 'react';
import { openDocument } from '../document-opening/public/open-document';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { loadProteinPrediction, loadProteinPredictionByDigest } from './prediction-library';

import type { PredictionResultView } from './public/prediction-result-types';
export type { PredictionResultView } from './public/prediction-result-types';

export async function openProteinPrediction(
  referenceId: string,
  sequence: string,
  chainId: string
) {
  const result = await loadProteinPrediction(referenceId, sequence, chainId);
  const chain = result.chains.find((item) => item.chainId === chainId)!;
  const opened = await openDocument({
    target: {
      kind: 'record',
      tabType: 'structure',
      entityId: `prediction-view:${referenceId}:${chainId}`,
    },
    label: result.run.label ?? `${result.run.toolId} · ${result.run.remoteId}`,
    placement: { kind: 'smart' },
    view: {
      predictionResult: { referenceId, chainId, proteinSequenceSha256: chain.sequenceSha256 },
    },
  });
  if (opened.status !== 'presented') throw new Error('The prediction view could not be opened.');
  return opened;
}

export function usePredictionResultAttrs(ref: PredictionResultView | undefined, viewId: string) {
  const [loaded, setLoaded] = useState<{
    ref: PredictionResultView;
    attrs?: Structure3dAttrs;
    error?: string;
  }>();
  useEffect(() => {
    let current = true;
    if (ref)
      void loadProteinPredictionByDigest(ref.referenceId, ref.proteinSequenceSha256, ref.chainId)
        .then((result) => {
          if (current)
            setLoaded({
              ref,
              attrs: {
                source: 'file',
                sourceId: result.coordinates.text,
                label: result.run.label ?? result.run.toolId,
                representation: 'cartoon',
                colorMode: 'chain',
                structureViewIdentity: {
                  schemaVersion: 1,
                  structureViewId: viewId,
                  bindingId: null,
                },
                predictionProvenance: {
                  provider: result.run.provider,
                  toolId: result.run.toolId,
                  remoteId: result.run.remoteId,
                  jobRecordId: result.run.jobRecordId,
                  proteinSequenceSha256: ref.proteinSequenceSha256,
                  coordinateSha256: result.coordinates.sha256,
                  metrics: result.metrics,
                },
              },
            });
        })
        .catch((error) => {
          if (current)
            setLoaded({ ref, error: error instanceof Error ? error.message : String(error) });
        });
    return () => {
      current = false;
    };
  }, [ref, viewId]);
  return ref && loaded?.ref === ref ? loaded : undefined;
}
