import type { AppServerSupervisor, IncomingServerRequest } from './app-server-supervisor';
import type { ChildNotification, IncomingToolRequest, TurnDriver } from './turn-loop';

export type SandboxPolicy =
  | { readonly type: 'readOnly'; readonly networkAccess?: boolean }
  | {
      readonly type: 'workspaceWrite';
      readonly networkAccess?: boolean;
      readonly writableRoots?: readonly string[];
      readonly excludeSlashTmp?: boolean;
      readonly excludeTmpdirEnvVar?: boolean;
    }
  | { readonly type: 'externalSandbox'; readonly networkAccess?: string }
  | { readonly type: 'dangerFullAccess' };

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  type: 'workspaceWrite',
  networkAccess: false,
};
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'on-request';

export interface SupervisorDriverOptions {
  readonly supervisor: AppServerSupervisor;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly model?: string;
}

export interface SupervisorDriver extends TurnDriver {
  readonly threadId: string | null;
  readonly turnId: string | null;
}

export function createSupervisorDriver(options: SupervisorDriverOptions): SupervisorDriver {
  const { supervisor } = options;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let notify: ((notification: ChildNotification) => void) | null = null;
  let ask: ((request: IncomingToolRequest) => void) | null = null;
  let exited: (() => void) | null = null;

  supervisor.setNotificationListener((notification) => {
    if (notification.method === 'turn/started') {
      const params = notification.params as { turn?: { id?: unknown } } | null;
      const id = params?.turn?.id;
      if (typeof id === 'string' && id.length > 0) {
        turnId = id;
      }
    }
    notify?.(notification);
  });
  supervisor.onExit(() => exited?.());

  return {
    get threadId() {
      return threadId;
    },

    get turnId() {
      return turnId;
    },

    send: async (message) => {
      if (threadId === null) {
        const started = (await supervisor.request('thread/start', {})) as {
          thread?: { id?: unknown };
        };
        const id = started.thread?.id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('the App Server started a thread without an id');
        }
        threadId = id;
      }
      await supervisor.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: message }],
        sandboxPolicy: options.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
        approvalPolicy: options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        ...(options.model === undefined ? {} : { model: options.model }),
      });
    },

    onNotification: (listener) => {
      notify = listener;
    },

    onExit: (listener) => {
      exited = listener;
    },

    onServerRequest: (listener) => {
      ask = listener;
      supervisor.setServerRequestHandler((request: IncomingServerRequest) => {
        const handler = ask;
        if (!handler) {
          request.refuse('the turn is not accepting tool calls');
          return;
        }
        handler({
          method: request.method,
          params: request.params,
          respond: request.respond,
          refuse: request.refuse,
        });
      });
    },
  };
}
