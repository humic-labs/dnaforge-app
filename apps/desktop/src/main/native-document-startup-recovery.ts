import type { NativeAnnotationDocumentOwner } from './native-annotation-document-owner';
import { nativeDocumentOwnerProfile } from './native-document-owner-identity';

export interface NativeDocumentRecoveryReport {
  observed: number;
  unresolved: number;
  skipped: number;
  failed: number;
  complete: boolean;
  reason?: string;
}

interface StartupRecoveryOptions {
  owner: Pick<NativeAnnotationDocumentOwner, 'pending' | 'recover'>;
  nativeOwnerInstanceId: string;
  profileKey: string;
  ready(): Promise<() => boolean>;
  report(result: NativeDocumentRecoveryReport): void;
}

export class NativeDocumentStartupRecovery {
  private version = 0;
  private closed = false;
  private task: Promise<void> = Promise.resolve();
  private stopWaitingForReady: () => void = () => {};
  private readonly closing = new Promise<() => boolean>((resolve) => {
    this.stopWaitingForReady = () => resolve(() => false);
  });

  constructor(private readonly options: StartupRecoveryOptions) {}

  request(): Promise<void> {
    if (this.closed) return this.task;
    const version = ++this.version;
    const current = () => !this.closed && version === this.version;
    this.task = this.task.then(async () => {
      if (!current()) return;
      const result: NativeDocumentRecoveryReport = {
        observed: 0,
        unresolved: 0,
        skipped: 0,
        failed: 0,
        complete: false,
      };
      const { owner, nativeOwnerInstanceId, profileKey } = this.options;
      if (nativeDocumentOwnerProfile(nativeOwnerInstanceId) !== profileKey) {
        this.options.report({
          ...result,
          reason: 'This native owner has no matching profile binding.',
        });
        return;
      }
      try {
        const serviceCurrent = await Promise.race([this.options.ready(), this.closing]);
        let cursor: string | undefined;
        for (let pageCount = 0; pageCount < 32 && current() && serviceCurrent(); pageCount++) {
          const page = await owner.pending(cursor);
          if (!current() || !serviceCurrent()) break;
          for (const action of page.actions) {
            if (!current() || !serviceCurrent()) break;
            const previousOwner = action.details_json.native_owner_instance_id;
            if (
              previousOwner === nativeOwnerInstanceId ||
              nativeDocumentOwnerProfile(previousOwner) !== profileKey ||
              action.operation_kind !== 'annotation'
            ) {
              result.skipped++;
              continue;
            }
            try {
              const observed = await owner.recover(action);
              result.observed++;
              if (observed.settlement.status === 'outcome-unresolved') result.unresolved++;
            } catch {
              result.failed++;
            }
          }
          if (!current() || !serviceCurrent()) break;
          if (page.next_action_id === null) {
            result.complete = true;
            break;
          }
          cursor = page.next_action_id;
        }
      } catch (error) {
        result.failed++;
        result.reason =
          error instanceof Error ? error.message.slice(0, 512) : 'Recovery discovery failed.';
      }
      this.options.report(result);
    });
    return this.task;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.version++;
    this.stopWaitingForReady();
    await this.task;
  }
}
