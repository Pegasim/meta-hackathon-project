// Attention's own IndexedDB (separate from memory's): the append-only event log,
// the user's labels, the relevance cache and the shadow intents. Browser only;
// covered by the extension e2e.
// events: auto-increment, indexed by ts and type. labels, relevanceCache: keyed by key.
// intents: keyed by id.

const VERSION = 1;

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const events = db.createObjectStore("events", { autoIncrement: true });
      events.createIndex("ts", "ts");
      events.createIndex("type", "type");
      db.createObjectStore("labels", { keyPath: "key" });
      db.createObjectStore("relevanceCache", { keyPath: "key" });
      db.createObjectStore("intents", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    // A request resolves to its result, even when that is undefined (a missing key).
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

export async function openStore(name = "attention") {
  const db = await openDb(name);
  const get = (store, key) => tx(db, store, "readonly", (s) => s.get(key));
  const put = (store, item) => tx(db, store, "readwrite", (s) => s.put(item));
  const eventsSince = (ts) => tx(db, "events", "readonly", (s) => s.index("ts").getAll(IDBKeyRange.lowerBound(ts)));

  return {
    appendEvent: (record) => tx(db, "events", "readwrite", (s) => s.add(record)),
    eventsSince,
    async exportLog() {
      return { version: 1, exportedAt: new Date().toISOString(), events: await eventsSince(0) };
    },
    // Replaces the log, e.g. with the demo log.
    importLog: (log) =>
      tx(db, "events", "readwrite", (s) => {
        s.clear();
        for (const e of log.events ?? []) s.add(e);
      }),
    getLabel: (key) => get("labels", key),
    putLabel: (label) => put("labels", label),
    deleteLabel: (key) => tx(db, "labels", "readwrite", (s) => s.delete(key)),
    recentLabels: async (n) => {
      const all = await tx(db, "labels", "readonly", (s) => s.getAll());
      return all.sort((a, b) => b.ts - a.ts).slice(0, n);
    },
    getCached: (key) => get("relevanceCache", key),
    putCached: (entry) => put("relevanceCache", entry),
    // What was judged before the person's notes changed may no longer hold.
    clearCached: () => tx(db, "relevanceCache", "readwrite", (s) => s.clear()),
    putIntent: (intent) => put("intents", intent),
    async activeIntent() {
      const all = await tx(db, "intents", "readonly", (s) => s.getAll());
      return all.filter((i) => !i.doneAt && !i.expiredAt).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },
    async latestIntent() {
      const all = await tx(db, "intents", "readonly", (s) => s.getAll());
      return all.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },
    // Goals that ended (done, replaced or run out) and have no day summary yet (#46).
    async endedIntents() {
      const all = await tx(db, "intents", "readonly", (s) => s.getAll());
      return all.filter((i) => (i.doneAt || i.expiredAt) && !i.summarizedAt).sort((a, b) => a.createdAt - b.createdAt);
    },
    pruneBefore: (ts) =>
      tx(db, "events", "readwrite", (s) => {
        const req = s.index("ts").openCursor(IDBKeyRange.upperBound(ts, true));
        req.onsuccess = () => {
          const c = req.result;
          if (c) {
            c.delete();
            c.continue();
          }
        };
      }),
  };
}
