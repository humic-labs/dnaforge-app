export type RequestedQosClass =
  | 'userInteractive'
  | 'userInitiated'
  | 'default'
  | 'utility'
  | 'background'
  | 'unspecified';

export type ThreadSchedulingMinimum = 'userInteractive' | 'userInitiated';

export interface ThreadSchedulingObservation {
  readonly status: 'observed' | 'requested' | 'unsupported' | 'unavailable';
  readonly platform: string;
  readonly pid: number;
  readonly nativeThreadId: string | null;
  readonly requestedQos: number | null;
  readonly requestedClass: RequestedQosClass | null;
  readonly minimumQos?: number;
  readonly minimumClass?: ThreadSchedulingMinimum;
  readonly previousRequestedQos?: number | null;
  readonly changed?: boolean;
  readonly reason?: string;
  readonly errorCode?: number;
}
