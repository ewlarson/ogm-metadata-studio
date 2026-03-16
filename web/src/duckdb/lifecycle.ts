import { resourceToJson } from "../aardvark/model";
import { queryResources } from "./queries";
import { getDuckDbContext, DB_FILENAME, INDEXEDDB_NAME, saveSnapshotToIndexedDB, saveToIndexedDB } from "./dbInit";

export async function saveDb() {
    const ctx = await getDuckDbContext();
    if (!ctx) return;

    // Force flush to virtual disk
    try { await ctx.conn.query("CHECKPOINT"); } catch (e) { console.warn("Checkpoint failed", e); }

    let savedDbFile = false;
    try {
        const buffer = await ctx.db.copyFileToBuffer(DB_FILENAME);
        if (buffer.byteLength === 0) {
            console.warn("Attempted to save 0-byte DB. Falling back to JSON snapshot persistence.");
        } else {
            await saveToIndexedDB(buffer);
            console.log("DB Saved to IndexedDB");
            savedDbFile = true;
        }
    } catch (e) {
        console.warn("Failed to persist DuckDB file. Falling back to JSON snapshot persistence.", e);
    }

    const resources = await queryResources();
    const snapshot = resources.map((resource) => resourceToJson(resource));
    await saveSnapshotToIndexedDB(snapshot);

    if (!savedDbFile) {
        console.log("Persisted JSON snapshot to IndexedDB.");
    }
}

export async function exportDbBlob(): Promise<Blob | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const buffer = await ctx.db.copyFileToBuffer(DB_FILENAME);
    // @ts-ignore
    return new Blob([buffer], { type: "application/octet-stream" });
}

export async function clearDuckDbFromIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(INDEXEDDB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn("Delete blocked");
    });
}
