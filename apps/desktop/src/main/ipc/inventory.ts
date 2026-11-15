import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { InventoryValidationError } from '@waypoint/domain-services';
import { ZodError } from 'zod';
import { handleGroup } from '../../shared/ipc-contract';
import { inventoryContract } from '../../shared/ipc/inventory.contract';
import {
  inventoryExecuteRequestSchema,
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
  return handleGroup(inventoryContract, {
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
    execute: (event, input) => {
      const scope = inventoryOperationRequestSchema.parse({
        project: input?.project,
        inventoryId: input?.inventoryId,
        operationId: input?.operationId,
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
        request = inventoryExecuteRequestSchema.parse(input);
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
        return owner.execute(request, assertCurrent, { actor: `human:desktop:${event.sender.id}` });
      } catch (error) {
        if (error instanceof NativeDocumentCommandError && error.stateChanged === false)
          return reject(error.code, error.message);
        throw error;
      }
    },
  });
}
