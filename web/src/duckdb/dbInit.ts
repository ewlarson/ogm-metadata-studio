import * as duckdb from "@duckdb/duckdb-wasm";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import { ensureSchema } from "./schema";

export const DB_FILENAME = "records.duckdb";
export const INDEXEDDB_NAME = "aardvark-duckdb";
export const INDEXEDDB_STORE = "database";

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

            // Always start with memory to ensure we have a valid interface
            await db.open({ path: ':memory:' });

            // Attempt to load from IndexedDB
            const idbBuffer = await loadFromIndexedDB();

            if (idbBuffer) {
                console.log("Restoring DB from IndexedDB...");
                try {
                    await db.registerFileBuffer(DB_FILENAME, idbBuffer);
                } catch (e) {
                    console.warn("Failed to register IDB buffer", e);
                }
            } else {
                // Try server fetch if IDB failed/empty
                console.log("Fetching DB from server...");
                try {
                    const response = await fetch(`/${DB_FILENAME}`);
                    if (response.ok) {
                        const buffer = new Uint8Array(await response.arrayBuffer());
                        await db.registerFileBuffer(DB_FILENAME, buffer);
                        console.log("Opened DB from server.");
                    }
                } catch (e) {
                    console.warn("Server DB fetch failed or invalid", e);
                }
            }

            const conn = await db.connect();

            // Optimization & Extensions
            await conn.query("SET preserve_insertion_order=false");
            await conn.query("INSTALL fts; LOAD fts;");
            await conn.query("INSTALL spatial; LOAD spatial;");

            // Attach the persistent file. This creates it if it doesn't exist.
            // If it exists but is corrupt, ATTACH might fail.
            let attached = false;
            try {
                await conn.query(`ATTACH '${DB_FILENAME}'`);
                attached = true;
            } catch (err: any) {
                console.warn("Used existing file but ATTACH failed (corruption?). Starting fresh.", err);
                // Corruption? Drop file and retry (creates new)
                try { await db.dropFile(DB_FILENAME); } catch { /* ignore */ }
                try {
                    await conn.query(`ATTACH '${DB_FILENAME}'`);
                    attached = true;
                } catch (retryErr) {
                    console.error("Retried ATTACH failed", retryErr);
                }
            }

            if (attached) {
                // Set as default so queries don't need 'records.' prefix
                await conn.query(`USE records`);
            } else {
                console.warn("Could not ATTACH persistent DB. Running purely in-memory.");
            }

            await ensureSchema(conn);
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
                if (get.result && get.result.byteLength > 0) {
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
