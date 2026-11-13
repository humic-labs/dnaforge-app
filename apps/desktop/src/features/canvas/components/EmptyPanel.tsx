interface EmptyPanelProps {
  onOpenFile?: () => void;
}

export function EmptyPanel({ onOpenFile }: EmptyPanelProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-fg-muted">
      <div className="text-center max-w-sm">
        <div className="text-5xl mb-4 opacity-50">📁</div>
        <h3 className="text-lg font-medium text-fg mb-2">No tabs open</h3>
        <p className="text-sm mb-4">Open a file from the sidebar or drop files here.</p>
        {onOpenFile && (
          <button
            onClick={onOpenFile}
            className="text-sm text-accent hover:text-accent/80 underline underline-offset-2"
          >
            Open a file
          </button>
        )}
      </div>
    </div>
  );
}
