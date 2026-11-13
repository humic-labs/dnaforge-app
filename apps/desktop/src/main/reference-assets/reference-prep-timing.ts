export function referencePreparationTiming(scope: string): (label: string) => void {
  if (!process.env.DNAFORGE_REFERENCE_PREP_TIMINGS) return () => {};
  const started = performance.now();
  let previous = started;
  return (label) => {
    const now = performance.now();
    console.log(
      `[reference-prep-timing] +${Math.round(now - previous)}ms total=${Math.round(now - started)}ms ${scope}: ${label}`
    );
    previous = now;
  };
}
