import { useEffect, useState } from 'react';
import { formatRelativeTime } from '../utils';

const TICK_MS = 10_000;

export function RelativeSavedLabel({ updatedAt }: { updatedAt: Date }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return <span>Saved {formatRelativeTime(updatedAt)}</span>;
}
