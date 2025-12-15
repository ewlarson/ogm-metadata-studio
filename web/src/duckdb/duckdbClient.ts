// Thin wrapper around DuckDB-WASM with IndexedDB persistence.
// DuckDB is the single source of truth for all data operations.

import * as duckdb from "@duckdb/duckdb-wasm";
import { Resource, Distribution, resourceToJson } from "../aardvark/model";
import { resourceFromRow, extractDistributionsFromJson } from "../aardvark/mapping";

// Import DuckDB assets using Vite's ?url and ?worker syntax
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";

const INDEXEDDB_NAME = "aardvark-duckdb";
const INDEXEDDB_STORE = "database";
const INDEXEDDB_VERSION = 1;

export interface DuckDbContext {
  db: duckdb.AsyncDuckDB;
}

let cached: Promise<DuckDbContext> | null = null;
let duckdbAvailable = true;

export async function getDuckDbContext(): Promise<DuckDbContext | null> {
  if (!duckdbAvailable) return null;

  if (cached) {
    try {
      return await cached;
    } catch {
      duckdbAvailable = false;
      cached = null;
      return null;
    }
  }

  cached = (async () => {
    try {
      // Create worker from the imported URL
      const worker = new Worker(workerUrl, { type: "module" });

      const logger = new duckdb.ConsoleLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);

      // Instantiate with the imported WASM URL
      await db.instantiate(wasmUrl);

      // Try to restore from IndexedDB
      await restoreDuckDbFromIndexedDB(db);

      return { db };
    } catch (err) {
      duckdbAvailable = false;
      cached = null;
      console.warn("DuckDB-WASM failed to initialize", err);
      throw err;
    }
  })();

  try {
    return await cached;
  } catch {
    return null;
  }
}

// Query helpers for reading from DuckDB

