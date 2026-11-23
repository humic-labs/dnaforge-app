export function isProviderContextError(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    /context_length_exceeded|context window exceeded|exceeds? (?:the |your |this model.s )?(?:maximum )?context (?:window|length)|ran out of room in the model.s context window|prompt is too long/i.test(
      message
    )
  );
}
