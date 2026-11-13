import type { StructureRenderTransaction } from './structureRenderTransaction';

export interface StructureRenderTransactionDiagnostic {
  key: string;
  structureKey: string;
  viewerReady: boolean;
  isConnected: boolean;
  transaction: StructureRenderTransaction;
  molstarPlan?: unknown;
}

const diagnosticsByViewerCacheKey = new Map<string, StructureRenderTransactionDiagnostic>();

export function recordStructureRenderTransactionDiagnostic(
  diagnostic: StructureRenderTransactionDiagnostic
): void {
  diagnosticsByViewerCacheKey.set(diagnostic.key, diagnostic);
}

export function removeStructureRenderTransactionDiagnostic(key: string): void {
  diagnosticsByViewerCacheKey.delete(key);
}

export function clearStructureRenderTransactionDiagnostics(): void {
  diagnosticsByViewerCacheKey.clear();
}

export function getStructureRenderTransactionDiagnostics(
  keyIncludes?: string
): StructureRenderTransactionDiagnostic[] {
  const diagnostics = Array.from(diagnosticsByViewerCacheKey.values());
  if (!keyIncludes) return diagnostics;
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.key.includes(keyIncludes) || diagnostic.structureKey.includes(keyIncludes)
  );
}

export function getStructureRenderTransactionDiagnostic(
  viewerCacheKey: string
): StructureRenderTransactionDiagnostic | null {
  return diagnosticsByViewerCacheKey.get(viewerCacheKey) ?? null;
}
