import type { Assembly } from '@waypoint/genome-renderer';

import type {
  AuthenticatedCoverageCorridorFloorPayload,
  CoverageCorridorFloorSource,
  PreparedCoverageCorridorFloor,
} from './coverage-corridor-floor';

export interface CoverageCorridorFloorWorkerInput {
  readonly baseUrl: string;
  readonly source: CoverageCorridorFloorSource;
  readonly assembly: Assembly;
}

export type CoverageCorridorFloorWorkerRequest =
  | {
      readonly id: number;
      readonly type: 'prepare';
      readonly input: CoverageCorridorFloorWorkerInput;
      readonly payload: AuthenticatedCoverageCorridorFloorPayload;
    }
  | {
      readonly id: number;
      readonly type: 'cancel';
      readonly targetId: number;
    };

export type CoverageCorridorFloorWorkerResponse =
  | {
      readonly id: number;
      readonly type: 'result';
      readonly result: PreparedCoverageCorridorFloor | null;
    }
  | {
      readonly id: number;
      readonly type: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };

export interface CoverageCorridorFloorWorkerLike {
  postMessage(message: CoverageCorridorFloorWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void
  ): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void
  ): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate?(): void;
}
