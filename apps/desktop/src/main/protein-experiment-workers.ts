import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { createUserDialogs } from './user-dialogs';
import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  dialog,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { handleGroup, sendRendererIpc } from '../shared/ipc-contract';
import type {
  ProteinExperimentBindRequest,
  ProteinExperimentPrepareRequest,
  ProteinExperimentReleaseRequest,
  ProteinExperimentWorkerLease,
  ProteinExperimentWorkerRequest,
  ProteinExperimentWorkerResponse,
  ReviewRoundRequest,
} from '../shared/protein-experiment-workers';
import { MAX_PROTEIN_EXPERIMENT_FIXTURES } from '../shared/protein-experiment-workers';
import { isTrustedRendererUrl } from './security';
import { proteinExperimentWorkersContract } from '../shared/ipc/protein-experiment-workers.contract';

interface Worker {
  id: string;
  window: BrowserWindow;
  contents: WebContents;
  jobs: Set<string>;
  workspaceFingerprint: string;
  ready: Promise<void>;
  markReady(): void;
  rejectReady(error: Error): void;
  closed: boolean;
}

interface Job {
  worker: Worker;
  ready: boolean;
  turnIds: Set<string>;
  purpose: 'fresh-author' | 'saved-view-replay';
  binding: boolean;
}

interface PendingRequest {
  worker: Worker;
  finish(error?: Error): void;
}

class WorkerPreparationError extends Error {}

export interface ProteinExperimentWorkerPoolOptions {
  rootWindow: BrowserWindow;
  rendererUrl: string;
  preloadPath: string;
  preloadArguments: string[];
  maxWorkers?: number;
  jobsPerWorker?: number;
  timeoutMs?: number;
  requireAgentToolsReady?: () => void;
  admission?: {
    check(request: ReviewRoundRequest): void;
    claim(request: ReviewRoundRequest, slot: string, jobId: string): void;
    approveAfterHumanConfirmation?(request: ReviewRoundRequest): void;
  };
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  onWorkerCreated?: (contents: WebContents) => void;
  onWorkerDestroyed?: (contents: WebContents) => void;
}

