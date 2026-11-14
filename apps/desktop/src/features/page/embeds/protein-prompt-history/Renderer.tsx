import {
  withUserMessage,
  toUserMessage,
  userMessage,
  userEntityLabel,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConversation } from '../../../../db';
import { getEntityReference, getEntityReferencesByIds } from '../../../../db/entity-references';
import {
  listMolecularPromptTrialResults,
  listMolecularPromptTrialStarts,
  listMolecularPromptTrialViewPreviews,
  MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT,
  type MolecularPromptTrialViewPreview,
} from '../../../../db/molecular-prompt-trials';
import { navigateToReference } from '../../../ai/public/navigate-to-reference';
import { useCanvasStore } from '../../../canvas/public/store';
import type { LayoutNode } from '../../../canvas/public/types';
import {
  ensureMolecularPromptNotebookCurrent,
  MOLECULAR_PROMPT_NOTEBOOK_ID,
} from '../../../ai/public/molecular-prompt-notebook';
import type { EmbedRendererProps } from '../types';
import { MolecularPromptBatchControls } from './BatchControls';
import { ProteinCorpusTrajectory } from './CorpusTrajectory';
import {
  buildProteinCorpusLedger,
  proteinCorpusEvidenceBundle,
  type ProteinCorpusInput,
} from './corpus-ledger';
import { ProteinPromptComparison } from './PromptComparison';
import { ProteinViewAssessment } from './ViewAssessment';
import {
  applyProteinSavedViewReferenceToTab,
  getOrCreateProteinComparisonReference,
  PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT,
} from './RunVersionSwitcher';
import {
  buildProteinRunIndex,
  groupProteinRunsByCase,
  groupProteinRunVersions,
  sortProteinRunEntries,
  type ProteinRunIndex,
  type ProteinRunIndexEntry,
  type ProteinRunSortDirection,
  type ProteinRunSortKey,
  type ProteinTestCaseRow,
} from './run-index';

function panelIdsInOrder(node: LayoutNode): string[] {
  return node.type === 'panel' ? [node.panelId] : node.children.flatMap(panelIdsInOrder);
}

function showRunChat(conversationId: string): void {
  const canvas = useCanvasStore.getState();
  const leftPanelId = panelIdsInOrder(canvas.layout)[0];
  if (!leftPanelId) throw new Error('No pane is available for the recorded chat.');
  const exact = canvas.findTab('chat', conversationId);
  const preview = canvas.panels[leftPanelId]?.tabs.find(
    (tab) => tab.type === 'chat' && tab.proteinRunPreview
  );
  let tabId: string;
  if (exact) {
    if (exact.panelId !== leftPanelId) canvas.moveTab(exact.panelId, leftPanelId, exact.tabId);
    tabId = exact.tabId;
  } else if (preview) {
    canvas.retargetTab(
      leftPanelId,
      preview.id,
      { type: 'chat', entityId: conversationId },
      { label: 'Recorded chat' }
    );
    tabId = preview.id;
  } else {
    tabId = canvas.openTab(leftPanelId, {
      type: 'chat',
      entityId: conversationId,
      label: 'Recorded chat',
      proteinRunPreview: true,
    });
  }
  canvas.setActiveTab(leftPanelId, tabId);
  canvas.focusPanel(leftPanelId);
}

function matchesSearch(
  entry: ProteinRunIndexEntry,
  query: string,
  previews: Record<string, MolecularPromptTrialViewPreview>
): boolean {
  if (!query) return true;
  return [
    entry.title,
    entry.caseTitle,
    entry.question,
    entry.methodLabel,
    entry.status,
    entry.id,
    entry.promptLabel,
    entry.promptSummary,
    entry.promptInstructions,
    entry.sentPrompt,
    entry.harnessLabel,
    entry.routeLabel,
    ...entry.feedback.map((note) => note.text),
    ...entry.outputIds.map((id) => previews[id]?.label),
  ].some((value) => value?.toLocaleLowerCase().includes(query));
}

function recordedTrialVisualInstructions(instructions: string): string {
  const marker = /\nPrompt module [^\n]+:\n/.exec(instructions);
  if (marker && marker.index !== undefined) {
    const start = marker.index + marker[0].length;
    const end = instructions.indexOf('\nPinned coordinate fixtures for this conversation:', start);
    const visual = (end < 0 ? instructions.slice(start) : instructions.slice(start, end)).trim();
    return visual || 'No added visual guidance was saved.';
  }
  if (instructions.includes('Fixed protein benchmark context (v1):'))
    return 'No added visual module in the saved trial instructions.';
  return instructions.trim();
}

