/**
 * Group an array of items into a Map keyed by the result of keyFn.
 * Each key maps to an array of all items that produced that key.
 */
export function groupBy<K, V>(items: V[], keyFn: (item: V) => K): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
