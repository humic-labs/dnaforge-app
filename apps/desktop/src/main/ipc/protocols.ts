import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { handleGroup } from '../../shared/ipc-contract';
import { protocolsContract } from '../../shared/ipc/protocols.contract';
import { NativeDocumentCommandError } from '../../shared/native-document-error';
import type { NativeProtocolPackages } from '../native-protocol-packages';

export function registerProtocolHandlers(options: {
  owner(): NativeProtocolPackages | null;
  target(): WebContents | null;
}): () => void {
  const currentOwner = () => {
    const owner = options.owner();
    if (!owner)
      throw new NativeDocumentCommandError(
        'PROTOCOL_OWNER_UNAVAILABLE',
        'The native protocol owner is not ready.',
        false
      );
    return owner;
  };
  const capture = (event: IpcMainInvokeEvent) => {
    const owner = currentOwner();
    const assertCurrent = () => {
      const target = options.target();
      if (
        !target ||
        target.isDestroyed() ||
        event.sender.isDestroyed() ||
        event.sender.id !== target.id ||
        (event.senderFrame && event.senderFrame !== event.sender.mainFrame) ||
        options.owner() !== owner
      )
        throw new NativeDocumentCommandError(
          'PROTOCOL_DESKTOP_CALLER_CHANGED',
          'The current protocol editing client changed.',
          false
        );
    };
    assertCurrent();
    return { owner, assertCurrent, actor: `human:desktop:${event.sender.id}` };
  };
  return handleGroup(protocolsContract, {
    createProtocol: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.createProtocol(request, invocation);
    },
    startRun: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.startRun(request, invocation);
    },
    recoverCreation: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.recoverCreation(request, invocation);
    },
    savePackage: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.savePackage(request, invocation);
    },
    editProtocolDeclarations: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.editProtocolDeclarations(request, invocation);
    },
    recordRunValues: (event, request) => {
      const invocation = capture(event);
      return invocation.owner.recordRunValues(request, invocation);
    },
    inspectCreation: async (event, request) => {
      const invocation = capture(event);
      const result = await invocation.owner.inspectCreation(request);
      invocation.assertCurrent();
      return result;
    },
    readPackage: async (event, request) => {
      const invocation = capture(event);
      const result = await invocation.owner.readPackage(request);
      invocation.assertCurrent();
      return result;
    },
    readSavedProtocol: async (event, request) => {
      const invocation = capture(event);
      const result = await invocation.owner.readSavedProtocol(request);
      invocation.assertCurrent();
      return result;
    },
    listPackages: async (event, request) => {
      const invocation = capture(event);
      const result = await invocation.owner.listPackages(request);
      invocation.assertCurrent();
      return result;
    },
  });
}
