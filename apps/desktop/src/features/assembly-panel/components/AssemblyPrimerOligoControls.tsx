import type {
  AssemblyPrimerOligoEntry,
  OligoBindingSplit,
} from '../../assembly/public/saved-primer-oligos';
import type { SavedOligoSnapshot } from '../../design/public/saved-primer-links';
import type { DesignPrimer } from '../../design/public/types';
import { Button } from '../../../shared/components/Button';
import type { AssemblyPrimerOligosView } from '../hooks/useAssemblyPrimerOligos';

const RESTORE_SPLIT_TITLE =
  'The saved oligo has no record of which bases bind the template, so matching searches the whole oligo. Restoring copies the binding part and tail from this assembly to the saved oligo.';

export function AssemblyPrimerOligoActions({ oligos }: { oligos: AssemblyPrimerOligosView }) {
  const disabled = oligos.busy || oligos.disabledReason !== null;
  const disabledTitle = oligos.disabledReason ?? undefined;
  return (
    <>
      {oligos.actions.link ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          data-testid="assembly-primers-link-saved"
          disabled={disabled}
          title={disabledTitle}
          onClick={oligos.linkSaved}
        >
          Link saved oligos
        </Button>
      ) : null}
      {oligos.actions.save ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          data-testid="assembly-primers-save-to-registry"
          disabled={disabled}
          title={disabledTitle}
          onClick={oligos.saveToRegistry}
        >
          Save to registry
        </Button>
      ) : null}
      {oligos.actions.restoreSplit > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="assembly-primers-restore-split"
          disabled={disabled}
          title={disabledTitle ?? RESTORE_SPLIT_TITLE}
          onClick={oligos.restoreBindingSplit}
        >
          {`Restore binding split (${oligos.actions.restoreSplit})`}
        </Button>
      ) : null}
    </>
  );
}

export function AssemblyPrimerOligoStatus({ oligos }: { oligos: AssemblyPrimerOligosView }) {
  if (!oligos.status) return null;
  return (
    <p
      role="status"
      data-testid="assembly-primers-oligo-status"
      className={`border-b border-border px-3 py-1.5 text-xs ${
        oligos.status.tone === 'warning' ? 'text-warning' : 'text-fg-muted'
      }`}
    >
      {oligos.status.text}
    </p>
  );
}

export function AssemblyPrimerTmContext({ oligos }: { oligos: AssemblyPrimerOligosView }) {
  const tm = oligos.report?.tm;
  if (!tm) return null;
  return (
    <p
      data-testid="assembly-primers-tm-context"
      className="border-t border-border px-3 py-1.5 text-xs text-fg-subtle"
    >
      {`Tm is calculated on the binding part only · ${tm.modelLabel} · ${tm.primerConcNm} nM primer.`}
    </p>
  );
}

function primerPosition(primer: DesignPrimer): string {
  return `${primer.fragmentIndex}-${primer.direction}`;
}

export function assemblyPrimerRowTestId(primer: DesignPrimer | undefined): string | undefined {
  return primer ? `assembly-primer-row-${primerPosition(primer)}` : undefined;
}

export function AssemblyPrimerOligoCells({
  primer,
  oligos,
}: {
  primer: DesignPrimer | undefined;
  oligos: AssemblyPrimerOligosView;
}) {
  if (!primer) return null;
  const position = primerPosition(primer);
  const entry = oligos.entryFor(primer.id);
  const onOpen = oligos.openOligo;
  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
        {entry ? `${entry.use.bindingSequence.length} / ${entry.use.tailSequence.length} nt` : '—'}
      </td>
      <td
        className="px-2 py-0 whitespace-nowrap"
        data-testid={`assembly-primer-saved-oligo-${position}`}
        data-link-state={entry?.status}
      >
        {entry ? (
          <div className="flex min-h-7 items-center gap-1.5">
            <SavedOligoState
              entry={entry}
              position={position}
              onOpen={onOpen}
              onChoose={(oligoId) => oligos.chooseOligo(primer.id, oligoId)}
              disabled={oligos.busy || oligos.disabledReason !== null}
            />
          </div>
        ) : null}
      </td>
    </>
  );
}

