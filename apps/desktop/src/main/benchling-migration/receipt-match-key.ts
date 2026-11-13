import type { ExportJob } from '../../shared/benchling-migration';

export function observableReceiptMatchKey(job: Pick<ExportJob, 'contentFamily'>): string {
  return ['attachment', 'generic'].includes(job.contentFamily) ? 'all_items' : job.contentFamily;
}
