import { useEffect, useRef, useState } from 'react';
import type { EntityDiscoveryScope } from '../../../../shared/entity-discovery';
import { discoverEntityLinkTypes, type EntityLinkCategory } from './search';

export function useEntityLinkTypes(scope?: EntityDiscoveryScope) {
  const scopeKey = JSON.stringify(scope ?? null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [types, setTypes] = useState<EntityLinkCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setTypes([]);
    void discoverEntityLinkTypes(currentScope.current)
      .then((items) => {
        if (active) setTypes(items);
      })
      .catch(() => {
        if (active) setError('Could not load entity classes.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, scopeKey]);
  return { types, error, loading, retry: () => setAttempt((value) => value + 1) };
}
