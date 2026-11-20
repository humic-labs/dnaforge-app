import { schemaEntityTypeLabel } from '@waypoint/scientific-artifacts/shared/entity-types';
import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { SchemaOriginBadge } from '../../shared/components/SchemaOriginBadge';
import { Button, UI_CARD_CLASS } from '../../components/ui';
import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useToastStore } from '../../stores/toast-store';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import type { LimsSchemaDefinitionView } from '../../shared/lims';
import { StrainCreationForm } from '../lims/public/components/StrainCreationForm';
import { getLimsSchemas } from '../lims/public/operations';
import {
  recordEntityArtifact,
  EntityArtifactCreationProjectionError,
} from '../lims/public/record-entity-artifact';
import type { RecordEntityArtifactInput } from '../lims/public/record-entity-artifact';
import { useEntityCreationStore } from './entity-creation-store';
import {
  SchemaEntityCreationForm,
  supportsGenericEntityCreation,
} from './SchemaEntityCreationForm';

interface EntityCreationHostProps {
  onOpenRegistryEntity?: (entityId: string, name: string) => void;
}

export function EntityCreationHost({ onOpenRegistryEntity }: EntityCreationHostProps = {}) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const request = useEntityCreationStore((state) => state.request);
  const close = useEntityCreationStore((state) => state.close);
  const folders = useWorkspaceStore((state) => state.folders);
  const owner = request ? findContainingPathBoundary(folders, request.destinationPath) : undefined;
  const [schemas, setSchemas] = useState<LimsSchemaDefinitionView[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaReload, setSchemaReload] = useState(0);
  const [selectedSchemaId, setSelectedSchemaId] = useState<string | null>(null);
  const [pendingProjection, setPendingProjection] = useState<{
    input: RecordEntityArtifactInput;
    error: string;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setPendingProjection(null);
    setRetrying(false);
  }, [request]);

  useEffect(() => {
    setSelectedSchemaId(null);
  }, [request]);

  useEffect(() => {
    if (request?.entityType !== 'registry-types') return undefined;
    let active = true;
    setSchemas([]);
    setSchemasLoading(true);
    setSchemaError(null);
    getLimsSchemas()
      .then((loaded) => {
        if (active) setSchemas(loaded);
      })
      .catch((cause) => {
        if (active) setSchemaError(toUserMessage(cause, 'failure.schemas-could-not-be-loaded'));
      })
      .finally(() => {
        if (active) setSchemasLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request, schemaReload]);

  const genericSchemas = useMemo(() => {
    const dedicatedKinds = new Set([
      'sequence',
      'oligo',
      'rna_oligo',
      'plasmid',
      'chromosome',
      'strain',
      'protein',
      'dna_sequence',
      'rna_sequence',
    ]);
    return schemas
      .filter(
        (schema) => !dedicatedKinds.has(schema.entityKind) && supportsGenericEntityCreation(schema)
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [schemas]);
  const selectedSchema = genericSchemas.find((schema) => schema.schemaId === selectedSchemaId);

  useEffect(() => {
    if (!request) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [close, request, presentationEvents]);

  if (!request || (request.entityType !== 'strains' && request.entityType !== 'registry-types')) {
    return null;
  }

  const handleSave = async (input: RecordEntityArtifactInput): Promise<void> => {
    let saved;
    try {
      saved = await recordEntityArtifact(input);
    } catch (error) {
      if (error instanceof EntityArtifactCreationProjectionError) {
        if (useEntityCreationStore.getState().request === request) {
          const fileName = error.artifactPath.split(/[\\/]/).pop()!;
          setPendingProjection({
            input: {
              ...input,
              id: error.artifact.id,
              artifactStem: fileName.replace(/\.entity\.json$/, ''),
            },
            error: toUserMessage(error, 'operation.failed'),
          });
        }
        return;
      }
      throw error;
    }
    if (useEntityCreationStore.getState().request !== request) return;
    close();
    useToastStore.getState().addToast(
      userMessageWithValues('notice.saved-value', {
        value0: userMessageValue(saved.artifact.name),
      }),
      {
        definition: 'entity-creation-host-created-example',
      }
    );
    window.dispatchEvent(
      new CustomEvent('waypoint:workspace-files-changed', {
        detail: {
          workspaceRoot: input.workspaceRoot,
          revealPath: saved.artifactPath,
        },
      })
    );
    onOpenRegistryEntity?.(saved.artifact.id, saved.artifact.name);
  };

  const title =
    request.entityType === 'strains'
      ? 'Create strain'
      : selectedSchema
        ? `Create ${schemaEntityTypeLabel(selectedSchema)}`
        : 'Create Registry entity';

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="entity-creation-backdrop"
      onMouseDown={close}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="entity-creation-title"
          data-testid="entity-creation-dialog"
          className="mx-4 flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-border px-4 py-3">
            <h2 id="entity-creation-title" className="text-sm font-semibold text-fg">
              {title}
            </h2>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {pendingProjection ? (
              <div className="space-y-3 p-4" data-testid="entity-projection-recovery">
                <p>Your record file is saved. Retry Registry to finish registration.</p>
                <p role="alert" className="text-sm text-error">
                  {toUserMessage(pendingProjection.error, 'operation.failed')}
                </p>
                <button
                  type="button"
                  disabled={retrying}
                  onClick={async () => {
                    setRetrying(true);
                    try {
                      await handleSave(pendingProjection.input);
                    } catch (error) {
                      if (useEntityCreationStore.getState().request === request) {
                        setPendingProjection({
                          ...pendingProjection,
                          error: toUserMessage(error, 'failure.registry-retry-failed'),
                        });
                      }
                    } finally {
                      if (useEntityCreationStore.getState().request === request) setRetrying(false);
                    }
                  }}
                  className="rounded border border-border px-3 py-2 text-sm"
                >
                  {retrying ? 'Retrying…' : 'Retry Registry'}
                </button>
              </div>
            ) : !owner ? (
              <div role="alert" className="p-4 text-sm text-error">
                Choose a folder inside an open project before creating this item.
              </div>
            ) : request.entityType === 'strains' ? (
              <StrainCreationForm
                workspaceRoot={owner.path}
                initialSaveDir={request.destinationPath}
                onSave={handleSave}
                onCancel={close}
              />
            ) : schemasLoading ? (
              <p role="status" className="p-4 text-sm text-fg-muted">
                Loading schemas…
              </p>
            ) : schemaError ? (
              <div role="alert" className="space-y-3 p-4 text-sm">
                <p>{toUserMessage(schemaError, 'operation.failed')}</p>
                <Button onClick={() => setSchemaReload((value) => value + 1)}>Retry schemas</Button>
              </div>
            ) : selectedSchema ? (
              <SchemaEntityCreationForm
                key={`${selectedSchema.schemaId}:${selectedSchema.currentRevisionId}`}
                schema={selectedSchema}
                workspaceRoot={owner.path}
                initialSaveDir={request.destinationPath}
                onBack={() => setSelectedSchemaId(null)}
                onSave={handleSave}
                onCancel={close}
              />
            ) : (
              <div
                data-testid="schema-entity-type-picker"
                className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto p-4"
              >
                {genericSchemas.length === 0 ? (
                  <p className="col-span-2 text-sm text-fg-muted">
                    No record schemas are available.
                  </p>
                ) : null}
                {genericSchemas.map((schema) => (
                  <button
                    key={schema.schemaId}
                    type="button"
                    data-testid={`schema-entity-type-${schema.entityKind}`}
                    onClick={() => setSelectedSchemaId(schema.schemaId)}
                    className={`${UI_CARD_CLASS} text-left wp-interactive `}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-fg">
                      <span>{schemaEntityTypeLabel(schema)}</span>
                      <SchemaOriginBadge builtin={schema.builtin} />
                    </span>
                    <span className="mt-1 block text-xs leading-snug text-fg-muted">
                      {schema.description}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
