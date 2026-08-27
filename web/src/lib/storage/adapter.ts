/**
 * Storage adapters.
 *
 * The vault only needs a key-value store, so that is the whole interface.
 * Keeping it this narrow means the encryption logic can be tested in Node
 * without IndexedDB, and a different backend (an Electron file store, say) is
 * a single implementation rather than a rewrite.
 */

export interface StorageAdapter {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

/** In-memory adapter: tests, SSR, and anywhere IndexedDB is unavailable. */
export class MemoryAdapter implements StorageAdapter {
  private readonly entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.entries.get(key);
    // Copy on the way out so a caller mutating the result cannot corrupt the
    // store, matching how a real backend behaves.
    return value ? value.slice() : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async keys(prefix = ""): Promise<string[]> {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

const DB_NAME = "shatters";
const DB_VERSION = 1;
const STORE = "vault";

/** IndexedDB-backed adapter for the browser. */
export class IndexedDbAdapter implements StorageAdapter {
  private db?: IDBDatabase;

  constructor(private readonly dbName: string = DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  private async run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = await this.run<ArrayBuffer | undefined>("readonly", (s) =>
      s.get(key),
    );
    return value ? new Uint8Array(value) : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    // Stored as a plain ArrayBuffer: structured clone would otherwise retain
    // the view's backing buffer, which may be much larger than the record.
    const buffer = value.slice().buffer;
    await this.run("readwrite", (s) => s.put(buffer, key));
  }

  async delete(key: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(key));
  }

  async keys(prefix = ""): Promise<string[]> {
    const all = await this.run<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return all
      .map(String)
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  async clear(): Promise<void> {
    await this.run("readwrite", (s) => s.clear());
  }
}

/** Picks IndexedDB when the environment has it, memory otherwise. */
export function defaultAdapter(): StorageAdapter {
  return typeof indexedDB === "undefined"
    ? new MemoryAdapter()
    : new IndexedDbAdapter();
}
