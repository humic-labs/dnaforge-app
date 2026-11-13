import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline';

export type PdfLoadTask = PDFDocumentLoadingTask & {
  readonly result: PDFDocumentLoadingTask['promise'];
  readonly workerFailure: Promise<unknown>;
};

export function beginPdfLoad(bytes: Uint8Array): PdfLoadTask {
  const worker = new PdfWorker();
  let sdkWorker: PDFWorker | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  let rawRetired = false;
  let sdkRetired = false;
  let listenersRetired = false;
  let failed = false;
  let primaryFailure: unknown;
  let resolveFailure!: (primary: unknown) => void;
  const workerFailure = new Promise<unknown>((resolve) => {
    resolveFailure = resolve;
  });
  const failureRejection = workerFailure.then((primary) => {
    throw primary;
  });
  void failureRejection.catch(() => {});
  const retire = () => {
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
      }
    };
    if (!listenersRetired) {
      listenersRetired = true;
      attempt(() => worker.removeEventListener('error', onFailure));
      attempt(() => worker.removeEventListener('messageerror', onFailure));
    }
    if (sdkWorker && !sdkRetired) {
      sdkRetired = true;
      attempt(() => sdkWorker!.destroy());
    }
    if (!rawRetired) {
      rawRetired = true;
      attempt(() => worker.terminate());
      attempt(() => {
        if (GlobalWorkerOptions.workerPort === worker) GlobalWorkerOptions.workerPort = null;
      });
    }
    if (cleanupFailed) throw cleanupFailure;
  };
  const retireAfterFailure = (primary: unknown): never => {
    try {
      retire();
    } catch {}
    throw primary;
  };
  function onFailure(event: Event): void {
    if (failed || rawRetired || listenersRetired) return;
    if (event.cancelable) event.preventDefault();
    failed = true;
    primaryFailure = 'error' in event && event.error != null ? event.error : event;
    resolveFailure(primaryFailure);
    try {
      retire();
    } catch {}
    if (task) void task.destroy().catch(() => {});
  }

  try {
    worker.addEventListener('error', onFailure);
    if (failed) throw primaryFailure;
    worker.addEventListener('messageerror', onFailure);
    if (failed) throw primaryFailure;
    GlobalWorkerOptions.workerPort = worker;
    if (failed) throw primaryFailure;
    sdkWorker = PDFWorker.create({ port: worker });
    if (failed) throw primaryFailure;
    task = getDocument({ data: bytes, worker: sdkWorker });
    const destroy = task.destroy.bind(task);
    let destroying: Promise<void> | undefined;
    task.destroy = () => {
      if (destroying) return destroying;
      let resolve!: () => void;
      let reject!: (primary: unknown) => void;
      destroying = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const close = async () => {
        try {
          await Promise.race([destroy(), failureRejection]);
          if (failed) throw primaryFailure;
        } catch (primary) {
          return retireAfterFailure(failed ? primaryFailure : primary);
        }
        retire();
      };
      void close().then(resolve, reject);
      return destroying;
    };
    const owned = Object.assign(task, {
      result: Promise.race([task.promise, failureRejection]).then(
        (document) => {
          if (failed) throw primaryFailure;
          return document;
        },
        (primary) => {
          throw failed ? primaryFailure : primary;
        }
      ),
      workerFailure,
    });
    if (failed) void owned.destroy().catch(() => {});
    return owned;
  } catch (primary) {
    return retireAfterFailure(failed ? primaryFailure : primary);
  }
}
