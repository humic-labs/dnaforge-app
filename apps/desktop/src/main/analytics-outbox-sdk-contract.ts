export interface MainAnalyticsSdkCapture {
  distinctId?: string;
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: Date;
  uuid?: string;
}

export interface MainAnalyticsSdkClient {
  capture(input: MainAnalyticsSdkCapture): void;
  flush(): Promise<void>;
  on(event: 'capture' | 'flush' | 'error', listener: (value: unknown) => void): () => void;
}
