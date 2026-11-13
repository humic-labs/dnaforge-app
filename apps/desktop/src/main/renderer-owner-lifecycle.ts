import type { WebContents } from 'electron';

export class RendererOwnerLifecycle {
  private readonly registered = new WeakSet<WebContents>();
  private readonly generations = new WeakMap<WebContents, number>();
  private readonly navigationStates = new WeakMap<
    WebContents,
    { navigationBlocked: boolean; rendererGone: boolean }
  >();

  constructor(
    private readonly releaseOwners: (sender: WebContents) => void,
    private readonly admissionError: () => Error = () => {
      const error = new Error('Renderer closed during owner admission.');
      error.name = 'AbortError';
      return error;
    }
  ) {}

  register(sender: WebContents): number {
    if (!this.registered.has(sender)) {
      this.registered.add(sender);
      this.navigationStates.set(sender, {
        navigationBlocked: false,
        rendererGone: false,
      });
      const releaseOwner = (): void => {
        this.generations.set(sender, (this.generations.get(sender) ?? 0) + 1);
        this.releaseOwners(sender);
      };
      const releaseOwnerOnMainFrameNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
      ): void => {
        if (!details.isMainFrame || details.isSameDocument) return;
        const state = this.navigationStates.get(sender);
        if (state) {
          state.navigationBlocked = true;
          state.rendererGone = false;
        }
        releaseOwner();
      };
      const finishCommittedFrameNavigation = (
        _event: Electron.Event,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame) return;
        const state = this.navigationStates.get(sender);
        if (state) {
          state.navigationBlocked = false;

          state.rendererGone = false;
        }
      };
      const finishStoppedNavigation = (): void => {
        const state = this.navigationStates.get(sender);
        if (state) state.navigationBlocked = false;
      };
      const releaseOwnerOnRendererGone = (): void => {
        const state = this.navigationStates.get(sender);
        if (state) state.rendererGone = true;
        releaseOwner();
      };
      sender.on('render-process-gone', releaseOwnerOnRendererGone);
      sender.on('did-start-navigation', releaseOwnerOnMainFrameNavigation);
      sender.on('did-frame-navigate', finishCommittedFrameNavigation);
      sender.on('did-stop-loading', finishStoppedNavigation);
      sender.once('destroyed', releaseOwner);
    }
    this.assertAdmissible(sender);
    return this.generations.get(sender) ?? 0;
  }

  assertCurrent(sender: WebContents, generation: number): void {
    this.assertAdmissible(sender);
    if ((this.generations.get(sender) ?? 0) !== generation) this.throwAdmissionAbort();
  }

  private assertAdmissible(sender: WebContents): void {
    const state = this.navigationStates.get(sender);
    if (sender.isDestroyed() || state?.rendererGone === true || state?.navigationBlocked === true) {
      this.throwAdmissionAbort();
    }
  }

  private throwAdmissionAbort(): never {
    throw this.admissionError();
  }
}
