import type { ClientOf } from './ipc/contract';
import type { remoteHostsContract } from './ipc/remote-hosts.contract';

export type { RemoteHostAccessV1, RemoteHostV1 } from './remote-host-records';

export interface RemoteHostsPort extends ClientOf<typeof remoteHostsContract> {}

export const OPEN_REMOTE_HOSTS_EVENT = 'dnaforge:open-remote-hosts';
