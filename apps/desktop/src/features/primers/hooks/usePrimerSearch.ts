import { withUserMessage } from '@waypoint/user-messages';
import { useState, useCallback, useEffect, useRef } from 'react';
import { type PrimerSearchResult, type BindingHit } from '../primer-search-service';
import { primerArtifactRelativePath } from '../primer-artifact-service';
import type { Primer } from '../types';
import { beginToolOperation, type ToolOperation } from '../../../lib/analytics-operation';
import { runWorkflowAction, type WorkflowResultMetadata } from '../../../lib/workflow-telemetry';
import { primerServices } from '../primer-services';

interface SearchConstraints {
  regionStart?: number;
  regionEnd?: number;
  maxEditDistance?: number;
  minMatchLength?: number;
  minEffectiveTm?: number;
  maxMismatches?: number;
}

export function usePrimerSearch(
  sequenceId: number | null,
  referenceSequence: string | undefined,
  circular: boolean,
  fileContext?: { workspaceRoot: string; targetDocumentId: string; targetFilePath: string },
  visible = true,
  targetDocumentId?: string
) {
  const [results, setResults] = useState<PrimerSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [libraryEmpty, setLibraryEmpty] = useState(false);
  const generationRef = useRef(0);
  const waitControllerRef = useRef<AbortController | null>(null);
  const searchJobRef = useRef<string | undefined>(undefined);
  const operationRef = useRef<{ generation: number; operation: ToolOperation } | null>(null);
  const pendingTerminalRef = useRef<{
    generation: number;
    outcome: 'completed' | 'sidecar';
    metadata?: WorkflowResultMetadata;
  } | null>(null);
  const [settledGeneration, setSettledGeneration] = useState(0);

  useEffect(() => {
    const pending = pendingTerminalRef.current;
    const active = operationRef.current;
    if (
      !pending ||
      pending.generation !== settledGeneration ||
      active?.generation !== settledGeneration
    ) {
      return;
    }
    if (pending.outcome === 'completed') active.operation.complete(undefined, pending.metadata);
    else active.operation.fail('sidecar');
    pendingTerminalRef.current = null;
    operationRef.current = null;
  }, [settledGeneration]);

  useEffect(
    () => () => {
      waitControllerRef.current?.abort();
      waitControllerRef.current = null;
      operationRef.current?.operation.cancel();
      operationRef.current = null;
      pendingTerminalRef.current = null;
    },
    []
  );

  useEffect(() => {
    generationRef.current += 1;
    searchJobRef.current = undefined;
    waitControllerRef.current?.abort();
    waitControllerRef.current = null;
    operationRef.current?.operation.cancel();
    operationRef.current = null;
    pendingTerminalRef.current = null;
    setResults([]);
    setError(null);
    setLibraryEmpty(false);
    setIsSearching(false);
  }, [sequenceId, referenceSequence, circular, targetDocumentId]);

  const search = useCallback(
    async (constraints: SearchConstraints = {}) => {
      const fileTarget =
        fileContext?.targetDocumentId && fileContext.targetFilePath ? fileContext : undefined;
      if (!referenceSequence || (sequenceId == null && !fileTarget)) return;

      waitControllerRef.current?.abort();
      const waitController = new AbortController();
      waitControllerRef.current = waitController;
      operationRef.current?.operation.cancel();
      operationRef.current = null;
      pendingTerminalRef.current = null;
      const gen = ++generationRef.current;
      searchJobRef.current = undefined;
      const operation = beginToolOperation({
        toolId: 'primer_design',
        surface: 'sidebar',
        action: 'searched',
      });
      operationRef.current = { generation: gen, operation };
      setIsSearching(true);
      setResults([]);
      setError(null);
      setLibraryEmpty(false);
      try {
        const options = {
          targetDocumentId: targetDocumentId ?? fileContext?.targetDocumentId,
          targetFilePath: fileContext?.targetFilePath,
          referenceSequence,
          circular,
          maxEditDistance: constraints.maxEditDistance,
          regionStart: constraints.regionStart,
          regionEnd: constraints.regionEnd,
          minMatchLength: constraints.minMatchLength,
          minEffectiveTm: constraints.minEffectiveTm,
          maxMismatches: constraints.maxMismatches,
          signal: waitController.signal,
          onOperationAdmitted: (id: string) => {
            if (gen === generationRef.current) searchJobRef.current = id;
          },
        };
        const candidates =
          sequenceId != null
            ? await primerServices.bindingSearch.findLibrary({ ...options, sequenceId })
            : await primerServices.bindingSearch.findLibraryOnTarget({
                ...options,
                targetDocumentId: fileTarget!.targetDocumentId,
                targetFilePath: fileTarget!.targetFilePath,
                loadAttachedBindingIds: async () => new Map<string, string>(),
              });
        if (gen !== generationRef.current) return;
        setResults(candidates);
        let outcomeKind: WorkflowResultMetadata['outcomeKind'] =
          candidates.length > 0 ? 'candidates' : 'unknown_empty';
        if (candidates.length === 0) {
          try {
            const library = await primerServices.persistence.searchLegacyPrimers({ limit: 1 });
            if (gen === generationRef.current) {
              setLibraryEmpty(library.length === 0);
              outcomeKind = library.length === 0 ? 'library_empty' : 'no_match';
            }
          } catch {}
        } else {
          setLibraryEmpty(false);
        }
        if (gen !== generationRef.current) return;
        pendingTerminalRef.current = {
          generation: gen,
          outcome: 'completed',
          metadata: {
            operationId: searchJobRef.current,
            resultCount: candidates.length,
            status: candidates.length > 0 ? 'completed' : 'no_match',
            usableResult: candidates.length > 0,
            valueDelivered: candidates.length > 0,
            outcomeKind,
          },
        };
        setSettledGeneration(gen);
      } catch (err) {
        if (gen !== generationRef.current) return;
        console.error('Primer search failed:', err);
        setResults([]);
        setError(
          err instanceof Error
            ? err
            : withUserMessage(new Error('Search failed'), 'failure.search-failed')
        );
        pendingTerminalRef.current = { generation: gen, outcome: 'sidecar' };
        setSettledGeneration(gen);
      } finally {
        if (gen === generationRef.current) {
          if (waitControllerRef.current === waitController) waitControllerRef.current = null;
          setIsSearching(false);
        }
      }
    },
    [
      sequenceId,
      referenceSequence,
      circular,
      fileContext?.targetDocumentId,
      fileContext?.targetFilePath,
      targetDocumentId,
    ]
  );

  const attach = useCallback(
    async (primer: Primer, hit: BindingHit) => {
      if (sequenceId == null) return;

      await runWorkflowAction(
        {
          workflow: 'primer',
          action: 'attach',
          operationId: searchJobRef.current,
          artifactCorrelationId: primer.id,
        },
        async () => {
          if (primerArtifactRelativePath(primer)) {
            if (!fileContext) {
              throw new Error('Cannot attach a file-backed primer without its owning workspace.');
            }
            await primerServices.persistence.attachBinding({
              primer,
              workspaceRoot: fileContext.workspaceRoot,
              targetDocumentId: fileContext.targetDocumentId,
              targetFilePath: fileContext.targetFilePath,
              bindingSequenceId: sequenceId,
              bindingStart: hit.start,
              bindingEnd: hit.end,
              bindingStrand: hit.strand as 1 | -1,
            });
          } else {
            await primerServices.persistence.createLegacyBinding({
              primerId: primer.id,
              sequenceId,
              bindingStart: hit.start,
              bindingEnd: hit.end,
              strand: hit.strand as 1 | -1,
            });
          }
        },
        () => ({ status: 'attached', affectedCount: 1 })
      );

      setResults((prev) =>
        prev.map((r) => (r.primer.id === primer.id ? { ...r, isAttached: true } : r))
      );
    },
    [fileContext, sequenceId]
  );

  const clear = useCallback(() => {
    generationRef.current += 1;
    searchJobRef.current = undefined;
    waitControllerRef.current?.abort();
    waitControllerRef.current = null;
    operationRef.current?.operation.cancel();
    operationRef.current = null;
    pendingTerminalRef.current = null;
    setResults([]);
    setError(null);
    setLibraryEmpty(false);
    setIsSearching(false);
  }, []);

  return {
    results: visible ? results : [],
    isSearching: visible ? isSearching : false,
    error: visible ? error : null,
    libraryEmpty: visible ? libraryEmpty : false,
    search,
    attach,
    clear,
  };
}