const COLUMN_WIDTH_STORAGE_KEY = 'dnaforge:protein-history-column-widths-v2';
const DEFAULT_COLUMN_WIDTHS = [17, 12, 22, 13, 16, 20];
const MIN_COLUMN_WIDTHS = [10, 8, 12, 10, 12, 14];

function hasCapturedPrompt(entry: ProteinRunIndexEntry): boolean {
  return !!(
    entry.sentPrompt &&
    entry.scenePolicy &&
    (entry.sentPromptChannel !== 'cli-seed' || entry.continuationPrompt)
  );
}

function isReviewedVisualReference(entry: ProteinRunIndexEntry): boolean {
  return entry.feedback.length > 0 && entry.outputIds.length > 0;
}

function readColumnWidths(): number[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY) ?? 'null');
    if (
      Array.isArray(saved) &&
      saved.length === DEFAULT_COLUMN_WIDTHS.length &&
      saved.every(
        (width, index) =>
          typeof width === 'number' && Number.isFinite(width) && width >= MIN_COLUMN_WIDTHS[index]
      ) &&
      Math.abs(saved.reduce((sum, width) => sum + width, 0) - 100) < 0.01
    )
      return saved;
  } catch {}
  return [...DEFAULT_COLUMN_WIDTHS];
}

function resizeAdjacentColumns(widths: number[], boundary: number, deltaPercent: number): number[] {
  const pairWidth = widths[boundary] + widths[boundary + 1];
  const left = Math.max(
    MIN_COLUMN_WIDTHS[boundary],
    Math.min(pairWidth - MIN_COLUMN_WIDTHS[boundary + 1], widths[boundary] + deltaPercent)
  );
  const next = [...widths];
  next[boundary] = left;
  next[boundary + 1] = pairWidth - left;
  return next;
}

