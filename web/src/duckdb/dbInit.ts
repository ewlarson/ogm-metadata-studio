import * as duckdb from "@duckdb/duckdb-wasm";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { AardvarkJson } from "../aardvark/model";
import { ensureSchema, DISTRIBUTIONS_TABLE, RESOURCES_MV_TABLE, RESOURCES_TABLE } from "./schema";
import { REPEATABLE_STRING_FIELDS } from "../aardvark/model";
import { backfillCentroidAndH3 } from "./backfill";

export const DB_FILENAME = "records.duckdb";
export const INDEXEDDB_NAME = "aardvark-duckdb";
export const INDEXEDDB_STORE = "database";
export const INDEXEDDB_RECORDS_STORE = "records";
export const SNAPSHOT_KEY = "records.snapshot.json";
const INDEXEDDB_VERSION = 2;
export const DUCKDB_RESTORE_PROGRESS_EVENT = "duckdb-restore-progress";
export const DUCKDB_RESTORED_EVENT = "duckdb-restored";

interface RestoreStatus {
    inProgress: boolean;
    processed: number;
    total: number;
}

export interface DuckDbContext {
    db: duckdb.AsyncDuckDB;
    conn: duckdb.AsyncDuckDBConnection;
}

// Singleton connection
let cached: Promise<DuckDbContext | null> | null = null;
let restoreStatus: RestoreStatus = { inProgress: false, processed: 0, total: 0 };
let restorePromise: Promise<void> | null = null;

function updateRestoreStatus(next: Partial<RestoreStatus>) {
    restoreStatus = { ...restoreStatus, ...next };
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORE_PROGRESS_EVENT, { detail: restoreStatus }));
    }
}

function notifyRestoreFinished() {
    restoreStatus = { ...restoreStatus, inProgress: false, processed: restoreStatus.total };
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORE_PROGRESS_EVENT, { detail: restoreStatus }));
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORED_EVENT, { detail: restoreStatus }));
    }
}

export function getDuckDbRestoreStatus(): RestoreStatus {
    return restoreStatus;
}

async function startBackgroundRestore(db: duckdb.AsyncDuckDB): Promise<void> {
    if (restorePromise) return restorePromise;

    restorePromise = (async () => {
        let records = await loadRecordsFromIndexedDB();
        if (records.length === 0) {
            const snapshot = await loadSnapshotFromIndexedDB();
            if (snapshot !== null && snapshot.length > 0) {
                console.log(`[IndexedDB] Migrating ${snapshot.length} resources from legacy JSON snapshot...`);
                await replaceRecordsInIndexedDB(snapshot);
                await clearLegacySnapshot();
                records = snapshot;
            }
        }

        if (records.length === 0) {
            updateRestoreStatus({ inProgress: false, processed: 0, total: 0 });
            notifyRestoreFinished();
            return;
        }

        console.log(`[IndexedDB] Restoring ${records.length} resources from IndexedDB records...`);
        updateRestoreStatus({ inProgress: true, processed: 0, total: records.length });

        const restoreConn = await db.connect();
        try {
            const { replaceAllJsonData } = await import("./import");
            await replaceAllJsonData(records, {
                skipSave: true,
                connOverride: restoreConn,
                onProgress: (processed, total) => updateRestoreStatus({ inProgress: true, processed, total }),
                // IndexedDB persistence currently stores resources only. Preserve any distributions
                // loaded from Parquet (or created via other means) so we don't wipe them out.
                preserveDistributions: true,
            });
        } finally {
            try {
                await restoreConn.close();
            } catch {
                // ignore
            }
        }

        backfillCentroidAndH3().then(({ h3Filled }) => {
            if (h3Filled > 0) console.log(`[Backfill] Centroid/H3: ${h3Filled} resources updated for map hexagons.`);
        }).catch((e) => console.warn("[Backfill] Failed:", e));

        notifyRestoreFinished();
    })().catch((error) => {
        console.error("Background restore failed", error);
        updateRestoreStatus({ inProgress: false });
        notifyRestoreFinished();
    });

    return restorePromise;
}

