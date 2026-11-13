import type Database from 'better-sqlite3';
import { handleGroup } from '../../shared/ipc-contract';
import { remoteHostsContract } from '../../shared/ipc/remote-hosts.contract';
import type { RemoteHostV1 } from '../../shared/remote-hosts';
import { getDb } from '../ipc/database';
import {
  findRemoteEndpointProfileByTarget,
  forgetRemoteEndpointProfile,
  listRemoteEndpointProfiles,
  recordRemoteEndpointSuccess,
  renameRemoteEndpointProfile,
  saveRemoteEndpointProfile,
} from '../remote-endpoint-registry';
import { remoteHostService } from '../remote-host-service';
import { RemoteGenomicsError } from '../remote-genomics-supervisor';
import type { MainFeature } from './main-feature';

export function registerRemoteHostsIpc(
  database: () => Database.Database = getDb,
  service: Pick<
    typeof remoteHostService,
    'status' | 'signIn' | 'checkAccess' | 'openTerminal' | 'endConnection'
  > = remoteHostService
): () => void {
  const describeHost = (profile: RemoteHostV1['profile']): RemoteHostV1 => ({
    profile,
    access: service.status(profile.target),
  });
  const savedHost = (target: string): RemoteHostV1['profile'] => {
    const profile = findRemoteEndpointProfileByTarget(database(), target);
    if (!profile)
      throw new RemoteGenomicsError(
        'invalid-request',
        'Save this host in Remote hosts before signing in.'
      );
    return profile;
  };
  return handleGroup(remoteHostsContract, {
    list: () => listRemoteEndpointProfiles(database()).map(describeHost),
    save: (_event, input) => describeHost(saveRemoteEndpointProfile(database(), input)),
    rename: (_event, endpointId, displayName) => {
      const profile = renameRemoteEndpointProfile(database(), endpointId, displayName);
      return profile ? describeHost(profile) : null;
    },
    forget: (_event, endpointId) => forgetRemoteEndpointProfile(database(), endpointId),
    signIn: async (_event, target) => service.signIn(savedHost(target).target),
    checkAccess: async (_event, target) => {
      const profile = savedHost(target);
      const access = await service.checkAccess(profile.target);
      if (access.state === 'verified')
        recordRemoteEndpointSuccess(database(), {
          ...profile,
          lastConnectedAt: access.checkedAt,
          lastFailure: null,
        });
      return access;
    },
    openTerminal: async (_event, target) => {
      await service.openTerminal(savedHost(target).target);
    },
    endConnection: async (_event, target) => service.endConnection(savedHost(target).target),
  });
}

export const remoteHostsFeature: MainFeature = {
  id: 'remote-hosts',
  registerIpc: () => registerRemoteHostsIpc(),
  shutdown: {
    name: 'remote host service',
    run: async () => {
      await remoteHostService.stopAll();
    },
  },
};