export async function queryResources(): Promise<Resource[]> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) return [];
    conn = await (ctx.db as any).connect();

    // Check if resources table exists
    const tablesResult = await conn.query("SHOW TABLES");
    const tables = tablesResult.toArray().map((row: any) => row.name);
    if (!tables.includes("resources")) {
      return [];
    }

    // Query all resources
    const resourcesResult = await conn.query("SELECT * FROM resources ORDER BY id");
    const resourceRows = resourcesResult.toArray().map((row: any) => {
      // Handle Arrow Proxy row
      const r = row.toJSON ? row.toJSON() : row;
      const obj: Record<string, string> = {};
      for (const key of Object.keys(r)) {
        obj[key] = r[key] ?? "";
      }
      return obj;
    });

    // Query all distributions
    const distributionsResult = await conn.query("SELECT * FROM distributions ORDER BY resource_id, relation_key");
    const distributionRows = distributionsResult.toArray().map((row: any) => {
      const r = row.toJSON ? row.toJSON() : row;
      return {
        resource_id: r.resource_id ?? "",
        relation_key: r.relation_key ?? "",
        url: r.url ?? "",
      };
    });

    // Group distributions by resource_id
    const distributionsByResourceId = new Map<string, Distribution[]>();
    for (const dist of distributionRows) {
      if (!distributionsByResourceId.has(dist.resource_id)) {
        distributionsByResourceId.set(dist.resource_id, []);
      }
      distributionsByResourceId.get(dist.resource_id)!.push(dist);
    }

    // Convert rows to Resource objects
    const resources: Resource[] = [];
    for (const row of resourceRows) {
      const resourceId = row.id ? String(row.id) : "";
      if (!resourceId) continue; // Skip rows without ID
      const distributions = distributionsByResourceId.get(resourceId) || [];
      const resource = resourceFromRow(row, distributions);
      resources.push(resource);
    }

    return resources;
  } catch (err) {
    console.warn("DuckDB query failed, returning empty array", err);
    return [];
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

export async function queryResourceById(id: string): Promise<Resource | null> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) return null;
    conn = await (ctx.db as any).connect();

    const stmt = await conn.prepare("SELECT * FROM resources WHERE id = ?");
    const result = await stmt.query(id);
    const rows = result.toArray();
    await stmt.close();
    if (rows.length === 0) return null;

    const row = rows[0];
    const r = row.toJSON ? row.toJSON() : row;
    const obj: Record<string, string> = {};
    for (const key of Object.keys(r)) {
      obj[key] = r[key] ?? "";
    }

    // Get distributions for this resource
    const distStmt = await conn.prepare("SELECT * FROM distributions WHERE resource_id = ?");
    const distResult = await distStmt.query(id);
    await distStmt.close();
    const distributions = distResult.toArray().map((row: any) => {
      const r = row.toJSON ? row.toJSON() : row;
      return {
        resource_id: r.resource_id ?? "",
        relation_key: r.relation_key ?? "",
        url: r.url ?? "",
      };
    });

    return resourceFromRow(obj, distributions);
  } catch (err) {
    console.warn("DuckDB query by ID failed", err);
    return null;
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

export async function queryDistributions(resourceId?: string): Promise<Distribution[]> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) return [];
    conn = await (ctx.db as any).connect();

    const sql = resourceId
      ? "SELECT * FROM distributions WHERE resource_id = ? ORDER BY relation_key"
      : "SELECT * FROM distributions ORDER BY resource_id, relation_key";
    const params = resourceId ? [resourceId] : [];

    let result;
    if (resourceId) {
      const stmt = await conn.prepare(sql);
      result = await stmt.query(resourceId);
      await stmt.close();
    } else {
      result = await conn.query(sql);
    }
    return result.toArray().map((row: any) => {
      const r = row.toJSON ? row.toJSON() : row;
      return {
        resource_id: r.resource_id ?? "",
        relation_key: r.relation_key ?? "",
        url: r.url ?? "",
      };
    });
  } catch (err) {
    console.warn("DuckDB query distributions failed", err);
    return [];
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

// Import Parquet file from URL into a table
export async function importParquetFromUrl(url: string, tableName: string): Promise<boolean> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) return false;
    conn = await (ctx.db as any).connect();

    // Check if table exists, if so drop it
    await conn.query(`DROP TABLE IF EXISTS ${tableName}`);

    // Create table from parquet
    // DuckDB WASM supports reading from HTTP URLs directly if they are accessible (CORS)
    await conn.query(`CREATE TABLE ${tableName} AS SELECT * FROM read_parquet('${url}')`);

    // Ensure distributions table exists to prevent query errors
    await conn.query(`CREATE TABLE IF NOT EXISTS distributions (resource_id TEXT, relation_key TEXT, url TEXT)`);

    return true;
  } catch (err) {
    console.warn(`Failed to import parquet from ${url}`, err);
    return false;
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

// Execute arbitrary SQL query and return results as array of objects
export async function executeQuery(sql: string, params: any[] = []): Promise<Record<string, any>[]> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) return [];
    conn = await (ctx.db as any).connect();

    // For executeQuery, we usually run simple queries. 
    // If params are strictly used for binding, we try prepare.
    let result;
    if (params && params.length > 0) {
      const stmt = await conn.prepare(sql);
      result = await stmt.query(...params);
      await stmt.close();
    } else {
      result = await conn.query(sql);
    }
    const rows = result.toArray();
    return rows.map((row: any) => {
      const r = row.toJSON ? row.toJSON() : row;
      const obj: Record<string, any> = {};
      for (const key of Object.keys(r)) {
        obj[key] = r[key];
      }
      return obj;
    });
  } catch (err) {
    console.warn("DuckDB executeQuery failed", err);
    return [];
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

// Export DuckDB database to binary blob
export async function exportDuckDbToBlob(): Promise<Blob> {
  let conn: any = null;
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) {
      throw new Error("DuckDB not available");
    }
    conn = await (ctx.db as any).connect();

    try {
      // Export the database to a file
      await conn.query("EXPORT DATABASE '/tmp/export' (FORMAT PARQUET)");

      // For DuckDB-WASM, we need to use COPY TO to get the data
      // Actually, DuckDB-WASM doesn't support direct file export like that.
      // We'll need to serialize the tables manually or use a different approach.
      // Let's use COPY TO with a format we can read back.

      // Alternative: Serialize the entire database state
      // DuckDB-WASM doesn't have a direct "export database" API, so we'll
      // need to use COPY TO for each table and reconstruct, or use the connection's
      // ability to serialize.

      // For now, let's create a custom format: JSON with table schemas and data
      const tables = ["resources", "distributions"];
      const exportData: any = {};

      for (const table of tables) {
        const schemaResult = await conn.query(`DESCRIBE ${table}`);
        const schema = schemaResult.toArray().map((row: any) => {
          const r = row.toJSON ? row.toJSON() : row;
          return {
            column: r.column_name,
            type: r.column_type,
          };
        });

        const dataResult = await conn.query(`SELECT * FROM ${table}`);
        const data = dataResult.toArray().map((row: any) => {
          // row is likely an Arrow StructRow or Proxy
          if (row && typeof row.toJSON === 'function') {
            return row.toJSON();
          }
          return row;
        });

        exportData[table] = { schema, data };
      }

      // Convert to JSON string and then to blob
      const jsonStr = JSON.stringify(exportData, null, 2);
      return new Blob([jsonStr], { type: "application/json" });
    } catch (err) {
      console.error("Failed to export DuckDB", err);
      throw err;
    }
  } finally {
    try {
      await conn?.close?.();
    } catch {
      // Ignore close errors
    }
  }
}

