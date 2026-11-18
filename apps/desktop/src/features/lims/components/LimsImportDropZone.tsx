import { useEffect, useRef, useState } from 'react';
import { FilePlusIcon } from '../../../components/icons/glyphs';

export function LimsImportDropZone({
  label,
  hint,
  accept,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  onFile: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const leave = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
    };
  }, [onFile]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <button
        type="button"
        data-testid="lims-import-dropzone"
        onClick={() => inputRef.current?.click()}
        className={`flex w-full max-w-lg flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragging
            ? 'border-accent bg-accent/10'
            : 'border-border bg-bg-subtle/40 hover:border-accent wp-interactive'
        }`}
      >
        <FilePlusIcon className={`h-10 w-10 ${dragging ? 'text-accent' : 'text-fg-subtle'}`} />
        <span className="text-sm font-medium text-fg">
          Drop your {label} file here, or click to browse
        </span>
        <span className="text-xs text-fg-muted">{hint}</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        data-testid="lims-import-drop-input"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = '';
        }}
      />

      {dragging && (
        <div
          data-testid="lims-import-drop-overlay"
          className="pointer-events-none fixed inset-0 z-[70] m-2 flex items-center justify-center rounded-lg border-4 border-dashed border-accent bg-accent/10 text-sm font-semibold text-accent"
        >
          Drop anywhere to import {label}
        </div>
      )}
    </div>
  );
}