export function ProteinPromptHistoryRenderer({ attrs }: EmbedRendererProps) {
  const pageId = typeof attrs.pageId === 'string' ? attrs.pageId : MOLECULAR_PROMPT_NOTEBOOK_ID;
  const [index, setIndex] = useState<ProteinRunIndex | null>(null);
  const [corpusInput, setCorpusInput] = useState<ProteinCorpusInput | null>(null);
  const [previews, setPreviews] = useState<Record<string, MolecularPromptTrialViewPreview>>({});
  const [query, setQuery] = useState('');
  const [questionFilter, setQuestionFilter] = useState('');
  const [sortKey, setSortKey] = useState<ProteinRunSortKey>('run');
  const [sortDirection, setSortDirection] = useState<ProteinRunSortDirection>('desc');
  const [columnWidths, setColumnWidths] = useState(readColumnWidths);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<Record<string, string>>({});
  const [alternateRuns, setAlternateRuns] = useState<Record<string, string>>({});
  const [outputIndices, setOutputIndices] = useState<Record<string, number>>({});
  const opening = useRef(false);
  const requestId = useRef(0);
  const resizeDrag = useRef<{
    boundary: number;
    startX: number;
    tableWidth: number;
    widths: number[];
  } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
    } catch {}
  }, [columnWidths]);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const [starts, results] = await Promise.all([
        listMolecularPromptTrialStarts(),
        listMolecularPromptTrialResults(),
      ]);
      const nextCorpusInput = { starts, results };
      buildProteinCorpusLedger(nextCorpusInput);
      const next = buildProteinRunIndex({ starts, results, harnessRecords: [], savedViews: [] });
      const viewIds = [
        ...new Set(
          next.promptTrials
            .filter((entry) => hasCapturedPrompt(entry) || isReviewedVisualReference(entry))
            .flatMap((entry) => entry.outputIds)
        ),
      ];
      const viewPreviews = await listMolecularPromptTrialViewPreviews(viewIds);
      if (request !== requestId.current) return;
      setIndex(next);
      setCorpusInput(nextCorpusInput);
      setPreviews(Object.fromEntries(viewPreviews.map((preview) => [preview.id, preview])));
      setError(null);
    } catch (cause) {
      if (request === requestId.current)
        setError(toUserMessage(cause, 'failure.could-not-load-protein-run-history'));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const reload = () => {
      void refresh();
    };
    window.addEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, reload);
    return () => {
      requestId.current++;
      window.removeEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, reload);
    };
  }, [refresh]);

  useEffect(() => {
    if (pageId !== MOLECULAR_PROMPT_NOTEBOOK_ID) return;
    void ensureMolecularPromptNotebookCurrent().catch((cause: unknown) => {
      setError(toUserMessage(cause, 'failure.could-not-update-the-run-notebook'));
    });
  }, [pageId]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const corpusLedger = useMemo(
    () => (corpusInput ? buildProteinCorpusLedger(corpusInput) : null),
    [corpusInput]
  );
  const downloadCorpusEvidence = () => {
    if (!corpusInput) return;
    try {
      const bundle = proteinCorpusEvidenceBundle(corpusInput);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `protein-corpus-evidence-${new Date(bundle.generatedAt).toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice('Exact recorded prompts, output IDs, feedback, and trajectory exported.');
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-export-corpus-evidence'));
    }
  };
  const recorded = useMemo(
    () =>
      index
        ? index.promptTrials.filter(
            (entry) => hasCapturedPrompt(entry) || isReviewedVisualReference(entry)
          )
        : [],
    [index]
  );
  const questions = useMemo(() => {
    const byQuestion = new Map<string, string>();
    for (const entry of recorded) {
      if (entry.question && !byQuestion.has(entry.question))
        byQuestion.set(entry.question, entry.caseTitle);
    }
    return [...byQuestion].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }, [recorded]);
  const cases = useMemo(
    () => groupProteinRunsByCase(sortProteinRunEntries(recorded, sortKey, sortDirection)),
    [recorded, sortKey, sortDirection]
  );
  useEffect(() => {
    const onStructureNavigated = (event: Event) => {
      const referenceId = (event as CustomEvent<{ referenceId?: string }>).detail?.referenceId;
      if (!referenceId) return;
      for (const row of cases) {
        const entry =
          row.versions.find(
            (candidate) =>
              candidate.id === selectedRuns[row.id] && candidate.outputIds.includes(referenceId)
          ) ?? row.versions.find((candidate) => candidate.outputIds.includes(referenceId));
        if (!entry) continue;
        setSelectedRuns((current) => ({ ...current, [row.id]: entry.id }));
        setOutputIndices((current) => ({
          ...current,
          [row.id]: entry.outputIds.indexOf(referenceId),
        }));
        break;
      }
    };
    window.addEventListener(PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT, onStructureNavigated);
    return () =>
      window.removeEventListener(PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT, onStructureNavigated);
  }, [cases, selectedRuns]);
  const visibleCases = useMemo(
    () =>
      cases.filter((row) =>
        row.versions.some(
          (entry) =>
            (!questionFilter || entry.question === questionFilter) &&
            matchesSearch(entry, normalizedQuery, previews)
        )
      ),
    [cases, questionFilter, normalizedQuery, previews]
  );
  const changeSort = (key: ProteinRunSortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDirection(key === 'run' ? 'desc' : 'asc');
    }
  };

  const startColumnResize = (boundary: number, event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    const tableWidth = event.currentTarget.closest('table')?.getBoundingClientRect().width;
    if (!tableWidth) return;
    event.preventDefault();
    event.stopPropagation();
    resizeDrag.current = { boundary, startX: event.clientX, tableWidth, widths: columnWidths };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveColumnResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = resizeDrag.current;
    if (!drag) return;
    event.preventDefault();
    setColumnWidths(
      resizeAdjacentColumns(
        drag.widths,
        drag.boundary,
        ((event.clientX - drag.startX) / drag.tableWidth) * 100
      )
    );
  };

  const finishColumnResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (!resizeDrag.current) return;
    moveColumnResize(event);
    resizeDrag.current = null;
  };

  const openRun = async (
    entry: ProteinRunIndexEntry,
    referenceId = entry.outputIds[0],
    openChat = false,
    replacePreview = false,
    openComparison = false
  ) => {
    if (opening.current) return false;
    opening.current = true;
    setBusyId(entry.id);
    setError(null);
    setNotice(null);
    try {
      if (openChat && entry.conversationId && !(await getConversation(entry.conversationId)))
        throw new Error('The recorded chat link is missing; the saved view was not changed.');
      if (referenceId) {
        let reference = await getEntityReference(referenceId);
        if (!reference || reference.entity_type !== 'structure')
          throw withUserMessage(
            new Error('This saved molecular view is missing.'),
            'guidance.this-saved-molecular-view-is-missing'
          );
        if (openComparison) {
          const recorded = await getEntityReferencesByIds(entry.outputIds);
          const byId = new Map(recorded.map((item) => [item.id, item]));
          const structures = entry.outputIds.map((id) => {
            const item = byId.get(id);
            const savedViewId = item?.locator?.match(
              /^entity:\/\/structure\/(saved-view:[^/]+)$/
            )?.[1];
            const coordinateSha256 = previews[id]?.coordinateSha256;
            if (!item || !savedViewId || !coordinateSha256)
              throw new Error('A recorded comparison structure is missing its pinned coordinates.');
            return {
              referenceId: id,
              savedViewId,
              label: previews[id]?.label ?? item.display_label,
              coordinateSha256,
            };
          });
          reference = (await getOrCreateProteinComparisonReference(structures)).reference;
        }
        const canvas = useCanvasStore.getState();
        const notebookPanelId = canvas.findTab('page', pageId)?.panelId;
        const targetPanelId = notebookPanelId
          ? canvas.agentContentPlacement(notebookPanelId).targetPanelId
          : panelIdsInOrder(canvas.layout).slice(-1)[0];
        const targetPanel = targetPanelId ? canvas.panels[targetPanelId] : undefined;
        const isReusablePreview = (tab: NonNullable<typeof targetPanel>['tabs'][number]) =>
          tab.type === 'structure' &&
          tab.proteinRunPreview &&
          tab.entityId.startsWith('saved-view:');
        const previewTab =
          replacePreview && targetPanel
            ? (targetPanel.tabs.find(
                (tab) => tab.id === targetPanel.activeTabId && isReusablePreview(tab)
              ) ?? targetPanel.tabs.find(isReusablePreview))
            : undefined;
        let opened;
        if (previewTab && targetPanelId) {
          await applyProteinSavedViewReferenceToTab(
            targetPanelId,
            previewTab.id,
            previewTab.entityId,
            reference
          );
          canvas.setActiveTab(targetPanelId, previewTab.id);
          opened = { panelId: targetPanelId, tabId: previewTab.id, created: false };
        } else {
          opened = await navigateToReference(reference, { sourceNotebookPageId: pageId });
        }
        if (!opened.panelId || !opened.tabId)
          throw new Error('A saved molecular view must open a canvas tab.');
        const nextCanvas = useCanvasStore.getState();
        const openedTab = nextCanvas.panels[opened.panelId]?.tabs.find(
          (tab) => tab.id === opened.tabId
        );
        if (opened.created || openedTab?.proteinRunPreview)
          nextCanvas.updateTab(opened.panelId, opened.tabId, {
            proteinRunPreview: true,
            label: entry.experiment
              ? `${entry.caseTitle} · ${entry.promptLabel} · Run ${entry.experiment.replicate}`
              : `${entry.caseTitle} · ${new Date(entry.createdAt).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })} · ${entry.promptLabel}`,
          });
      }
      if (openChat && entry.conversationId) showRunChat(entry.conversationId);
      if (!referenceId && openChat) setNotice('No saved view is linked to this chat.');
      return true;
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-open-this-recorded-run'));
      return false;
    } finally {
      opening.current = false;
      setBusyId(null);
    }
  };

  const renderEntry = (row: ProteinTestCaseRow) => {
    const versions = groupProteinRunVersions(row);
    const entry =
      row.versions.find((version) => version.id === selectedRuns[row.id]) ?? versions[0].runs[0];
    const version = versions.find((group) => group.runs.some((run) => run.id === entry.id))!;
    const replicateIndex = entry.experiment?.replicate ?? version.runs.indexOf(entry) + 1;
    const otherVersion =
      versions.find(
        (group) =>
          group.label !== version.label &&
          version.experimentId &&
          group.experimentId === version.experimentId
      ) ?? versions.find((group) => group.label !== version.label);
    const alternate =
      row.versions.find(
        (version) =>
          version.id === alternateRuns[row.id] &&
          version.id !== entry.id &&
          version.promptLabel !== entry.promptLabel
      ) ??
      otherVersion?.runs.find((run) => run.experiment?.replicate === replicateIndex) ??
      otherVersion?.runs[replicateIndex - 1] ??
      otherVersion?.runs[0];
    const outputIndex = outputIndices[row.id] ?? 0;
    const referenceId = entry.outputIds[outputIndex] ?? entry.outputIds[0];
    const firstPreview = referenceId ? previews[referenceId] : null;
    const coordinateDigests = entry.outputIds.map((id) => previews[id]?.coordinateSha256);
    const separateStructures =
      entry.outputIds.length > 1 &&
      coordinateDigests.every((digest): digest is string => !!digest) &&
      new Set(coordinateDigests).size === entry.outputIds.length;
    const outputKind = separateStructures ? 'saved structures' : 'saved outputs';
    const viewLabel =
      firstPreview?.label ?? (entry.outputIds.length ? 'Saved scene' : 'No saved view');
    const openSelected = async (id = referenceId, openChat = false) => {
      const opened = await openRun(entry, id, openChat);
      if (opened) setSelectedRuns((current) => ({ ...current, [row.id]: entry.id }));
      return opened;
    };
    const instructions = entry.promptInstructions
      ? recordedTrialVisualInstructions(entry.promptInstructions)
      : null;
    const switchVersion = async (id: string) => {
      const next = row.versions.find((version) => version.id === id);
      if (!next || next.id === entry.id) return;
      const nextReference = next.outputIds[outputIndex] ?? next.outputIds[0];
      const opened = await openRun(next, nextReference, false, true);
      if (!opened) return;
      setSelectedRuns((current) => ({ ...current, [row.id]: next.id }));
      if (next.promptLabel !== entry.promptLabel)
        setAlternateRuns((current) => ({ ...current, [row.id]: entry.id }));
      else {
        const nextIndex = next.experiment?.replicate ?? version.runs.indexOf(next) + 1;
        const other =
          otherVersion?.runs.find((run) => run.experiment?.replicate === nextIndex) ??
          otherVersion?.runs[nextIndex - 1];
        if (other) setAlternateRuns((current) => ({ ...current, [row.id]: other.id }));
      }
      if (!nextReference)
        setNotice('This version has no saved view. Its recorded prompt is shown.');
      else
        setOutputIndices((current) => ({
          ...current,
          [row.id]: next.outputIds.indexOf(nextReference),
        }));
    };
    const versionLabels = new Map<string, number>();
    for (const group of versions)
      versionLabels.set(group.label, (versionLabels.get(group.label) ?? 0) + 1);
    const alternateNumber = alternate?.promptLabel.match(/\bv\d+\b/i)?.[0];
    const currentNumber = entry.promptLabel.match(/\bv\d+\b/i)?.[0];
    return (
      <tr
        key={row.id}
        data-testid="protein-run-row"
        data-case-id={row.id}
        data-run-id={entry.id}
        data-run-kind={entry.kind}
        className="border-t border-border align-top text-sm"
      >
        <td className="px-2 py-2">
          <div className="font-medium">
            {entry.kind === 'saved-view' ? entry.title : entry.caseTitle}
          </div>
          <div className="mt-0.5 whitespace-normal text-fg-muted">
            {entry.kind === 'saved-view'
              ? `${entry.caseTitle} · question not recorded`
              : (entry.question ?? 'Question not recorded')}
          </div>
        </td>
        <td className="px-2 py-2">
          <select
            aria-label={`Version for ${entry.caseTitle}`}
            value={version.id}
            disabled={busyId !== null}
            className="w-full rounded border border-border bg-bg px-1 py-1 text-xs text-fg"
            onChange={(event) => {
              const group = versions.find((value) => value.id === event.target.value)!;
              const run =
                group.runs.find((value) => value.experiment?.replicate === replicateIndex) ??
                group.runs[replicateIndex - 1] ??
                group.runs[0];
              void switchVersion(run.id);
            }}
          >
            {versions.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
                {(versionLabels.get(group.label) ?? 0) > 1
                  ? ` · ${new Date(group.runs[0].createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit',
                    })}`
                  : ''}
              </option>
            ))}
          </select>
          {version.runs.length > 1 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-xs text-fg-muted">Run</span>
              {version.runs.length <= 3 ? (
                version.runs.map((run, index) => {
                  const number = run.experiment?.replicate ?? index + 1;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      disabled={busyId !== null}
                      aria-label={`Run ${number} for ${entry.caseTitle}`}
                      aria-pressed={run.id === entry.id}
                      className={`rounded border px-2 py-0.5 text-xs disabled:opacity-50 ${
                        run.id === entry.id
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border hover:bg-bg-muted'
                      }`}
                      onClick={() => void switchVersion(run.id)}
                    >
                      {number}
                    </button>
                  );
                })
              ) : (
                <select
                  aria-label={`Run for ${entry.caseTitle}`}
                  value={entry.id}
                  disabled={busyId !== null}
                  className="min-w-0 rounded border border-border bg-bg text-xs"
                  onChange={(event) => void switchVersion(event.target.value)}
                >
                  {version.runs.map((run, index) => (
                    <option key={run.id} value={run.id}>
                      {index + 1} · {new Date(run.createdAt).toLocaleTimeString()}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {alternate && (
            <button
              type="button"
              disabled={busyId !== null}
              aria-label={`Switch ${entry.caseTitle} to ${alternate.promptLabel}`}
              title={`Switch to ${alternate.promptLabel}`}
              className="mt-1 rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted disabled:opacity-50"
              onClick={() => void switchVersion(alternate.id)}
            >
              ↔{' '}
              {alternateNumber && alternateNumber !== currentNumber
                ? alternateNumber
                : alternate.promptLabel}
            </button>
          )}
          <time
            className="block whitespace-nowrap"
            dateTime={new Date(entry.createdAt).toISOString()}
          >
            {new Date(entry.createdAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
          <div className="mt-0.5 text-xs text-fg-muted">
            {entry.kind === 'saved-view'
              ? 'Saved view · run details not recorded'
              : entry.kind === 'harness-outcome'
                ? 'Harness outcome'
                : 'Prompt trial'}
          </div>
          <details className="mt-1">
            <summary className="w-fit cursor-pointer text-accent">Run details</summary>
            <code className="block break-all text-fg-muted">{entry.id}</code>
            <button
              type="button"
              className="text-accent underline"
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setError(userMessage('failure.clipboard-is-unavailable'));
                  return;
                }
                void navigator.clipboard
                  .writeText(entry.id)
                  .then(() => setNotice('Run ID copied.'))
                  .catch(() => setError(userMessage('failure.could-not-copy-the-run-id')));
              }}
            >
              Copy ID
            </button>
            {entry.evidence && <p className="mt-1 whitespace-pre-wrap">{entry.evidence}</p>}
            {entry.feedback.length > 0 && (
              <div className="mt-2">
                <div className="font-medium">Your feedback</div>
                {entry.feedback.map((note) => (
                  <p key={note.id} className="mt-1 whitespace-pre-wrap">
                    <span className="font-medium">
                      {userEntityLabel(previews[note.viewReferenceId]?.label)}
                      {note.assessment === 'acceptable'
                        ? ' · Meets the question'
                        : note.assessment === 'needs-work'
                          ? ' · Needs revision'
                          : note.assessment === 'uncertain'
                            ? ' · Uncertain'
                            : ''}
                      :{' '}
                    </span>
                    {note.text}
                  </p>
                ))}
              </div>
            )}
            {entry.recordCount > 1 && (
              <p className="text-fg-muted">Recorded in {entry.recordCount} comparison batches.</p>
            )}
            {entry.roundReview && (
              <details className="mt-2" data-testid="protein-recorded-round-review">
                <summary className="cursor-pointer">Round review</summary>
                <p>
                  {entry.roundReview.corpus.starts} starts · {entry.roundReview.corpus.attempts}{' '}
                  attempts · {entry.roundReview.corpus.incompleteStarts} incomplete starts
                </p>
                {(['systemPrompt', 'harness', 'guidance'] as const).map((key) => (
                  <p key={key} className="mt-1 whitespace-pre-wrap">
                    <span className="font-medium">
                      {key === 'systemPrompt'
                        ? 'System prompt'
                        : key === 'harness'
                          ? 'Harness'
                          : 'Guidance'}
                      :{' '}
                    </span>
                    {entry.roundReview!.decisions[key]}
                  </p>
                ))}
                <p className="mt-1 break-all text-fg-muted">
                  Corpus: {entry.roundReview.corpusSha256}
                  <br />
                  Prompt: {entry.roundReview.systemPromptSha256}
                  <br />
                  Run plan: {entry.roundReview.runPlanSha256}
                </p>
              </details>
            )}
            {entry.scenePolicy && (
              <div className="mt-2">
                <div className="font-medium">Enforced scene rules · {entry.scenePolicy.id}</div>
                {entry.scenePolicy.enforcedConstraints.map((rule) => (
                  <p key={rule.id} className="mt-1">
                    <span className="font-medium">{rule.label}</span>
                    <span className="text-fg-muted"> · {rule.enforcement}</span>
                  </p>
                ))}
              </div>
            )}
          </details>
        </td>
        <td className="px-2 py-2 text-[13px]">
          <div className="font-medium">{entry.promptLabel}</div>
          {alternate && (
            <ProteinPromptComparison
              current={entry}
              alternate={alternate}
              guidance={recordedTrialVisualInstructions}
            />
          )}
          {!hasCapturedPrompt(entry) && (
            <p className="mt-1 font-medium text-fg-muted">Exact app-sent prompt not recorded</p>
          )}
          {entry.promptCapture !== 'none' && (
            <>
              {instructions && (
                <details className="mt-1">
                  <summary className="w-fit cursor-pointer text-accent">Variant guidance</summary>
                  <p
                    data-testid="recorded-visual-instructions"
                    onMouseDownCapture={(event) => event.stopPropagation()}
                    onDragStartCapture={(event) => event.preventDefault()}
                    className="mt-1 select-text whitespace-pre-wrap break-words text-fg"
                  >
                    {instructions}
                  </p>
                </details>
              )}
              {entry.sentPrompt ? (
                <details className="mt-1">
                  <summary className="w-fit cursor-pointer text-accent">
                    Full app-sent prompt
                  </summary>
                  <p className="mt-1 text-fg-muted">Channel: {entry.sentPromptChannel}</p>
                  <pre
                    onMouseDownCapture={(event) => event.stopPropagation()}
                    onDragStartCapture={(event) => event.preventDefault()}
                    className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-subtle p-2 select-text"
                  >
                    {entry.sentPrompt}
                  </pre>
                  {entry.continuationPrompt && (
                    <>
                      <p className="mt-2 font-medium">Continuation prompt</p>
                      <pre
                        onMouseDownCapture={(event) => event.stopPropagation()}
                        onDragStartCapture={(event) => event.preventDefault()}
                        className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-subtle p-2 select-text"
                      >
                        {entry.continuationPrompt}
                      </pre>
                    </>
                  )}
                  {entry.supplementalInstructions && (
                    <>
                      <p className="mt-2 font-medium">Separate agent instructions</p>
                      <pre
                        onMouseDownCapture={(event) => event.stopPropagation()}
                        onDragStartCapture={(event) => event.preventDefault()}
                        className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-subtle p-2 select-text"
                      >
                        {entry.supplementalInstructions}
                      </pre>
                    </>
                  )}
                </details>
              ) : null}
            </>
          )}
        </td>
        <td className="px-2 py-2">
          <div className="font-medium">{entry.harnessLabel}</div>
          {entry.routeLabel && <div className="mt-0.5 text-fg-muted">{entry.routeLabel}</div>}
          {entry.sourceUrl && (
            <a
              className="mt-1 block w-fit text-accent underline"
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Source code
            </a>
          )}
        </td>
        <td className="px-2 py-2">
          <span className="rounded bg-bg-muted px-1 py-0.5 text-fg-muted">
            {hasCapturedPrompt(entry) ? entry.status : 'Visual reference'}
          </span>
          {entry.feedback.length > 0 && (
            <span className="ml-2 text-xs text-fg-muted">Reviewed</span>
          )}
          <div className="mt-2 flex flex-col items-start gap-1">
            <span className="line-clamp-2 break-words" title={viewLabel}>
              {viewLabel}
            </span>
            {firstPreview?.preview?.startsWith('data:image/') ? (
              <img
                src={firstPreview.preview}
                alt={viewLabel + ' preview'}
                className="h-14 w-20 rounded bg-white object-contain"
                loading="lazy"
              />
            ) : (
              <div className="flex h-14 w-20 items-center justify-center rounded bg-bg-muted text-center text-fg-muted">
                No preview
              </div>
            )}
          </div>
        </td>
        <td className="sticky right-0 z-10 border-l border-border bg-bg px-2 py-2">
          <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
            {entry.outputIds.length ? (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void openSelected()}
                className="rounded border border-accent px-2 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                aria-label={'View ' + viewLabel}
              >
                View
              </button>
            ) : (
              <span className="text-fg-muted">No view</span>
            )}
            {separateStructures && (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void openRun(entry, referenceId, false, true, true)}
                className="rounded border border-accent px-2 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                aria-label={`Compare structures for ${entry.caseTitle}`}
              >
                Compare structures
              </button>
            )}
            {entry.conversationId ? (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void openSelected(referenceId, true)}
                className="rounded border border-border px-2 py-1 hover:bg-bg-muted disabled:opacity-50"
              >
                {entry.outputIds.length ? 'Chat' : 'Chat only'}
              </button>
            ) : (
              <span className="text-[10px] text-fg-muted">No chat recorded</span>
            )}
            {entry.outputIds.length > 1 && (
              <div
                role="group"
                aria-label={`${separateStructures ? 'Saved structures' : 'Saved outputs'} for ${entry.caseTitle}`}
                className="mt-2 w-full min-w-0 space-y-1 whitespace-normal"
              >
                <div
                  className="text-xs font-medium text-fg"
                  title="Each saved output opens separately. Scene buttons below the 3D viewer stay within that structure."
                >
                  {entry.outputIds.length} {outputKind}
                </div>
                <div className="text-xs text-fg-muted">
                  {separateStructures ? 'Different coordinates' : 'Separate saved results'}
                </div>
                <div className="space-y-1">
                  {entry.outputIds.map((id, outputIndex) => (
                    <button
                      key={id}
                      type="button"
                      disabled={busyId !== null}
                      aria-pressed={referenceId === id}
                      title={userEntityLabel(previews[id]?.label)}
                      onClick={() => {
                        void openSelected(id).then((opened) => {
                          if (opened)
                            setOutputIndices((current) => ({ ...current, [row.id]: outputIndex }));
                        });
                      }}
                      className={`block w-full min-w-0 truncate rounded border px-2 py-1 text-left text-xs disabled:opacity-50 ${
                        referenceId === id
                          ? 'border-accent bg-accent/10 font-medium text-accent'
                          : 'border-border text-fg hover:bg-bg-hover'
                      }`}
                    >
                      {outputIndex + 1}. {userEntityLabel(previews[id]?.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {entry.resultRecordId && referenceId && (
              <ProteinViewAssessment
                key={`${entry.resultRecordId}:${referenceId}`}
                resultId={entry.resultRecordId}
                viewReferenceId={referenceId}
                viewLabel={viewLabel}
              />
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderHeading = (label: string, key: ProteinRunSortKey, column: number) => (
    <th
      scope="col"
      aria-label={label}
      aria-sort={sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="relative px-2 py-2 text-left font-semibold"
    >
      <button type="button" onClick={() => changeSort(key)} className="hover:text-accent">
        {label}
        <span aria-hidden="true" className="ml-1 text-fg-muted">
          {sortKey === key ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        aria-valuemin={MIN_COLUMN_WIDTHS[column]}
        aria-valuemax={Math.round(
          columnWidths[column] + columnWidths[column + 1] - MIN_COLUMN_WIDTHS[column + 1]
        )}
        aria-valuenow={Math.round(columnWidths[column])}
        tabIndex={0}
        title={`Drag to resize ${label} column`}
        className="absolute right-0 top-0 z-20 flex h-full w-2 cursor-col-resize touch-none items-center justify-center hover:bg-accent/10"
        onPointerDown={(event) => startColumnResize(column, event)}
        onPointerMove={moveColumnResize}
        onPointerUp={finishColumnResize}
        onPointerCancel={() => {
          resizeDrag.current = null;
        }}
        onLostPointerCapture={() => {
          resizeDrag.current = null;
        }}
        onMouseDownCapture={(event) => event.stopPropagation()}
        onDragStartCapture={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          setColumnWidths((current) =>
            resizeAdjacentColumns(current, column, event.key === 'ArrowRight' ? 1 : -1)
          );
        }}
      >
        <span aria-hidden="true" className="h-3/5 w-px bg-border" />
      </span>
    </th>
  );

  return (
    <section
      className="my-3 rounded border border-border bg-bg p-2 text-sm select-text"
      data-testid="protein-run-index"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Test cases{index ? ` · ${cases.length}` : ''}</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-error">
          {toUserMessage(error, 'structure.failed')}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-fg-muted">
          {notice}
        </p>
      )}
      {corpusLedger && corpusLedger.attempts.length > 0 && (
        <ProteinCorpusTrajectory ledger={corpusLedger} onExport={downloadCorpusEvidence} />
      )}
      {import.meta.env.DEV && pageId === MOLECULAR_PROMPT_NOTEBOOK_ID && (
        <details className="mt-2 text-xs">
          <summary className="w-fit cursor-pointer text-accent">Run another comparison</summary>
          <MolecularPromptBatchControls notebookPageId={pageId} />
        </details>
      )}
      {loading && !index && <p className="mt-3">Loading visualization history…</p>}
      {index &&
        (recorded.length === 0 ? (
          <p className="mt-2 text-fg-muted">No captured or reviewed runs recorded yet.</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                aria-label="Search history"
                className="min-w-44 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg"
                placeholder="Search question, prompt, harness, or scene"
              />
              <select
                value={questionFilter}
                onChange={(event) => setQuestionFilter(event.target.value)}
                aria-label="Filter question"
                className="max-w-full rounded border border-border bg-bg px-2 py-1 text-sm text-fg"
              >
                <option value="">All questions</option>
                {questions.map(([question, caseTitle]) => (
                  <option key={question} value={question}>
                    {caseTitle}: {question}
                  </option>
                ))}
              </select>
              <span className="text-xs text-fg-muted">
                {visibleCases.length} of {cases.length} cases
              </span>
            </div>
            <div className="mt-2 overflow-x-auto rounded border border-border">
              <table
                aria-label="Protein comparison runs"
                className="w-full min-w-[680px] table-fixed border-collapse"
              >
                <colgroup>
                  {columnWidths.map((width, index) => (
                    <col key={index} style={{ width: `${width}%` }} />
                  ))}
                </colgroup>
                <thead className="bg-bg-muted text-sm">
                  <tr>
                    {renderHeading('Question', 'question', 0)}
                    {renderHeading('Version', 'run', 1)}
                    {renderHeading('System prompt', 'prompt', 2)}
                    {renderHeading('Harness / MCP', 'harness', 3)}
                    {renderHeading('Result', 'status', 4)}
                    <th
                      scope="col"
                      className="sticky right-0 z-30 border-l border-border bg-bg-muted px-2 py-2 text-left font-semibold"
                    >
                      Open
                    </th>
                  </tr>
                </thead>
                <tbody>{visibleCases.map(renderEntry)}</tbody>
              </table>
              {visibleCases.length === 0 && (
                <p className="py-3 text-center text-fg-muted">No matching cases.</p>
              )}
            </div>
          </>
        ))}
    </section>
  );
}
