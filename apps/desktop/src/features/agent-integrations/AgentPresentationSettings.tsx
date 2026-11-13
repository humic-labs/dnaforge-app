import { useEffect, useState } from 'react';
import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import {
  executeAdministration,
  inspectAdministrationSettings,
  subscribeAdministrationSettings,
} from '../../lib/administration-client';
import { DEFAULT_MOLECULAR_AGENT_INSTRUCTIONS } from '../../shared/agent-presentation-instructions';
import type { AdministrationSettingsSnapshot } from '../../shared/administration';

type PreferenceKey = 'molecularAgentInstructions' | 'rememberedAgentPreferences';
type Draft = { revision: string; patch: Partial<Record<PreferenceKey, string>> };

export function AgentPresentationSettings() {
  const [snapshot, setSnapshot] = useState<AdministrationSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeAdministrationSettings((value) => {
      if (mounted) setSnapshot(value);
    });
    void inspectAdministrationSettings()
      .then((value) => {
        if (mounted) setSnapshot(value);
      })
      .catch((cause: unknown) => {
        console.error('[AgentPresentationSettings] Preferences could not be loaded:', cause);
        if (mounted) setError(toUserMessage(cause, 'assistant.failed'));
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const edit = (key: PreferenceKey, value: string) => {
    if (!snapshot) return;
    setDraft((previous) => ({
      revision: previous?.revision ?? snapshot.revision,
      patch: { ...previous?.patch, [key]: value },
    }));
    setError(null);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await executeAdministration({
        kind: 'update-settings',
        expectedRevision: draft.revision,
        patch: draft.patch,
      });
      if (result.kind !== 'settings')
        throw new Error(
          result.kind === 'failed' ? result.message : 'Agent preferences were not saved.'
        );
      if (result.snapshot.persistence !== 'saved') {
        setDraft((current) =>
          current ? { ...current, revision: result.snapshot.revision } : null
        );
        throw new Error(
          result.snapshot.message ?? 'Agent preferences could not be saved. Retry Save.'
        );
      }
      setSnapshot(result.snapshot);
      setDraft(null);
    } catch (cause) {
      console.error('[AgentPresentationSettings] Preferences could not be saved:', cause);
      setError(toUserMessage(cause, 'assistant.failed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-4" aria-label="Agent presentation preferences">
      <div>
        <label htmlFor="molecular-agent-instructions" className="block text-sm font-medium text-fg">
          Protein presentation instructions
        </label>
        <p className="mt-1 text-xs text-fg-muted">
          Guide how the agent explains structures and chooses overview, detail and comparison views.
        </p>
        <textarea
          id="molecular-agent-instructions"
          data-testid="molecular-agent-instructions"
          className="mt-2 w-full rounded border border-border bg-bg p-2 text-sm"
          rows={6}
          maxLength={16_000}
          disabled={!snapshot || saving}
          value={
            draft?.patch.molecularAgentInstructions ??
            snapshot?.values.molecularAgentInstructions ??
            DEFAULT_MOLECULAR_AGENT_INSTRUCTIONS
          }
          onChange={(event) => edit('molecularAgentInstructions', event.currentTarget.value)}
        />
        <button
          type="button"
          className="mt-1 text-xs text-accent"
          disabled={!snapshot || saving}
          onClick={() => edit('molecularAgentInstructions', DEFAULT_MOLECULAR_AGENT_INSTRUCTIONS)}
        >
          Restore default guidance
        </button>
      </div>
      <div>
        <label htmlFor="remembered-agent-preferences" className="block text-sm font-medium text-fg">
          Remembered preferences
        </label>
        <p className="mt-1 text-xs text-fg-muted">
          The agent keeps lasting preferences you express here for future conversations. You can
          edit or clear them.
        </p>
        <textarea
          id="remembered-agent-preferences"
          data-testid="remembered-agent-preferences"
          className="mt-2 w-full rounded border border-border bg-bg p-2 text-sm"
          rows={4}
          maxLength={16_000}
          disabled={!snapshot || saving}
          value={
            draft?.patch.rememberedAgentPreferences ??
            snapshot?.values.rememberedAgentPreferences ??
            ''
          }
          onChange={(event) => edit('rememberedAgentPreferences', event.currentTarget.value)}
        />
        <button
          type="button"
          className="mt-1 text-xs text-accent"
          disabled={!snapshot || saving}
          onClick={() => edit('rememberedAgentPreferences', '')}
        >
          Clear remembered preferences
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-warning">
          {error}
        </p>
      )}
      {draft && (
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="save-agent-presentation-preferences"
            disabled={saving}
            className="rounded bg-accent px-3 py-1 text-white"
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      )}
    </section>
  );
}
