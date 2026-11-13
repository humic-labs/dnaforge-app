import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentMaterializationV1,
  RemoteDirectoryListingV1,
  RemoteEndpointProfileV1,
  RemoteExplorerSessionV1,
  RemoteGenomicsRuntimeStatusV1,
  RemoteSignalConnectRequestV1,
  RemoteSignalMaterializationV1,
  RemoteExplorerClosedEventV1,
  RemoteSshAuthPromptV1,
} from '../remote-genomics-ipc';
import { defineGroup, invoke, event } from './contract';

export const remoteGenomicsContract = defineGroup('remoteGenomics', {
  listEndpoints: invoke<[], RemoteEndpointProfileV1[]>(),
  renameEndpoint: invoke<
    [endpointId: string, displayName: string],
    RemoteEndpointProfileV1 | null
  >(),
  forgetEndpoint: invoke<[endpointId: string], boolean>(),
  listStatuses: invoke<[], RemoteGenomicsRuntimeStatusV1[]>(),
  openExplorer: invoke<
    [
      request: {
        requestId: string;
        target: string;
      },
    ],
    RemoteExplorerSessionV1
  >(),
  listRemoteDirectory: invoke<[sessionId: string, path: string], RemoteDirectoryListingV1>(),
  closeExplorer: invoke<[sessionId: string], boolean>(),
  cancelExplorerOpen: invoke<[requestId: string], boolean>(),
  respondAuthPrompt: invoke<[promptId: string, answer: string | null], boolean>(),
  connectAlignment: invoke<
    [request: RemoteAlignmentConnectRequestV1],
    RemoteAlignmentMaterializationV1
  >(),
  connectSignal: invoke<[request: RemoteSignalConnectRequestV1], RemoteSignalMaterializationV1>(),
  cancelConnect: invoke<[requestId: string], boolean>(),
  disconnectSession: invoke<[sessionId: string], void>(),
  retryEndpoint: invoke<[endpointIdOrTarget: string], boolean>(),
  subscribeExplorerClosed: event<[event: RemoteExplorerClosedEventV1]>().channel(
    'remoteGenomics:explorerClosed'
  ),
  subscribeAuthPrompt: event<[prompt: RemoteSshAuthPromptV1]>().channel(
    'remoteGenomics:authPrompt'
  ),
  subscribeAuthPromptClosed: event<[promptId: string]>().channel('remoteGenomics:authPromptClosed'),
});
