import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  inspectAssemblyPrimerOligos,
  linkAssemblyPrimerOligos,
  reconcileAssemblyPrimerOligos,
  type AssemblyPrimerOligoEntry,
  type AssemblyPrimerOligoReport,
  type AssemblyPrimerOligoStatus,
  type LinkAssemblyPrimerOligosInput,
  type LinkAssemblyPrimerOligosResult,
} from '../../assembly/public/saved-primer-oligos';
import type { SavedOligoSnapshot } from '../../design/public/saved-primer-links';
import type { DesignPrimerPair, SequenceDesign } from '../../design/public/types';
import { isLimsEntityOpened, openLimsEntity } from '../../lims/public/open-entity';

export interface AssemblyPrimerOligoMessage {
  text: string;
  tone: 'neutral' | 'warning';
}

export interface AssemblyPrimerOligoActions {
  link: boolean;
  save: boolean;
  restoreSplit: number;
}

type LinkOptions = Pick<
  LinkAssemblyPrimerOligosInput,
  'saveUnsaved' | 'restoreMissingBindingSplit' | 'choices'
>;

const STALE_LINK_STATUSES: ReadonlySet<AssemblyPrimerOligoStatus> = new Set([
  'draft-primer-changed',
  'oligo-bases-changed',
  'oligo-unavailable',
]);

const PROJECT_CLOSED = 'Open the project that owns this design to work with its saved oligos.';

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function assemblyPrimerOligoActions(
  report: AssemblyPrimerOligoReport | null
): AssemblyPrimerOligoActions {
  const primers = report?.primers ?? [];
  const stale = primers.some((entry) => STALE_LINK_STATUSES.has(entry.status));
  return {
    link: stale || primers.some((entry) => entry.status === 'match-available'),
    save: stale || primers.some((entry) => entry.status === 'unsaved'),
    restoreSplit: primers.filter(
      (entry) => entry.status === 'linked' && entry.oligoBindingSplit === 'missing'
    ).length,
  };
}

export function describeAssemblyPrimerOligoReport(
  report: AssemblyPrimerOligoReport
): AssemblyPrimerOligoMessage {
  if (report.workspaceRoot === null) return { text: PROJECT_CLOSED, tone: 'warning' };
  const count = (matches: (status: AssemblyPrimerOligoStatus) => boolean) =>
    report.primers.filter((entry) => matches(entry.status)).length;
  const linked = count((status) => status === 'linked');
  const matching = count((status) => status === 'match-available');
  const ambiguous = count((status) => status === 'ambiguous');
  const stale = count((status) => STALE_LINK_STATUSES.has(status));
  const unsaved = count((status) => status === 'unsaved');
  if (linked + matching + ambiguous + stale === 0) {
    return { text: 'No primers saved yet.', tone: 'neutral' };
  }
  const sentences = [
    `${linked} of ${counted(report.primers.length, 'primer', 'primers')} linked to saved oligos.`,
  ];
  if (stale > 0) sentences.push(`${counted(stale, 'link needs', 'links need')} attention.`);
  if (matching > 0) {
    sentences.push(
      matching === 1
        ? '1 matches a saved oligo but is not linked.'
        : `${matching} match a saved oligo but are not linked.`
    );
  }
  if (ambiguous > 0) {
    sentences.push(
      `${counted(ambiguous, 'primer has', 'primers have')} several identical saved oligos.`
    );
  }
  if (unsaved > 0) sentences.push(`${unsaved} not saved.`);
  return { text: sentences.join(' '), tone: stale + ambiguous > 0 ? 'warning' : 'neutral' };
}

