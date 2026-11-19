import { useDocumentDraft } from '../../../shared/use-document-draft';
import {
  documentLifecycle,
  type DocumentSaveAcknowledgement,
} from '../../../shared/document-lifecycle';
import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { Button, TextField, TextArea } from '../../../components/ui';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeChecksum } from '@waypoint/sequence-utils';
import { serializeEntityArtifact } from '../../lims/public/entity-artifact';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { SequenceDrawer } from '../../sequence/public/components/SequenceDrawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useToastStore } from '../../../stores/toast-store';
import {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '../../lims/public/protein-sequence';
import {
  recordProtein,
  ProteinProjectionError,
  type PublishedProteinDraft,
} from '../record-proteins';
import { updatePublishedProteinDraft } from '../save-protein-sequence';
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

function publicationFields(publication?: PublishedProteinDraft): Record<string, string> {
  return publication
    ? {
        publishedProteinId: publication.id,
        publishedProteinPath: publication.relativePath,
        publishedProteinHash: publication.contentHash,
      }
    : {};
}

export function ProteinCreationTab({ tab, panelId }: ProteinCreationTabProps) {
  const context = tab.artifactDocument?.kind === 'protein' ? tab.artifactDocument : undefined;
  const folders = useWorkspaceStore((state) => state.folders);
  const updateTab = useCanvasStore((state) => state.updateTab);

  const recovered = tab.recoveredDraft;
  const [publication, setPublication] = useState<PublishedProteinDraft | undefined>(() =>
    recovered &&
    ('publishedProteinId' in recovered ||
      'publishedProteinPath' in recovered ||
      'publishedProteinHash' in recovered)
      ? {
          id: recovered.publishedProteinId ?? '',
          relativePath: recovered.publishedProteinPath ?? '',
          contentHash: recovered.publishedProteinHash ?? '',
        }
      : undefined
  );
  const published = useRef(publication);
  const lifetime = useMemo(() => ({ active: true }), [tab.id, context?.workspaceRoot]);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  const draft = useDocumentDraft(() => ({
    name: recovered?.name ?? '',
    sequence: recovered?.sequence ?? '',
    organism: recovered?.organism ?? '',
    sourceCds: recovered?.sourceCds ?? '',
    notes: recovered?.notes ?? '',
    destinationDir: recovered?.destinationDir ?? context?.destinationPath ?? '',
  }));
  const { name, sequence, organism, sourceCds, notes, destinationDir } = draft.value;
  const isDirty = () => {
    const current = draft.read().value;
    return Boolean(
      recovered ||
      current.name ||
      current.sequence ||
      current.organism ||
      current.sourceCds ||
      current.notes ||
      current.destinationDir !== context?.destinationPath
    );
  };
  const dirty = isDirty();
  const recoveryPayload = useMemo<NewDraftPayload | undefined>(
    () =>
      context
        ? {
            tabType: 'protein',
            label: name.trim() || 'Untitled Protein',
            artifactDocument: context,
            fields: {
              name,
              sequence,
              organism,
              sourceCds,
              notes,
              destinationDir,
              ...publicationFields(publication),
            },
          }
        : undefined,
    [context, destinationDir, name, notes, organism, publication, sequence, sourceCds]
  );
  const { completePublishedDraft, flushDraft } = useUnsavedDraftRecovery<NewDraftPayload>({
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
    draft.edit({ name: value });
    updateTab(panelId, tab.id, {
      label: value.trim() || 'Untitled Protein',
    });
  };

  const retainPublication = async (next: PublishedProteinDraft) => {
    if (!lifetime.active || !context) return;
    published.current = next;
    setPublication(next);
    const fields = draft.read().value;
    await flushDraft({
      baseline: NEW_DOCUMENT_BASELINE,
      payload: {
        tabType: 'protein',
        artifactDocument: context,
        label: fields.name.trim() || 'Untitled Protein',
        fields: { ...fields, ...publicationFields(next) },
      },
    });
  };

  const save = async (): Promise<DocumentSaveAcknowledgement> => {
    const revision = draft.revision;
    if (
      !context ||
      draft.read().revision !== revision ||
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
      const input = {
        name: name.trim(),
        sequence: normalizedSequence,
        workspaceRoot: context.workspaceRoot,
        dir: destinationDir,
        organism: organism.trim() || undefined,
        sourceCds: sourceCds.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      const prior = published.current;
      const result = prior
        ? await updatePublishedProteinDraft(input, prior)
        : await recordProtein(input);
      const current = () => lifetime.active && draft.read().revision === revision;
      if (!current() || !(await completePublishedDraft(current)) || !current()) {
        if (prior || ('created' in result && result.created)) {
          await retainPublication({
            id: result.limsEntity.id,
            relativePath: result.artifactPath,
            contentHash: result.contentHash,
          });
        }
        return false;
      }
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
      return { publishedRevision: revision };
    } catch (error) {
      if (
        error instanceof ProteinProjectionError &&
        (error.created || published.current?.id === error.artifact.id)
      ) {
        await retainPublication({
          id: error.artifact.id,
          relativePath: error.artifactPath,
          contentHash: await computeChecksum(serializeEntityArtifact(error.artifact)),
        });
      }
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
    readRevision: () => draft.read().revision,
    isDirty,
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
            draft.edit({ sequence: event.target.value.toUpperCase() });
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
            void documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id);
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
                    draft.edit({ organism: event.target.value });
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Source CDS/ORF
                <TextField
                  value={sourceCds}
                  onChange={(event) => {
                    draft.edit({ sourceCds: event.target.value });
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
                Notes
                <TextArea
                  value={notes}
                  onChange={(event) => {
                    draft.edit({ notes: event.target.value });
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
                  draft.edit({ destinationDir: path });
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
