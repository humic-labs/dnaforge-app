export function formatPosition(
  start: number,
  end: number,
  direction: number
): { origin: string; delta: string | null } {
  const length = Math.abs(end - start) + 1;
  if (direction === 1) {
    return { origin: start.toLocaleString(), delta: `+ ${length.toLocaleString()}` };
  }
  if (direction === -1) {
    const hi = Math.max(start, end);
    return { origin: hi.toLocaleString(), delta: `- ${length.toLocaleString()}` };
  }
  const lo = Math.min(start, end);
  return { origin: lo.toLocaleString(), delta: null };
}
