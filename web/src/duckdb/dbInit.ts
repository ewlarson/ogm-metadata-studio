import * as duckdb from "@duckdb/duckdb-wasm";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { AardvarkJson } from "../aardvark/model";
import { ensureSchema } from "./schema";
import { backfillCentroidAndH3 } from "./backfill";

export const DB_FILENAME = "records.duckdb";
export const INDEXEDDB_NAME = "aardvark-duckdb";
export const INDEXEDDB_STORE = "database";
export const SNAPSHOT_KEY = "records.snapshot.json";

export interface DuckDbContext {
    db: duckdb.AsyncDuckDB;
    conn: duckdb.AsyncDuckDBConnection;
}

// Singleton connection
let cached: Promise<DuckDbContext | null> | null = null;

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

            await ensureSchema(conn);

            const snapshot = await loadSnapshotFromIndexedDB();
            if (snapshot !== null && snapshot.length > 0) {
                console.log(`[IndexedDB] Restoring ${snapshot.length} resources from JSON snapshot...`);
                const { importJsonData } = await import("./import");
                await importJsonData(snapshot, { skipSave: true });
            }

            // Backfill centroid + H3 for existing resources so map hexagons show (non-blocking)
            backfillCentroidAndH3().then(({ centroidFilled, h3Filled }) => {
                if (h3Filled > 0) console.log(`[Backfill] Centroid/H3: ${h3Filled} resources updated for map hexagons.`);
            }).catch((e) => console.warn("[Backfill] Failed:", e));
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
        const req = indexedDB.open(INDEXEDDB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
            console.log("[IndexedDB] Creating object store...");
            e.target.result.createObjectStore(INDEXEDDB_STORE);
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
        const req = indexedDB.open(INDEXEDDB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
            e.target.result.createObjectStore(INDEXEDDB_STORE);
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
        const req = indexedDB.open(INDEXEDDB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
            e.target.result.createObjectStore(INDEXEDDB_STORE);
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
        const req = indexedDB.open(INDEXEDDB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
            e.target.result.createObjectStore(INDEXEDDB_STORE);
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
