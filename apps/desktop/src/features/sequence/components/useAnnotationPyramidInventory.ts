import { useEffect, useMemo, useState } from 'react';

import { platform } from '../../../platform';
import type { AssemblyAnnotationSceneReadRequest } from '../../../shared/indexed-genome';

const EMPTY_INVENTORY: readonly string[] = [];

export function useAnnotationPyramidInventory(options: {
  seedProduct: AssemblyAnnotationSceneReadRequest | null;
  requestKey: string | null;
}): readonly string[] {
  const [inventory, setInventory] = useState<{ key: string; types: readonly string[] }>({
    key: '',
    types: [],
  });
  const stableSeedProduct = useMemo(
    () => options.seedProduct,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.requestKey]
  );

  useEffect(() => {
    const seedProduct = stableSeedProduct;
    const requestKey = options.requestKey;
    if (!seedProduct || !requestKey) return;
    let cancelled = false;
    void platform()
      .genome.readAssemblyAnnotationProductSetInventoryV1({ seedProduct })
      .then((result) => {
        if (cancelled) return;
        setInventory({
          key: requestKey,
          types:
            result.status === 'ready'
              ? [...new Set(result.trackTypes)].sort((left, right) => left.localeCompare(right))
              : [],
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[assembly-annotation-product-set] inventory read failed', error);
        setInventory({ key: requestKey, types: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [options.requestKey, stableSeedProduct]);

  return options.requestKey && inventory.key === options.requestKey
    ? inventory.types
    : EMPTY_INVENTORY;
}
