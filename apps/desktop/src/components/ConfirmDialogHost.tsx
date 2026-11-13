import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { safeFocus } from '../shared/utils/safeFocus';
import { CloseIcon } from './icons';
import {
  useConfirmDialogStore,
  type ConfirmInput,
  type ConfirmRequest,
} from './confirm-dialog-store';
import { SafeAgentApprovalDialog } from './SafeAgentApprovalDialog';
import { Button, TextField } from './ui';

export function ConfirmDialogHost() {
  const request = useConfirmDialogStore((s) => s.request);
  const resolveCurrent = useConfirmDialogStore((s) => s.resolveCurrent);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request || request.safeDefault || request.input) return;
    safeFocus(confirmRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveCurrent(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolveCurrent(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, resolveCurrent]);

  if (!request) return null;

  if (request.input) {
    return <PromptDialog request={request} input={request.input} resolveCurrent={resolveCurrent} />;
  }

  if (request.safeDefault) {
    return (
      <SafeAgentApprovalDialog
        title={request.title}
        body={
          <p className="whitespace-pre-line text-sm leading-5 text-fg-muted">
            {toUserMessage(request.message, 'operation.failed')}
          </p>
        }
        allowLabel={request.confirmLabel ?? 'Confirm'}
        denyLabel={request.cancelLabel ?? 'Cancel'}
        onAllow={() => resolveCurrent(true)}
        onDeny={() => resolveCurrent(false)}
        testId="confirm-dialog"
        allowTestId="confirm-dialog-confirm"
        denyTestId="confirm-dialog-cancel"
      />
    );
  }

  const danger = request.tone === 'danger';

  return (
    <DialogFrame title={request.title} onDismiss={() => resolveCurrent(false)}>
      {request.showCloseButton ? (
        <button
          type="button"
          aria-label="Close dialog"
          data-testid="confirm-dialog-close"
          onClick={() => resolveCurrent(false)}
          className="absolute right-3 top-3 rounded p-1 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
      <p className="mt-2 whitespace-pre-line text-sm leading-5 text-fg-muted">
        {toUserMessage(request.message, 'operation.failed')}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <CancelButton label={request.cancelLabel} onClick={() => resolveCurrent(false)} />
        <Button
          ref={confirmRef}
          type="button"
          data-testid="confirm-dialog-confirm"
          onClick={() => resolveCurrent(true)}
          variant={danger ? 'danger' : 'primary'}
          autoFocus
        >
          {request.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </DialogFrame>
  );
}

function DialogFrame({
  title,
  onDismiss,
  children,
}: {
  title: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40"
      data-testid="confirm-dialog-backdrop"
      onMouseDown={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        data-testid="confirm-dialog"
        className="relative mx-4 w-full max-w-sm rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-dialog-title" className="pr-6 text-sm font-semibold text-fg">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

function CancelButton({ label, onClick }: { label?: string; onClick: () => void }) {
  return (
    <Button type="button" data-testid="confirm-dialog-cancel" onClick={onClick}>
      {label ?? 'Cancel'}
    </Button>
  );
}

function PromptDialog({
  request,
  input,
  resolveCurrent,
}: {
  request: ConfirmRequest;
  input: ConfirmInput;
  resolveCurrent: (confirmed: boolean, text?: string) => void;
}) {
  const [value, setValue] = useState(input.defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    safeFocus(field);
    field.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      resolveCurrent(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [resolveCurrent]);

  const submit = () => {
    if (canSubmit) resolveCurrent(true, trimmed);
  };

  return (
    <DialogFrame title={request.title} onDismiss={() => resolveCurrent(false)}>
      {request.message ? (
        <p className="mt-2 whitespace-pre-line text-sm leading-5 text-fg-muted">
          {toUserMessage(request.message, 'operation.failed')}
        </p>
      ) : null}
      <label
        htmlFor="confirm-dialog-input"
        className="mt-3 block text-xs font-medium text-fg-muted"
      >
        {input.label ?? 'Name'}
      </label>
      <div className="mt-1">
        <TextField
          ref={inputRef}
          id="confirm-dialog-input"
          data-testid="confirm-dialog-input"
          type="text"
          value={value}
          maxLength={input.maxLength}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <CancelButton label={request.cancelLabel} onClick={() => resolveCurrent(false)} />
        <Button
          variant="primary"
          type="button"
          data-testid="confirm-dialog-confirm"
          onClick={submit}
          disabled={!canSubmit}
        >
          {request.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </DialogFrame>
  );
}
