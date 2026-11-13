import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import type { BoundPrimer } from '../types';
import { primerArtifactRelativePath } from '../primer-artifact-service';
import { primerServices } from '../primer-services';
import { PrimerLengthField } from './PrimerLengthField';

interface BindingSite {
  start: number;
  end: number;
  strand: 1 | -1;
}

interface PrimerBindingEditorProps {
  primer: BoundPrimer;
  workspaceRoot?: string;
  targetDocumentId?: string;
  targetFilePath?: string;
  sequenceLength?: number;
  circular?: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

export function PrimerBindingEditor({
  primer,
  workspaceRoot,
  targetDocumentId,
  targetFilePath,
  sequenceLength = 0,
  circular = false,
  onSaved,
  onCancel,
}: PrimerBindingEditorProps) {
  const [site, setSite] = useState<BindingSite>({
    start: primer.binding.bindingStart,
    end: primer.binding.bindingEnd,
    strand: primer.binding.strand === -1 ? -1 : 1,
  });
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    if (!workspaceRoot || !targetDocumentId || !targetFilePath || !sequenceLength) {
      setError(userMessage('failure.open-this-sequence-in-its-project-to-edit-the-binding-site'));
      return;
    }
    if (!primerArtifactRelativePath(primer)) {
      setError(
        userMessage(
          'failure.this-library-primer-needs-a-project-file-before-its-binding-site-can-b'
        )
      );
      return;
    }
    void primerServices.persistence.readArtifact(primer, workspaceRoot).then(
      ({ artifact }) => {
        if (!active) return;
        const binding = artifact.bindings.find((entry) => entry.id === primer.binding.id);
        if (!binding || binding.target.documentId !== targetDocumentId) {
          setError(
            userMessage('failure.this-binding-site-has-changed-reopen-it-from-the-sequence')
          );
          return;
        }
        setSite(binding.coordinates);
        setRevision(artifact.artifactRevision);
      },
      (failure: unknown) => {
        if (active) setError(toUserMessage(failure, 'failure.could-not-load-this-binding-site'));
      }
    );
    return () => {
      active = false;
    };
  }, [primer, workspaceRoot, targetDocumentId, targetFilePath, sequenceLength]);

  const span =
    site.end > site.start ? site.end - site.start : sequenceLength - site.start + site.end;
  const position = site.strand === -1 ? site.start + 1 : site.end || sequenceLength;
  const min = circular || site.strand === -1 ? 1 : span;
  const max = circular || site.strand === 1 ? sequenceLength : sequenceLength - span + 1;
  const editable = revision != null && !saving && span > 0 && span <= sequenceLength;

  const move = (nextPosition: number) => {
    const rawStart = site.strand === -1 ? nextPosition - 1 : nextPosition - span;
    const start = circular ? (rawStart + sequenceLength) % sequenceLength : rawStart;
    const rawEnd = start + span;
    const end = circular && rawEnd > sequenceLength ? rawEnd % sequenceLength : rawEnd;
    setSite({ ...site, start, end });
  };

  const save = async () => {
    if (!editable || !workspaceRoot || !targetFilePath || !targetDocumentId || revision == null)
      return;
    setSaving(true);
    setError(null);
    try {
      await primerServices.persistence.updateBinding({
        primer,
        workspaceRoot,
        targetFilePath,
        targetDocumentId,
        bindingId: primer.binding.id,
        bindingSequenceId: primer.binding.sequenceId,
        bindingStart: site.start,
        bindingEnd: site.end,
        bindingStrand: site.strand,
        expectedArtifactRevision: revision,
        source: 'manual',
      });
      primerServices.persistence.notifyBindingsChanged(primer.binding.sequenceId);
      onSaved();
    } catch (failure) {
      setError(toUserMessage(failure, 'failure.could-not-save-this-binding-site'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="primer-binding-editor"
      className="flex min-h-0 flex-col gap-3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <h2 className="truncate text-base font-semibold text-fg">{primer.name}</h2>
        <p className="mt-1 text-xs text-fg-muted">Edit this sequence attachment.</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex w-[68px] flex-col gap-1">
          <span className="text-[10px] font-medium text-fg-muted">Direction</span>
          <div className="grid h-8 grid-cols-2 rounded-md bg-bg-muted p-0.5">
            {([1, -1] as const).map((strand) => (
              <button
                key={strand}
                type="button"
                aria-label={strand === 1 ? 'Forward binding' : 'Reverse binding'}
                aria-pressed={site.strand === strand}
                disabled={!editable}
                className={`rounded px-1 text-xs transition-colors disabled:opacity-50 ${site.strand === strand ? 'bg-bg text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
                onClick={() => setSite({ ...site, strand })}
              >
                {strand === 1 ? 'Fwd' : 'Rev'}
              </button>
            ))}
          </div>
        </div>
        <div
          className="flex flex-col gap-1"
          style={{ width: Math.max(72, String(sequenceLength).length * 9 + 28) }}
        >
          <span className="text-[10px] font-medium text-fg-muted">3′ position</span>
          <PrimerLengthField
            value={position}
            min={min}
            max={max}
            onChange={move}
            editable={editable}
            quantity="position"
            wrap={circular}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-fg-muted">Binding span</span>
          <span className="flex h-8 items-center text-sm font-semibold tabular-nums text-fg">
            {span} bp
          </span>
        </div>
      </div>
      <p data-testid="primer-binding-range" className="text-xs tabular-nums text-fg-muted">
        Bases {site.start + 1}–{site.end || sequenceLength}
      </p>
      {error && (
        <p role="alert" className="text-xs text-error">
          {toUserMessage(error, 'primer.failed')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!editable}
          className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save binding site'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded bg-bg-muted px-3 py-2 text-sm text-fg-muted hover:text-fg disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
