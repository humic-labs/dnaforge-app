import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  BiologyFileIcon,
  ChatTabIcon,
  CloseIcon,
  FolderOpenIcon,
  OligoIcon,
  OpenExternalIcon,
  StrainIcon,
} from '../../components/icons';
import { ExplorerAddButton } from '../../components/ExplorerAddButton';
import type { ConfirmedEntityType, ConfirmedEntityTypeId, ProjectImportAction } from './model';

export const PANEL_CLASS =
  'absolute left-[264px] top-[47px] z-20 border border-border bg-bg shadow-xl';

export function EntityTypeGlyph({
  type,
  className = 'h-5 w-5',
}: {
  type: ConfirmedEntityType | ConfirmedEntityTypeId;
  className?: string;
}) {
  const id = typeof type === 'string' ? type : type.id;
  const glyph =
    id === 'dna-sequences' ? (
      <BiologyFileIcon className={className} />
    ) : id === 'primers' ? (
      <OligoIcon className={className} />
    ) : (
      <StrainIcon className={className} />
    );

  return (
    <span data-entity-icon={id} aria-hidden="true" className="inline-flex flex-none">
      {glyph}
    </span>
  );
}

export function ProjectActionGlyph({
  action,
  className = 'h-4 w-4',
}: {
  action: ProjectImportAction;
  className?: string;
}) {
  const glyph =
    action === 'Import a project' ? (
      <FolderOpenIcon className={className} />
    ) : action === 'Import with agent' ? (
      <ChatTabIcon className={className} />
    ) : (
      <OpenExternalIcon className={className} />
    );
  return <span aria-hidden="true">{glyph}</span>;
}

export function ProjectTree() {
  return (
    <div className="px-2 py-2 text-[12px] text-fg-muted" aria-label="Example project files">
      <div className="flex h-7 items-center gap-1.5 px-2 font-medium text-fg">
        <span aria-hidden="true">▾</span>
        <span>Project</span>
      </div>
      <div className="flex h-7 items-center gap-1.5 pl-6 pr-2">
        <span aria-hidden="true">▸</span>
        <span>sequences</span>
      </div>
      <div className="flex h-7 items-center gap-1.5 pl-6 pr-2">
        <span aria-hidden="true">▸</span>
        <span>primers</span>
      </div>
      <div className="flex h-7 items-center gap-1.5 pl-6 pr-2">
        <span className="w-3" aria-hidden="true" />
        <span>README.md</span>
      </div>
    </div>
  );
}

export function ImportPickerPrototypeFrame({
  children,
}: {
  children: (controls: { onRequestClose: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div
      className="relative flex h-[760px] min-h-0 overflow-hidden border border-border bg-bg"
      data-testid="import-picker-prototype-frame"
    >
      <aside className="relative z-10 w-[304px] flex-none border-r border-border bg-bg">
        <div className="flex h-12 items-center justify-between border-b border-border px-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">Project</div>
            <div className="text-[11px] text-fg-muted">Local project</div>
          </div>
          <ExplorerAddButton
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          />
        </div>
        <ProjectTree />
        {open && children({ onRequestClose: () => setOpen(false) })}
      </aside>
      <main className="relative min-w-0 flex-1 bg-bg-muted/20" aria-label="Empty project canvas">
        <div className="absolute inset-x-0 top-0 h-9 border-b border-border/70 bg-bg/60" />
      </main>
    </div>
  );
}

export function ClosePickerButton({
  onClick,
  className = '',
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Close add picker"
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${className}`}
    >
      <CloseIcon className="h-3.5 w-3.5" />
    </button>
  );
}

export function PrototypeSurface({
  children,
  className = '',
  style,
  label,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  label: string;
}) {
  return (
    <section
      className={className}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={label}
    >
      {children}
    </section>
  );
}

export function SelectionNotice({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div aria-live="polite" className={className}>
      {children}
    </div>
  );
}
