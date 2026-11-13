export function SequenceSkeleton() {
  return (
    <div className="flex items-center justify-center h-full bg-bg">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-2" />
        <div className="text-fg-muted text-sm">Loading sequence...</div>
      </div>
    </div>
  );
}
