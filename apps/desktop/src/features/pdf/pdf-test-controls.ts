export type PdfTestPhase = 'bytes' | 'document' | 'page' | 'canvas' | 'text';
const gates = new Map<PdfTestPhase, { promise: Promise<void>; release(): void; entered: number }>();
const failures = new Set<PdfTestPhase>();
export function holdPdfPhase(phase: PdfTestPhase): void {
  releasePdfPhase(phase);
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.set(phase, { promise, release, entered: 0 });
}
export function releasePdfPhase(phase: PdfTestPhase): void {
  gates.get(phase)?.release();
  gates.delete(phase);
}
export function failPdfPhaseOnce(phase: PdfTestPhase): void {
  failures.add(phase);
}
export function pdfPhaseEntered(phase: PdfTestPhase): number {
  return gates.get(phase)?.entered ?? 0;
}
export async function waitPdfPhase(phase: PdfTestPhase): Promise<void> {
  const gate = gates.get(phase);
  if (gate && gate.entered === 0) {
    gate.entered = 1;
    await gate.promise;
  }
  if (failures.delete(phase)) throw new Error('Controlled PDF phase failure');
}

export function resetPdfTestControls(): void {
  for (const phase of gates.keys()) releasePdfPhase(phase);
  failures.clear();
}
