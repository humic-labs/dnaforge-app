import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { InlineEditableValue } from '../InlineEditableValue';
import { useMetadataFieldEditing } from './MetadataEditing';

export function MetadataField({
  label,
  display,
  children,
  disabled = false,
  onBegin,
  onFinish = () => {},
  onCancel = () => {},
  onEditingChange,
  editRequestId,
  triggerProps,
}: {
  label: string;
  display: ReactNode;
  children: (session: ReturnType<typeof useMetadataFieldEditing>) => ReactNode;
  disabled?: boolean;
  onBegin?: () => void;
  onFinish?: () => void;
  onCancel?: () => void;
  onEditingChange?: (editing: boolean) => void;
  editRequestId?: number;
  triggerProps?: ComponentProps<'button'> & { 'data-testid'?: string };
}) {
  const session = useMetadataFieldEditing({
    onBegin,
    onFinish,
    onCancel,
    onEditingChange,
    editRequestId,
    disabled,
  });
  useEffect(() => {
    if (disabled && session.editing) session.cancel();
  }, [disabled, session]);
  return (
    <span {...session.boundaryProps} className="block min-w-0">
      {session.editing ? (
        children(session)
      ) : (
        <InlineEditableValue
          {...triggerProps}
          ref={session.triggerRef}
          aria-label={triggerProps?.['aria-label'] ?? `Edit ${label}`}
          disabled={disabled}
          onClick={() => session.begin()}
        >
          {display}
        </InlineEditableValue>
      )}
    </span>
  );
}
