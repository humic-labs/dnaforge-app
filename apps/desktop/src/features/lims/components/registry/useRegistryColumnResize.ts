import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadRegistryColumnWidths,
  persistRegistryColumnWidths,
  REGISTRY_MIN_COL_WIDTH,
} from './registry-columns';

export function useRegistryColumnResize(): {
  registryColumnWidths: Record<string, number>;
  setRegistryColumnWidths: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  startRegistryColumnResize: (key: string, startX: number, startWidth: number) => void;
} {
  const [registryColumnWidths, setRegistryColumnWidths] = useState<Record<string, number>>(() =>
    loadRegistryColumnWidths()
  );
  const registryResizeCleanupRef = useRef<(() => void) | null>(null);
  const startRegistryColumnResize = useCallback(
    (key: string, startX: number, startWidth: number) => {
      const handleMove = (event: PointerEvent) => {
        const next = Math.max(REGISTRY_MIN_COL_WIDTH, startWidth + (event.clientX - startX));
        setRegistryColumnWidths((prev) => ({ ...prev, [key]: next }));
      };
      const detach = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        registryResizeCleanupRef.current = null;
      };
      const handleUp = () => {
        detach();
        setRegistryColumnWidths((prev) => {
          persistRegistryColumnWidths(prev);
          return prev;
        });
      };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      registryResizeCleanupRef.current = detach;
    },
    []
  );
  useEffect(() => () => registryResizeCleanupRef.current?.(), []);

  return { registryColumnWidths, setRegistryColumnWidths, startRegistryColumnResize };
}
