import type { PresentationCapture, PresentationOwner } from './ownership';

export class OverlayBinding {
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly nativeCleanup = new Map<string, () => void>();
  private readonly suspendedDialogs = new WeakSet<HTMLDialogElement>();
  private unsubscribe: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;
  private returnFocusPolicy: 'restore' | 'preserve' | 'advance' = 'restore';

  setReturnFocusPolicy = (policy: 'restore' | 'preserve' | 'advance'): void => {
    this.returnFocusPolicy = policy;
  };

  setReturnFocus = (target: HTMLElement | null): void => {
    this.returnFocus = target;
  };

  private restoreFocus = (): void => {
    if (this.returnFocusPolicy === 'preserve') return;
    const target = this.returnFocus;
    const surfaceId =
      target?.closest<HTMLElement>('[data-presentation-surface]')?.dataset.presentationSurface ??
      'window';
    const allowed =
      this.returnFocusPolicy === 'advance'
        ? this.owner.allowsFocus(surfaceId)
        : this.owner.allows(surfaceId, 'keyboard');
    if (target?.isConnected && allowed) {
      target.focus({ preventScroll: true });
      this.returnFocus = null;
    }
  };

  constructor(
    private readonly owner: PresentationOwner,
    private parentId: string,
    private readonly id: string,
    private readonly capture: Exclude<PresentationCapture, 'none'>
  ) {}

  private active = (): boolean =>
    [...this.nodes.values()].some((node) => !(node instanceof HTMLDialogElement) || node.open);

  setParent = (parentId: string): void => {
    this.parentId = parentId;
    if (this.nodes.size)
      this.owner.dispatch({
        type: 'attach',
        id: this.id,
        parentId,
        active: this.active(),
        capture: this.capture,
      });
  };

  private sync = (): void => {
    if (this.owner.allows(this.parentId, 'presentation')) {
      for (const node of this.nodes.values()) {
        if (node instanceof HTMLDialogElement && this.suspendedDialogs.has(node)) {
          this.suspendedDialogs.delete(node);
          if (node.isConnected && !node.open) node.showModal();
        }
      }
    }
    const visible = this.owner.allows(this.id, 'presentation');
    for (const node of this.nodes.values()) {
      node.toggleAttribute('inert', !visible);
      node.style.visibility = visible ? '' : 'hidden';
      node.style.contentVisibility = visible ? '' : 'hidden';
      if (
        !visible &&
        this.owner.getSnapshot().surfaces[this.id]?.status === 'active' &&
        node instanceof HTMLDialogElement &&
        node.open
      ) {
        this.suspendedDialogs.add(node);
        node.close();
      }
    }
  };

  bind = (key: string, node: HTMLElement | null): void => {
    this.nativeCleanup.get(key)?.();
    this.nativeCleanup.delete(key);
    if (!node) {
      const removed = this.nodes.get(key);
      const focused = removed?.ownerDocument.activeElement;
      const restoreFocus =
        this.returnFocusPolicy !== 'preserve' &&
        (focused === removed?.ownerDocument.body ||
          (focused instanceof Node && removed?.contains(focused)));
      this.nodes.delete(key);
      if (!this.nodes.size) {
        this.owner.dispatch({ type: 'suspend', id: this.id });
        if (restoreFocus && !(removed instanceof HTMLDialogElement)) this.restoreFocus();
        this.unsubscribe?.();
        this.unsubscribe = null;
        const surface = this.owner.getSnapshot().surfaces[this.id];
        const target = this.returnFocus;
        const surfaceId =
          target?.closest<HTMLElement>('[data-presentation-surface]')?.dataset
            .presentationSurface ?? 'window';
        const focusLease = this.owner.captureFocus(
          this.returnFocusPolicy === 'advance' ? this.parentId : surfaceId
        );
        queueMicrotask(() => {
          if (this.nodes.size || this.owner.getSnapshot().surfaces[this.id] !== surface) return;
          this.owner.dispatch({ type: 'dispose', id: this.id });
          if (
            restoreFocus &&
            this.returnFocusPolicy !== 'preserve' &&
            target?.isConnected &&
            target.ownerDocument.activeElement === target.ownerDocument.body &&
            this.returnFocus === target &&
            this.owner.isCurrent(focusLease)
          )
            target.focus({ preventScroll: true });
          if (this.returnFocus === target) this.returnFocus = null;
        });
      }
      return;
    }
    if (!this.nodes.size) {
      const focused = node.ownerDocument.activeElement;
      if (
        this.returnFocusPolicy === 'restore' &&
        !this.returnFocus &&
        focused instanceof HTMLElement &&
        !node.contains(focused)
      )
        this.returnFocus = focused;
    }
    node.dataset.presentationSurface = this.id;
    this.nodes.set(key, node);
    this.unsubscribe ??= this.owner.subscribe(this.sync);
    this.owner.dispatch({
      type: 'attach',
      id: this.id,
      parentId: this.parentId,
      active: this.active(),
      capture: this.capture,
    });
    if (node instanceof HTMLDialogElement) {
      const beforeToggle = (event: Event) => {
        if (!('newState' in event)) return;
        if (event.newState === 'open') {
          const focused = node.ownerDocument.activeElement;
          if (focused instanceof HTMLElement && !node.contains(focused)) this.returnFocus = focused;
          if (!this.owner.allows(this.parentId, 'presentation')) {
            this.suspendedDialogs.add(node);
            event.preventDefault();
            return;
          }
          this.owner.dispatch({ type: 'activate', id: this.id });
        } else {
          if (this.owner.allows(this.parentId, 'presentation')) this.suspendedDialogs.delete(node);
          this.owner.dispatch({ type: 'suspend', id: this.id });
        }
      };
      const reconcile = () => {
        this.owner.dispatch({ type: this.active() ? 'activate' : 'suspend', id: this.id });
      };
      const observer = new MutationObserver(reconcile);
      observer.observe(node, { attributes: true, attributeFilter: ['open'] });
      node.addEventListener('beforetoggle', beforeToggle);
      node.addEventListener('close', reconcile);
      this.nativeCleanup.set(key, () => {
        observer.disconnect();
        node.removeEventListener('beforetoggle', beforeToggle);
        node.removeEventListener('close', reconcile);
      });
    }
    this.sync();
  };
}
