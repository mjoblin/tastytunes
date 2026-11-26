/**
 * A bounded map that forgets the least recently used entry past its cap: the ONE home for
 * the renderer's module caches (0.11.0 sweep). They were plain Maps that grew for as long as
 * the window lived, decoded pictures, blurred washes and waveform analyses among them; each
 * now names its own cap beside the reasoning for it. A get counts as a use, and so does a
 * set; has, peek and iterating do not.
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly cap: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** The entry's value, without counting it as a use. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // move to the young end
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Every entry, the least recently used first; iterating is not a use. */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

/**
 * A LOOKUP KEPT, NOT ITS MISS: the answer's promise is kept by key, so an ask while one is out, or
 * after it came, shares it; one that comes to nothing (null, or a throw) is let go as it settles,
 * so the next ask tries again. A miss kept as the answer outlived its cause: a cover that failed to
 * come once left a scene on its default colors, and its picture missing, for as long as the entry
 * lived (components/display/palette, feed).
 */
export function keptLookup<K, V>(
  cache: Lru<K, Promise<V | null>>,
  key: K,
  look: () => Promise<V | null>,
): Promise<V | null> {
  const kept = cache.get(key);
  if (kept) return kept;
  const asked = look().catch(() => null);
  cache.set(key, asked);
  void asked.then((answer) => {
    // only this ask's own entry: the key may have been let go and asked anew while it was out
    if (answer == null && cache.peek(key) === asked) cache.delete(key);
  });
  return asked;
}
