import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { FolderIcon } from '../../components/icons';
import { TreeRow } from '../../shared/components/tree/TreeRow';
import { safeFocus } from '../../shared/utils/safeFocus';

export interface DestinationRoot {
  path: string;
  name: string;
}

interface Props {
  roots: DestinationRoot[];
  selected: ImportDestination;
  onSelect: (destination: ImportDestination) => void;
  listSubfolders?: (path: string) => Promise<DestinationRoot[]>;
  onDropDestination?: (destination: ImportDestination) => void;
  renderDestExtra?: (destination: ImportDestination) => ReactNode;
  showRegistry?: boolean;
  autoFocus?: boolean;
}

function useDestinationDropTarget(
  destination: ImportDestination,
  onDropDestination?: (destination: ImportDestination) => void
) {
  const [dropActive, setDropActive] = useState(false);
  if (!onDropDestination) {
    return { dropProps: {}, dropActive: false };
  }
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      if (!dropActive) setDropActive(true);
    },
    onDragEnter: (event: DragEvent) => {
      event.preventDefault();
      setDropActive(true);
    },
    onDragLeave: () => setDropActive(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      onDropDestination(destination);
    },
    'data-drop-active': dropActive ? '' : undefined,
  };
  return { dropProps, dropActive };
}

export function ImportDestinationPicker({
  roots,
  selected,
  onSelect,
  listSubfolders,
  onDropDestination,
  renderDestExtra,
  showRegistry = false,
  autoFocus = false,
}: Props) {
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) {
      safeFocus(
        treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ??
          treeRef.current?.querySelector<HTMLElement>('[role="treeitem"]')
      );
    }
  }, [autoFocus]);
  const selectedPath = selected.kind === 'existing-root' ? selected.rootPath : null;
  const { dropProps: newWorkspaceDropProps } = useDestinationDropTarget(
    { kind: 'new-workspace' },
    onDropDestination
  );
  const { dropProps: registryDropProps } = useDestinationDropTarget(
    { kind: 'registry' },
    onDropDestination
  );
  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Import destination"
      data-testid="import-destination-tree"
      className="min-h-0 flex-1 overflow-y-auto"
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        const current = (event.target as HTMLElement).closest('[role="treeitem"]');
        const index = rows.findIndex((row) => row === current);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
                );
        event.preventDefault();
        safeFocus(rows[next]);
      }}
    >
      <button
        type="button"
        role="treeitem"
        aria-selected={selected.kind === 'new-workspace'}
        data-testid="dest-new-workspace"
        onClick={() => onSelect({ kind: 'new-workspace' })}
        {...newWorkspaceDropProps}
        className={
          'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ' +
          'data-[drop-active]:bg-accent/20 data-[drop-active]:ring-1 data-[drop-active]:ring-inset data-[drop-active]:ring-accent ' +
          (selected.kind === 'new-workspace'
            ? 'bg-accent/15 text-fg'
            : 'text-fg-muted hover:bg-bg-muted')
        }
      >
        ＋ New project from these files
      </button>
      {renderDestExtra?.({ kind: 'new-workspace' })}
      {showRegistry ? (
        <>
          <button
            type="button"
            role="treeitem"
            aria-selected={selected.kind === 'registry'}
            data-testid="dest-registry"
            onClick={() => onSelect({ kind: 'registry' })}
            {...registryDropProps}
            className={
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm ' +
              'data-[drop-active]:bg-accent/20 data-[drop-active]:ring-1 data-[drop-active]:ring-inset data-[drop-active]:ring-accent ' +
              (selected.kind === 'registry'
                ? 'bg-accent/15 text-fg'
                : 'text-fg-muted hover:bg-bg-muted')
            }
          >
            ⛃ Register as entities
          </button>
          {renderDestExtra?.({ kind: 'registry' })}
        </>
      ) : null}
      {roots.map((root) => (
        <FolderNode
          key={root.path}
          node={root}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          listSubfolders={listSubfolders}
          onDropDestination={onDropDestination}
          renderDestExtra={renderDestExtra}
        />
      ))}
    </div>
  );
}

function FolderNode({
  node,
  depth,
  selectedPath,
  onSelect,
  listSubfolders,
  onDropDestination,
  renderDestExtra,
}: {
  node: DestinationRoot;
  depth: number;
  selectedPath: string | null;
  onSelect: (destination: ImportDestination) => void;
  listSubfolders?: (path: string) => Promise<DestinationRoot[]>;
  onDropDestination?: (destination: ImportDestination) => void;
  renderDestExtra?: (destination: ImportDestination) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DestinationRoot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const selected = selectedPath === node.path;
  const { dropProps, dropActive } = useDestinationDropTarget(
    { kind: 'existing-root', rootPath: node.path },
    onDropDestination
  );

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null && listSubfolders) {
      setLoading(true);
      try {
        setChildren(await listSubfolders(node.path));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div role="none">
      <TreeRow
        depth={depth}
        isSelected={selected}
        isExpanded={listSubfolders ? expanded : undefined}
        isDropActive={dropActive}
        onToggleExpand={listSubfolders ? () => void toggle() : undefined}
        toggleLabel={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        toggleTestId={`dest-expand-${node.name}`}
        icon={<FolderIcon expanded={expanded} className="h-4 w-4 flex-shrink-0 text-fg-subtle" />}
        label={node.name}
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        data-selected={selected ? 'true' : 'false'}
        aria-expanded={listSubfolders ? expanded : undefined}
        data-folder-path={node.path}
        {...dropProps}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect({ kind: 'existing-root', rootPath: node.path });
          } else if (listSubfolders && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault();
            if (
              (event.key === 'ArrowRight' && !expanded) ||
              (event.key === 'ArrowLeft' && expanded)
            ) {
              void toggle();
            }
          }
        }}
        onClick={() => onSelect({ kind: 'existing-root', rootPath: node.path })}
      />
      {renderDestExtra?.({ kind: 'existing-root', rootPath: node.path })}
      {expanded && (
        <>
          {loading && (
            <div
              className="text-xs text-fg-muted"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              Loading…
            </div>
          )}
          {children?.map((child) => (
            <FolderNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              listSubfolders={listSubfolders}
              onDropDestination={onDropDestination}
              renderDestExtra={renderDestExtra}
            />
          ))}
          {children?.length === 0 && !loading && (
            <div
              className="text-xs text-fg-muted/70"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              No subfolders
            </div>
          )}
        </>
      )}
    </div>
  );
}
