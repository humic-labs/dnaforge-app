export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? (cb: () => void) => {
            requestAnimationFrame(() => {
              setTimeout(cb, 0);
            });
          }
        : (cb: () => void) => {
            setTimeout(cb, 0);
          };
    schedule(() => resolve());
  });
}
