import type { DesignPrimer, SequenceDesign } from '../design/public/types';
import {
  assemblyPrimerUse,
  designPrimerList,
  matchSavedOligos,
  mergeSavedPrimerLinks,
  oligoMatchesPrimer,
  savedPrimerLinkFor,
  savedPrimerLinkState,
  sourceAttachmentAgreement,
  type AssemblyPrimerUse,
  type SavedOligoSnapshot,
  type SavedPrimerLink,
  type SavedPrimerLinkOrigin,
  type SavedPrimerLinkState,
  type SourceAttachmentAgreement,
} from '../design/public/saved-primer-links';
import type { AssemblyTmContext } from '../junction-workbench/public/settings';

export type AssemblyPrimerOligoStatus =
  | 'linked'
  | 'draft-primer-changed'
  | 'oligo-bases-changed'
  | 'oligo-unavailable'
  | 'match-available'
  | 'ambiguous'
  | 'unsaved';

export type OligoBindingSplit = 'same' | 'missing' | 'different' | 'unavailable';

export interface AssemblyPrimerOligoEntry {
  use: AssemblyPrimerUse;
  status: AssemblyPrimerOligoStatus;
  link: SavedPrimerLink | null;
  oligo: SavedOligoSnapshot | null;
  candidates: SavedOligoSnapshot[];
  oligoRevisedSinceLink: boolean;
  oligoBindingSplit: OligoBindingSplit;
  sourceAttachment: SourceAttachmentAgreement;
}

export interface AssemblyPrimerOligoReport {
  designId: string;
  designName: string;
  designVersion: number;
  workspaceRoot: string | null;
  tm: AssemblyTmContext;
  primers: AssemblyPrimerOligoEntry[];
}

export interface LinkAssemblyPrimerOligosInput {
  designId: string;
  expectedDesignVersion?: number;
  saveUnsaved?: boolean;
  restoreMissingBindingSplit?: boolean;
  choices?: ReadonlyArray<{ primerId: string; oligoId: string }>;
}

export type LinkAssemblyPrimerOligosRefusal =
  | 'design-not-found'
  | 'stale-design-version'
  | 'project-unavailable'
  | 'no-primers'
  | 'invalid-choice'
  | 'design-busy';

export interface OligoWrite {
  primerId: string;
  oligoId: string;
  kind: 'oligo-saved' | 'oligo-binding-split-restored';
}

export interface ReconcileAssemblyPrimerOligosResult {
  report: AssemblyPrimerOligoReport | null;
  linked: Array<{ primerId: string; oligoId: string; via: SavedPrimerLinkOrigin }>;
  refusal: { code: LinkAssemblyPrimerOligosRefusal; message: string } | null;
}

export interface LinkAssemblyPrimerOligosResult {
  status: 'completed' | 'refused';
  refusal?: { code: LinkAssemblyPrimerOligosRefusal; message: string };
  changed: boolean;
  linked: Array<{ primerId: string; oligoId: string; via: SavedPrimerLinkOrigin }>;
  kept: string[];
  ambiguous: Array<{ primerId: string; oligoIds: string[] }>;
  unsaved: string[];
  unresolved: Array<{ primerId: string; state: SavedPrimerLinkState; oligoId: string }>;
  bindingSplitRestored: Array<{ primerId: string; oligoId: string; artifactRevision: number }>;
  failed: Array<{ primerId: string; message: string }>;
  oligoWrites: OligoWrite[];
  report: AssemblyPrimerOligoReport | null;
}

export interface SavedPrimerOligoDependencies {
  getDesign(designId: string): SequenceDesign | undefined;
  setSavedPrimerLinks(designId: string, links: SavedPrimerLink[]): boolean;
  resolveWorkspaceRoot(design: SequenceDesign): Promise<string | null>;
  describeTm(design: SequenceDesign): AssemblyTmContext;
  findOligosByBases(bases: string, workspaceRoot: string): Promise<SavedOligoSnapshot[]>;
  readOligo(oligoId: string, workspaceRoot: string): Promise<SavedOligoSnapshot | null>;
  saveOligo(primer: DesignPrimer, workspaceRoot: string): Promise<SavedOligoSnapshot>;
  restoreBindingSplit(
    oligo: SavedOligoSnapshot,
    bindingLength: number,
    workspaceRoot: string
  ): Promise<SavedOligoSnapshot>;
  now(): Date;
}

function oligoBindingSplit(use: AssemblyPrimerUse, oligo: SavedOligoSnapshot | null) {
  if (!oligo) return 'unavailable' as const;
  if (oligo.bindingSequence === null) {
    return use.tailSequence.length > 0 ? ('missing' as const) : ('same' as const);
  }
  return oligo.bindingSequence.toUpperCase() === use.bindingSequence.toUpperCase()
    ? ('same' as const)
    : ('different' as const);
}