export function describeLinkAssemblyPrimerOligosResult(
  result: LinkAssemblyPrimerOligosResult
): AssemblyPrimerOligoMessage {
  if (result.status === 'refused') {
    return {
      text: result.refusal?.message ?? 'Saved oligos could not be linked.',
      tone: 'warning',
    };
  }
  const restored = new Set(result.bindingSplitRestored.map((item) => item.primerId));
  const linked = result.linked.filter((item) => !restored.has(item.primerId));
  const saved = linked.filter((item) => item.via === 'saved-from-assembly').length;
  const matched = linked.length - saved;
  const clauses: string[] = [];
  if (saved > 0) clauses.push(`${saved} saved to the registry`);
  if (matched > 0) {
    const target = matched === 1 ? 'a saved oligo' : 'saved oligos';
    clauses.push(
      clauses.length > 0
        ? `${matched} linked to ${target}`
        : `${counted(matched, 'primer', 'primers')} linked to ${target}`
    );
  }
  if (restored.size > 0) {
    clauses.push(
      `binding split restored on ${counted(restored.size, 'saved oligo', 'saved oligos')}`
    );
  }
  if (result.kept.length > 0) clauses.push(`${result.kept.length} already linked`);
  const sentences: string[] = [];
  if (clauses.length > 0) {
    const summary = clauses.join(', ');
    sentences.push(`${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`);
  }
  if (result.ambiguous.length > 0) {
    sentences.push(
      `${counted(result.ambiguous.length, 'primer has', 'primers have')} several identical saved oligos; pick one in the Saved oligo column.`
    );
  }
  if (result.unresolved.length > 0) {
    sentences.push(
      `${counted(
        result.unresolved.length,
        'primer no longer matches its saved oligo',
        'primers no longer match their saved oligos'
      )}; use Save to registry to save the current bases.`
    );
  }
  if (result.unsaved.length > 0) {
    sentences.push(
      `${counted(result.unsaved.length, 'primer is', 'primers are')} not saved; use Save to registry.`
    );
  }
  const failure = result.failed[0];
  if (failure) {
    sentences.push(
      `${counted(result.failed.length, 'primer', 'primers')} could not be saved or linked. ${toUserMessage(failure.message, 'primer.failed')}`
    );
  }
  return {
    text: sentences.length > 0 ? sentences.join(' ') : 'No changes.',
    tone:
      result.ambiguous.length + result.unresolved.length + result.failed.length > 0
        ? 'warning'
        : 'neutral',
  };
}

function reportSignature(report: AssemblyPrimerOligoReport | null): string {
  if (!report) return '';
  return report.primers
    .map((entry) =>
      [
        entry.use.primerId,
        entry.status,
        entry.oligo?.oligoId ?? '',
        entry.oligo?.artifactRevision ?? '',
        entry.link?.artifactRevision ?? '',
        entry.oligoBindingSplit,
      ].join(':')
    )
    .join('|');
}

interface OligoLinkState {
  designId: string;
  report: AssemblyPrimerOligoReport | null;
  running: boolean;
  outcome: (AssemblyPrimerOligoMessage & { signature: string }) | null;
}

function emptyState(designId: string): OligoLinkState {
  return { designId, report: null, running: false, outcome: null };
}

function withOutcome(
  state: OligoLinkState,
  message: AssemblyPrimerOligoMessage,
  report: AssemblyPrimerOligoReport | null = state.report
): OligoLinkState {
  return { ...state, report, outcome: { ...message, signature: reportSignature(report) } };
}

export interface AssemblyPrimerOligosView {
  report: AssemblyPrimerOligoReport | null;
  entryFor(primerId: string): AssemblyPrimerOligoEntry | null;
  actions: AssemblyPrimerOligoActions;
  busy: boolean;
  disabledReason: string | null;
  status: AssemblyPrimerOligoMessage | null;
  linkSaved(): void;
  saveToRegistry(): void;
  restoreBindingSplit(): void;
  chooseOligo(primerId: string, oligoId: string): void;
  openOligo(oligo: SavedOligoSnapshot): void;
}

