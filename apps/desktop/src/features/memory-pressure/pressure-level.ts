import type { MemoryPressureLevel } from '../../shared/memory-pressure';

export type { MemoryPressureLevel };

export type BudgetLevel = Exclude<MemoryPressureLevel, 'unknown'>;

export function budgetLevel(level: MemoryPressureLevel): BudgetLevel {
  return level === 'unknown' ? 'normal' : level;
}
