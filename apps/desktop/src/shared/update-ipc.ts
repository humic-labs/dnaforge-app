export interface UpdateEventPayloadMap {
  'update:available': { version: string; isManual: boolean };
  'update:downloaded': { version: string; restartRequired?: boolean };
  'update:error': {
    message: string;
    stage: 'check' | 'download' | 'install';
    operation?: 'native-preparation';
    isManual: boolean;
    reason?: 'authentication' | 'network' | 'no-manifest' | 'permission' | 'unknown';
  };
  'update:no-update': { version: string; isDevMode?: boolean };
  'update:progress': { percent: number; bytesPerSecond: number };
}

export type UpdateInstallResult =
  | { status: 'started' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; readyVersion?: string | null };

export type UpdateEventChannel = keyof UpdateEventPayloadMap;
export type UpdateEventPayload<C extends UpdateEventChannel> = UpdateEventPayloadMap[C];
export type UpdateSimulationArguments = {
  [C in UpdateEventChannel]: [channel: C, payload: UpdateEventPayload<C>];
}[UpdateEventChannel];