export function useAssemblyPrimerOligos({
  design,
  primers,
  projectRoot,
}: {
  design: SequenceDesign;
  primers: DesignPrimerPair[] | null;
  projectRoot: string | null;
}): AssemblyPrimerOligosView {
  const designId = design.id;
  const designVersion = design.version;
  const hasPrimers = Boolean(primers && primers.length > 0);
  const [state, setState] = useState<OligoLinkState>(() => emptyState(designId));
  const latestRequest = useRef(0);
  const reconciled = useRef('');
  const current = state.designId === designId ? state : null;
  const report = current?.report ?? null;
  const running = current?.running ?? false;
  const outcome = current?.outcome ?? null;

  const patch = useCallback(
    (targetDesignId: string, change: (previous: OligoLinkState) => OligoLinkState) =>
      setState((previous) => (previous.designId === targetDesignId ? change(previous) : previous)),
    []
  );

  useEffect(() => {
    setState((previous) => (previous.designId === designId ? previous : emptyState(designId)));
    if (!hasPrimers) return;
    let active = true;
    const request = ++latestRequest.current;
    const isCurrent = () => active && latestRequest.current === request;
    const arrival = `${designId}:${designVersion}`;
    const linksUnambiguousMatches = reconciled.current !== arrival;
    if (linksUnambiguousMatches) {
      reconciled.current = arrival;
      patch(designId, (previous) => ({ ...previous, running: true }));
    }
    const load = linksUnambiguousMatches
      ? reconcileAssemblyPrimerOligos(designId).then((result) => result.report)
      : inspectAssemblyPrimerOligos(designId);
    void load.then(
      (next) => {
        if (isCurrent()) {
          patch(designId, (previous) => ({ ...previous, report: next, running: false }));
        }
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        console.warn('[AssemblyPrimerOligos] Saved oligos could not be read:', error);
        patch(designId, (previous) => ({
          ...withOutcome(previous, { text: 'Saved oligos could not be read.', tone: 'warning' }),
          running: false,
        }));
      }
    );
    return () => {
      active = false;
    };
  }, [
    designId,
    designVersion,
    hasPrimers,
    primers,
    design.designPrimers,
    design.savedPrimerLinks,
    design.pcrPolymerase,
    patch,
  ]);

  const run = useCallback(
    (options: LinkOptions) => {
      if (running) return;
      latestRequest.current += 1;
      setState((previous) => ({
        ...(previous.designId === designId ? previous : emptyState(designId)),
        running: true,
      }));
      const settle = (
        message: AssemblyPrimerOligoMessage,
        next: AssemblyPrimerOligoReport | null
      ) =>
        patch(designId, (previous) => ({
          ...withOutcome(previous, message, next ?? previous.report),
          running: false,
        }));
      void linkAssemblyPrimerOligos({ designId, expectedDesignVersion: designVersion, ...options })
        .then((result) => {
          if (result.failed.length > 0) {
            console.warn('[AssemblyPrimerOligos] Some primers were not linked:', result.failed);
          }
          settle(describeLinkAssemblyPrimerOligosResult(result), result.report);
        })
        .catch((error: unknown) => {
          console.warn('[AssemblyPrimerOligos] Saved oligos could not be linked:', error);
          settle({ text: toUserMessage(error, 'assembly.failed'), tone: 'warning' }, null);
        });
    },
    [designId, designVersion, patch, running]
  );

  const linkSaved = useCallback(() => run({}), [run]);
  const saveToRegistry = useCallback(() => run({ saveUnsaved: true }), [run]);
  const restoreBindingSplit = useCallback(() => run({ restoreMissingBindingSplit: true }), [run]);
  const chooseOligo = useCallback(
    (primerId: string, oligoId: string) => run({ choices: [{ primerId, oligoId }] }),
    [run]
  );

  const openOligo = useCallback(
    (oligo: SavedOligoSnapshot) => {
      const fail = (reason: unknown) => {
        console.warn('[AssemblyPrimerOligos] A saved oligo could not be opened:', reason);
        patch(designId, (previous) =>
          withOutcome(previous, {
            text: `Saved oligo ${oligo.catalogNumber} could not be opened.`,
            tone: 'warning',
          })
        );
      };
      void openLimsEntity({ entityId: oligo.oligoId }).then((result) => {
        if (!isLimsEntityOpened(result)) fail(result.message);
      }, fail);
    },
    [designId, patch]
  );

  const entries = useMemo(
    () => new Map((report?.primers ?? []).map((entry) => [entry.use.primerId, entry])),
    [report]
  );
  const entryFor = useCallback((primerId: string) => entries.get(primerId) ?? null, [entries]);
  const actions = useMemo(() => assemblyPrimerOligoActions(report), [report]);
  const status = useMemo(() => {
    if (outcome && outcome.signature === reportSignature(report)) {
      return { text: outcome.text, tone: outcome.tone };
    }
    return report ? describeAssemblyPrimerOligoReport(report) : null;
  }, [outcome, report]);

  return {
    report,
    entryFor,
    actions,
    busy: running,
    disabledReason: projectRoot === null || report?.workspaceRoot === null ? PROJECT_CLOSED : null,
    status,
    linkSaved,
    saveToRegistry,
    restoreBindingSplit,
    chooseOligo,
    openOligo,
  };
}
