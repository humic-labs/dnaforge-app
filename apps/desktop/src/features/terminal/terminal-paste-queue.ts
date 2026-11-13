export function queueTerminalPaste(
  previous: Promise<void>,
  capture: Promise<string>,
  commit: (token: string) => Promise<void>
): Promise<void> {
  const staged = capture.then(
    (token) => ({ token }),
    (error: unknown) => ({ error })
  );
  return previous.then(async () => {
    const result = await staged;
    if ('error' in result) throw result.error;
    await commit(result.token);
  });
}
