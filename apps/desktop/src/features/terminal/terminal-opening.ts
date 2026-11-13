export interface TerminalOpenRequest {
  mode: 'tab' | 'subtab' | 'split';
  parentSessionId?: string;
  cwd?: string;
}

export interface TerminalOpenResult {
  sessionId: string;
  groupId: string;
  viewId: string;
  tabId: string | null;
  title: string;
  cwd: string;
}

export class TerminalOpeningError extends Error {
  readonly stateChanged: boolean | 'unknown';
  readonly sessionId?: string;
  readonly retriable: boolean;
  constructor(
    readonly code: string,
    message: string,
    options: { stateChanged?: boolean | 'unknown'; sessionId?: string; retriable?: boolean } = {}
  ) {
    super(message);
    this.stateChanged = options.stateChanged ?? false;
    this.sessionId = options.sessionId;
    this.retriable = options.retriable ?? false;
  }
}

type Opener = (request: TerminalOpenRequest) => Promise<TerminalOpenResult>;
let opener: Opener | undefined;

export function registerTerminalViewOpener(handler: Opener): () => void {
  opener = handler;
  return () => {
    if (opener === handler) opener = undefined;
  };
}

export async function openTerminalView(request: TerminalOpenRequest): Promise<TerminalOpenResult> {
  if (!opener)
    throw new TerminalOpeningError(
      'TERMINAL_UNAVAILABLE',
      'The terminal controller is not ready.',
      {
        retriable: true,
      }
    );
  return opener(request);
}
