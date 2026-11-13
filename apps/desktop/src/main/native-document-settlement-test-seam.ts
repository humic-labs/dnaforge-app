export const nativeDocumentSettlementTestSeam = {
  pause: null as {
    actionId: string | null;
    wait: Promise<void>;
    release(): void;
  } | null,
  failure: null as 'before-send' | 'after-response' | null,
  attempts: 0,
};
