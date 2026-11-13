export interface InputOwnershipAuthority {
  allows(target: Element, input: 'keyboard' | 'pointer', event?: Event): boolean;
  capture(target: Element, input: 'keyboard' | 'pointer'): () => boolean;
  captureFocus?(target: Element): () => boolean;
  allowsFocus?(target: Element): boolean;
  subscribe(listener: () => void): () => void;
}

const authorities = new WeakMap<Document, InputOwnershipAuthority>();

export function installInputOwnership(
  document: Document,
  authority: InputOwnershipAuthority
): () => void {
  authorities.set(document, authority);
  return () => {
    if (authorities.get(document) === authority) authorities.delete(document);
  };
}

export function inputTargetAllows(
  target: Element,
  input: 'keyboard' | 'pointer',
  event?: Event
): boolean {
  const authority = authorities.get(target.ownerDocument);
  return !authority || (target.isConnected && authority.allows(target, input, event));
}

export function focusTargetAllows(target: Element): boolean {
  const authority = authorities.get(target.ownerDocument);
  if (!authority) return true;
  if (!target.isConnected) return false;
  return authority.allowsFocus
    ? authority.allowsFocus(target)
    : authority.allows(target, 'keyboard');
}

export function captureInputOwnership(
  target: Element,
  input: 'keyboard' | 'pointer'
): () => boolean {
  const current = authorities.get(target.ownerDocument)?.capture(target, input);
  const focused = target.ownerDocument.activeElement;
  return () =>
    (current ? current() : target.isConnected) &&
    (input !== 'keyboard' || target.ownerDocument.activeElement === focused);
}

export function captureFocusOwnership(target: Element): () => boolean {
  const authority = authorities.get(target.ownerDocument);
  const current = authority?.captureFocus?.(target) ?? captureInputOwnership(target, 'keyboard');
  const focused = target.ownerDocument.activeElement;
  return () => current() && target.ownerDocument.activeElement === focused;
}

export function subscribeInputRevocation(
  target: Element,
  onRevoke: () => void,
  input: 'keyboard' | 'pointer' = 'pointer'
): () => void {
  const authority = authorities.get(target.ownerDocument);
  if (!authority) return () => undefined;
  const capture = () =>
    target.isConnected && authority.allows(target, input)
      ? captureInputOwnership(target, input)
      : null;
  let current = capture();
  return authority.subscribe(() => {
    if (current && !current()) onRevoke();
    current = capture();
  });
}
