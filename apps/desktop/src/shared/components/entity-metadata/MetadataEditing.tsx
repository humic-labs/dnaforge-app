import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { safeFocus } from '../../utils/safeFocus';
import {
  createMetadataEditingCoordinator,
  type MetadataEditingCoordinator,
} from './metadata-editing-coordinator';

type EditingSession = { id: string; finish: () => void };

const MetadataEditingContext = createContext<{
  activate: (session: EditingSession) => void;
  release: (id: string) => void;
} | null>(null);

export function MetadataEditingScope({
  children,
  coordinator,
}: {
  children: ReactNode;
  coordinator?: MetadataEditingCoordinator;
}) {
  const [local] = useState(createMetadataEditingCoordinator);
  const scope = coordinator ?? local;
  return (
    <MetadataEditingContext.Provider value={scope}>{children}</MetadataEditingContext.Provider>
  );
}

export function useMetadataFieldEditing({
  onBegin,
  onFinish,
  onCancel,
  onEditingChange,
  editRequestId,
  disabled = false,
}: {
  onBegin?: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onEditingChange?: (editing: boolean) => void;
  editRequestId?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const scope = useContext(MetadataEditingContext);
  const [editing, setEditing] = useState(false);
  const active = useRef(false);
  const restoreFocus = useRef(false);
  const pointerTransfer = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLSpanElement>(null);
  const callbacks = useRef({ onBegin, onFinish, onCancel, onEditingChange });
  callbacks.current = { onBegin, onFinish, onCancel, onEditingChange };

  const owns = useCallback(
    (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest('[data-metadata-field]')?.getAttribute('data-metadata-field') === id,
    [id]
  );

  const leave = (reason: 'finish' | 'cancel', focus = false) => {
    if (!active.current) return;
    active.current = false;
    pointerTransfer.current = false;
    scope?.release(id);
    restoreFocus.current = focus;
    setEditing(false);
    callbacks.current.onEditingChange?.(false);
    if (reason === 'cancel') callbacks.current.onCancel();
    else callbacks.current.onFinish();
  };
  const latestLeave = useRef(leave);
  latestLeave.current = leave;
  const begin = () => {
    if (active.current || disabled) return;
    callbacks.current.onBegin?.();
    scope?.activate({ id, finish: () => latestLeave.current('finish') });
    active.current = true;
    setEditing(true);
    callbacks.current.onEditingChange?.(true);
  };
  const latestBegin = useRef(begin);
  latestBegin.current = begin;
  const consumedRequest = useRef<number>();
  useEffect(() => {
    if (!editRequestId || disabled || editRequestId === consumedRequest.current) return;
    consumedRequest.current = editRequestId;
    latestBegin.current();
  }, [editRequestId, disabled, scope]);

  useLayoutEffect(() => {
    if (editing) {
      const editor = editorRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
      );
      safeFocus(editor, { preventScroll: true });
      if (editor instanceof HTMLInputElement && editor.type === 'text') editor.select();
    } else if (restoreFocus.current) {
      if (triggerRef.current?.disabled) return;
      restoreFocus.current = false;
      if (document.activeElement === document.body || owns(document.activeElement))
        safeFocus(triggerRef.current, { preventScroll: true });
    }
  }, [disabled, editing, owns]);

  useEffect(() => {
    if (!editing) return;
    const outside = (event: PointerEvent) => {
      if (owns(event.target)) return;
      const control =
        event.target instanceof Element
          ? event.target.closest('button, input, textarea, select, a, [tabindex]')
          : null;
      if (control && !control.matches(':disabled, [aria-disabled="true"]')) {
        pointerTransfer.current = true;
        return;
      }
      latestLeave.current('finish');
    };
    const finishTransfer = (event: MouseEvent) => {
      if (pointerTransfer.current && !owns(event.target)) latestLeave.current('finish');
      pointerTransfer.current = false;
    };
    const finishPointer = () => {
      if (pointerTransfer.current)
        setTimeout(() => {
          if (pointerTransfer.current) latestLeave.current('finish');
        }, 0);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('click', finishTransfer, true);
    document.addEventListener('pointerup', finishPointer, true);
    document.addEventListener('pointercancel', finishPointer, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('click', finishTransfer, true);
      document.removeEventListener('pointerup', finishPointer, true);
      document.removeEventListener('pointercancel', finishPointer, true);
    };
  }, [editing, owns]);

  useEffect(
    () => () => {
      if (active.current) callbacks.current.onEditingChange?.(false);
      active.current = false;
      consumedRequest.current = undefined;
      setEditing(false);
      scope?.release(id);
    },
    [id, scope]
  );

  return {
    editing,
    triggerRef,
    ownerId: id,
    begin,
    finish: (focus = false) => leave('finish', focus),
    cancel: () => leave('cancel', true),
    boundaryProps: {
      ref: editorRef,
      'data-metadata-field': id,
      onBlur: (event: React.FocusEvent<HTMLSpanElement>) => {
        if (!owns(event.relatedTarget) && !pointerTransfer.current) leave('finish');
      },
      onKeyDownCapture: (event: React.KeyboardEvent<HTMLSpanElement>) => {
        if (
          event.key !== 'Escape' ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          !active.current
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        leave('cancel', true);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => event.stopPropagation(),
    },
  };
}
