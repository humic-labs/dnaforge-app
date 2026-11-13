import { platform } from '../../platform';
import {
  BUILT_IN_AGENT_PERMISSION_CATALOG,
  type AgentPermissionCatalog,
} from '../../shared/agent-permissions';

let request: Promise<AgentPermissionCatalog> | null = null;

export function readPermissionCatalog(): Promise<AgentPermissionCatalog> {
  request ??= Promise.resolve()
    .then(() => platform().agentSession.permissionCatalog())
    .catch(() => BUILT_IN_AGENT_PERMISSION_CATALOG);
  return request;
}
