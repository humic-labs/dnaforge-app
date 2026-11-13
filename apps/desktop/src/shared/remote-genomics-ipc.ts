export const REMOTE_ALIGNMENT_LOCATOR_V1 = 'remote-alignment-locator.v1' as const;
export const REMOTE_SIGNAL_LOCATOR_V1 = 'remote-signal-locator.v1' as const;
export const REMOTE_RANGE_PROTOCOL_V1 = 'dnaforge-remote-range.v1' as const;

export type RemoteSshFailureCode =
  | 'invalid-request'
  | 'ssh-unavailable'
  | 'authentication-required'
  | 'host-trust-failed'
  | 'host-unreachable'
  | 'python-unavailable'
  | 'alignment-not-found'
  | 'index-not-found'
  | 'signal-not-found'
  | 'source-changed'
  | 'cluster-unavailable'
  | 'unsupported-signal'
  | 'unsupported-alignment'
  | 'tunnel-failed'
  | 'connection-timeout'
  | 'helper-failed';

export interface RemoteSshFailureV1 {
  readonly code: RemoteSshFailureCode;
  readonly message: string;
}

export type RemoteGenomicsRuntimeStateV1 =
  | 'connecting'
  | 'online'
  | 'retrying'
  | 'needs-authentication'
  | 'blocked';

export interface RemoteGenomicsRuntimeStatusV1 {
  readonly sourceId: string;
  readonly endpointId: string;
  readonly target: string;
  readonly displayName: string;
  readonly alignmentPath: string | null;
  readonly indexPath: string | null;
  readonly signalPath: string | null;
  readonly state: RemoteGenomicsRuntimeStateV1;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly transportGeneration: number;
  readonly lastFailure: RemoteSshFailureV1 | null;
  readonly updatedAt: number;
}

export interface RemoteGenomicsRuntimeStatusEventV1 {
  readonly sequence: number;
  readonly reason:
    | 'created'
    | 'connecting'
    | 'connected'
    | 'transport-closed'
    | 'retrying'
    | 'blocked';
  readonly status: RemoteGenomicsRuntimeStatusV1;
}

export interface RemoteGenomicsStatusSubscriptionV1 {
  readonly subscriptionId: string;
  readonly statuses: readonly RemoteGenomicsRuntimeStatusV1[];
}

export interface RemoteGenomicsStatusDeliveryV1 {
  readonly subscriptionId: string;
  readonly event: RemoteGenomicsRuntimeStatusEventV1;
}

export interface RemoteEndpointProfileV1 {
  readonly endpointId: string;
  readonly displayName: string;
  readonly target: string;
  readonly lastConnectedAt: number | null;
  readonly observedPlatform: string | null;
  readonly lastFailure: RemoteSshFailureV1 | null;
}

export interface RemoteExplorerSessionV1 {
  readonly sessionId: string;
  readonly target: string;
  readonly platform: string;
  readonly homePath: string;
  readonly connectedAt: number;
}

export interface RemoteExplorerClosedEventV1 {
  readonly sessionId: string;
  readonly reason: 'idle' | 'connection-lost' | 'disconnected';
}

export type RemoteDirectoryEntryKindV1 = 'directory' | 'alignment' | 'index' | 'signal';

export interface RemoteDirectoryEntryV1 {
  readonly name: string;
  readonly path: string;
  readonly kind: RemoteDirectoryEntryKindV1;
}

export interface RemoteDirectoryListingV1 {
  readonly path: string;
  readonly parentPath: string | null;
  readonly entries: readonly RemoteDirectoryEntryV1[];
  readonly truncated: boolean;
}

export interface RemoteSshAuthPromptV1 {
  readonly promptId: string;
  readonly requestId: string;
  readonly text: string;
  readonly kind: 'host-trust' | 'secret';
}

export interface RemoteAlignmentConnectRequestV1 {
  readonly requestId?: string;
  readonly allowInteractive?: boolean;
  readonly explorerSessionId?: string;
  readonly endpointId?: string;
  readonly displayName?: string;
  readonly target: string;
  readonly alignmentPath: string;
  readonly indexPath?: string;
  readonly signalPath?: string;
  readonly tileServerReceiptPath?: string;
}

export interface RemoteSignalConnectRequestV1 {
  readonly requestId?: string;
  readonly allowInteractive?: boolean;
  readonly explorerSessionId?: string;
  readonly endpointId?: string;
  readonly displayName?: string;
  readonly target: string;
  readonly signalPath: string;
}

export interface RemoteSignalLocatorV1 {
  readonly contract: typeof REMOTE_SIGNAL_LOCATOR_V1;
  readonly endpointId: string;
  readonly target: string;
  readonly signalPath: string;
}

export interface RemoteAlignmentLocatorV1 {
  readonly contract: typeof REMOTE_ALIGNMENT_LOCATOR_V1;
  readonly endpointId: string;
  readonly target: string;
  readonly alignmentPath: string;
  readonly indexPath: string;
  readonly signalPath?: string;
  readonly tileServerReceiptPath?: string;
}

export interface RemoteFileReceiptV1 {
  readonly canonicalPath: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly device: string | null;
  readonly inode: string | null;
}

export interface RemoteAlignmentMaterializationV1 {
  readonly protocol: typeof REMOTE_RANGE_PROTOCOL_V1;
  readonly sessionId: string;
  readonly endpoint: RemoteEndpointProfileV1;
  readonly locator: RemoteAlignmentLocatorV1;
  readonly runtimeStatus?: RemoteGenomicsRuntimeStatusV1;
  readonly bamUrl: string;
  readonly tileBaseUrl?: string;
  readonly indexPath: string;
  readonly bigWigUrl?: string;
  readonly generation: {
    readonly alignment: RemoteFileReceiptV1;
    readonly index: RemoteFileReceiptV1;
    readonly signal?: RemoteFileReceiptV1;
    readonly reference?: RemoteFileReceiptV1;
    readonly referenceIndex?: RemoteFileReceiptV1;
  };
}

export interface RemoteSignalMaterializationV1 {
  readonly protocol: typeof REMOTE_RANGE_PROTOCOL_V1;
  readonly sessionId: string;
  readonly endpoint: RemoteEndpointProfileV1;
  readonly locator: RemoteSignalLocatorV1;
  readonly runtimeStatus?: RemoteGenomicsRuntimeStatusV1;
  readonly bigWigUrl: string;
  readonly generation: { readonly signal: RemoteFileReceiptV1 };
}
