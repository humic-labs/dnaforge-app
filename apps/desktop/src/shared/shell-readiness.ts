import type { ClientOf } from './ipc/contract';
import type { startupContract } from './ipc/startup.contract';

export type { ShellReadinessSnapshot } from './ipc/startup.contract';

export type ShellReadinessBridge = ClientOf<typeof startupContract>;
