import { budgetLevel, type BudgetLevel, type MemoryPressureLevel } from './pressure-level';

export type RetentionBudgets = Readonly<Record<BudgetLevel, number>>;

export interface RetentionPoolOptions {
  id: string;
  budgets: RetentionBudgets;
}

export interface RetentionPoolSnapshot {
  id: string;
  budgets: RetentionBudgets;
  recency: string[];
}

export class RetentionPool {
  readonly id: string;
  readonly budgets: RetentionBudgets;
  private readonly recency: string[] = [];

  constructor(options: RetentionPoolOptions) {
    for (const [level, budget] of Object.entries(options.budgets)) {
      if (!Number.isInteger(budget) || budget < 1) {
        throw new Error(`${options.id}: ${level} budget must be a positive integer, got ${budget}`);
      }
    }
    if (
      options.budgets.moderate > options.budgets.normal ||
      options.budgets.critical > options.budgets.moderate
    ) {
      throw new Error(`${options.id}: budgets must not grow with pressure`);
    }
    this.id = options.id;
    this.budgets = options.budgets;
  }

  touch(key: string): void {
    const index = this.recency.indexOf(key);
    if (index === 0) return;
    if (index > 0) this.recency.splice(index, 1);
    this.recency.unshift(key);
  }

  forget(key: string): void {
    const index = this.recency.indexOf(key);
    if (index >= 0) this.recency.splice(index, 1);
  }

  prune(live: ReadonlySet<string>): void {
    for (let i = this.recency.length - 1; i >= 0; i -= 1) {
      if (!live.has(this.recency[i])) this.recency.splice(i, 1);
    }
  }

  budget(level: MemoryPressureLevel): number {
    return this.budgets[budgetLevel(level)];
  }

  retain(level: MemoryPressureLevel, pinned: ReadonlySet<string>): Set<string> {
    const retained = new Set(pinned);
    const budget = this.budget(level);
    for (const key of this.recency) {
      if (retained.size >= budget) break;
      retained.add(key);
    }
    this.prune(retained);
    return retained;
  }

  clear(): void {
    this.recency.length = 0;
  }

  snapshot(): RetentionPoolSnapshot {
    return { id: this.id, budgets: this.budgets, recency: [...this.recency] };
  }
}
