import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore } from './store';
import type { Tab } from './types';
import {
  resolveEntityRegistryReference,
  type EntityRegistryReference,
} from '../../services/entity-registry-reference';
import { requestRegistryOpen } from '../../shared/registry-events';
import { subscribeLimsRegistrationChanged } from '../lims/public/events';
import { requestManagedSequenceMetadata } from '../sequence/public/managed-sequence-metadata';

export function tabRegistryReference(tab: Tab | undefined): EntityRegistryReference | null {
  if (!tab || tab.artifactDocument?.persistence === 'draft' || tab.quickLookSource) return null;
  if (tab.trackView) return { kind: 'entity', entityId: tab.trackView.document.id };
  if (tab.type === 'sequence') {
    const document = tab.sequenceDocument;
    if (document?.kind === 'import-source-sequence') return null;
    if (document?.kind === 'managed-sequence')
      return { kind: 'entity', entityId: document.packageId };
    return {
      kind: 'sequence',
      documentId:
        document?.kind === 'catalog-sequence'
          ? document.entityId
          : (document?.documentId ?? tab.entityId),
    };
  }
  if (tab.type === 'primer')
    return tab.artifactDocument?.artifactPath
      ? { kind: 'file', path: tab.artifactDocument.artifactPath }
      : { kind: 'primer', primerId: tab.entityId };
  if (tab.type === 'structure' && tab.initialStructureAttrs?.molecularDocumentPath)
    return { kind: 'file', path: tab.initialStructureAttrs.molecularDocumentPath };
  if (tab.type === 'structure') return { kind: 'entity', entityId: tab.entityId };
  if (
    ['file', 'text', 'image', 'html', 'scientific-document'].includes(tab.type) ||
    (tab.type === 'protein' && tab.entityId.toLowerCase().endsWith('.faa'))
  )
    return { kind: 'file', path: tab.entityId };
  return { kind: 'entity', entityId: tab.entityId };
}

export function useTabRegistryNavigation(panelId: string, tabId: string) {
  const tab = useCanvasStore((state) =>
    state.panels[panelId]?.tabs.find((candidate) => candidate.id === tabId)
  );
  const key = JSON.stringify(tabRegistryReference(tab));
  const reference = useMemo(() => JSON.parse(key) as EntityRegistryReference | null, [key]);
  const current = useRef(key);
  current.current = key;
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    entityId: string;
    registered: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => subscribeLimsRegistrationChanged(() => setVersion((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    setError(null);
    if (!reference) {
      setResult(null);
      return;
    }
    void resolveEntityRegistryReference(reference, true)
      .then((entity) => {
        if (active)
          setResult(
            entity
              ? { key, entityId: entity.id, registered: entity.registrationStatus !== 'tracked' }
              : null
          );
      })
      .catch((cause) => {
        if (active) {
          setResult(null);
          setError(toUserMessage(cause, 'failure.registry-registration-could-not-be-checked'));
        }
      });
    return () => {
      active = false;
    };
  }, [key, reference, version]);
  const resolved = result?.key === key ? result : null;
  return {
    usesEmbeddedMetadata:
      tab?.type === 'primer' ||
      Boolean(
        tab?.type === 'sequence' &&
        !tab.trackView &&
        !tab.indexedGenome &&
        tab.sequenceDocument?.kind !== 'indexed-sequence'
      ),
    canReveal: Boolean(resolved?.registered),
    canOpenMetadata: Boolean(resolved),
    opening,
    error,
    reveal: async () => {
      if (!reference || opening) return false;
      setOpening(true);
      try {
        const entity = await resolveEntityRegistryReference(reference);
        if (!mounted.current || current.current !== key) return false;
        if (!entity) throw new Error('This entity no longer has a Registry registration.');
        requestRegistryOpen({ entityId: entity.id, fallbackSearch: '' });
        return true;
      } catch (cause) {
        if (mounted.current)
          setError(toUserMessage(cause, 'failure.the-registration-could-not-be-opened'));
        return false;
      } finally {
        if (mounted.current) setOpening(false);
      }
    },
    openMetadata: () => {
      if (!resolved || !tab) return;
      const store = useCanvasStore.getState();
      store.setActiveTab(panelId, tabId);
      if (tab.type === 'sequence' && tab.sequenceDocument?.kind === 'managed-sequence')
        requestManagedSequenceMetadata(tab.sequenceDocument.packageId);
      else
        store.setTabViewState(panelId, tabId, {
          entityDetailsEntityId: resolved.entityId,
          entityDetailsOpen: true,
        });
    },
  };
}
