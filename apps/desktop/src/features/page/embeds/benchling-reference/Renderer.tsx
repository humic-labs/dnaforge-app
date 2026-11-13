'use client';
import { toUserMessage } from '@waypoint/user-messages';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import type { EmbedRendererProps } from '../types';
import { EmbedWrapper } from '../components/EmbedWrapper';
import { useOptionalReferenceContext } from '../../entity-ref/reference-context';
import { dispatchOpenNativeEntityReference } from '../../editor/native-entity-links';
import {
  getReferenceGeneration,
  subscribeToReferenceGeneration,
} from '../../entity-ref/reference-generation';
import { platform } from '../../../../platform';
import { cardStateFromResolution, type BenchlingReferenceAttrs } from './types';
import type { BenchlingReferenceCardState } from './types';

export function BenchlingReferenceRenderer({
  attrs,
  selected,
  onRemove,
}: EmbedRendererProps): JSX.Element {
  const data = attrs as unknown as BenchlingReferenceAttrs;
  const referenceContext = useOptionalReferenceContext();
  const owningRoot = referenceContext?.owningRoot ?? null;
  const [state, setState] = useState<BenchlingReferenceCardState>({ kind: 'loading' });

  const generation = useSyncExternalStore(
    subscribeToReferenceGeneration,
    getReferenceGeneration,
    getReferenceGeneration
  );
  const [reconcileToken, setReconcileToken] = useState(0);
  useEffect(() => {
    const onReconciled = (): void => setReconcileToken((value) => value + 1);
    window.addEventListener('waypoint:workspace-reconciled', onReconciled);
    return () => window.removeEventListener('waypoint:workspace-reconciled', onReconciled);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!owningRoot) {
      setState({
        kind: 'unavailable',
        message: 'This notebook has no owning project, so its references cannot resolve.',
      });
      return () => {
        cancelled = true;
      };
    }
    void platform()
      .benchlingMigration.resolveProviderReference({
        workspaceRoot: owningRoot,
        reference: data.target,
        ...(data.disposition !== 'pending' ? { disposition: data.disposition } : {}),
        sourceUrl: data.sourceUrl,
        ...(data.brokenReason ? { brokenReason: data.brokenReason } : {}),
      })
      .then((result) => {
        if (!cancelled) setState(cardStateFromResolution(result.resolution, result.target));
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            kind: 'unavailable',
            message: 'DNAForge could not check this reference just now.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    owningRoot,
    data.target.provider,
    data.target.stableObjectId,
    data.target.objectClass,
    data.disposition,
    data.sourceUrl,
    data.brokenReason,
    generation,
    reconcileToken,
  ]);

  const openTarget = useCallback(() => {
    if (state.kind !== 'resolved') return;
    dispatchOpenNativeEntityReference({
      entityId: state.entityId,
      label: state.title,
      owningRoot,
    });
  }, [owningRoot, state]);

  return (
    <EmbedWrapper
      type="benchling-reference"
      label={data.label || 'Benchling reference'}
      selected={selected}
      onRemove={onRemove}
    >
      <div
        className="p-3 text-sm"
        data-testid="benchling-reference-card"
        data-reference-ref-id={data.refId}
      >
        <BenchlingReferenceBody state={state} label={data.label} onOpen={openTarget} />
      </div>
    </EmbedWrapper>
  );
}

function BenchlingReferenceBody({
  state,
  label,
  onOpen,
}: {
  state: BenchlingReferenceCardState;
  label: string;
  onOpen: () => void;
}): JSX.Element {
  switch (state.kind) {
    case 'loading':
      return (
        <span className="text-fg-subtle" data-reference-state="loading">
          Checking this reference…
        </span>
      );

    case 'resolved':
      return (
        <div data-reference-state="resolved">
          <button
            type="button"
            data-testid="benchling-reference-open"
            onClick={onOpen}
            className="text-accent hover:underline"
          >
            {state.title}
          </button>
          <p className="mt-1 text-xs text-fg-subtle">
            Available — {state.entityType} in this{' '}
            {state.scope === 'registry' ? 'registry' : 'project'}
          </p>
        </div>
      );

    case 'pending':
      return (
        <div data-reference-state="pending">
          <p className="font-medium text-fg">{label || 'Benchling reference'}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            {state.reason === 'target_not_imported'
              ? 'Source not imported yet — add the Benchling export that contains it.'
              : 'Needs review — this export did not record an exact Benchling ID for the target.'}
          </p>
        </div>
      );

    case 'ambiguous':
      return (
        <div data-reference-state="ambiguous">
          <p className="font-medium text-fg">{label || 'Benchling reference'}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            Needs review — more than one object in this workspace claims this Benchling ID.
          </p>
        </div>
      );

    case 'external':
      return (
        <div data-reference-state="external">
          <a
            href={state.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="benchling-reference-external"
            className="text-accent hover:underline"
          >
            {label || 'Open in Benchling'}
          </a>
          <p className="mt-1 text-xs text-fg-subtle">External Benchling link</p>
        </div>
      );

    case 'source_broken':
      return (
        <div data-reference-state="source_broken">
          <p className="font-medium text-fg">{label || 'Benchling reference'}</p>
          <p className="mt-1 text-xs text-fg-subtle">Source link is broken — {state.reason}</p>
        </div>
      );

    case 'unavailable':
      return (
        <div data-reference-state="unavailable">
          <p className="font-medium text-fg">{label || 'Benchling reference'}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            {toUserMessage(state.message, 'operation.failed')}
          </p>
        </div>
      );
  }
}