// IndexedDB persistence functions

async function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) {
        db.createObjectStore(INDEXEDDB_STORE);
      }
    };
  });
}

export async function persistDuckDbToIndexedDB(db: duckdb.AsyncDuckDB): Promise<void> {
  try {
    // Export database state as JSON (using our export function)
    const conn: any = await (db as any).connect();
    try {
      const tables = ["resources", "distributions"];
      const exportData: any = {};

      // Check which tables exist
      const tablesResult = await conn.query("SHOW TABLES");
      const existingTables = tablesResult.toArray().map((row: any) => row.name);

      for (const table of tables) {
        if (!existingTables.includes(table)) {
          exportData[table] = { schema: [], data: [] };
          continue;
        }

        const schemaResult = await conn.query(`DESCRIBE ${table}`);
        const schema = schemaResult.toArray().map((row: any) => {
          const r = row.toJSON ? row.toJSON() : row;
          return {
            column: r.column_name,
            type: r.column_type,
          };
        });

        const dataResult = await conn.query(`SELECT * FROM ${table}`);
        const data = dataResult.toArray().map((row: any) => {
          if (row && typeof row.toJSON === 'function') {
            return row.toJSON();
          }
          return row;
        });

        exportData[table] = { schema, data };
      }

      const jsonStr = JSON.stringify(exportData);
      const idb = await openIndexedDB();
      const transaction = idb.transaction([INDEXEDDB_STORE], "readwrite");
      const store = transaction.objectStore(INDEXEDDB_STORE);
      await new Promise<void>((resolve, reject) => {
        const request = store.put(jsonStr, "state");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      idb.close();
      console.log("DuckDB state persisted to IndexedDB");
    } finally {
      await conn?.close?.();
    }
  } catch (err) {
    console.warn("Failed to persist DuckDB to IndexedDB", err);
    // Don't throw - persistence failure shouldn't break the app
  }
}

export async function restoreDuckDbFromIndexedDB(db: duckdb.AsyncDuckDB): Promise<boolean> {
  try {
    const idb = await openIndexedDB();
    const transaction = idb.transaction([INDEXEDDB_STORE], "readonly");
    const store = transaction.objectStore(INDEXEDDB_STORE);

    const jsonStr = await new Promise<string | null>((resolve, reject) => {
      const request = store.get("state");
      request.onsuccess = () => resolve(request.result as string | null);
      request.onerror = () => reject(request.error);
    });
    idb.close();

    if (!jsonStr) {
      return false; // No saved state
    }

    const exportData = JSON.parse(jsonStr);
    const conn: any = await (db as any).connect();

    try {
      // Recreate tables and insert data
      for (const [tableName, tableData] of Object.entries(exportData) as [string, any][]) {
        if (!tableData.schema || !tableData.data) continue;

        // Drop table if exists
        await conn.query(`DROP TABLE IF EXISTS ${tableName}`);

        if (tableData.schema.length === 0 || tableData.data.length === 0) {
          continue; // Empty table
        }

        // Create table from schema
        const columns = tableData.schema.map((col: any) => `"${col.column}" ${col.type}`).join(", ");
        await conn.query(`CREATE TABLE ${tableName} (${columns})`);

        // Insert data
        if (tableData.data.length > 0) {
          const firstRow = tableData.data[0];
          const columnNames = Object.keys(firstRow);
          const placeholders = columnNames.map(() => "?").join(", ");

          const stmt = await conn.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`);
          try {
            for (const row of tableData.data) {
              const values = columnNames.map((col) => row[col] ?? null);
              await stmt.query(...values);
            }
          } finally {
            await stmt.close();
          }
        }
      }

      console.log("DuckDB state restored from IndexedDB");
      return true;
    } finally {
      await conn?.close?.();
    }
  } catch (err) {
    console.warn("Failed to restore DuckDB from IndexedDB", err);
    return false;
  }
}

export async function clearDuckDbFromIndexedDB(): Promise<void> {
  try {
    const idb = await openIndexedDB();
    const transaction = idb.transaction([INDEXEDDB_STORE], "readwrite");
    const store = transaction.objectStore(INDEXEDDB_STORE);
    await new Promise<void>((resolve, reject) => {
      const request = store.delete("state");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    idb.close();
    console.log("DuckDB state cleared from IndexedDB");
  } catch (err) {
    console.warn("Failed to clear DuckDB from IndexedDB", err);
  }
}


