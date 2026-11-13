import { expect } from 'vitest';

export function runCatches(block: () => void): boolean {
  try {
    block();
    return false;
  } catch {
    return true;
  }
}

export async function runCatchesAsync(block: () => Promise<void>): Promise<boolean> {
  try {
    await block();
    return false;
  } catch {
    return true;
  }
}

export async function assertMutantKilledAsync(
  label: string,
  block: () => Promise<void>
): Promise<void> {
  const killed = await runCatchesAsync(block);
  expect(killed, `mutant [${label}] survived the spec block (UNENFORCED property)`).toBe(true);
}

export async function assertCorrectImplPassesAsync(
  label: string,
  block: () => Promise<void>
): Promise<void> {
  const killed = await runCatchesAsync(block);
  expect(killed, `correct impl unexpectedly failed the spec block [${label}]`).toBe(false);
}

export function assertMutantKilled(label: string, block: () => void): void {
  const killed = runCatches(block);
  expect(killed, `mutant [${label}] survived the spec block (UNENFORCED property)`).toBe(true);
}

export function assertCorrectImplPasses(label: string, block: () => void): void {
  const killed = runCatches(block);
  expect(killed, `correct impl unexpectedly failed the spec block [${label}]`).toBe(false);
}
