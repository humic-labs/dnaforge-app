'use client';

import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import type { GoldenGateEnzyme, SequenceDesign } from '../../design/public/types';
import { schemaSlotIndexForRegion } from '../../design/public/assembly-slots';
import {
  loadMocloCatalogCandidates,
  rankMocloCatalogCandidates,
  type MocloCatalogCandidate,
} from '../../design/public/moclo-part-catalog';
import { loadMocloKitDefinitionInventory } from '../../design/public/moclo-kit-definition';
import { subscribeMocloSchemaCatalog } from '../../design/public/moclo-schema-catalog';
import { MocloPartPicker, type MocloPartPickerCatalogState } from './MocloAssemblyWorkspace';
import {
  WORKSPACE_RECONCILED_EVENT,
  type WorkspaceReconciledEventDetail,
} from '../../../services/workspace-reconciled-event';

const EMPTY_CATALOG: MocloPartPickerCatalogState = {
  status: 'loading',
  candidates: [],
  skippedSourceCount: 0,
};

export function useMocloPartCatalog(
  projectRoot: string | null,
  enzyme: GoldenGateEnzyme | undefined
) {
  const [loaded, setLoaded] = useState<{
    projectRoot: string;
    enzyme: GoldenGateEnzyme;
    catalog: MocloPartPickerCatalogState;
  } | null>(null);

  useEffect(() => {
    if (!projectRoot || !enzyme) return;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const publish = (catalog: MocloPartPickerCatalogState) => {
        if (!request.signal.aborted) setLoaded({ projectRoot, enzyme, catalog });
      };
      publish(EMPTY_CATALOG);
      try {
        const inventory = await loadMocloKitDefinitionInventory(projectRoot);
        if (request.signal.aborted) return;
        const result = await loadMocloCatalogCandidates({
          workspaceRoot: projectRoot,
          enzymeName: enzyme,
          kitDefinitions: inventory.definitions,
          abortSignal: request.signal,
        });
        publish({ status: 'ready', ...result });
      } catch (error: unknown) {
        publish({
          status: 'error',
          candidates: [],
          skippedSourceCount: 0,
          message: toUserMessage(error, 'failure.could-not-search-project-parts'),
        });
      }
    };
    const reconcile = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceReconciledEventDetail>).detail;
      if (detail.workspaceRoot.replace(/\/+$/, '') !== projectRoot.replace(/\/+$/, '')) return;
      void refresh();
    };
    void refresh();
    const unsubscribe = subscribeMocloSchemaCatalog((changedRoot) => {
      if (changedRoot === projectRoot) void refresh();
    });
    window.addEventListener(WORKSPACE_RECONCILED_EVENT, reconcile);
    return () => {
      controller?.abort();
      unsubscribe();
      window.removeEventListener(WORKSPACE_RECONCILED_EVENT, reconcile);
    };
  }, [projectRoot, enzyme]);

  return loaded?.projectRoot === projectRoot && loaded?.enzyme === enzyme
    ? loaded.catalog
    : EMPTY_CATALOG;
}

interface MocloSlotPartPickerProps {
  design: SequenceDesign;
  catalog: MocloPartPickerCatalogState;
  slotIndex: number;
  onChoose: (candidate: MocloCatalogCandidate) => void;
  onClose: () => void;
}

export function MocloSlotPartPicker({
  design,
  catalog,
  slotIndex,
  onChoose,
  onClose,
}: MocloSlotPartPickerProps) {
  const schema = design.goldenGateSchema;
  const schemaIndex = schemaSlotIndexForRegion(design, design.regions[slotIndex]);
  const [query, setQuery] = useState('');
  const [includePhysicallyIncompatible, setIncludePhysicallyIncompatible] = useState(false);

  const visibleCandidates = useMemo(
    () =>
      schema && schemaIndex >= 0
        ? rankMocloCatalogCandidates({
            candidates: catalog.candidates,
            schema,
            slotIndex: schemaIndex,
            topology: design.topology,
            query,
            includePhysicallyIncompatible,
          })
        : [],
    [catalog.candidates, design.topology, includePhysicallyIncompatible, query, schema, schemaIndex]
  );

  if (!schema) return null;
  const slotLabel = schema.slots[schemaIndex]?.label ?? `Position ${slotIndex + 1}`;

  return (
    <MocloPartPicker
      layout="portal"
      slotLabel={slotLabel}
      catalog={catalog}
      candidates={visibleCandidates}
      query={query}
      setQuery={setQuery}
      includePhysicallyIncompatible={includePhysicallyIncompatible}
      setIncludePhysicallyIncompatible={setIncludePhysicallyIncompatible}
      onChoose={onChoose}
      onClose={onClose}
    />
  );
}
