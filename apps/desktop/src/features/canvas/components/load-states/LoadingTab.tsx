export function LoadingTab() {
  return (
    <div
      className="h-full flex items-center justify-center"
      data-testid="canvas-loading-tab"
      role="status"
      aria-live="polite"
    >
      <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
    </div>
  );
}