function refusal(
  code: LinkAssemblyPrimerOligosRefusal,
  message: string,
  report: AssemblyPrimerOligoReport | null = null,
  oligoWrites: OligoWrite[] = []
): LinkAssemblyPrimerOligosResult {
  return {
    status: 'refused',
    refusal: { code, message },
    changed: false,
    linked: [],
    kept: [],
    ambiguous: [],
    unsaved: [],
    unresolved: [],
    bindingSplitRestored: [],
    failed: [],
    oligoWrites,
    report,
  };
}

export function createSavedPrimerOligoCommands(dependencies: SavedPrimerOligoDependencies) {
  async function entryFor(
    design: SequenceDesign,
    primer: DesignPrimer,
    workspaceRoot: string | null
  ): Promise<AssemblyPrimerOligoEntry> {
    const use = assemblyPrimerUse(design, primer);
    const link = savedPrimerLinkFor(design, primer.id);
    const linked =
      link && workspaceRoot ? await dependencies.readOligo(link.oligoId, workspaceRoot) : null;
    const state = link ? savedPrimerLinkState(use, link, linked) : null;
    if (link && state === 'current') {
      return {
        use,
        status: 'linked',
        link,
        oligo: linked,
        candidates: [],
        oligoRevisedSinceLink: (linked?.artifactRevision ?? 0) > link.artifactRevision,
        oligoBindingSplit: oligoBindingSplit(use, linked),
        sourceAttachment: sourceAttachmentAgreement(use.sourceSite, linked),
      };
    }
    const candidates = workspaceRoot
      ? await dependencies.findOligosByBases(use.sequence, workspaceRoot)
      : [];
    const match = matchSavedOligos(use, candidates);
    if (link && state && match.kind === 'none') {
      return {
        use,
        status: state === 'current' ? 'linked' : state,
        link,
        oligo: linked,
        candidates: [],
        oligoRevisedSinceLink: (linked?.artifactRevision ?? 0) > link.artifactRevision,
        oligoBindingSplit: oligoBindingSplit(use, linked),
        sourceAttachment: sourceAttachmentAgreement(use.sourceSite, linked),
      };
    }
    if (match.kind === 'unique') {
      return {
        use,
        status: 'match-available',
        link,
        oligo: match.oligo,
        candidates: [match.oligo],
        oligoRevisedSinceLink: false,
        oligoBindingSplit: oligoBindingSplit(use, match.oligo),
        sourceAttachment: sourceAttachmentAgreement(use.sourceSite, match.oligo),
      };
    }
    return {
      use,
      status: match.kind === 'ambiguous' ? 'ambiguous' : 'unsaved',
      link,
      oligo: null,
      candidates: match.kind === 'ambiguous' ? match.oligos : [],
      oligoRevisedSinceLink: false,
      oligoBindingSplit: 'unavailable',
      sourceAttachment: { kind: 'none' },
    };
  }

  async function reportFor(
    design: SequenceDesign,
    workspaceRoot: string | null
  ): Promise<AssemblyPrimerOligoReport> {
    const primers: AssemblyPrimerOligoEntry[] = [];
    for (const primer of designPrimerList(design)) {
      primers.push(await entryFor(design, primer, workspaceRoot));
    }
    return {
      designId: design.id,
      designName: design.name,
      designVersion: design.version,
      workspaceRoot,
      tm: dependencies.describeTm(design),
      primers,
    };
  }

  async function inspectAssemblyPrimerOligos(
    designId: string
  ): Promise<AssemblyPrimerOligoReport | null> {
    const design = dependencies.getDesign(designId);
    if (!design) return null;
    return reportFor(design, await dependencies.resolveWorkspaceRoot(design));
  }

  async function linkAssemblyPrimerOligos(
    input: LinkAssemblyPrimerOligosInput
  ): Promise<LinkAssemblyPrimerOligosResult> {
    const design = dependencies.getDesign(input.designId);
    if (!design) return refusal('design-not-found', `Design not found: ${input.designId}`);
    if (
      input.expectedDesignVersion !== undefined &&
      input.expectedDesignVersion !== design.version
    ) {
      return refusal(
        'stale-design-version',
        `The design is at version ${design.version}. Read it again and retry.`
      );
    }
    const primers = designPrimerList(design);
    if (primers.length === 0) {
      return refusal('no-primers', 'Draft the assembly primers before linking saved oligos.');
    }
    const workspaceRoot = await dependencies.resolveWorkspaceRoot(design);
    if (!workspaceRoot) {
      return refusal(
        'project-unavailable',
        'The project that owns this design is not open, so its saved oligos cannot be read.'
      );
    }
    const before = await reportFor(design, workspaceRoot);
    const choices = new Map((input.choices ?? []).map((choice) => [choice.primerId, choice]));
    for (const choice of choices.values()) {
      const entry = before.primers.find((item) => item.use.primerId === choice.primerId);
      const chosen = entry && (await dependencies.readOligo(choice.oligoId, workspaceRoot));
      if (!entry || !chosen || !oligoMatchesPrimer(entry.use, chosen)) {
        return refusal(
          'invalid-choice',
          `Saved oligo ${choice.oligoId} does not have the exact bases and chemistry of primer ${choice.primerId}.`,
          before
        );
      }
    }

    const result: LinkAssemblyPrimerOligosResult = {
      status: 'completed',
      changed: false,
      linked: [],
      kept: [],
      ambiguous: [],
      unsaved: [],
      unresolved: [],
      bindingSplitRestored: [],
      failed: [],
      oligoWrites: [],
      report: null,
    };
    const additions: SavedPrimerLink[] = [];
    const linkedAt = dependencies.now().toISOString();
    const linkTo = (primerId: string, oligo: SavedOligoSnapshot, via: SavedPrimerLinkOrigin) => {
      additions.push({
        primerId,
        oligoId: oligo.oligoId,
        artifactRevision: oligo.artifactRevision,
        sequenceContentHash: oligo.sequenceContentHash,
        linkedAtDesignVersion: design.version,
        linkedAt,
        via,
      });
      result.linked.push({ primerId, oligoId: oligo.oligoId, via });
    };

    for (const entry of before.primers) {
      const primerId = entry.use.primerId;
      const primer = primers.find((item) => item.id === primerId)!;
      try {
        const choice = choices.get(primerId);
        let target: { oligo: SavedOligoSnapshot; via: SavedPrimerLinkOrigin } | null = null;
        if (choice && choice.oligoId !== (entry.status === 'linked' ? entry.link?.oligoId : null)) {
          const chosen = await dependencies.readOligo(choice.oligoId, workspaceRoot);
          if (chosen) target = { oligo: chosen, via: 'matched-existing' };
        } else if (entry.status === 'linked' && entry.oligo) {
          result.kept.push(primerId);
        } else if (entry.status === 'match-available' && entry.oligo) {
          target = { oligo: entry.oligo, via: 'matched-existing' };
        } else if (entry.status === 'ambiguous') {
          result.ambiguous.push({
            primerId,
            oligoIds: entry.candidates.map((candidate) => candidate.oligoId),
          });
        } else if (input.saveUnsaved) {
          const savedOligo = await dependencies.saveOligo(primer, workspaceRoot);
          result.oligoWrites.push({ primerId, oligoId: savedOligo.oligoId, kind: 'oligo-saved' });
          target = { oligo: savedOligo, via: 'saved-from-assembly' };
        } else if (entry.link && entry.status !== 'unsaved') {
          result.unresolved.push({
            primerId,
            state: entry.status as SavedPrimerLinkState,
            oligoId: entry.link.oligoId,
          });
        } else {
          result.unsaved.push(primerId);
        }

        const current = target?.oligo ?? (entry.status === 'linked' ? entry.oligo : null);
        if (
          current &&
          input.restoreMissingBindingSplit &&
          oligoBindingSplit(entry.use, current) === 'missing'
        ) {
          const restored = await dependencies.restoreBindingSplit(
            current,
            entry.use.bindingSequence.length,
            workspaceRoot
          );
          result.bindingSplitRestored.push({
            primerId,
            oligoId: restored.oligoId,
            artifactRevision: restored.artifactRevision,
          });
          result.oligoWrites.push({
            primerId,
            oligoId: restored.oligoId,
            kind: 'oligo-binding-split-restored',
          });
          result.kept = result.kept.filter((keptPrimerId) => keptPrimerId !== primerId);
          target = {
            oligo: restored,
            via: target?.via ?? entry.link?.via ?? 'matched-existing',
          };
        }
        if (target) linkTo(primerId, target.oligo, target.via);
      } catch (error) {
        result.failed.push({
          primerId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const latest = dependencies.getDesign(design.id);
    if (!latest || latest.version !== design.version) {
      return refusal(
        'stale-design-version',
        'The design changed while its saved oligos were being linked. Read it again and retry; oligos already saved are matched on the next attempt.',
        latest ? await reportFor(latest, workspaceRoot) : null,
        result.oligoWrites
      );
    }
    if (additions.length > 0) {
      try {
        result.changed = dependencies.setSavedPrimerLinks(
          design.id,
          mergeSavedPrimerLinks(latest, additions)
        );
      } catch (error) {
        return refusal(
          'design-busy',
          error instanceof Error ? error.message : String(error),
          await reportFor(latest, workspaceRoot),
          result.oligoWrites
        );
      }
    }
    result.report = await reportFor(dependencies.getDesign(design.id) ?? latest, workspaceRoot);
    return result;
  }

  async function reconcileAssemblyPrimerOligos(
    designId: string
  ): Promise<ReconcileAssemblyPrimerOligosResult> {
    const result = await linkAssemblyPrimerOligos({ designId });
    if (result.report) {
      return { report: result.report, linked: result.linked, refusal: result.refusal ?? null };
    }
    return {
      report: await inspectAssemblyPrimerOligos(designId),
      linked: [],
      refusal: result.refusal ?? null,
    };
  }

  return { inspectAssemblyPrimerOligos, linkAssemblyPrimerOligos, reconcileAssemblyPrimerOligos };
}
