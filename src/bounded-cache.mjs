// Bounded, least-recently-used caches for session-lifetime state.
//
// A long-lived viewer outlives any one snapshot: it may watch hundreds of
// consecutive captures and a store can hand it ids that later disappear. Every
// cache whose key space is input-controlled therefore needs an explicit cap
// and an eviction rule, or a hostile/accidental cardinality turns into leaked
// heap. These two containers are the one policy:
//
// - BoundedCache<key, value>: insertion-ordered Map; get()/set() move the key
//   to the newest end; set() on a full cache drops the least recently used
//   entry first. The cap is exact: size never exceeds `limit`.
// - BoundedKeySet: the same policy for a dedupe set (warning coalescing).
//
// Counters are kept per cache so tests and scripts/bench.mjs can report the
// eviction history without exposing the backing Map. They are ordinary numbers,
// not references, so they cannot keep an evicted value alive.

export class BoundedCache {
  constructor(limit, { name = 'cache' } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`${name}: limit must be a positive integer`);
    }
    this.name = name;
    this.limit = limit;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get size() {
    return this.store.size;
  }

  has(key) {
    return this.store.has(key);
  }

  // A read without an LRU touch. Callers that inspect a key and may not use
  // the value (or that only want a membership answer) use this form.
  peek(key) {
    return this.store.get(key);
  }

  get(key) {
    if (!this.store.has(key)) {
      this.misses++;
      return undefined;
    }
    const value = this.store.get(key);
    this.store.delete(key);
    this.store.set(key, value);
    this.hits++;
    return value;
  }

  set(key, value) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.limit) {
      this.store.delete(this.store.keys().next().value);
      this.evictions++;
    }
    this.store.set(key, value);
    return value;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  keys() {
    return this.store.keys();
  }

  values() {
    return this.store.values();
  }

  entries() {
    return this.store.entries();
  }

  [Symbol.iterator]() {
    return this.store[Symbol.iterator]();
  }

  stats() {
    return {
      name: this.name,
      limit: this.limit,
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

export class BoundedKeySet {
  constructor(limit, { name = 'set' } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`${name}: limit must be a positive integer`);
    }
    this.name = name;
    this.limit = limit;
    this.items = new Map();
    this.evictions = 0;
  }

  get size() {
    return this.items.size;
  }

  has(key) {
    return this.items.has(key);
  }

  add(key) {
    if (this.items.has(key)) {
      this.items.delete(key);
    } else if (this.items.size >= this.limit) {
      this.items.delete(this.items.keys().next().value);
      this.evictions++;
    }
    this.items.set(key, true);
    return this;
  }

  delete(key) {
    return this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }

  keys() {
    return this.items.keys();
  }

  [Symbol.iterator]() {
    return this.items.keys();
  }

  stats() {
    return {
      name: this.name,
      limit: this.limit,
      size: this.items.size,
      evictions: this.evictions,
    };
  }
}

// A cache that retains exactly one build result. It is the explicit form of the
// single-slot caches (graph layout, wire raster): a changed key replaces the
// value, so the retained size is always 0 or 1 and the previous entry becomes
// collectable. `get(key, build)` counts builds, hits and replacements.
export class SingleEntryCache {
  constructor(name = 'entry') {
    this.name = name;
    this.key = undefined;
    this.value = undefined;
    this.filled = false;
    this.builds = 0;
    this.hits = 0;
    this.evictions = 0;
  }

  get size() {
    return this.filled ? 1 : 0;
  }

  has(key) {
    return this.filled && this.key === key;
  }

  get(key, build) {
    if (this.has(key)) {
      this.hits++;
      return this.value;
    }
    if (this.filled) this.evictions++;
    this.key = key;
    this.value = build();
    this.filled = true;
    this.builds++;
    return this.value;
  }

  clear() {
    this.key = undefined;
    this.value = undefined;
    this.filled = false;
  }

  stats() {
    return {
      name: this.name,
      limit: 1,
      size: this.size,
      builds: this.builds,
      hits: this.hits,
      evictions: this.evictions,
    };
  }
}
