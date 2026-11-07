/**
 * Durable client-side storage for the net layer. Values are structured-cloned, so a
 * non-extractable `CryptoKeyPair` survives a reload without its private half ever being
 * readable. Everything read back is untrusted and re-validated by the caller.
 */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

const OBJECT_STORE = 'kv';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed without an error.'));
    };
  });
}

export function indexedDbStore(
  dbName = 'coinposh-net',
  factory: IDBFactory = indexedDB,
): KeyValueStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(OBJECT_STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        opened = null;
        reject(
          new Error(
            `CoinPosh net: IndexedDB "${dbName}" could not be opened (${request.error?.message ?? 'unknown error'}). Session and offline claims need it; check that site storage is allowed.`,
          ),
        );
      };
    });
    return opened;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return promisify(action(db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE)));
  };
  return {
    get: (key) => run<unknown>('readonly', (store) => store.get(key)),
    set: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key));
    },
  };
}
