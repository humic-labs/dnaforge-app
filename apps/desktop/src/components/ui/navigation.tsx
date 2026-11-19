import {
  useId,
  useRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { Tooltip } from '../../shared/components/Tooltip';
import {
  UI_NAVIGATION_ACTION_CLASS,
  UI_NAVIGATION_ACTIONS_CLASS,
  UI_NAVIGATION_DETAIL_CLASS,
  UI_NAVIGATION_LINE_CLASS,
  UI_NAVIGATION_LIST_CLASS,
  UI_NAVIGATION_METADATA_CLASS,
  UI_NAVIGATION_PRIMARY_CLASS,
  UI_NAVIGATION_ROW_CLASS,
  UI_NAVIGATION_TEXT_CLASS,
  UI_NAVIGATION_TITLE_CLASS,
  navigationStatusClass,
} from './styles';

export interface NavigationRowAction {
  id: string;
  label: string;
  icon?: ReactNode;
  text?: string;
  tooltip?: string;
  testId?: string;
  disabled?: boolean;
  onInvoke: (trigger: HTMLButtonElement) => void;
}

export type NavigationSelection =
  | { kind: 'tab'; selected: boolean; tabIndex: 0 | -1; controls?: string }
  | { kind: 'page'; selected: boolean }
  | { kind: 'none' };

export interface NavigationRowContent {
  title: string;
  detail?: string;
  metadata?: string;
  status?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'error'; testId?: string };
  leadingIcon?: ReactNode;
  actions?: readonly NavigationRowAction[];
}

export type NavigationRowProps = NavigationRowContent &
  Omit<
    ComponentPropsWithoutRef<'div'>,
    'children' | 'className' | 'style' | 'onClick' | 'onDoubleClick' | 'onKeyDown'
  > & {
    selection: NavigationSelection;
    onActivate: MouseEventHandler<HTMLButtonElement>;
    onPrimaryKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
    onPrimaryDoubleClick?: MouseEventHandler<HTMLButtonElement>;
    primaryLabel?: string;
    primaryTitle?: string;
    primaryTestId?: string;
    detailTestId?: string;
    metadataTestId?: string;
    dimmed?: boolean;
    disabled?: boolean;
  };

function withoutAppearance<Props>(props: Props) {
  const {
    className: _className,
    style: _style,
    ...nativeProps
  } = props as Props & {
    className?: string;
    style?: CSSProperties;
  };
  return nativeProps;
}

export function NavigationList(
  props: Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'style'>
) {
  return (
    <div
      {...withoutAppearance(props)}
      data-ui-navigation-list
      className={UI_NAVIGATION_LIST_CLASS}
    />
  );
}

export function NavigationAction({
  id,
  label,
  icon,
  text,
  tooltip,
  testId,
  disabled,
  onInvoke,
}: NavigationRowAction) {
  const tooltipId = useId();
  return (
    <Tooltip id={tooltipId} content={tooltip ?? label} delay={0}>
      <button
        type="button"
        data-ui-navigation-action
        data-navigation-action={id}
        data-testid={testId}
        aria-label={label}
        aria-describedby={tooltipId}
        disabled={disabled}
        className={UI_NAVIGATION_ACTION_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          onInvoke(event.currentTarget);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {icon ? <span aria-hidden="true">{icon}</span> : (text ?? label)}
      </button>
    </Tooltip>
  );
}

export function NavigationRow({
  title,
  detail,
  metadata,
  status,
  leadingIcon,
  actions = [],
  selection,
  onActivate,
  onPrimaryKeyDown,
  onPrimaryDoubleClick,
  primaryLabel,
  primaryTitle,
  primaryTestId,
  detailTestId,
  metadataTestId,
  dimmed,
  disabled,
  ...props
}: NavigationRowProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const selected = selection.kind !== 'none' && selection.selected;
  return (
    <div
      {...withoutAppearance(props)}
      data-ui-navigation-row
      data-interaction-group="true"
      data-selected={selected || undefined}
      className={`${UI_NAVIGATION_ROW_CLASS}${dimmed ? ' opacity-50' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) primaryRef.current?.click();
      }}
    >
      <button
        type="button"
        ref={primaryRef}
        data-ui-navigation-primary
        data-testid={primaryTestId}
        role={selection.kind === 'tab' ? 'tab' : undefined}
        aria-selected={selection.kind === 'tab' ? selection.selected : undefined}
        aria-controls={selection.kind === 'tab' ? selection.controls : undefined}
        aria-current={selection.kind === 'page' && selection.selected ? 'page' : undefined}
        tabIndex={selection.kind === 'tab' ? selection.tabIndex : undefined}
        aria-label={primaryLabel}
        title={primaryTitle}
        disabled={disabled}
        className={UI_NAVIGATION_PRIMARY_CLASS}
        onClick={onActivate}
        onKeyDown={onPrimaryKeyDown}
        onDoubleClick={onPrimaryDoubleClick}
      >
        {leadingIcon ? (
          <span className="shrink-0" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}
        <span className={UI_NAVIGATION_TEXT_CLASS}>
          <span className={UI_NAVIGATION_LINE_CLASS}>
            <span data-ui-navigation-title className={UI_NAVIGATION_TITLE_CLASS}>
              {title}
            </span>
            {metadata ? (
              <span
                data-ui-navigation-metadata
                data-testid={metadataTestId}
                className={UI_NAVIGATION_METADATA_CLASS}
              >
                {metadata}
              </span>
            ) : null}
            {status ? (
              <span
                data-ui-navigation-status
                data-testid={status.testId}
                className={navigationStatusClass(status.tone)}
              >
                {status.label}
              </span>
            ) : null}
          </span>
          {detail ? (
            <span
              data-ui-navigation-detail
              data-testid={detailTestId}
              className={UI_NAVIGATION_DETAIL_CLASS}
              title={detail}
            >
              {detail}
            </span>
          ) : null}
        </span>
      </button>
      {actions.length > 0 ? (
        <span data-ui-navigation-actions className={UI_NAVIGATION_ACTIONS_CLASS}>
          {actions.map((action) => (
            <NavigationAction key={action.id} {...action} />
          ))}
        </span>
      ) : null}
    </div>
  );
}
