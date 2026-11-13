import { useEffect, useState } from 'react';

const KEY = 'waypoint:devFixturesMounted';
const EVENT = 'waypoint:devFixturesMountedChange';

export function getDevFixturesMounted(): boolean {
  if (import.meta.env.VITE_DNAFORGE_AUTOMATION_ISOLATED === '1') return false;
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(KEY) !== 'false';
}

export function setDevFixturesMounted(value: boolean): void {
  if (import.meta.env.VITE_DNAFORGE_AUTOMATION_ISOLATED === '1') value = false;
  try {
    localStorage.setItem(KEY, value ? 'true' : 'false');
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function useDevFixturesMounted(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(getDevFixturesMounted);
  useEffect(() => {
    const onChange = () => setValue(getDevFixturesMounted());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return [value, setDevFixturesMounted];
}
