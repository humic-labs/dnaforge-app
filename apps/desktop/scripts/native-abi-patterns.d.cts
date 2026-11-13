export const ABI_SIGNATURES: readonly string[];
export const ARCH_SIGNATURES: readonly string[];
export const LOAD_SIGNATURES: readonly string[];
export function matchesAny(message: unknown, signatures: readonly string[]): boolean;
export function isAbiError(message: unknown): boolean;
export function isArchError(message: unknown): boolean;
export function isLoadError(message: unknown): boolean;
