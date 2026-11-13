import { useEffect, useState } from 'react';
import {
  peekRecentlyEditedSnapshot,
  subscribeRecentlyEditedSnapshot,
  type RecentlyEditedItem,
} from './recently-edited';

export function useRecentlyEditedSnapshot(): RecentlyEditedItem[] {
  const [items, setItems] = useState(peekRecentlyEditedSnapshot);
  useEffect(() => subscribeRecentlyEditedSnapshot(setItems), []);
  return items;
}
