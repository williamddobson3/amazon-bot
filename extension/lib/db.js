import { DB_NAME, DB_VERSION, STORES } from './constants.js';

let dbInstance = null;

export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORES.ASIN_MASTER)) {
        const store = db.createObjectStore(STORES.ASIN_MASTER, { keyPath: 'asin' });
        store.createIndex('tier', 'tier', { unique: false });
        store.createIndex('nextScrapeAt', 'nextScrapeAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.OBSERVATIONS)) {
        const store = db.createObjectStore(STORES.OBSERVATIONS, { keyPath: ['asin', 'observedAt'] });
        store.createIndex('asin', 'asin', { unique: false });
        store.createIndex('observedAt', 'observedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.CONDITIONS)) {
        const store = db.createObjectStore(STORES.CONDITIONS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('asin', 'asin', { unique: false });
        store.createIndex('enabled', 'enabled', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.NOTIFICATIONS)) {
        const store = db.createObjectStore(STORES.NOTIFICATIONS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('asin', 'asin', { unique: false });
        store.createIndex('sentAt', 'sentAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- ASIN Master ----------

export async function getAsin(asin) {
  const store = await tx(STORES.ASIN_MASTER);
  return reqToPromise(store.get(asin));
}

export async function putAsin(data) {
  const store = await tx(STORES.ASIN_MASTER, 'readwrite');
  return reqToPromise(store.put(data));
}

export async function deleteAsin(asin) {
  const store = await tx(STORES.ASIN_MASTER, 'readwrite');
  return reqToPromise(store.delete(asin));
}

export async function getAllAsins() {
  const store = await tx(STORES.ASIN_MASTER);
  return reqToPromise(store.getAll());
}

export async function getAsinCount() {
  const store = await tx(STORES.ASIN_MASTER);
  return reqToPromise(store.count());
}

// ── Bulk helpers (one transaction per call) ────────────────
//
// Per-row putAsin / deleteAsin each open their own IDB transaction, which
// is ~1 ms of overhead per call. For reconciliation of a 2000-row list
// that's 2-4 seconds of pure transaction churn. The helpers below do the
// whole batch inside a single readwrite transaction — all writes commit
// together, ~50-100 ms total.
export async function bulkPutAsins(rows) {
  if (!rows || rows.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.ASIN_MASTER, 'readwrite');
    const store = t.objectStore(STORES.ASIN_MASTER);
    for (const row of rows) store.put(row);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  });
}

export async function bulkDeleteAsins(asins) {
  if (!asins || asins.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.ASIN_MASTER, 'readwrite');
    const store = t.objectStore(STORES.ASIN_MASTER);
    for (const asin of asins) store.delete(asin);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  });
}

// ---------- Observations ----------

export async function addObservation(obs) {
  const store = await tx(STORES.OBSERVATIONS, 'readwrite');
  return reqToPromise(store.put(obs));
}

export async function getObservations(asin, fromTs, toTs) {
  const store = await tx(STORES.OBSERVATIONS);
  const index = store.index('asin');
  const results = [];

  return new Promise((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(asin));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(results); return; }
      const rec = cursor.value;
      if ((!fromTs || rec.observedAt >= fromTs) && (!toTs || rec.observedAt <= toTs)) {
        results.push(rec);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function pruneObservations(olderThanTs) {
  const db = await openDB();
  const t = db.transaction(STORES.OBSERVATIONS, 'readwrite');
  const store = t.objectStore(STORES.OBSERVATIONS);
  const index = store.index('observedAt');

  return new Promise((resolve, reject) => {
    let deleted = 0;
    const req = index.openCursor(IDBKeyRange.upperBound(olderThanTs));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(deleted); return; }
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Conditions ----------

export async function addCondition(cond) {
  const store = await tx(STORES.CONDITIONS, 'readwrite');
  return reqToPromise(store.put(cond));
}

export async function getConditionsForAsin(asin) {
  const store = await tx(STORES.CONDITIONS);
  const index = store.index('asin');
  return reqToPromise(index.getAll(asin));
}

export async function getAllConditions() {
  const store = await tx(STORES.CONDITIONS);
  return reqToPromise(store.getAll());
}

export async function updateCondition(cond) {
  const store = await tx(STORES.CONDITIONS, 'readwrite');
  return reqToPromise(store.put(cond));
}

export async function deleteCondition(id) {
  const store = await tx(STORES.CONDITIONS, 'readwrite');
  return reqToPromise(store.delete(id));
}

// ---------- Notifications ----------

export async function addNotification(notif) {
  const store = await tx(STORES.NOTIFICATIONS, 'readwrite');
  return reqToPromise(store.put(notif));
}

export async function getRecentNotifications(limit = 50) {
  const store = await tx(STORES.NOTIFICATIONS);
  const index = store.index('sentAt');
  const results = [];

  return new Promise((resolve, reject) => {
    const req = index.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || results.length >= limit) { resolve(results); return; }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Settings ----------

export async function getSetting(key) {
  const store = await tx(STORES.SETTINGS);
  const rec = await reqToPromise(store.get(key));
  return rec ? rec.value : null;
}

export async function setSetting(key, value) {
  const store = await tx(STORES.SETTINGS, 'readwrite');
  return reqToPromise(store.put({ key, value }));
}
