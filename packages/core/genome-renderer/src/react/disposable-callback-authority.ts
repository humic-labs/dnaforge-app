export interface DisposableCallbackAuthority<Args extends unknown[]> {
  readonly callback: (...args: Args) => void;
  dispose: () => void;
}

export function createDisposableCallbackAuthority<Args extends unknown[]>(
  handler: (...args: Args) => void
): DisposableCallbackAuthority<Args> {
  let activeHandler: ((...args: Args) => void) | null = handler;

  return {
    callback: (...args: Args): void => {
      activeHandler?.(...args);
    },
    dispose: (): void => {
      activeHandler = null;
    },
  };
}
