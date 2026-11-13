'use client';

import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import { confirmDialog } from '../../../components/confirm-dialog-store';
import type { SequenceDesign } from '../../design/public/types';
import {
  mocloAssemblySchemaOptions,
  type MocloKitDefinition,
} from '../../design/public/moclo-kit-definition';
import {
  loadMocloSchemaCatalog,
  subscribeMocloSchemaCatalog,
} from '../../design/public/moclo-schema-catalog';
import { selectedGoldenGateKit } from '../../design/public/golden-gate-schema-command';
import { FilterableSelect } from './FilterableSelect';
import { MocloKitBuilderDialog } from './MocloKitBuilderDialog';
import { useDesignStore } from '../../design/public/store';
import type { GoldenGateAssemblySchema } from '../../design/public/golden-gate-schema';

type InventoryState =
  | { status: 'loading'; definitions: MocloKitDefinition[] }
  | { status: 'ready'; definitions: MocloKitDefinition[]; issueCount: number }
  | { status: 'error'; definitions: MocloKitDefinition[]; message: string };

export interface MocloSchemaSelectorProps {
  design: SequenceDesign;
  projectRoot: string | null;
}

export function MocloSchemaSelector({ design, projectRoot }: MocloSchemaSelectorProps) {
  const [pending, setPending] = useState<{
    designId: string;
    projectRoot: string | null;
    expectedVersion: number;
    schema?: GoldenGateAssemblySchema;
    kit?: SequenceDesign['pendingGoldenGateKit'];
  } | null>(null);
  const [inventory, setInventory] = useState<InventoryState>({
    status: 'loading',
    definitions: [],
  });
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [builderKit, setBuilderKit] = useState<{ kit: MocloKitDefinition | null } | null>(null);

  useEffect(
    () =>
      subscribeMocloSchemaCatalog((changedRoot) => {
        if (changedRoot === projectRoot) setCatalogRevision((revision) => revision + 1);
      }),
    [projectRoot]
  );

  useEffect(() => {
    setPending(null);
    setSelectionError(null);
  }, [design.id, projectRoot]);

  useEffect(() => {
    if (!pending || pending.designId !== design.id || pending.projectRoot !== projectRoot) {
      return;
    }
    const controller = new AbortController();
    void confirmDialog({
      title: userMessageWithValues('dialog.switch-to-value', {
        value0: userMessageValue(pending.schema?.name ?? pending.kit?.name ?? 'free-form'),
      }),
      message: userMessage(
        'detail.this-clears-all-parts-spacers-and-primers-from-this-assembly-this-cann'
      ),
      confirmLabel: userMessage('dialog.clear-and-switch'),
      cancelLabel: userMessage('dialog.cancel'),
      tone: 'danger',
      safeDefault: true,
      signal: controller.signal,
    }).then((confirmed) => {
      if (controller.signal.aborted) return;
      if (confirmed) {
        const result = useDesignStore
          .getState()
          .setGoldenGateSchema(pending.designId, pending.schema, pending.expectedVersion, {
            kit: pending.kit,
            confirmedReset: true,
          });
        if (result.status === 'rejected')
          setSelectionError(toUserMessage(result, 'assembly.failed'));
      }
      setPending(null);
    });
    return () => controller.abort();
  }, [pending, design.id, projectRoot]);

  useEffect(() => {
    let active = true;
    if (!projectRoot) {
      setInventory({ status: 'ready', definitions: [], issueCount: 0 });
      return () => {
        active = false;
      };
    }
    setInventory({ status: 'loading', definitions: [] });
    void loadMocloSchemaCatalog(projectRoot)
      .then((result) => {
        if (!active) return;
        setInventory({
          status: 'ready',
          definitions: result.definitions,
          issueCount: result.issues.length,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setInventory({
          status: 'error',
          definitions: [],
          message: toUserMessage(error, 'failure.could-not-load-assembly-schemas'),
        });
      });
    return () => {
      active = false;
    };
  }, [projectRoot, catalogRevision]);

  const selectedKit = selectedGoldenGateKit(design);
  const definition = inventory.definitions.find((kit) => kit.id === selectedKit?.id);
  const options = useMemo(
    () =>
      definition
        ? mocloAssemblySchemaOptions(definition).filter(
            (option) => option.topology === design.topology
          )
        : [],
    [definition, design.topology]
  );
  const selectedId = design.goldenGateSchema?.id ?? '';
  const selectedIsListed = options.some((option) => option.schema.id === selectedId);

  const changeSelection = (
    schema: GoldenGateAssemblySchema | undefined,
    kit?: SequenceDesign['pendingGoldenGateKit']
  ) => {
    setSelectionError(null);
    const result = useDesignStore
      .getState()
      .setGoldenGateSchema(design.id, schema, design.version, { kit });
    if (result.status === 'rejected' && result.code === 'confirmation-required') {
      setPending({
        designId: design.id,
        projectRoot,
        expectedVersion: design.version,
        schema,
        kit,
      });
    } else {
      setPending(null);
      if (result.status === 'rejected') setSelectionError(toUserMessage(result, 'assembly.failed'));
    }
  };
  const kitOptions = useMemo(() => {
    const listed = inventory.definitions.map((kit) => {
      const layouts = mocloAssemblySchemaOptions(kit).length;
      const parts = kit.members.length;
      return {
        value: kit.id,
        label: kit.name,
        hint: `${layouts} layout${layouts === 1 ? '' : 's'} · ${parts === 0 ? 'no parts yet' : `${parts} parts`}`,
      };
    });
    const missingSelected =
      selectedKit && !definition
        ? [{ value: selectedKit.id, label: selectedKit.name, hint: 'not in this project' }]
        : [];
    return [{ value: '', label: 'None (free-form)' }, ...missingSelected, ...listed];
  }, [definition, inventory.definitions, selectedKit]);

  const disabled = !projectRoot || inventory.status === 'loading';
  const selectClass =
    'h-8 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent';

  return (
    <div data-testid="moclo-drawer-schema-selector" className="mb-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="w-12 shrink-0 font-medium text-fg-muted">Kit</span>
        <FilterableSelect
          label="Assembly kit"
          testId="moclo-kit-picker"
          value={selectedKit?.id ?? ''}
          disabled={!projectRoot}
          placeholder="None (free-form)"
          emptyMessage={inventory.status === 'loading' ? 'Loading kits…' : 'No matching kits'}
          options={kitOptions}
          onChange={(value) => {
            const kit = inventory.definitions.find((candidate) => candidate.id === value);
            void changeSelection(undefined, kit ? { id: kit.id, name: kit.name } : undefined);
          }}
        />
        <button
          type="button"
          className="h-8 shrink-0 rounded border border-border px-2 text-[11px] text-fg hover:bg-bg-muted disabled:opacity-60"
          disabled={!projectRoot}
          onClick={() => setBuilderKit({ kit: null })}
        >
          New kit
        </button>
        {definition ? (
          <button
            type="button"
            className="h-8 shrink-0 rounded border border-border px-2 text-[11px] text-fg hover:bg-bg-muted"
            onClick={() => setBuilderKit({ kit: definition })}
          >
            Edit
          </button>
        ) : null}
      </div>
      {selectedKit ? (
        <label className="flex items-center gap-2 text-xs">
          <span className="w-12 shrink-0 font-medium text-fg-muted">Schema</span>
          <select
            aria-label="Assembly schema"
            value={selectedId}
            disabled={disabled}
            onChange={(event) => {
              const schema = options.find(
                (option) => option.schema.id === event.target.value
              )?.schema;
              void changeSelection(schema, selectedKit);
            }}
            className={selectClass}
          >
            <option value="">
              {options.length === 0 ? 'No schemas defined' : 'Choose a schema…'}
            </option>
            {selectedId && !selectedIsListed ? (
              <option value={selectedId}>{design.goldenGateSchema?.name}</option>
            ) : null}
            {options.map((option) => (
              <option key={option.schema.id} value={option.schema.id}>
                {option.schema.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selectionError ? (
        <p role="alert" className="mt-1 text-[11px] text-error">
          {toUserMessage(selectionError, 'assembly.failed')}
        </p>
      ) : inventory.status === 'error' ? (
        <p role="alert" className="mt-1 text-[11px] text-error">
          {toUserMessage(inventory.message, 'assembly.failed')}
        </p>
      ) : inventory.status === 'ready' && inventory.issueCount > 0 ? (
        <p role="alert" className="mt-1 text-[11px] text-amber-600">
          {inventory.issueCount} invalid schema {inventory.issueCount === 1 ? 'file' : 'files'}{' '}
          ignored
        </p>
      ) : null}
      {builderKit && projectRoot ? (
        <MocloKitBuilderDialog
          projectRoot={projectRoot}
          kit={builderKit.kit}
          existingKits={inventory.definitions}
          onEditExisting={(kitId) => {
            const existing = inventory.definitions.find((candidate) => candidate.id === kitId);
            if (existing) setBuilderKit({ kit: existing });
          }}
          onClose={() => setBuilderKit(null)}
          onSaved={(kitId, kitName) => {
            setBuilderKit(null);
            if (selectedKit?.id !== kitId)
              void changeSelection(undefined, { id: kitId, name: kitName });
          }}
        />
      ) : null}
    </div>
  );
}