function OpenOligoButton({
  oligo,
  position,
  onOpen,
}: {
  oligo: SavedOligoSnapshot;
  position: string;
  onOpen: (oligo: SavedOligoSnapshot) => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      data-testid={`assembly-primer-open-oligo-${position}`}
      title={`Open saved oligo ${oligo.catalogNumber}`}
      onClick={() => onOpen(oligo)}
    >
      {`${oligo.catalogNumber} · ${oligo.name}`}
    </Button>
  );
}

const SPLIT_NOTES: Partial<Record<OligoBindingSplit, { text: string; title: string }>> = {
  missing: { text: 'No binding part on file', title: RESTORE_SPLIT_TITLE },
  different: {
    text: 'Binding part differs',
    title:
      'The saved oligo records a different template-binding part than this assembly uses. Matching this oligo against a template will search the wrong bases.',
  },
};

function SplitNote({ split, position }: { split: OligoBindingSplit; position: string }) {
  const note = SPLIT_NOTES[split];
  if (!note) return null;
  return (
    <span
      data-testid={`assembly-primer-oligo-split-${position}`}
      data-split={split}
      className="text-warning"
      title={note.title}
    >
      {note.text}
    </span>
  );
}

function SavedOligoState({
  entry,
  position,
  onOpen,
  onChoose,
  disabled,
}: {
  entry: AssemblyPrimerOligoEntry;
  position: string;
  onOpen: (oligo: SavedOligoSnapshot) => void;
  onChoose: (oligoId: string) => void;
  disabled: boolean;
}) {
  const { oligo, link } = entry;
  switch (entry.status) {
    case 'linked':
      if (!oligo || !link) break;
      return (
        <>
          <OpenOligoButton oligo={oligo} position={position} onOpen={onOpen} />
          <span className="text-fg-subtle">
            {entry.oligoRevisedSinceLink
              ? `rev ${link.artifactRevision}, now rev ${oligo.artifactRevision}`
              : `rev ${link.artifactRevision}`}
          </span>
          <SplitNote split={entry.oligoBindingSplit} position={position} />
        </>
      );
    case 'draft-primer-changed':
      if (!oligo) break;
      return (
        <>
          <OpenOligoButton oligo={oligo} position={position} onOpen={onOpen} />
          <span className="text-warning">{`Draft differs from ${oligo.catalogNumber}`}</span>
        </>
      );
    case 'oligo-bases-changed':
      if (!oligo) break;
      return (
        <>
          <OpenOligoButton oligo={oligo} position={position} onOpen={onOpen} />
          <span className="text-warning">{`${oligo.catalogNumber} was edited after linking`}</span>
        </>
      );
    case 'match-available':
      if (!oligo) break;
      return <span className="text-fg-muted">{`Matches ${oligo.catalogNumber} (not linked)`}</span>;
    case 'ambiguous':
      return (
        <>
          <span
            className="text-fg-muted"
            title={entry.candidates.map((candidate) => candidate.catalogNumber).join(', ')}
          >
            {`${entry.candidates.length} identical saved oligos`}
          </span>
          {entry.candidates.map((candidate) => (
            <Button
              key={candidate.oligoId}
              type="button"
              size="xs"
              variant="ghost"
              data-testid={`assembly-primer-choose-oligo-${position}-${candidate.catalogNumber}`}
              title={`Link this primer to ${candidate.catalogNumber} · ${candidate.name}`}
              disabled={disabled}
              onClick={() => onChoose(candidate.oligoId)}
            >
              {`Link ${candidate.catalogNumber}`}
            </Button>
          ))}
        </>
      );
    case 'unsaved':
      return <span className="text-fg-subtle">Not saved</span>;
    case 'oligo-unavailable':
      break;
    default:
      return entry.status satisfies never;
  }
  return <span className="text-warning">Saved oligo unavailable</span>;
}
