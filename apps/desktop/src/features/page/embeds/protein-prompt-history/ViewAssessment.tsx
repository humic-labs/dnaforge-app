import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import {
  appendMolecularPromptTrialFeedback,
  type MolecularPromptTrialAssessment,
} from '../../../../db/molecular-prompt-trials';

export function ProteinViewAssessment({
  resultId,
  viewReferenceId,
  viewLabel,
}: {
  resultId: string;
  viewReferenceId: string;
  viewLabel: string;
}) {
  const [assessment, setAssessment] = useState<MolecularPromptTrialAssessment | ''>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (!assessment || !note.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await appendMolecularPromptTrialFeedback(resultId, viewReferenceId, note, assessment);
      setNote('');
      setAssessment('');
      setMessage('Assessment recorded for this saved output.');
    } catch (cause) {
      setMessage(
        toUserMessage(
          cause instanceof Error ? cause.message : 'Could not record the assessment.',
          'operation.failed'
        )
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <details
      data-testid="protein-view-assessment"
      className="mt-2 w-full min-w-0 whitespace-normal"
    >
      <summary className="cursor-pointer text-xs text-accent">Assess selected output</summary>
      <div className="mt-1 grid gap-1 rounded border border-border p-2 text-xs">
        <p className="break-words text-fg-muted">Reviewing: {viewLabel}</p>
        <label className="grid gap-1">
          <span>Judgment</span>
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              aria-label="Saved output judgment"
              value={assessment}
              disabled={saving}
              onChange={(event) =>
                setAssessment(event.target.value as MolecularPromptTrialAssessment | '')
              }
            >
              <option value="">Choose one</option>
              <option value="acceptable">Meets the question</option>
              <option value="needs-work">Needs revision</option>
              <option value="uncertain">Uncertain</option>
            </MenuNativeSelect>
          </span>
        </label>
        <label className="grid gap-1">
          <span>What worked or failed?</span>
          <textarea
            aria-label="Saved output review note"
            value={note}
            disabled={saving}
            maxLength={2000}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            className="min-w-0 rounded border border-border bg-bg p-1"
          />
        </label>
        <button
          type="button"
          disabled={!assessment || !note.trim() || saving}
          onClick={() => void save()}
          className="w-fit rounded border border-border px-2 py-1 text-accent disabled:opacity-50"
        >
          Record assessment
        </button>
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  );
}
