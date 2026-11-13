import { useState, useEffect, useCallback, useMemo, useRef, type KeyboardEvent } from 'react';
import type {
  MountedCatalogEntitySearchResult,
  SidebarSearchableCatalogEntityType,
} from '../db/catalog-reference-search';
import {
  searchWorkspace,
  settleCatalogSearchOpen,
} from '../features/workspace/public/search-commands';
import { referenceIconFor } from '../features/page/entity-ref/reference-icon';
import { dispatchOpenExactCatalogEntity } from '../features/page/public/native-entity-links';
import { useDesignStore } from '../features/design/store';
import { beginWorkflowAction } from '../lib/workflow-telemetry';
import { useWorkspaceStore } from '../stores/workspaceStore';

interface SearchPanelProps {
  onClose?: () => void;
}

export function SearchPanel({ onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const folders = useWorkspaceStore((state) => state.folders);
  const designs = useDesignStore((state) => state.designs);
  const openLocalDesignIds = useMemo(() => Object.keys(designs), [designs]);
  const [retry, setRetry] = useState(0);
  const scope = useMemo(
    () => ({ query, folders, openLocalDesignIds, retry }),
    [query, folders, openLocalDesignIds, retry]
  );
  const [settled, setSettled] = useState<{
    scope: typeof scope;
    results: MountedCatalogEntitySearchResult[];
    failed: boolean;
    episodeId: string;
    revision: number;
  } | null>(null);
  const episodeRef = useRef<{ id: string; revision: number; acceptedResult: boolean } | null>(null);
  const current = settled?.scope === scope;
  const results = current ? settled.results : [];
  const loading = Boolean(query.trim()) && !current;
  const failed = current && settled.failed;

  useEffect(() => {
    if (!query.trim()) {
      episodeRef.current = null;
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const episode = (episodeRef.current ??= {
        id: crypto.randomUUID(),
        revision: 0,
        acceptedResult: false,
      });
      const revision = ++episode.revision;
      const operation = beginWorkflowAction({
        workflow: 'search',
        action: 'search',
        searchEpisodeId: episode.id,
        searchQueryRevision: revision,
      });
      try {
        const data = await searchWorkspace({ query, limit: 100 }, () => ({
          projects: folders,
          openLocalDesignIds,
        }));
        const role = cancelled
          ? 'superseded'
          : episode.acceptedResult
            ? 'continuation'
            : 'first_result';
        const accepted = operation.complete({
          status: data.results.length === 0 ? 'no_match' : 'success',
          resultCount: data.results.length,
          searchActivityRole: role,
        });
        if (!cancelled) {
          if (accepted) episode.acceptedResult = true;
          setSettled({
            scope,
            results: data.results,
            failed: false,
            episodeId: episode.id,
            revision,
          });
        }
      } catch (error) {
        operation.fail(error instanceof TypeError ? 'TypeError' : 'search_failed', {
          searchActivityRole: cancelled ? 'superseded' : 'continuation',
        });
        console.error('Search failed.');
        if (!cancelled)
          setSettled({ scope, results: [], failed: true, episodeId: episode.id, revision });
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, query, folders, openLocalDesignIds]);

  const displayedResults = useMemo(
    () =>
      SEARCH_RESULT_GROUPS.flatMap(({ entityType }) =>
        results.filter((result) => result.entityType === entityType)
      ),
    [results]
  );

  const handleSelect = useCallback(
    (entity: MountedCatalogEntitySearchResult) => {
      if (!current || loading || !settled || !settled.results.includes(entity)) return;
      const rank = displayedResults.indexOf(entity);
      const operation = beginWorkflowAction({
        workflow: 'search',
        action: 'open',
        searchEpisodeId: settled.episodeId,
        searchQueryRevision: settled.revision,
        resultCount: displayedResults.length,
        ...(rank >= 0 ? { resultRank: rank + 1 } : {}),
      });
      const accepted = dispatchOpenExactCatalogEntity({
        entityId: entity.entityId,
        label: entity.name,
        owningRoot: entity.workspaceRoot,
        onResult: (outcome) => settleCatalogSearchOpen({ operation, outcome }),
      });
      if (accepted) episodeRef.current = null;
    },
    [current, loading, settled, displayedResults]
  );

  const firstVisibleResult = useMemo(() => {
    for (const { entityType } of SEARCH_RESULT_GROUPS) {
      const match = results.find((result) => result.entityType === entityType);
      if (match) return match;
    }
    return null;
  }, [results]);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key === 'Enter' && firstVisibleResult && !loading) {
        event.preventDefault();
        handleSelect(firstVisibleResult);
      }
    },
    [firstVisibleResult, handleSelect, loading, onClose]
  );

  const hasResults = results.length > 0;
  const showEmpty = !loading && !failed && query.trim() && !hasResults;

  return (
    <div className="flex flex-col h-full" data-analytics-block data-ph-mask>
      <div className="p-4 border-b border-border">
        <h2 className="text-lg font-semibold text-fg mb-3">Search</h2>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search pages, sequences, primers..."
            className="w-full px-3 py-2 pl-9 rounded-md border border-border bg-bg text-fg text-sm placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            autoFocus
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          {loading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {failed ? (
          <div role="alert" className="p-4 text-center text-fg-muted text-sm">
            <p>Search could not finish. Try again.</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className="mt-2 text-accent hover:underline"
            >
              Retry search
            </button>
          </div>
        ) : showEmpty ? (
          <div className="p-4 text-center text-fg-muted text-sm">
            No results found for {'"'}
            {query}
            {'"'}
          </div>
        ) : (
          <>
            {SEARCH_RESULT_GROUPS.map(({ entityType, title, itemLabel }) => {
              const entities = results.filter((result) => result.entityType === entityType);
              return entities.length > 0 ? (
                <ResultSection
                  key={entityType}
                  title={title}
                  itemLabel={itemLabel}
                  entities={entities}
                  onSelect={handleSelect}
                />
              ) : null;
            })}

            {!query.trim() && !hasResults && (
              <div className="p-4 text-center text-fg-muted text-sm">
                <p>Start typing to search</p>
                <p className="mt-2 text-xs">Search across open workspace entities</p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border text-xs text-fg-muted flex gap-4">
        <span>
          <kbd className="px-1 py-0.5 bg-bg-muted rounded text-fg-subtle">Enter</kbd> to select
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-bg-muted rounded text-fg-subtle">Esc</kbd> to close
        </span>
      </div>
    </div>
  );
}

interface ResultSectionProps {
  title: string;
  itemLabel: string;
  entities: MountedCatalogEntitySearchResult[];
  onSelect: (entity: MountedCatalogEntitySearchResult) => void;
}

function ResultSection({ title, itemLabel, entities, onSelect }: ResultSectionProps) {
  return (
    <section className="py-2" role="region" aria-label={title}>
      <div className="px-4 py-1 text-xs font-medium text-fg-subtle uppercase tracking-wide">
        {title}
      </div>
      {entities.map((entity) => (
        <button
          key={`${entity.workspaceRoot}:${entity.entityId}`}
          type="button"
          aria-label={`Open ${entity.name} (${itemLabel})`}
          onClick={() => onSelect(entity)}
          className="w-full px-4 py-2 text-left hover:bg-bg-muted transition-colors flex items-center gap-2"
        >
          <span className="text-base" aria-hidden="true">
            {referenceIconFor(entity.entityType)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-fg truncate">{entity.name}</div>
            <div className="text-xs text-fg-muted truncate">{entity.workspaceName}</div>
          </div>
        </button>
      ))}
    </section>
  );
}

interface SearchResultPresentation {
  title: string;
  itemLabel: string;
}

const SEARCH_RESULT_PRESENTATION = {
  notebook: { title: 'Pages', itemLabel: 'page' },
  sequence: { title: 'Sequences', itemLabel: 'sequence' },
  primer: { title: 'Primers', itemLabel: 'primer' },
  design: { title: 'Designs', itemLabel: 'design' },
  structure: { title: 'Structures', itemLabel: 'structure' },
  protein: { title: 'Proteins', itemLabel: 'protein' },
  protocol: { title: 'Protocols', itemLabel: 'protocol' },
  protocol_run: { title: 'Protocol runs', itemLabel: 'protocol run' },
  alignment: { title: 'Alignments', itemLabel: 'alignment' },
  trace: { title: 'Traces', itemLabel: 'trace' },
  report: { title: 'Reports', itemLabel: 'report' },
  construct: { title: 'Constructs', itemLabel: 'construct' },
  sample: { title: 'Samples', itemLabel: 'sample' },
  record: { title: 'Records', itemLabel: 'record' },
  'track-view': { title: 'Track views', itemLabel: 'track view' },
  'molecular-document': { title: 'Molecular views', itemLabel: 'molecular document' },
  file: { title: 'Files', itemLabel: 'file' },
} as const satisfies Record<SidebarSearchableCatalogEntityType, SearchResultPresentation>;

const SEARCH_RESULT_GROUPS = (
  Object.keys(SEARCH_RESULT_PRESENTATION) as SidebarSearchableCatalogEntityType[]
).map((entityType) => ({ entityType, ...SEARCH_RESULT_PRESENTATION[entityType] }));