async function loadInitialDataFromParquet(
    db: duckdb.AsyncDuckDB,
    conn: duckdb.AsyncDuckDBConnection
): Promise<boolean> {
    try {
        // Try to load resources from a published Parquet artifact if present.
        // This is especially useful on GitHub Pages / first load / incognito where IndexedDB is empty.
        const basePath = (import.meta as any).env?.BASE_URL || "/";
        const absoluteBase =
            typeof window !== "undefined"
                ? new URL(basePath, window.location.href).toString()
                : basePath;

        const resourcesUrl = new URL("resources.parquet", absoluteBase).toString();
        const distributionsUrl = new URL("resource_distributions.parquet", absoluteBase).toString();

        const fetchParquet = async (url: string): Promise<Uint8Array | null> => {
            try {
                const res = await fetch(url, { cache: "no-cache" });
                if (!res.ok) return null;
                const buf = await res.arrayBuffer();
                if (!buf.byteLength) return null;
                return new Uint8Array(buf);
            } catch {
                return null;
            }
        };

        const [resourcesBuf, distributionsBuf] = await Promise.all([
            fetchParquet(resourcesUrl),
            fetchParquet(distributionsUrl),
        ]);

        if (!resourcesBuf && !distributionsBuf) {
            return false;
        }

        const tasks: Promise<void>[] = [];

        if (resourcesBuf) {
            tasks.push(
                (async () => {
                    const fileName = "bootstrap_resources.parquet";
                    await db.registerFileBuffer(fileName, resourcesBuf);
                    await conn.query(
                        `CREATE OR REPLACE TABLE ${RESOURCES_TABLE} AS SELECT * FROM read_parquet('${fileName}')`,
                    );
                    await db.dropFile(fileName);
                })(),
            );
        }

        if (distributionsBuf) {
            tasks.push(
                (async () => {
                    const fileName = "bootstrap_distributions.parquet";
                    await db.registerFileBuffer(fileName, distributionsBuf);
                    await conn.query(
                        `CREATE OR REPLACE TABLE ${DISTRIBUTIONS_TABLE} AS SELECT * FROM read_parquet('${fileName}')`,
                    );
                    await db.dropFile(fileName);
                })(),
            );
        }

        await Promise.all(tasks);
        console.log("[Parquet bootstrap] Loaded initial data from published Parquet artifacts.");
        return true;
    } catch (e) {
        console.warn("[Parquet bootstrap] Failed to load initial data from Parquet.", e);
        return false;
    }
}

async function rebuildDerivedIndexesFromResources(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
    try {
        const res = await conn.query(`SELECT * FROM ${RESOURCES_TABLE}`);
        const rows = res.toArray() as any[];
        if (rows.length === 0) return;

        await conn.query(`DELETE FROM ${RESOURCES_MV_TABLE}`);
        await conn.query(`DELETE FROM search_index`);

        const mvValues: string[] = [];
        const searchValues: string[] = [];

        for (const row of rows) {
            const id = row.id;
            if (!id) continue;
            const safeId = String(id).replace(/'/g, "''");

            for (const field of REPEATABLE_STRING_FIELDS) {
                const raw = (row as any)[field];
                const values = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
                for (const value of values) {
                    const s = String(value);
                    if (!s) continue;
                    const safeField = field.replace(/'/g, "''");
                    const safeVal = s.replace(/'/g, "''");
                    mvValues.push(`('${safeId}','${safeField}','${safeVal}')`);
                }
            }

            const parts: string[] = [];
            if (row.dct_title_s) parts.push(String(row.dct_title_s));
            if (Array.isArray(row.dct_description_sm)) parts.push(...row.dct_description_sm.map((v: any) => String(v)));
            if (Array.isArray(row.dct_subject_sm)) parts.push(...row.dct_subject_sm.map((v: any) => String(v)));
            if (Array.isArray(row.dcat_keyword_sm)) parts.push(...row.dcat_keyword_sm.map((v: any) => String(v)));
            const content = parts.join(" ").replace(/\n/g, " ");
            const safeContent = content.replace(/'/g, "''");
            searchValues.push(`('${safeId}','${safeContent}')`);
        }

        const chunkSize = 500;
        for (let i = 0; i < mvValues.length; i += chunkSize) {
            const chunk = mvValues.slice(i, i + chunkSize);
            if (chunk.length === 0) continue;
            await conn.query(
                `INSERT INTO ${RESOURCES_MV_TABLE} (id, field, val) VALUES ${chunk.join(",")}`
            );
        }

        for (let i = 0; i < searchValues.length; i += chunkSize) {
            const chunk = searchValues.slice(i, i + chunkSize);
            if (chunk.length === 0) continue;
            await conn.query(
                `INSERT INTO search_index (id, content) VALUES ${chunk.join(",")}`
            );
        }

        console.log("[Parquet bootstrap] Rebuilt resources_mv and search_index from resources.");
    } catch (e) {
        console.warn("[Parquet bootstrap] Failed to rebuild derived indexes from resources.", e);
    }
}

// Initialize DuckDB
export async function getDuckDbContext(): Promise<DuckDbContext | null> {
    if (cached) return cached;

    cached = (async () => {
        try {
            const db = await initializeDuckDB();

            // Run fully in memory in the browser; persistence is handled separately.
            await db.open({ path: ':memory:' });

            const conn = await db.connect();

            // Optimization & Extensions
            await conn.query("SET preserve_insertion_order=false");
            await conn.query("INSTALL fts; LOAD fts;");
            await conn.query("INSTALL spatial; LOAD spatial;");

            // First, try to bootstrap from any published Parquet artifacts.
            const loadedFromParquet = await loadInitialDataFromParquet(db, conn);
            // Then, ensure the schema is fully up to date (adds any missing columns/indexes).
            await ensureSchema(conn);
            // If we bootstrapped from Parquet, rebuild resources_mv and search_index
            // so search and multivalue facets work.
            if (loadedFromParquet) {
                await rebuildDerivedIndexesFromResources(conn);
            }
            void startBackgroundRestore(db);
            return { db, conn };
        } catch (err: any) {
            console.error("DuckDB initialization failed", err);
            return null;
        }
    })();

    return cached;
}

async function initializeDuckDB(): Promise<duckdb.AsyncDuckDB> {
    try {
        return await createDB(workerUrl, wasmUrl);
    } catch (err) {
        console.warn("DuckDB EH initialization failed, trying MVP...", err);
        try {
            return await createDB(mvpWorkerUrl, mvpWasmUrl);
        } catch (mvpErr) {
            console.error("DuckDB MVP initialization failed", mvpErr);
            throw err; // Throw the original error or the new one? Let's throw the original to keep context, or mvpErr.
        }
    }
}

async function createDB(wUrl: string, waUrl: string): Promise<duckdb.AsyncDuckDB> {
    const worker = new Worker(wUrl, { type: "module" });
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    try {
        await db.instantiate(waUrl);
        return db;
    } catch (err) {
        worker.terminate();
        throw err;
    }
}

// *** IndexedDB Helpers ***

export async function loadFromIndexedDB(): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        console.log(`[IndexedDB] Opening ${INDEXEDDB_NAME} to read...`);
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            console.log("[IndexedDB] Creating object store...");
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        }
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(DB_FILENAME);
            get.onsuccess = () => {
                if (get.result instanceof Uint8Array && get.result.byteLength > 0) {
                    console.log("[IndexedDB] Found valid DB.");
                    resolve(get.result);
                } else {
                    console.log("[IndexedDB] Found empty/invalid DB.");
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load DB", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB", req.error);
            resolve(null);
        };
    });
}

