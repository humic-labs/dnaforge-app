import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { Button, TextField, TextArea } from '../../../components/ui';
import { useMemo, useState } from 'react';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { SequenceDrawer } from '../../sequence/public/components/SequenceDrawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useToastStore } from '../../../stores/toast-store';
import {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '../../lims/public/protein-sequence';
import { recordProtein } from '../record-proteins';
import { ProteinSaveLocationPicker } from './ProteinSaveLocationPicker';
import { requestTabClose } from '../../canvas/public/artifact-document-lifecycle';
import {
  NEW_DOCUMENT_BASELINE,
  useUnsavedDraftRecovery,
  type NewDraftPayload,
} from '../../../shared/unsaved-draft-recovery';

interface ProteinCreationTabProps {
  tab: Tab;
  panelId: string;
}

export function ProteinCreationTab({ tab, panelId }: ProteinCreationTabProps) {
  const context = tab.artifactDocument?.kind === 'protein' ? tab.artifactDocument : undefined;
  const folders = useWorkspaceStore((state) => state.folders);
  const updateTab = useCanvasStore((state) => state.updateTab);

  const recovered = tab.recoveredDraft;
  const [name, setName] = useState(recovered?.name ?? '');
  const [sequence, setSequence] = useState(recovered?.sequence ?? '');
  const [organism, setOrganism] = useState(recovered?.organism ?? '');
  const [sourceCds, setSourceCds] = useState(recovered?.sourceCds ?? '');
  const [notes, setNotes] = useState(recovered?.notes ?? '');
  const [destinationDir, setDestinationDir] = useState(
    recovered?.destinationDir ?? context?.destinationPath ?? ''
  );
  const dirty = Boolean(recovered || name || sequence || organism || sourceCds || notes);
  const recoveryPayload = useMemo<NewDraftPayload | undefined>(
    () =>
      context
        ? {
            tabType: 'protein',
            label: name.trim() || 'Untitled Protein',
            artifactDocument: context,
            fields: { name, sequence, organism, sourceCds, notes, destinationDir },
          }
        : undefined,
    [context, destinationDir, name, notes, organism, sequence, sourceCds]
  );
  useUnsavedDraftRecovery<NewDraftPayload>({
    key: context?.persistence === 'draft' ? `new:${tab.id}` : null,
    name: recoveryPayload?.label ?? 'Untitled Protein',
    baseline: NEW_DOCUMENT_BASELINE,
    dirty,
    payload: recoveryPayload,
    onRestore: () => undefined,
    discardTarget: { kind: 'tab', tabId: tab.id },
  });
  const [saving, setSaving] = useState(false);
  const normalizedSequence = useMemo(() => normalizeProteinSequence(sequence), [sequence]);
  const sequenceError = sequence.trim() ? proteinSequenceValidationError(sequence) : null;

  const updateName = (value: string) => {
    setName(value);
    updateTab(panelId, tab.id, {
      label: value.trim() || 'Untitled Protein',
    });
  };

  const save = async (): Promise<boolean> => {
    if (
      !context ||
      saving ||
      !name.trim() ||
      !normalizedSequence ||
      sequenceError ||
      !destinationDir
    ) {
      return false;
    }
    setSaving(true);
    try {
      const result = await recordProtein({
        name: name.trim(),
        sequence: normalizedSequence,
        workspaceRoot: context.workspaceRoot,
        dir: destinationDir,
        organism: organism.trim() || undefined,
        sourceCds: sourceCds.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      useCanvasStore
        .getState()
        .retargetTab(
          panelId,
          tab.id,
          { type: 'protein', entityId: result.limsEntity.id },
          { label: result.limsEntity.name, artifactDocument: undefined, isDirty: false }
        );
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot: context.workspaceRoot, revealPath: result.artifactPath },
        })
      );
      useToastStore.getState().addToast(
        userMessageWithValues('notice.created-protein-value', {
          value0: userMessageValue(result.limsEntity.name),
        }),
        {
          definition: 'protein-creation-tab-created-protein-example',
        }
      );
      return true;
    } catch (error) {
      reportSaveFailure('[ProteinCreationTab] Save failed:', { tabId: tab.id }, error);
      useToastStore.getState().addToast(toUserMessage(error, 'structure.failed'), {
        definition: 'protein-creation-tab-save',
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  useDocumentLifecycle({
    target: { kind: 'tab', tabId: tab.id },
    tabId: tab.id,
    isDirty: () => dirty,
    save,
    discard: () => undefined,
  });

  if (!context) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-error" role="alert">
        This protein tab is missing its workspace destination.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-bg" data-testid="protein-creation-tab">
      <main className="flex min-w-0 flex-1 flex-col px-8 py-7" aria-label="Protein editor">
        <div className="mb-3 flex shrink-0 items-center justify-end text-xs tabular-nums text-fg-muted">
          {normalizedSequence.length} aa
        </div>
        <textarea
          autoFocus
          aria-label="Amino-acid sequence"
          data-testid="protein-draft-sequence"
          value={sequence}
          onChange={(event) => {
            setSequence(event.target.value.toUpperCase());
          }}
          spellCheck={false}
          placeholder="Type or paste an amino-acid sequence"
          className="min-h-0 flex-1 resize-none border-0 bg-transparent p-0 font-mono text-base uppercase leading-7 tracking-wide text-fg placeholder:text-fg-subtle focus:outline-none"
        />
        {sequenceError ? (
          <div className="mt-2 shrink-0 text-xs text-error" role="alert">
            {toUserMessage(sequenceError, 'structure.failed')}
          </div>
        ) : null}
      </main>

      <SequenceDrawer width={420} onWidthChange={() => undefined}>
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">Protein details</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4 border-b border-border p-4">
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Name
                <TextField
                  value={name}
                  onChange={(event) => updateName(event.target.value)}
                  placeholder="Untitled Protein"
                  data-testid="protein-draft-name"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Organism
                <TextField
                  value={organism}
                  onChange={(event) => {
                    setOrganism(event.target.value);
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Source CDS/ORF
                <TextField
                  value={sourceCds}
                  onChange={(event) => {
                    setSourceCds(event.target.value);
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Notes
                <TextArea
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                  rows={3}
                />
              </label>
            </div>
            <div className="flex min-h-72 flex-col p-4">
              <div className="mb-2 text-xs font-medium text-fg-muted">Save location</div>
              <ProteinSaveLocationPicker
                roots={folders}
                initialDir={context.destinationPath}
                selectedDir={destinationDir}
                onSelectFolder={(path) => {
                  setDestinationDir(path);
                }}
              />
            </div>
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-bg-subtle px-4 py-3">
            <Button
              type="button"
              onClick={() => requestTabClose(panelId, tab.id)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="protein-draft-save"
              disabled={
                saving ||
                !name.trim() ||
                !normalizedSequence ||
                Boolean(sequenceError) ||
                !destinationDir
              }
              variant="primary"
            >
              {saving ? 'Saving…' : 'Save Protein'}
            </Button>
          </div>
        </form>
      </SequenceDrawer>
    </div>
  );
}
