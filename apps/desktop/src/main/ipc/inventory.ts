import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { InventoryValidationError } from '@waypoint/domain-services';
import { ZodError } from 'zod';
import { handleGroup } from '../../shared/ipc-contract';
import { inventoryContract } from '../../shared/ipc/inventory.contract';
import {
  inventoryApplyArrivalRequestSchema,
  inventoryExecuteRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryApplyTableRequestSchema,
  inventoryApplyStocktakeRequestSchema,
  inventoryApplyHierarchyRequestSchema,
  inventoryApplyMappedTableRequestSchema,
  inventoryApplyBenchlingCaptureRequestSchema,
  inventoryAcknowledgeSourceRequestSchema,
  inventoryOperationRequestSchema,
  type NativeInventoryRejection,
} from '../../shared/inventory-command';
import { NativeDocumentCommandError } from '../../shared/native-document-error';
import type { NativeInventoryOwner } from '../inventory-owner';

export function registerInventoryHandlers(options: {
  owner(): NativeInventoryOwner | null;
  target(): WebContents | null;
}): () => void {
  const currentOwner = () => {
    const owner = options.owner();
    if (!owner)
      throw new NativeDocumentCommandError(
        'INVENTORY_OWNER_UNAVAILABLE',
        'The desktop inventory owner is not ready.',
        false
      );
    return owner;
  };
  const assertCaller = (event: IpcMainInvokeEvent) => {
    const target = options.target();
    if (
      !target ||
      target.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.sender.id !== target.id ||
      (event.senderFrame && event.senderFrame !== event.sender.mainFrame)
    )
      throw new NativeDocumentCommandError(
        'INVENTORY_DESKTOP_CALLER_UNAVAILABLE',
        'The current desktop caller changed.',
        false
      );
  };
  const mutate = (
    event: IpcMainInvokeEvent,
    input: unknown,
    kind:
      | 'arrival'
      | 'commands'
      | 'adoption'
      | 'table'
      | 'stocktake'
      | 'hierarchy'
      | 'mapped-table'
      | 'benchling-capture'
      | 'source-revision'
  ): ReturnType<NativeInventoryOwner['execute']> => {
    const value = input as
      | { project?: unknown; inventoryId?: unknown; operationId?: unknown }
      | undefined;
    const scope = inventoryOperationRequestSchema.parse({
      project: value?.project,
      inventoryId: value?.inventoryId,
      operationId: value?.operationId,
    });
    const reject = (code: string, message: string): NativeInventoryRejection => ({
      status: 'rejected',
      inventoryId: scope.inventoryId,
      operationId: scope.operationId,
      code,
      message,
    });
    let request;
    try {
      request =
        kind === 'arrival'
          ? inventoryApplyArrivalRequestSchema.parse(input)
          : kind === 'benchling-capture'
            ? inventoryApplyBenchlingCaptureRequestSchema.parse(input)
            : kind === 'commands'
              ? inventoryExecuteRequestSchema.parse(input)
              : kind === 'adoption'
                ? inventoryApplyImportRequestSchema.parse(input)
                : kind === 'table'
                  ? inventoryApplyTableRequestSchema.parse(input)
                  : kind === 'stocktake'
                    ? inventoryApplyStocktakeRequestSchema.parse(input)
                    : kind === 'hierarchy'
                      ? inventoryApplyHierarchyRequestSchema.parse(input)
                      : kind === 'mapped-table'
                        ? inventoryApplyMappedTableRequestSchema.parse(input)
                        : inventoryAcknowledgeSourceRequestSchema.parse(input);
    } catch (error) {
      if (!(error instanceof ZodError || error instanceof InventoryValidationError)) throw error;
      return reject('INVALID_INVENTORY_INPUT', error.message);
    }
    try {
      const owner = currentOwner();
      const assertCurrent = () => {
        assertCaller(event);
        if (options.owner() !== owner)
          throw new NativeDocumentCommandError(
            'INVENTORY_OWNER_UNAVAILABLE',
            'The desktop inventory owner changed.',
            false
          );
      };
      assertCurrent();
      return kind === 'arrival'
        ? owner.applyArrival(request, assertCurrent, { actor: `human:desktop:${event.sender.id}` })
        : kind === 'benchling-capture'
          ? owner.applyBenchlingCapture(request, assertCurrent, {
              actor: `human:desktop:${event.sender.id}`,
            })
          : kind === 'commands'
            ? owner.execute(request, assertCurrent, { actor: `human:desktop:${event.sender.id}` })
            : kind === 'adoption'
              ? owner.applyImport(request, assertCurrent, {
                  actor: `human:desktop:${event.sender.id}`,
                })
              : kind === 'table'
                ? owner.applyTable(request, assertCurrent, {
                    actor: `human:desktop:${event.sender.id}`,
                  })
                : kind === 'stocktake'
                  ? owner.applyStocktake(request, assertCurrent, {
                      actor: `human:desktop:${event.sender.id}`,
                    })
                  : kind === 'hierarchy'
                    ? owner.applyHierarchy(request, assertCurrent, {
                        actor: `human:desktop:${event.sender.id}`,
                      })
                    : kind === 'mapped-table'
                      ? owner.applyMappedTable(request, assertCurrent, {
                          actor: `human:desktop:${event.sender.id}`,
                        })
                      : owner.acknowledgeSource(request, assertCurrent, {
                          actor: `human:desktop:${event.sender.id}`,
                        });
    } catch (error) {
      if (error instanceof NativeDocumentCommandError && error.stateChanged === false)
        return reject(error.code, error.message);
      throw error;
    }
  };
  return handleGroup(inventoryContract, {
    stockroom: (event, request) => {
      assertCaller(event);
      return currentOwner().stockroom(request);
    },
    previewArrival: (event, request) => {
      assertCaller(event);
      return currentOwner().previewArrival(request);
    },
    arrivalDocument: (event, request) => {
      assertCaller(event);
      return currentOwner().arrivalDocument(request);
    },
    applyArrival: (event, request) => mutate(event, request, 'arrival'),
    previewBenchlingCapture: (event, request) => {
      assertCaller(event);
      return currentOwner().previewBenchlingCapture(request);
    },
    applyBenchlingCapture: (event, request) => mutate(event, request, 'benchling-capture'),
    inspectBenchlingCapture: (event, request) => {
      assertCaller(event);
      return currentOwner().inspectBenchlingCapture(request);
    },
    previewMappedTable: (event, request) => {
      assertCaller(event);
      return currentOwner().previewMappedTable(request);
    },
    applyMappedTable: (event, request) => mutate(event, request, 'mapped-table'),
    previewHierarchy: (event, request) => {
      assertCaller(event);
      return currentOwner().previewHierarchy(request);
    },
    applyHierarchy: (event, request) => mutate(event, request, 'hierarchy'),
    previewSourceRevision: (event, request) => {
      assertCaller(event);
      return currentOwner().previewSourceRevision(request);
    },
    acknowledgeSource: (event, request) => mutate(event, request, 'source-revision'),
    previewStocktake: (event, request) => {
      assertCaller(event);
      return currentOwner().previewStocktake(request);
    },
    applyStocktake: (event, request) => mutate(event, request, 'stocktake'),
    exportSnapshot: (event, request) => {
      assertCaller(event);
      return currentOwner().exportSnapshot(request);
    },
    previewImport: (event, request) => {
      assertCaller(event);
      return currentOwner().previewImport(request);
    },
    applyImport: (event, request) => mutate(event, request, 'adoption'),
    previewTable: (event, request) => {
      assertCaller(event);
      return currentOwner().previewTable(request);
    },
    applyTable: (event, request) => mutate(event, request, 'table'),
    projects: (event) => {
      assertCaller(event);
      return currentOwner().projects();
    },
    catalog: (event, request) => {
      assertCaller(event);
      return currentOwner().catalog(request);
    },
    catalogUpdatePreview: (event, request) => {
      assertCaller(event);
      return currentOwner().catalogUpdatePreview(request);
    },
    resolveItemCode: (event, request) => {
      assertCaller(event);
      return currentOwner().resolveItemCode(request);
    },
    storageConditions: (event, request) => {
      assertCaller(event);
      return currentOwner().storageConditions(request);
    },
    prepareLabel: async (event, request) => {
      assertCaller(event);
      const owner = currentOwner();
      const artifact = await owner.prepareLabel(request);
      assertCaller(event);
      if (currentOwner() !== owner)
        throw new NativeDocumentCommandError(
          'INVENTORY_OWNER_UNAVAILABLE',
          'The desktop inventory owner changed.',
          false
        );
      return artifact;
    },
    materials: (event, request) => {
      assertCaller(event);
      return currentOwner().materials(request);
    },
    inspect: (event, request) => {
      assertCaller(event);
      return currentOwner().inspect(request);
    },
    availability: (event, request) => {
      assertCaller(event);
      return currentOwner().availability(request);
    },
    operation: (event, request) => {
      assertCaller(event);
      return currentOwner().operation(request);
    },
    history: (event, request) => {
      assertCaller(event);
      return currentOwner().history(request);
    },
    execute: (event, input) => mutate(event, input, 'commands'),
  });
}
