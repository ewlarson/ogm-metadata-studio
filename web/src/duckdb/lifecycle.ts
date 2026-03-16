import { resourceToJson } from "../aardvark/model";
import { queryResources } from "./queries";
import { getDuckDbContext, INDEXEDDB_NAME, replaceRecordsInIndexedDB } from "./dbInit";

export async function saveDb() {
    const ctx = await getDuckDbContext();
    if (!ctx) return;

    const resources = await queryResources();
    const snapshot = resources.map((resource) => resourceToJson(resource));
    await replaceRecordsInIndexedDB(snapshot);
    console.log("Persisted structured IndexedDB records.");
}

export async function exportDbBlob(): Promise<Blob | null> {
    return null;
}

export async function clearDuckDbFromIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(INDEXEDDB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn("Delete blocked");
    });
}
