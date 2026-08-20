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

export function setDifference<T>(all: Iterable<T>, exclude: Set<T>): Set<T> {
  return new Set(Array.from(all).filter(x => !exclude.has(x)));
}
/**
 * A Map that keeps at most `capacity` entries, evicting least-recently-used
 * ones first. Reads count as use, so a hot key survives.
 *
 * For caches that would otherwise grow for the lifetime of the session but
 * whose older entries are still occasionally wanted — dropping them entirely
 * (e.g. on document close) would regress the reopen path, while keeping them
 * all is unbounded.
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error(`BoundedMap capacity must be >= 1, got ${capacity}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }
    // Re-insert so Map iteration order tracks recency.
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Keys from least- to most-recently used. */
  keysByAge(): K[] {
    return [...this.entries.keys()];
  }
}