export async function loadSnapshotFromIndexedDB(): Promise<AardvarkJson[] | null> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(SNAPSHOT_KEY);
            get.onsuccess = () => {
                if (typeof get.result !== "string") {
                    resolve(null);
                    return;
                }

                try {
                    const parsed = JSON.parse(get.result);
                    resolve(Array.isArray(parsed) ? parsed as AardvarkJson[] : null);
                } catch (error) {
                    console.warn("[IndexedDB] Failed to parse snapshot", error);
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load snapshot", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for snapshot", req.error);
            resolve(null);
        };
    });
}

export async function saveToIndexedDB(buffer: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log(`[IndexedDB] Saving ${buffer.byteLength} bytes...`);
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        }
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
            const put = tx.objectStore(INDEXEDDB_STORE).put(buffer, DB_FILENAME);
            put.onsuccess = () => {
                console.log("[IndexedDB] Save successful.");
                resolve();
            };
            put.onerror = () => reject(put.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function saveSnapshotToIndexedDB(snapshot: AardvarkJson[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
            const put = tx.objectStore(INDEXEDDB_STORE).put(JSON.stringify(snapshot), SNAPSHOT_KEY);
            put.onsuccess = () => {
                console.log(`[IndexedDB] Snapshot saved (${snapshot.length} resources).`);
                resolve();
            };
            put.onerror = () => reject(put.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function loadRecordsFromIndexedDB(): Promise<AardvarkJson[]> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE], "readonly");
            const getAll = tx.objectStore(INDEXEDDB_RECORDS_STORE).getAll();
            getAll.onsuccess = () => {
                const results = Array.isArray(getAll.result) ? getAll.result as AardvarkJson[] : [];
                resolve(results);
            };
            getAll.onerror = () => {
                console.warn("[IndexedDB] Failed to load records store", getAll.error);
                resolve([]);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for records store", req.error);
            resolve([]);
        };
    });
}

export async function replaceRecordsInIndexedDB(records: AardvarkJson[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE, INDEXEDDB_STORE], "readwrite");
            const recordsStore = tx.objectStore(INDEXEDDB_RECORDS_STORE);
            const legacyStore = tx.objectStore(INDEXEDDB_STORE);

            const clear = recordsStore.clear();
            clear.onerror = () => reject(clear.error);
            clear.onsuccess = () => {
                for (const record of records) {
                    if (!record?.id) continue;
                    recordsStore.put(record);
                }
                legacyStore.delete(SNAPSHOT_KEY);
                legacyStore.delete(DB_FILENAME);
            };

            tx.oncomplete = () => {
                console.log(`[IndexedDB] Saved ${records.length} records to structured store.`);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function clearLegacySnapshot(): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
            const store = tx.objectStore(INDEXEDDB_STORE);
            store.delete(SNAPSHOT_KEY);
            store.delete(DB_FILENAME);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}
