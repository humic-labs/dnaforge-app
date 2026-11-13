'use client';

export function PageSkeleton() {
  return (
    <div className="h-full flex flex-col animate-pulse">
      {}
      <div className="px-4 py-2 border-b border-border">
        <div className="h-3 w-24 bg-bg-muted rounded" />
      </div>

      {}
      <div className="flex-1 p-4 space-y-4">
        {}
        <div className="h-6 w-2/3 bg-bg-muted rounded" />

        {}
        <div className="space-y-2 pt-4">
          <div className="h-4 w-full bg-bg-muted rounded" />
          <div className="h-4 w-5/6 bg-bg-muted rounded" />
          <div className="h-4 w-4/5 bg-bg-muted rounded" />
        </div>

        <div className="space-y-2 pt-2">
          <div className="h-4 w-full bg-bg-muted rounded" />
          <div className="h-4 w-3/4 bg-bg-muted rounded" />
        </div>
      </div>
    </div>
  );
}
