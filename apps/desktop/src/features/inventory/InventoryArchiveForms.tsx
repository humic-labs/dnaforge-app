import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  InventoryScientificReference,
  InventoryImportBinding,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { platform } from '../../platform';
import { readInventoryArchiveFile } from './inventory-archive-file';
import type {
  InventoryClient,
  InventoryMaterial,
  InventoryImportPreviewSnapshot,
} from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { inventoryTextOutputLocked, inventoryTextOutputPending } from './inventory-text-output';

interface ArchiveFormProps {
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}

export function InventoryArchiveExportForm({
  data,
  controller,
  status,
  onClose,
}: ArchiveFormProps) {
  const source = { project: data.project.projectId, inventoryId: data.project.defaultInventoryId };
  const session = controller.archiveSession(source, {
    chooseDestination: async (defaultPath) => {
      const result = await platform().dialog.save({
        title: 'Export inventory archive',
        defaultPath,
      });
      return typeof result === 'string' ? result : null;
    },
    write: (path, content) => platform().fs.writeTextFileAtomic({ path, content }),
    read: readInventoryArchiveFile,
  });
  useEffect(() => () => session.cancelChoosing(), [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { capture, output } = snapshot;
  const artifact = capture.kind === 'captured' ? capture.artifact : null;
  const locked = inventoryTextOutputLocked(output);
  return (
    <InventoryPhysicalDialog
      title="Export inventory archive"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
    >
      <section
        className="space-y-4"
        data-testid="inventory-archive-export"
        data-capture-state={capture.kind}
        data-output-state={output.kind}
      >
        <p className="text-sm">
          Capture recorded inventory and complete accepted history as a native archive. Scientific
          records are listed as dependencies and keep their existing document export workflow.
        </p>
        <Button
          disabled={capture.kind === 'capturing' || locked}
          onClick={() => void session.capture()}
        >
          {capture.kind === 'capturing'
            ? 'Capturing…'
            : artifact
              ? 'Capture latest inventory'
              : 'Capture inventory archive'}
        </Button>
        {capture.kind === 'failed' ? <Notice tone="error">{capture.message}</Notice> : null}
        {artifact ? (
          <div
            className="space-y-3"
            data-testid="inventory-archive-captured"
            data-source-revision={artifact.source.revision}
            data-source-sha256={artifact.sourceSha256}
          >
            <p>Captured inventory revision {artifact.source.revision}</p>
            <p className="break-all text-xs">
              Source: {artifact.source.projectId} / {artifact.source.inventoryId}
            </p>
            <p className="break-all text-xs">SHA-256: {artifact.sourceSha256}</p>
            <p className="text-xs">
              Archive size: {new TextEncoder().encode(artifact.sourceText).length.toLocaleString()}{' '}
              bytes
            </p>
            {artifact.source.revision !== data.state.revision ? (
              <Notice>This retained capture is from an earlier inventory revision.</Notice>
            ) : null}
            <Button disabled={locked} onClick={() => void session.exportArchive()}>
              Save archive file
            </Button>
            <p data-testid="inventory-archive-output-status">
              {output.kind === 'not-exported'
                ? 'No saved output has been confirmed for this capture.'
                : output.kind === 'choosing'
                  ? 'Choosing a destination…'
                  : output.kind === 'writing'
                    ? 'Writing the retained archive…'
                    : output.kind === 'confirming'
                      ? 'Checking saved bytes…'
                      : output.kind === 'exported'
                        ? 'Saved bytes match this archive.'
                        : output.kind === 'output-unconfirmed'
                          ? 'Output is unconfirmed. Retained bytes and destination are available for recovery.'
                          : 'The file output failed.'}
            </p>
            {'path' in output && output.path ? (
              <p className="break-all text-xs" data-testid="inventory-archive-destination">
                {output.path}
              </p>
            ) : null}
            {'message' in output ? <Notice tone="warning">{output.message}</Notice> : null}
            {['exported', 'failed', 'output-unconfirmed'].includes(output.kind) ? (
              <div className="flex flex-wrap gap-2">
                {'path' in output && output.path ? (
                  <Button onClick={() => void session.checkOutput()}>Check saved archive</Button>
                ) : null}
                {output.kind !== 'exported' && 'path' in output && output.path ? (
                  <Button onClick={() => void session.retryOutput()}>
                    Retry same archive output
                  </Button>
                ) : null}
                <Button
                  disabled={inventoryTextOutputPending(output)}
                  onClick={() => session.forgetOutput()}
                >
                  Forget output attempt
                </Button>
              </div>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm">Inspect captured archive text</summary>
              <TextArea
                readOnly
                aria-label="Captured inventory archive"
                data-testid="inventory-archive-source-text"
                value={artifact.sourceText}
                className="mt-2 h-48 font-mono text-xs"
              />
            </details>
          </div>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}

interface ImportDraftFacts {
  sourceText: string;
  sourcePath: string | null;
  bindings: Readonly<Record<string, string>>;
  references: readonly InventoryScientificReference[];
}
type ImportDraft = ImportDraftFacts &
  (
    | { phase: 'editing' | 'previewing' | 'reading-source' }
    | { phase: 'previewed'; preview: InventoryImportPreviewSnapshot }
    | { phase: 'failed'; message: string }
  );
const draftFacts = (draft: ImportDraft): ImportDraftFacts => ({
  sourceText: draft.sourceText,
  sourcePath: draft.sourcePath,
  bindings: draft.bindings,
  references: draft.references,
});
const recordLabels: Readonly<Record<string, string>> = {
  storage: 'Locations',
  vessels: 'Containers',
  stocks: 'Stocks',
  lots: 'Lots',
  reservations: 'Reservations',
  typeVersions: 'Physical types',
  recipeVersions: 'Equipment recipes',
  fitEvidence: 'Fit evidence',
  itemCodes: 'Item codes',
  temperatureClaims: 'Temperature evidence',
  equipmentSetpoints: 'Reported setpoints',
  storageRequirements: 'Storage requirements',
  thermalContexts: 'Thermal relationships',
  tableBindings: 'Imported table rows',
  hierarchyBindings: 'Imported hierarchy rows',
  vesselBindings: 'Imported vessel identities',
  observations: 'Stocktake observations',
};

export function InventoryArchiveImportForm({
  data,
  controller,
  status,
  onClose,
  client,
}: ArchiveFormProps & { client: InventoryClient }) {
  const pending =
    'attempt' in status &&
    status.attempt &&
    'kind' in status.attempt.request &&
    status.attempt.request.kind === 'adopt-archive'
      ? status.attempt.request
      : null;
  const [draft, setDraft] = useState<ImportDraft>(() => ({
    phase: 'editing',
    sourceText: pending?.sourceText ?? '',
    sourcePath: null,
    bindings: Object.fromEntries(
      pending?.options.bindings.map((binding) => [
        binding.sourceMaterialId,
        binding.destinationMaterialId,
      ]) ?? []
    ),
    references: [],
  }));
  const generation = useRef(0);
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const activeAttempt =
    status.kind === 'submitting' ||
    status.kind === 'outcome-unknown' ||
    status.kind === 'committed-refresh-failed';
  const preview = draft.phase === 'previewed' ? draft.preview : null;
  const stale = Boolean(
    preview &&
    (preview.target.projectId !== data.project.projectId ||
      preview.target.inventoryId !== data.project.defaultInventoryId ||
      preview.target.revision !== data.state.revision ||
      (status.kind === 'refused' && status.attempt && 'kind' in status.attempt.request))
  );
  const canApply = preview?.kind === 'ready' && !stale && inventoryCanEdit(status);

  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setMaterialError(null);
          }
        })
        .catch(() => {
          if (!cancelled)
            setMaterialError(
              'Scientific records could not be searched. Retry the search before selecting a binding.'
            );
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);

  function changeSource(sourceText: string) {
    ++generation.current;
    setDraft({ phase: 'editing', sourceText, sourcePath: null, bindings: {}, references: [] });
  }
  function changeBinding(sourceMaterialId: string, destinationMaterialId: string) {
    ++generation.current;
    setDraft({
      ...draftFacts(draft),
      phase: 'editing',
      bindings: { ...draft.bindings, [sourceMaterialId]: destinationMaterialId },
    });
  }
  async function chooseSourceFile() {
    if (activeAttempt || draft.phase === 'reading-source') return;
    const before = draft;
    const current = ++generation.current;
    setDraft({ ...draftFacts(before), phase: 'reading-source' });
    try {
      const selected = await platform().dialog.open({
        title: 'Choose inventory archive',
        multiple: false,
        filters: [{ name: 'DNAForge inventory archive', extensions: ['json'] }],
      });
      if (generation.current !== current) return;
      if (selected === null) {
        setDraft(before);
        return;
      }
      if (Array.isArray(selected) && selected.length !== 1)
        throw new Error('Choose one inventory archive.');
      const path = Array.isArray(selected) ? selected[0] : selected;
      const sourceText = await readInventoryArchiveFile(path);
      if (generation.current !== current) return;
      setDraft({ phase: 'editing', sourceText, sourcePath: path, bindings: {}, references: [] });
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...draftFacts(before),
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  async function previewSource() {
    if (!draft.sourceText || activeAttempt) return;
    if (status.kind === 'refused' || status.kind === 'conflict') controller.dismiss();
    const current = ++generation.current;
    const facts = draftFacts(draft);
    const bindings: InventoryImportBinding[] = Object.entries(facts.bindings)
      .filter(([, id]) => id !== '')
      .map(([sourceMaterialId, destinationMaterialId]) => ({
        sourceMaterialId,
        destinationMaterialId,
      }));
    setDraft({ ...facts, phase: 'previewing' });
    try {
      const result = await client.previewImport({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        sourceText: facts.sourceText,
        options: { bindings },
      });
      if (generation.current !== current) return;
      if (
        result.target.projectId !== data.project.projectId ||
        result.target.inventoryId !== data.project.defaultInventoryId
      )
        throw new Error('The preview belongs to another project or inventory.');
      setDraft({
        ...facts,
        references: result.scientificReferences,
        phase: 'previewed',
        preview: result,
      });
    } catch (cause) {
      if (generation.current === current)
        setDraft({
          ...facts,
          phase: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }
  async function apply() {
    if (!canApply || preview?.kind !== 'ready') return;
    if (await controller.adoptArchive(draft.sourceText, preview.options, preview.planDigest))
      onClose();
  }

  return (
    <InventoryPhysicalDialog
      title="Import inventory archive"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Adopt archived inventory"
      disabled={!canApply}
    >
      <section
        className="space-y-4"
        data-testid="inventory-archive-import"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? draft.phase)}
      >
        <p className="text-sm">
          Create destination inventory from recorded archive facts. Original history is retained as
          source evidence. Scientific records require explicit destination bindings.
        </p>
        <Button
          disabled={activeAttempt || draft.phase === 'reading-source'}
          onClick={() => void chooseSourceFile()}
        >
          {draft.phase === 'reading-source' ? 'Reading archive…' : 'Choose archive file'}
        </Button>
        {draft.sourcePath ? (
          <p className="break-all text-xs" data-testid="inventory-import-source-path">
            {draft.sourcePath}
          </p>
        ) : null}
        <details data-testid="inventory-import-source-details">
          <summary className="cursor-pointer text-sm">Paste or inspect archive text</summary>
          <label className="mt-2 flex flex-col gap-2 text-xs font-medium">
            Native inventory archive text
            <TextArea
              aria-label="Native inventory archive text"
              data-testid="inventory-import-source"
              value={draft.sourceText}
              onChange={(event) => changeSource(event.target.value)}
              disabled={activeAttempt || draft.phase === 'reading-source'}
              className="h-40 font-mono text-xs"
            />
          </label>
        </details>
        {draft.references.length ? (
          <div className="space-y-3" data-testid="inventory-import-bindings">
            <h3 className="font-semibold">Scientific record bindings</h3>
            <TextField
              aria-label="Search destination scientific records"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={activeAttempt || draft.phase === 'reading-source'}
            />
            {materialError ? <Notice tone="error">{materialError}</Notice> : null}
            {draft.references.map((reference) => {
              const selected = Object.hasOwn(draft.bindings, reference.materialId)
                ? draft.bindings[reference.materialId]
                : '';
              return (
                <div
                  key={reference.materialId}
                  className="space-y-2 rounded border border-border p-3"
                  data-source-material-id={reference.materialId}
                >
                  <p className="break-all text-xs">
                    Source scientific record: {reference.materialId}
                  </p>
                  <Select
                    ariaLabel={`Destination scientific record for ${reference.materialId}`}
                    value={selected}
                    disabled={activeAttempt || draft.phase === 'reading-source'}
                    options={[
                      { value: '', label: 'Choose an explicit destination record' },
                      ...(!materials.some((record) => record.id === selected) && selected
                        ? [{ value: selected, label: `Selected record ${selected}` }]
                        : []),
                      ...materials.map((record) => ({
                        value: record.id,
                        label: `${record.name} · ${record.id}`,
                      })),
                    ]}
                    onValueChange={(value) => changeBinding(reference.materialId, value)}
                  />
                  {selected ? <p className="break-all text-xs">Destination: {selected}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <Button
          disabled={
            !draft.sourceText ||
            activeAttempt ||
            draft.phase === 'previewing' ||
            draft.phase === 'reading-source'
          }
          onClick={() => void previewSource()}
        >
          {draft.phase === 'previewing' ? 'Previewing…' : 'Preview archive import'}
        </Button>
        {draft.phase === 'failed' ? <Notice tone="error">{draft.message}</Notice> : null}
        {stale ? (
          <Notice tone="warning">
            This preview is stale. Preview the retained source and bindings again before applying.
          </Notice>
        ) : null}
        {preview ? (
          <div
            className="space-y-3"
            data-testid="inventory-import-preview"
            data-plan-digest={preview.planDigest ?? ''}
          >
            <p className="font-semibold">
              {stale
                ? 'Stale preview'
                : preview.kind === 'ready'
                  ? 'Ready for explicit adoption'
                  : preview.kind === 'no-change'
                    ? 'This archive has no inventory changes'
                    : 'Resolution required'}
            </p>
            <p className="break-all text-xs">Source SHA-256: {preview.sourceSha256}</p>
            {preview.source ? (
              <p className="break-all text-xs">
                Source inventory: {preview.source.projectId} / {preview.source.inventoryId} ·
                Revision {preview.source.revision}
              </p>
            ) : null}
            <p className="text-xs">
              Retained source history: {preview.sourceHistoryEntries} accepted operations
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {preview.records.map((record) => (
                <p key={record.kind} data-record-kind={record.kind}>
                  {recordLabels[record.kind]}: {record.ids.length}
                </p>
              ))}
            </div>
            {preview.responsibilities.activeReservationIds.length ||
            preview.responsibilities.unavailableItems.length ? (
              <Notice>
                {preview.responsibilities.activeReservationIds.length} active source reservations
                and {preview.responsibilities.unavailableItems.length} unavailable items keep their
                source holders. Use an explicit cancellation or recovery action to change
                responsibility.
              </Notice>
            ) : null}
            <p className="text-xs">
              Source qualification and temperature reports retain their original scope. Adoption
              records no new physical qualification or movement.
            </p>
            {preview.kind === 'blocked'
              ? preview.issues.map((issue, index) => (
                  <Notice
                    key={`${issue.code}:${index}`}
                    tone="warning"
                    testId="inventory-import-issue"
                  >
                    {issue.message}
                    <span className="mt-1 block break-all font-mono text-xs">{issue.pointer}</span>
                  </Notice>
                ))
              : null}
            {preview.kind === 'ready' ? (
              <p className="break-all text-xs">Plan: {preview.planDigest}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </InventoryPhysicalDialog>
  );
}