export class ProteinExperimentWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly jobs = new Map<string, Job>();
  private readonly routes = new Map<string, Job | null>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly root: WebContents;
  private closed = false;
  private rootLoading = false;
  private readonly rootLost = () => this.close();
  private readonly rootLoaded = () => {
    this.rootLoading = false;
  };
  private readonly rootNavigated = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame || inPlace) return;
    this.rootLoading = true;
    this.closeWorkers();
  };

  constructor(private readonly options: ProteinExperimentWorkerPoolOptions) {
    this.root = options.rootWindow.webContents;
    this.root.on('destroyed', this.rootLost);
    this.root.on('render-process-gone', this.rootLost);
    this.root.on('did-start-navigation', this.rootNavigated);
    this.root.on('did-finish-load', this.rootLoaded);
  }

  async prepare(
    event: IpcMainInvokeEvent,
    request: ProteinExperimentPrepareRequest
  ): Promise<ProteinExperimentWorkerLease> {
    this.requireRoot(event);
    validatePrepareRequest(request);
    if (request.purpose !== 'saved-view-replay') {
      if (!request.admission || !this.options.admission)
        throw new Error('HUMAN_REVIEW_REQUIRED: Fresh authors require explicit round admission.');
      const { slot, ...admission } = request.admission;
      this.options.admission.claim(admission, slot, request.jobId);
    }
    this.options.requireAgentToolsReady?.();
    if (this.jobs.has(request.jobId)) throw new Error('This experiment job is already owned.');
    const worker = this.allocateWorker(JSON.stringify(request.workspace));
    const job: Job = {
      worker,
      ready: false,
      turnIds: new Set(),
      purpose: request.purpose ?? 'fresh-author',
      binding: false,
    };
    worker.jobs.add(request.jobId);
    this.jobs.set(request.jobId, job);
    try {
      await worker.ready;
      await this.request(worker, { requestId: randomUUID(), kind: 'prepare', request });
      if (worker.closed || this.closed) throw new Error('The experiment worker is unavailable.');
      job.ready = true;
      return {
        jobId: request.jobId,
        workerId: worker.id,
        rendererProcessId: worker.contents.getOSProcessId?.(),
        ownerRendererProcessId: this.root.getOSProcessId?.(),
      };
    } catch (error) {
      this.removeJob(request.jobId, job);
      if (!(error instanceof WorkerPreparationError)) {
        this.loseWorker(worker);
        if (!worker.window.isDestroyed()) worker.window.destroy();
      }
      throw error;
    }
  }

  async bind(event: IpcMainInvokeEvent, request: ProteinExperimentBindRequest): Promise<void> {
    this.requireRoot(event);
    this.options.requireAgentToolsReady?.();
    if (!request || !validId(request.turnId, false))
      throw new Error('Invalid private experiment turn ID.');
    const job = this.jobs.get(request.jobId);
    if (!job?.ready || job.worker.closed) throw new Error('The experiment job is not ready.');
    if (job.purpose !== 'fresh-author')
      throw new Error('Saved-view replay cannot dispatch a model.');
    if (job.binding || (job.turnIds.size && !job.turnIds.has(request.turnId)))
      throw new Error('Every authoring attempt requires a new clean experiment job.');
    if (this.routes.has(request.turnId) && this.routes.get(request.turnId) !== job)
      throw new Error('This private turn already belongs to another experiment job.');
    if (job.turnIds.has(request.turnId)) return;
    job.binding = true;
    try {
      await this.request(job.worker, {
        requestId: randomUUID(),
        kind: 'assert-fresh-start',
        jobId: request.jobId,
      });
      if (this.jobs.get(request.jobId) !== job || !job.ready || job.worker.closed)
        throw new Error('The fresh experiment ended before model dispatch.');
      this.routes.set(request.turnId, job);
      registeredPrivateTurns.add(request.turnId);
      job.turnIds.add(request.turnId);
    } finally {
      job.binding = false;
    }
  }

  checkAdmission(event: IpcMainInvokeEvent, request: ReviewRoundRequest): void {
    this.requireRoot(event);
    if (!this.options.admission)
      throw new Error('HUMAN_REVIEW_REQUIRED: Round admission authority is unavailable.');
    this.options.admission.check(request);
  }

  async requestApproval(event: IpcMainInvokeEvent, request: ReviewRoundRequest): Promise<void> {
    this.requireRoot(event);
    if (!this.options.admission?.approveAfterHumanConfirmation)
      throw new Error('HUMAN_REVIEW_REQUIRED: Human approval authority is unavailable.');
    if (request.mode !== 'full-round')
      throw new Error('Unscored experiments cannot issue full-round approval.');
    const response = await createUserDialogs(dialog).showMessageBox(this.options.rootWindow, {
      type: 'question',
      title: userMessage('dialog.review-before-the-next-round'),
      message: userMessage(
        'dialog.have-you-reviewed-the-current-round-and-authorized-this-next-run'
      ),
      detail: userMessageWithValues(
        'dialog.next-run-value-required-outputs-value-the-exact-source-instructions-an',
        { value0: userMessageValue(request.runId), value1: userMessageValue(request.slots.length) }
      ),
      buttons: [
        userMessage('dialog.keep-reviewing'),
        userMessage('dialog.i-reviewed-it-authorize-this-run'),
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    this.requireRoot(event);
    if (response.response !== 1) throw new Error('HUMAN_REVIEW_REQUIRED: No approval was given.');
    this.options.admission.approveAfterHumanConfirmation(request);
  }

  async release(
    event: IpcMainInvokeEvent,
    request: ProteinExperimentReleaseRequest
  ): Promise<void> {
    this.requireRoot(event);
    const job = this.jobs.get(request?.jobId);
    if (!job) return;
    if (job.worker.closed) {
      this.removeJob(request.jobId, job);
      return;
    }
    try {
      await this.request(job.worker, {
        requestId: randomUUID(),
        kind: 'release',
        jobId: request.jobId,
      });
      this.removeJob(request.jobId, job, true);
    } catch (error) {
      this.loseWorker(job.worker);
      if (!job.worker.window.isDestroyed()) job.worker.window.destroy();
      throw error;
    }
  }

  ready(event: IpcMainInvokeEvent): void {
    const worker = this.workerForEvent(event);
    if (!worker) throw new Error('Untrusted experiment worker ready sender.');
    worker.markReady();
  }

  respond(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
    response: ProteinExperimentWorkerResponse
  ): void {
    const pending = this.pending.get(response?.requestId);
    if (!pending) return;
    if (this.workerForEvent(event) !== pending.worker)
      throw new Error('Untrusted experiment worker response sender.');
    if (response.ok !== true && response.ok !== false)
      throw new Error('Invalid experiment worker response.');
    pending.finish(
      response.ok
        ? undefined
        : new WorkerPreparationError(String(response.error || 'The experiment worker failed.'))
    );
  }

  rendererForTurn(turnId?: string): WebContents | null | undefined {
    if (!turnId || !this.routes.has(turnId)) return undefined;
    const job = this.routes.get(turnId);
    if (!job || job.worker.closed || job.worker.window.isDestroyed()) return null;
    const contents = job.worker.contents;
    return contents.isDestroyed() ? null : contents;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.root.removeListener('destroyed', this.rootLost);
    this.root.removeListener('render-process-gone', this.rootLost);
    this.root.removeListener('did-start-navigation', this.rootNavigated);
    this.root.removeListener('did-finish-load', this.rootLoaded);
    this.closeWorkers();
  }

  private closeWorkers(): void {
    for (const worker of [...this.workers]) {
      this.loseWorker(worker);
      if (!worker.window.isDestroyed()) worker.window.destroy();
    }
  }

  private requireRoot(event: IpcMainInvokeEvent): void {
    if (
      this.closed ||
      this.rootLoading ||
      this.root.isDestroyed() ||
      event.sender !== this.root ||
      event.senderFrame !== this.root.mainFrame ||
      !event.senderFrame ||
      !isTrustedRendererUrl(event.senderFrame.url, this.options.rendererUrl)
    )
      throw new Error('Untrusted experiment root sender.');
  }

  private workerForEvent(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
  ): Worker | undefined {
    return [...this.workers].find((worker) => {
      const contents = worker.contents;
      return (
        !worker.closed &&
        !contents.isDestroyed() &&
        event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        !!event.senderFrame &&
        isTrustedRendererUrl(event.senderFrame.url, this.options.rendererUrl) &&
        new URL(event.senderFrame.url).searchParams.get('proteinExperimentWorker') === worker.id
      );
    });
  }

  private allocateWorker(workspaceFingerprint: string): Worker {
    const jobsPerWorker = this.options.jobsPerWorker ?? 4;
    const available = [...this.workers].find(
      (worker) =>
        !worker.closed &&
        worker.jobs.size < jobsPerWorker &&
        (worker.jobs.size === 0 || worker.workspaceFingerprint === workspaceFingerprint)
    );
    if (available) {
      available.workspaceFingerprint = workspaceFingerprint;
      return available;
    }
    if (this.workers.size >= (this.options.maxWorkers ?? 4))
      throw new Error('Experiment worker pool capacity is full.');
    const id = randomUUID();
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set('proteinExperimentWorker', id);
    const window = (this.options.createWindow ?? ((input) => new BrowserWindow(input)))({
      width: 1024,
      height: 768,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: this.options.preloadArguments,
      },
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const timer = setTimeout(() => {
      rejectReady(new Error('The experiment worker is unavailable: startup timed out.'));
    }, this.options.timeoutMs ?? 90_000);
    const worker: Worker = {
      id,
      window,
      contents: window.webContents,
      ready,
      jobs: new Set(),
      workspaceFingerprint,
      closed: false,
      markReady: () => {
        clearTimeout(timer);
        resolveReady();
      },
      rejectReady: (error) => {
        clearTimeout(timer);
        rejectReady(error);
      },
    };
    this.workers.add(worker);
    this.options.onWorkerCreated?.(window.webContents);
    window.webContents.once('destroyed', () => this.loseWorker(worker));
    window.webContents.once('render-process-gone', () => {
      this.loseWorker(worker);
      if (!window.isDestroyed()) window.destroy();
    });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && worker.jobs.size > 0 && this.jobsForWorkerReady(worker)) {
        this.loseWorker(worker);
        if (!window.isDestroyed()) window.destroy();
      }
    });
    void window
      .loadURL(url.toString())
      .catch((error) =>
        worker.rejectReady(error instanceof Error ? error : new Error(String(error)))
      );
    return worker;
  }

  private jobsForWorkerReady(worker: Worker): boolean {
    return [...worker.jobs].some((jobId) => this.jobs.get(jobId)?.ready);
  }

  private request(worker: Worker, payload: ProteinExperimentWorkerRequest): Promise<void> {
    if (worker.closed) return Promise.reject(new Error('The experiment worker is unavailable.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('The experiment worker is unavailable: request timed out.')),
        this.options.timeoutMs ?? 90_000
      );
      const finish = (error?: Error) => {
        if (!this.pending.delete(payload.requestId)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.pending.set(payload.requestId, { worker, finish });
      try {
        sendRendererIpc(worker.contents, 'protein-experiment-workers:request', payload);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private removeJob(jobId: string, job: Job, terminalRelease = false): void {
    if (this.jobs.get(jobId) !== job) return;
    this.jobs.delete(jobId);
    job.worker.jobs.delete(jobId);
    for (const turnId of job.turnIds) {
      this.routes.set(turnId, null);
      if (terminalRelease) {
        for (const listener of releasedTurnListeners) listener(turnId);
      }
    }
  }

  private loseWorker(worker: Worker): void {
    if (worker.closed) return;
    worker.closed = true;
    worker.rejectReady(new Error('The experiment worker is unavailable.'));
    this.workers.delete(worker);
    for (const pending of [...this.pending.values()])
      if (pending.worker === worker)
        pending.finish(new Error('The experiment worker is unavailable.'));
    for (const jobId of [...worker.jobs]) {
      const job = this.jobs.get(jobId);
      if (job) this.removeJob(jobId, job);
    }
    this.options.onWorkerDestroyed?.(worker.contents);
  }
}

function validId(value: unknown, allowColon = true): value is string {
  return (
    typeof value === 'string' &&
    (allowColon ? /^[A-Za-z0-9_:.-]{1,256}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(value)
  );
}

function validatePrepareRequest(request: ProteinExperimentPrepareRequest): void {
  if (
    !request ||
    !validId(request.jobId) ||
    typeof request.label !== 'string' ||
    request.label.length > 1000 ||
    (request.purpose !== undefined &&
      request.purpose !== 'fresh-author' &&
      request.purpose !== 'saved-view-replay') ||
    !Array.isArray(request.fixtures) ||
    request.fixtures.length < 1 ||
    request.fixtures.length > MAX_PROTEIN_EXPERIMENT_FIXTURES ||
    request.fixtures.some(
      (fixture) =>
        !fixture ||
        !validId(fixture.structureViewId) ||
        !fixture.attrs ||
        typeof fixture.attrs !== 'object'
    ) ||
    new Set(request.fixtures.map((fixture) => fixture.structureViewId)).size !==
      request.fixtures.length ||
    !request.workspace ||
    !Array.isArray(request.workspace.folders) ||
    request.workspace.folders.some(
      (folder) =>
        !folder ||
        typeof folder.path !== 'string' ||
        typeof folder.name !== 'string' ||
        !Number.isFinite(folder.addedAt)
    ) ||
    (request.workspace.activeWorkspaceFile !== null &&
      typeof request.workspace.activeWorkspaceFile !== 'string')
  )
    throw new Error('Invalid experiment preparation request.');
}

let activePool: ProteinExperimentWorkerPool | null = null;
let handlersInstalled = false;
const registeredPrivateTurns = new Set<string>();
const releasedTurnListeners = new Set<(turnId: string) => void>();

export function onProteinExperimentTurnReleased(listener: (turnId: string) => void): () => void {
  releasedTurnListeners.add(listener);
  return () => releasedTurnListeners.delete(listener);
}

export function proteinExperimentRendererForTurn(turnId?: string): WebContents | null | undefined {
  const target = activePool?.rendererForTurn(turnId);
  return target === undefined && turnId && registeredPrivateTurns.has(turnId) ? null : target;
}

export function installProteinExperimentWorkerPool(
  options: ProteinExperimentWorkerPoolOptions
): ProteinExperimentWorkerPool {
  activePool?.close();
  const pool = new ProteinExperimentWorkerPool(options);
  activePool = pool;
  if (!handlersInstalled) {
    handlersInstalled = true;
    handleGroup(proteinExperimentWorkersContract, {
      prepare: (event, request) => activePool!.prepare(event, request),
      checkAdmission: (event, request) => activePool!.checkAdmission(event, request),
      requestApproval: (event, request) => activePool!.requestApproval(event, request),
      bind: (event, request) => activePool!.bind(event, request),
      release: (event, request) => activePool!.release(event, request),
      ready: (event) => activePool!.ready(event),
      respond: (event, response) => {
        try {
          activePool!.respond(event, response);
        } catch (error) {
          console.error(
            '[ProteinExperiment] Rejected worker response:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    });
  }
  return pool;
}
