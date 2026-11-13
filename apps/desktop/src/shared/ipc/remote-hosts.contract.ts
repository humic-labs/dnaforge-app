import type { RemoteHostAccessV1, RemoteHostV1 } from '../remote-host-records';
import { defineGroup, invoke } from './contract';

export const remoteHostsContract = defineGroup('remoteHosts', {
  list: invoke<[], RemoteHostV1[]>(),
  save: invoke<[input: { readonly target: string; readonly displayName: string }], RemoteHostV1>(),
  rename: invoke<[endpointId: string, displayName: string], RemoteHostV1 | null>(),
  forget: invoke<[endpointId: string], boolean>(),
  signIn: invoke<[target: string], RemoteHostAccessV1>(),
  checkAccess: invoke<[target: string], RemoteHostAccessV1>(),
  openTerminal: invoke<[target: string], void>(),
  endConnection: invoke<[target: string], RemoteHostAccessV1>(),
});
