import { randomUUID } from 'node:crypto';
import type { ShellReadinessSnapshot } from '../shared/shell-readiness';

export class ShellReadiness {
  private state: ShellReadinessSnapshot = { loadId: '', pageLoaded: false, shellReady: false };
  private acknowledged = false;

  constructor(private readonly onReady: (loadId: string) => void) {}

  beginLoad(): ShellReadinessSnapshot {
    this.state = { loadId: randomUUID(), pageLoaded: false, shellReady: false };
    this.acknowledged = false;
    return this.snapshot();
  }

  snapshot(): ShellReadinessSnapshot {
    return { ...this.state };
  }

  pageLoaded(): void {
    this.state.pageLoaded = true;
    this.publishReady();
  }

  acknowledge(loadId: unknown): boolean {
    if (!this.state.loadId || loadId !== this.state.loadId) return false;
    this.acknowledged = true;
    this.publishReady();
    return true;
  }

  private publishReady(): void {
    if (!this.acknowledged || !this.state.pageLoaded || this.state.shellReady) return;
    this.state.shellReady = true;
    this.onReady(this.state.loadId);
  }
}
