import type { RemoteEndpointProfileV1, RemoteSshFailureV1 } from './remote-genomics-ipc';

export interface RemoteHostAccessV1 {
  readonly target: string;
  readonly state:
    | 'not-checked'
    | 'signing-in'
    | 'verified'
    | 'needs-authentication'
    | 'unavailable';
  readonly checkedAt: number | null;
  readonly connection: 'none' | 'dnaforge' | 'external';
  readonly activeConsumers: number;
  readonly lastFailure: RemoteSshFailureV1 | null;
}

export interface RemoteHostV1 {
  readonly profile: RemoteEndpointProfileV1;
  readonly access: RemoteHostAccessV1;
}
