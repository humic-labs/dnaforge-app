interface Props {
  chainCount?: number;
  hasLighterSource: boolean;
  onUseLighterSource?: () => void;
  onOpenCandidatePicker: () => void;
}

export function StructureLargeComplexState({
  chainCount,
  hasLighterSource,
  onUseLighterSource,
  onOpenCandidatePicker,
}: Props) {
  const chainLabel =
    typeof chainCount === 'number' && chainCount > 0
      ? `This ${chainCount}-chain structure was too large to finish rendering.`
      : 'This structure was too large to finish rendering.';

  return (
    <div
      data-testid="structure-large-complex-state"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <div className="text-sm font-medium text-fg">{chainLabel}</div>
      <div className="max-w-xs text-xs text-fg-muted">
        You can try a lighter model when one is available, or choose a different source from the
        candidate list.
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {hasLighterSource && onUseLighterSource ? (
          <button
            type="button"
            data-testid="structure-large-complex-lighter"
            onClick={onUseLighterSource}
            className="rounded border border-border bg-bg-subtle px-3 py-1 text-xs wp-interactive"
          >
            Use a lighter model
          </button>
        ) : null}
        <button
          type="button"
          data-testid="structure-large-complex-picker"
          onClick={onOpenCandidatePicker}
          className="rounded border border-border bg-bg-subtle px-3 py-1 text-xs wp-interactive"
        >
          Choose a different source
        </button>
      </div>
    </div>
  );
}
