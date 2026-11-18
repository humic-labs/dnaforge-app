import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InventoryScientificCitationEntry } from '@waypoint/domain-services';
import { parseProtocolPackage } from '@waypoint/domain-services/protocol-package';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import {
  inventoryScientificCitationsReadSchema,
  inventoryScientificCitationSourceReadSchema,
  type InventoryScientificCitationCursor,
  type InventoryScientificCitationsRead,
  type InventoryScientificCitationSourceRead,
} from '../../shared/inventory-scientific-citations';
import { FrozenProtocolDefinition } from '../scientific-document/FrozenProtocolDefinition';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import {
  InventoryScientificCitationSession,
  type CitationTarget,
  type CitationAction,
} from './inventory-scientific-citation-session';
import {
  sharedInventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { inventoryPrincipalLabel } from './inventory-view';

export type CitationSelection = {
  key: string;
  target: CitationTarget;
  action: CitationAction;
  resume?: InventoryAttempt;
};
type Read = Extract<InventoryScientificCitationsRead, { kind: 'ready' }>;
export function InventoryScientificCitations({
  target,
  onSelect,
}: {
  target: CitationTarget;
  onSelect(selection: CitationSelection): void;
}) {
  const client = platform().inventory;
  const [read, setRead] = useState<Read | null>(null),
    [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<InventoryScientificCitationCursor | null>(null),
    [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState<InventoryScientificCitationSourceRead | null>(null),
    [sourceLoading, setSourceLoading] = useState<string | null>(null),
    [sourceError, setSourceError] = useState<string | null>(null);
  const generation = useRef(0),
    sourceGeneration = useRef(0),
    navigation = useRef<AbortController | null>(null);
  const targetKey = JSON.stringify(target),
    cursorKey = JSON.stringify(cursor);
  useEffect(
    () =>
      client.onChanged((event) => {
        if (event.projectId !== target.project || event.inventoryId !== target.inventoryId) return;
        generation.current++;
        sourceGeneration.current++;
        navigation.current?.abort();
        setCursor(null);
        setRefresh((value) => value + 1);
      }),
    [client, targetKey]
  );
  useEffect(() => {
    const current = ++generation.current;
    sourceGeneration.current++;
    navigation.current?.abort();
    setRead(null);
    setError(null);
    setSource(null);
    setSourceError(null);
    setSourceLoading(null);
    void client
      .scientificCitations({ ...target, limit: 20, ...(cursor ? { cursor } : {}) })
      .then((raw) => {
        if (current !== generation.current) return;
        const result = inventoryScientificCitationsReadSchema.parse(raw);
        if (result.kind !== 'ready') {
          if (cursor && result.code === 'INVENTORY_QUERY_REVISION_CHANGED') {
            setCursor(null);
            return;
          }
          throw Error(result.message);
        }
        if (
          result.projectId !== target.project ||
          result.inventoryId !== target.inventoryId ||
          result.workId !== target.workId ||
          result.workIntentSha256 !== target.workIntentSha256 ||
          result.entries.length > 20 ||
          (cursor && result.revision !== cursor.revision)
        )
          throw Error('The citations belong to another work or inventory snapshot.');
        setRead(result);
      })
      .catch((cause) => {
        if (current === generation.current) setError(message(cause));
      });
    return () => {
      generation.current++;
      sourceGeneration.current++;
      navigation.current?.abort();
    };
  }, [client, targetKey, cursorKey, refresh]);
  function select(action: CitationAction) {
    onSelect({ key: crypto.randomUUID(), target, action });
  }
  async function saved(entry: InventoryScientificCitationEntry) {
    const current = generation.current,
      selected = ++sourceGeneration.current;
    setSource(null);
    setSourceError(null);
    setSourceLoading(entry.citation.id);
    try {
      const result = inventoryScientificCitationSourceReadSchema.parse(
        await client.scientificCitationSource({
          project: target.project,
          inventoryId: target.inventoryId,
          citationId: entry.citation.id,
        })
      );
      if (current !== generation.current || selected !== sourceGeneration.current) return;
      if (result.kind === 'available') {
        const context = entry.citation.context,
          savedId =
            result.source.schema === 'dnaforge.notebook-saved-source.v1'
              ? result.source.pageId
              : result.source.runId;
        if (
          result.citationId !== entry.citation.id ||
          result.workId !== target.workId ||
          result.sourceSha256 !== context.source.sha256 ||
          result.source.projectId !== context.projectId ||
          result.source.workspaceScope !== context.workspaceScope ||
          result.source.fileObjectUuid !== context.source.fileObjectUuid ||
          savedId !== context.entityId ||
          (context.kind === 'notebook-page') !==
            (result.source.schema === 'dnaforge.notebook-saved-source.v1')
        )
          throw Error('The saved citation context does not match this record.');
      }
      setSource(result);
    } catch (cause) {
      if (current === generation.current && selected === sourceGeneration.current)
        setSourceError(message(cause));
    } finally {
      if (current === generation.current && selected === sourceGeneration.current)
        setSourceLoading(null);
    }
  }
  async function open(entry: InventoryScientificCitationEntry) {
    const current = generation.current;
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    try {
      await openProjectResourceReference(
        {
          kind: 'entity',
          projectId: entry.citation.context.projectId,
          entityId: entry.citation.context.entityId,
        },
        { signal: controller.signal }
      );
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted)
        setSourceError(message(cause));
    }
  }
  return (
    <section
      className="space-y-3 border-t border-border pt-3"
      data-testid="scientific-citations"
      data-work-id={target.workId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Additional citations</h4>
        <Button disabled={!read} onClick={() => select({ kind: 'add' })}>
          Add saved citation
        </Button>
      </div>
      {error ? (
        <Notice tone="error">
          {error}
          <Button
            onClick={() => {
              setCursor(null);
              setRefresh((value) => value + 1);
            }}
          >
            Retry citations
          </Button>
        </Notice>
      ) : !read ? (
        <p role="status">Loading citations…</p>
      ) : (
        <>
          {!read.entries.length ? <p>No additional saved citations for this work.</p> : null}
          {read.entries.map((entry) => (
            <article
              className="space-y-2 rounded border border-border p-3"
              key={entry.citation.id}
              data-citation-id={entry.citation.id}
              data-citation-status={entry.withdrawal ? 'withdrawn' : 'active'}
            >
              <h5 className="font-semibold">
                {entry.citation.context.source.title} · {entry.withdrawal ? 'Withdrawn' : 'Active'}
              </h5>
              <p>
                {entry.citation.context.kind === 'notebook-page' ? 'Notebook page' : 'Protocol Run'}{' '}
                · {inventoryPrincipalLabel(entry.citation.by)} ·{' '}
                {new Date(entry.citation.at).toISOString()}
              </p>
              <p>Reason: {entry.citation.reason}</p>
              {entry.withdrawal ? (
                <p>
                  Withdrawal: {entry.withdrawal.reason} ·{' '}
                  {inventoryPrincipalLabel(entry.withdrawal.by)} ·{' '}
                  {new Date(entry.withdrawal.at).toISOString()}
                </p>
              ) : null}
              <details>
                <summary>Citation identity and saved source</summary>
                <p className="break-all text-xs">{entry.citation.id}</p>
                <p className="break-all text-xs">{entry.citation.context.source.sha256}</p>
                {entry.citation.reinstates ? (
                  <p className="break-all text-xs">
                    Added again after withdrawal: {entry.citation.reinstates.withdrawalId}
                  </p>
                ) : null}
              </details>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={sourceLoading === entry.citation.id}
                  onClick={() => void saved(entry)}
                >
                  View saved citation
                </Button>
                <Button onClick={() => void open(entry)}>Open current source</Button>
                {entry.withdrawal ? (
                  <Button onClick={() => select({ kind: 'reattach', entry })}>
                    Add citation again
                  </Button>
                ) : (
                  <Button onClick={() => select({ kind: 'withdraw', entry })}>
                    Withdraw citation
                  </Button>
                )}
              </div>
              {source?.kind === 'available' && source.citationId === entry.citation.id ? (
                <SavedCitation read={source} />
              ) : null}
            </article>
          ))}
          <div className="flex gap-2">
            <Button disabled={!cursor} onClick={() => setCursor(null)}>
              First citations page
            </Button>
            <Button disabled={!read.nextCursor} onClick={() => setCursor(read.nextCursor)}>
              Next citations page
            </Button>
          </div>
        </>
      )}
      {sourceLoading ? <p role="status">Loading saved citation…</p> : null}
      {sourceError ? (
        <Notice tone="error">{sourceError}</Notice>
      ) : source?.kind === 'unavailable' ? (
        <Notice tone="error">{source.message}</Notice>
      ) : null}
    </section>
  );
}
function SavedCitation({
  read,
}: {
  read: Extract<InventoryScientificCitationSourceRead, { kind: 'available' }>;
}) {
  const source = read.source;
  return (
    <section
      className="space-y-2 border-t border-border pt-2"
      data-testid="retained-citation-source"
    >
      <h5 className="font-semibold">Saved citation: {source.title}</h5>
      <p>This copy preserves the source from when the citation was recorded.</p>
      {source.schema === 'dnaforge.notebook-saved-source.v1' ? (
        <TextArea
          readOnly
          aria-label="Saved cited notebook context"
          value={savedText(source.content)}
          rows={6}
        />
      ) : (
        <FrozenProtocolDefinition raw={parseProtocolPackage(source.originalText).raw} />
      )}
      <details>
        <summary>Complete saved citation record</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(source, null, 2)}
        </pre>
      </details>
    </section>
  );
}
function savedText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const node = content as { text?: unknown; content?: unknown; type?: unknown };
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.content)
    ? node.content.map(savedText).join(node.type === 'doc' ? '\n' : '')
    : '';
}
export function InventoryCitationHost({
  projectId,
  selection,
  onSelect,
}: {
  projectId: string | null;
  selection: CitationSelection | null;
  onSelect(value: CitationSelection | null): void;
}) {
  const pending = sharedInventoryPendingCoordinator(),
    snapshot = useSyncExternalStore(pending.subscribe, pending.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      pending.refresh();
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [pending, projectId]);
  useEffect(() => {
    if (selection && selection.target.project !== projectId) onSelect(null);
  }, [projectId, selection]);
  const attempt = snapshot.attempts.find((entry) => entry.request.project === projectId);
  function resume() {
    if (
      !attempt ||
      !('kind' in attempt.request) ||
      (attempt.request.kind !== 'record-scientific-citation' &&
        attempt.request.kind !== 'withdraw-scientific-citation')
    )
      return;
    onSelect({
      key: crypto.randomUUID(),
      target: {
        project: attempt.request.project,
        inventoryId: attempt.request.inventoryId,
        workId: attempt.request.choices.workId,
        workIntentSha256: attempt.request.choices.workIntentSha256,
      },
      action: { kind: 'add' },
      resume: attempt,
    });
  }
  return (
    <>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : attempt && !selection ? (
        <Notice>
          A saved inventory change needs confirmation.{' '}
          {'kind' in attempt.request &&
          ['record-scientific-citation', 'withdraw-scientific-citation'].includes(
            attempt.request.kind
          ) ? (
            <Button onClick={resume}>Resume saved change</Button>
          ) : (
            <span>Open Inventory to confirm it before another change.</span>
          )}
        </Notice>
      ) : null}
      {selection ? (
        <CitationDialog
          key={selection.key}
          selection={selection}
          onClose={() => onSelect(null)}
          onSelect={(action) =>
            onSelect({ key: crypto.randomUUID(), target: selection.target, action })
          }
        />
      ) : null}
    </>
  );
}
function CitationDialog({
  selection,
  onClose,
  onSelect,
}: {
  selection: CitationSelection;
  onClose(): void;
  onSelect(action: CitationAction): void;
}) {
  const client = platform().inventory,
    pending = sharedInventoryPendingCoordinator(),
    overlay = usePresentationOverlay('modal');
  const session = useMemo(
    () =>
      new InventoryScientificCitationSession(client, pending, selection.target, selection.action, {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
      }),
    [selection.key]
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot),
    { draft, phase } = snapshot;
  const [contexts, setContexts] = useState<
      Awaited<ReturnType<typeof client.scientificContextsV2>>['contexts']
    >([]),
    [contextError, setContextError] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    session.activate();
    if (selection.resume) session.resume(selection.resume);
    const inventory = client.onChanged((event) => {
      if (
        event.projectId === selection.target.project &&
        event.inventoryId === selection.target.inventoryId
      )
        session.invalidatePreview();
    });
    const notebook = platform().notebook.onChanged(() => {
      if (session.getSnapshot().draft.contextKind === 'notebook-page') session.invalidatePreview();
    });
    const protocols = platform().protocols.onChanged((event) => {
      if (
        event.projectId === selection.target.project &&
        event.entityId === session.getSnapshot().draft.entityId
      )
        session.invalidatePreview();
    });
    return () => {
      inventory();
      notebook();
      protocols();
      session.dispose();
    };
  }, [session]);
  useEffect(() => {
    let active = true;
    if (selection.action.kind !== 'add' || selection.resume) return;
    setLoading(true);
    setContextError(null);
    void client
      .scientificContextsV2({
        project: selection.target.project,
        inventoryId: selection.target.inventoryId,
        kind: draft.contextKind,
        query,
        limit: 50,
      })
      .then((result) => {
        if (!active) return;
        if (
          result.projectId !== selection.target.project ||
          result.inventoryId !== selection.target.inventoryId
        )
          throw Error('Saved sources belong to another inventory.');
        setContexts(result.contexts);
        if (
          draft.entityId &&
          !result.contexts.some(
            (entry) =>
              entry.entityId === draft.entityId && entry.sourceSha256 === draft.sourceSha256
          )
        )
          session.invalidatePreview();
      })
      .catch((cause) => {
        if (active) {
          setContexts([]);
          setContextError(message(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, selection.key, draft.contextKind, query, refresh]);
  const locked = ['sending', 'unknown', 'saved-refresh-failed', 'previewing', 'complete'].includes(
      phase.kind
    ),
    preview = phase.kind === 'previewed' ? phase.preview : null;
  const withdrawal = selection.action.kind === 'withdraw',
    title = selection.resume
      ? 'Confirm saved citation change'
      : withdrawal
        ? 'Withdraw citation'
        : selection.action.kind === 'reattach'
          ? 'Add citation again'
          : 'Add saved citation';
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="flex max-h-[calc(100vh-48px)] w-full max-w-2xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid="scientific-citation-dialog"
          data-citation-draft-id={draft.identityId}
          data-citation-phase={phase.kind}
        >
          <header className="border-b border-border p-4">
            <h2 className="font-semibold">{title}</h2>
          </header>
          <div className="space-y-4 overflow-y-auto p-4">
            <p>
              {withdrawal
                ? 'Record why this citation was withdrawn. Its original details and saved context stay in history.'
                : 'Attach a saved page or Run as a citation for this recorded work.'}
            </p>
            {'entry' in selection.action ? (
              <Notice>
                <p>{selection.action.entry.citation.context.source.title}</p>
                <p>Original reason: {selection.action.entry.citation.reason}</p>
                <p className="break-all text-xs">
                  {selection.action.entry.citation.context.source.sha256}
                </p>
              </Notice>
            ) : null}
            {!selection.resume ? (
              <fieldset disabled={locked} className="space-y-3">
                {selection.action.kind === 'add' ? (
                  <>
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span>Citation source kind</span>
                      <Select
                        ariaLabel="Citation source kind"
                        value={draft.contextKind}
                        options={[
                          { value: 'notebook-page', label: 'Notebook page' },
                          { value: 'protocol-run', label: 'Protocol Run' },
                        ]}
                        onValueChange={(value) =>
                          session.edit({
                            ...draft,
                            contextKind: value as typeof draft.contextKind,
                            entityId: '',
                            sourceSha256: '',
                          })
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span>Find saved source</span>
                      <TextField
                        aria-label="Find saved citation source"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <Button
                      onClick={() => {
                        session.invalidatePreview();
                        setRefresh((value) => value + 1);
                      }}
                    >
                      Refresh saved sources
                    </Button>
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span>Saved source</span>
                      {loading ? (
                        <p role="status">Loading saved sources…</p>
                      ) : contextError ? (
                        <Notice tone="error">{contextError}</Notice>
                      ) : (
                        <Select
                          ariaLabel="Saved citation source"
                          value={draft.entityId}
                          options={[
                            { value: '', label: 'Choose a saved source' },
                            ...contexts.map((entry) => ({
                              value: entry.entityId,
                              label: entry.title,
                              description: entry.entityId,
                            })),
                          ]}
                          onValueChange={(value) => {
                            const entry = contexts.find((item) => item.entityId === value);
                            session.edit({
                              ...draft,
                              entityId: value,
                              sourceSha256: entry?.sourceSha256 ?? '',
                            });
                          }}
                        />
                      )}
                    </label>
                    {draft.sourceSha256 ? (
                      <details>
                        <summary>Selected saved source version</summary>
                        <p className="break-all text-xs">{draft.sourceSha256}</p>
                      </details>
                    ) : null}
                    {contexts.some(
                      (entry) =>
                        entry.entityId === draft.entityId &&
                        entry.sourceSha256 !== draft.sourceSha256
                    ) ? (
                      <Notice>
                        The saved source changed.{' '}
                        <Button
                          onClick={() => {
                            const current = contexts.find(
                              (entry) => entry.entityId === draft.entityId
                            );
                            if (current)
                              session.edit({ ...draft, sourceSha256: current.sourceSha256 });
                          }}
                        >
                          Use current saved version
                        </Button>
                      </Notice>
                    ) : null}
                  </>
                ) : selection.action.kind === 'reattach' ? (
                  <p>
                    This adds a new citation after the recorded withdrawal, using that same saved
                    source version.
                    <Button onClick={() => onSelect({ kind: 'add' })}>
                      Choose another saved source
                    </Button>
                  </p>
                ) : null}
                <label className="flex flex-col gap-1.5 text-sm">
                  <span>{withdrawal ? 'Reason for withdrawal' : 'Reason for citation'}</span>
                  <TextArea
                    aria-label={withdrawal ? 'Reason for withdrawal' : 'Reason for citation'}
                    value={draft.reason}
                    rows={3}
                    onChange={(event) => session.edit({ ...draft, reason: event.target.value })}
                  />
                </label>
                <Button onClick={() => void session.preview()}>
                  Preview {withdrawal ? 'withdrawal' : 'citation'}
                </Button>
              </fieldset>
            ) : null}
            {preview?.kind === 'blocked' ? (
              <Notice tone="error">{preview.issues.map((issue) => issue.message).join(' ')}</Notice>
            ) : preview?.kind === 'no-change' ? (
              <Notice>
                {'match' in preview ? (
                  preview.match.kind === 'primary-context' ? (
                    <p>This saved source is already the primary context for this work.</p>
                  ) : (
                    <>
                      <p>
                        {preview.match.entry.withdrawal
                          ? 'This citation was withdrawn.'
                          : 'This saved source is already cited.'}
                      </p>
                      <p>Original reason: {preview.match.entry.citation.reason}</p>
                      {preview.match.entry.withdrawal ? (
                        <>
                          <p>Withdrawal: {preview.match.entry.withdrawal.reason}</p>
                          <Button
                            onClick={() =>
                              onSelect({
                                kind: 'reattach',
                                entry:
                                  preview.match.kind === 'citation'
                                    ? preview.match.entry
                                    : neverEntry(),
                              })
                            }
                          >
                            Add citation again
                          </Button>
                        </>
                      ) : null}
                    </>
                  )
                ) : (
                  <p>This citation was already withdrawn. {preview.withdrawal.reason}</p>
                )}
              </Notice>
            ) : preview?.kind === 'ready' ? (
              <Notice>
                {withdrawal
                  ? 'Ready to record the withdrawal.'
                  : 'Ready to add this saved citation.'}
              </Notice>
            ) : null}
            {phase.kind === 'sending' ? (
              <p role="status">Saving citation change…</p>
            ) : phase.kind === 'unknown' ? (
              <Notice tone="warning">
                {phase.message}
                <Button onClick={() => void session.checkStatus()}>Check status</Button>
                <Button onClick={() => void session.retry()}>Retry same change</Button>
              </Notice>
            ) : phase.kind === 'saved-refresh-failed' ? (
              <Notice tone="warning">
                {phase.message}
                <Button onClick={() => void session.reloadSaved()}>Reload saved citations</Button>
              </Notice>
            ) : phase.kind === 'failed' ? (
              <Notice tone="error">{phase.message}</Notice>
            ) : phase.kind === 'complete' ? (
              <Notice>{phase.message}</Notice>
            ) : null}
          </div>
          <footer className="flex justify-end gap-2 border-t border-border p-4">
            <Button disabled={phase.kind === 'sending'} onClick={onClose}>
              {phase.kind === 'complete' ? 'Close' : 'Cancel'}
            </Button>
            {preview?.kind === 'ready' && !locked ? (
              <Button variant="primary" onClick={() => void session.submit()}>
                {withdrawal
                  ? 'Withdraw citation'
                  : selection.action.kind === 'reattach'
                    ? 'Add citation again'
                    : 'Add citation'}
              </Button>
            ) : null}
          </footer>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function neverEntry(): never {
  throw Error('The citation match is unavailable.');
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Citations could not be loaded.';
}
