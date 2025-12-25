import * as duckdb from "@duckdb/duckdb-wasm";
import { Resource, resourceToJson, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS, CSV_HEADER_MAPPING, Distribution, REFERENCE_URI_MAPPING } from "../aardvark/model";
import { resourceFromRow } from "../aardvark/mapping";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

import JSZip from "jszip";

const DB_FILENAME = "records.duckdb";
const INDEXEDDB_NAME = "aardvark-duckdb";
const INDEXEDDB_STORE = "database";

export interface DuckDbContext {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

let cached: Promise<DuckDbContext | null> | null = null;
let initError: Error | null = null;

// Initialize DuckDB
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
        try { await db.dropFile(DB_FILENAME); } catch { }
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
      initError = err;
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

async function ensureSchema(conn: duckdb.AsyncDuckDBConnection) {
  // resources table (scalars)
  const scalarCols = SCALAR_FIELDS.map(f => `"${f}" VARCHAR`).join(", ");
  // Add GEOMETRY column for DuckDB Spatial
  // Note: We use 'geom' as the column name.
  await conn.query(`CREATE TABLE IF NOT EXISTS resources (${scalarCols}, geom GEOMETRY)`);

  // Ensure geom column exists (migration)
  try { await conn.query(`ALTER TABLE resources ADD COLUMN geom GEOMETRY`); } catch { }

  // resources_mv (multivalue)
  await conn.query(`CREATE TABLE IF NOT EXISTS resources_mv (id VARCHAR, field VARCHAR, val VARCHAR)`);

  // Backfill GEOMETRY from dcat_bbox if missing
  // This ensures existing data is indexed without re-import
  try {
    const needsBackfill = await conn.query("SELECT count(*) as c FROM resources WHERE geom IS NULL AND dcat_bbox LIKE 'ENVELOPE(%'");
    if (Number(needsBackfill.toArray()[0].c) > 0) {
      console.log("Backfilling spatial index...");
      await conn.query(`
          UPDATE resources
          SET geom = ST_MakeEnvelope(
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
          )
          WHERE geom IS NULL AND dcat_bbox LIKE 'ENVELOPE(%'
        `);
      console.log("Spatial backfill complete.");
    }
  } catch (e) {
    console.warn("Spatial backfill failed", e);
  }

  // distributions
  await conn.query(`CREATE TABLE IF NOT EXISTS distributions (resource_id VARCHAR, relation_key VARCHAR, url VARCHAR, label VARCHAR)`);

  // Ensure label column exists (migration)
  try { await conn.query(`ALTER TABLE distributions ADD COLUMN label VARCHAR`); } catch { }

  // resources_image_service (Thumbnail Cache)
  try {
    const resImgInfo = await conn.query(`DESCRIBE resources_image_service`);
    const hasData = resImgInfo.toArray().some((r: any) => r.column_name === 'data');
    if (!hasData) {
      console.log("Migrating resources_image_service: Dropping old table");
      await conn.query(`DROP TABLE resources_image_service`);
    }
  } catch (e) { /* Table likely doesn't exist, ignore */ }

  await conn.query(`CREATE TABLE IF NOT EXISTS resources_image_service (id VARCHAR PRIMARY KEY, data VARCHAR, last_updated BIGINT)`);

  // static_maps (Static Map Cache)
  try {
    const staticMapInfo = await conn.query(`DESCRIBE static_maps`);
    const hasData = staticMapInfo.toArray().some((r: any) => r.column_name === 'data');
    if (!hasData) {
      console.log("Migrating static_maps: Dropping old table");
      await conn.query(`DROP TABLE static_maps`);
    }
  } catch (e) { /* Table likely doesn't exist, ignore */ }

  await conn.query(`CREATE TABLE IF NOT EXISTS static_maps (id VARCHAR PRIMARY KEY, data VARCHAR, last_updated BIGINT)`);

  // search_index (FTS)
  await conn.query(`CREATE TABLE IF NOT EXISTS search_index (id VARCHAR, content VARCHAR)`);
  try { await conn.query(`PRAGMA create_fts_index('search_index', 'id', 'content')`); } catch { }
}

export async function zipResources(resources: Resource[]): Promise<Blob> {
  const zip = new JSZip();
  let count = 0;
  for (const res of resources) {
    if (!res.id) continue;
    const json = resourceToJson(res);
    zip.file(`${res.id}.json`, JSON.stringify(json, null, 2));
    count++;
  }
  console.log(`Zipped ${count} resources.`);
  return await zip.generateAsync({ type: "blob" });
}

function csvResources(resources: Resource[]): Blob {
  const fields = [...SCALAR_FIELDS, ...REPEATABLE_STRING_FIELDS];

  // Invert mapping: SolrField -> FriendlyHeader
  const fieldToLabel: Record<string, string> = {};
  for (const [label, field] of Object.entries(CSV_HEADER_MAPPING)) {
    fieldToLabel[field] = label;
  }

  const headerRow = fields.map(f => {
    // Simple CSV escaping for headers just in case
    const label = fieldToLabel[f] || f;
    if (label.includes(",")) return `"${label}"`;
    return label;
  }).join(",");

  const rows = resources.map(res => {
    return fields.map(h => {
      const val = (res as any)[h];
      if (Array.isArray(val)) return `"${val.join("|").replace(/"/g, '""')}"`;
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(",");
  });
  const csvContent = [headerRow, ...rows].join("\n");
  return new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
}

async function fetchResourcesByIds(conn: duckdb.AsyncDuckDBConnection, ids: string[]): Promise<Resource[]> {
  if (ids.length === 0) return [];

  const idList = ids.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");

  // Check if ID list is too long? DuckDB usually ok ~10k.

  const scalarSql = `SELECT * FROM resources WHERE id IN (${idList})`;
  const mvSql = `SELECT * FROM resources_mv WHERE id IN (${idList})`;
  const distSql = `SELECT * FROM distributions WHERE resource_id IN (${idList})`;
  const thumbSql = `SELECT * FROM resources_image_service WHERE id IN (${idList})`;

  const [scalarRes, mvRes, distRes, thumbRes] = await Promise.all([
    conn.query(scalarSql),
    conn.query(mvSql),
    conn.query(distSql),
    conn.query(thumbSql)
  ]);

  const scalarRows = scalarRes.toArray();

  const mvMap = new Map<string, any[]>();
  for (const r of mvRes.toArray()) {
    if (!mvMap.has(r.id)) mvMap.set(r.id, []);
    mvMap.get(r.id)?.push(r);
  }

  const distMap = new Map<string, any[]>();
  for (const r of distRes.toArray()) {
    if (!distMap.has(r.resource_id)) distMap.set(r.resource_id, []);
    distMap.get(r.resource_id)?.push(r);
  }

  const thumbMap = new Map<string, string>();
  for (const r of thumbRes.toArray()) {
    // If we have cached data, we can create an object URL here?
    // Doing it for 20 items is fine.
    try {
      const base64 = r.data;
      if (base64) {
        // Decoding in bulk might be heavy?
        // Let's do it lazily or just handle it here. 
        // Actually implementation_plan says "Update useThumbnailQueue to fetch...".
        // But if we want instant load on refresh, we need it here.
        // But wait, getThumbnail creates ObjectURL. 
        // We should use `getThumbnail` or replicate logic here.

        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        thumbMap.set(r.id, URL.createObjectURL(blob));
      }
    } catch (e) {
      console.warn("Failed to decode thumb for " + r.id);
    }
  }

  const resources: Resource[] = [];
  for (const row of scalarRows) {
    const r: any = { ...row };
    const mvs = mvMap.get(r.id) || [];
    for (const m of mvs) {
      if (!r[m.field]) r[m.field] = [];
      r[m.field].push(m.val);
    }
    const resObj = resourceFromRow(r, distMap.get(r.id) || []);
    // Attach thumbnail if cached
    if (thumbMap.has(resObj.id)) {
      resObj.thumbnail = thumbMap.get(resObj.id);
    }
    resources.push(resObj);
  }

  // Sort resources to match input IDs order (CRITICAL for Search Sorting)
  const idMap = new Map(resources.map(r => [r.id, r]));
  return ids.map(id => idMap.get(id)).filter(r => r !== undefined) as Resource[];
}

export async function upsertThumbnail(id: string, data: Blob): Promise<void> {
  const ctx = await getDuckDbContext();
  if (!ctx) return;
  const { conn } = ctx;

  const buf = await data.arrayBuffer();
  // Base64 encode
  let binary = '';
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const now = Date.now();

  try {
    // Overwrite existing
    await conn.query(`DELETE FROM resources_image_service WHERE id = '${id}'`);
    await conn.query(`INSERT INTO resources_image_service (id, data, last_updated) VALUES ('${id}', '${base64}', ${now})`);
  } catch (e) {
    console.warn("Failed to cache thumbnail", e);
  }
}

export async function getThumbnail(id: string): Promise<string | null> {
  const ctx = await getDuckDbContext();
  if (!ctx) return null;
  try {
    const result = await ctx.conn.query(`SELECT data FROM resources_image_service WHERE id = '${id}'`);
    if (result.numRows === 0) return null;

    const row = result.get(0);
    if (!row || !row['data']) return null;

    const base64 = row['data'];
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' }); // Assume JPEG or PNG?
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn("Failed to load thumbnail", e);
    return null;
  }
}

export function compileFacetedWhere(req: FacetedSearchRequest, omitField: string | null = null, emitGlobal: boolean = true): { sql: string } {
  let clauses: string[] = ["1=1"];

  if (emitGlobal && req.q && req.q.trim()) {
    const k = req.q.replace(/'/g, "''");
    // Use ILIKE on flattened content - robust and fast enough (Avoiding FTS sync issues)
    // We maintain 'id' in clauses for potential fallback? unnest? 
    // Actually, simply query search_index
    clauses.push(`id IN (SELECT id FROM search_index WHERE content ILIKE '%${k}%')`);
  }

  if (emitGlobal && req.bbox) {
    const { minX, minY, maxX, maxY } = req.bbox;
    clauses.push(`ST_Intersects(geom, ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY}))`);
  }

  if (req.filters) {
    for (const [field, condition] of Object.entries(req.filters)) {
      if (field === omitField) continue;
      const isScalar = SCALAR_FIELDS.includes(field);

      if (condition.any && Array.isArray(condition.any) && condition.any.length > 0) {
        const values = condition.any.map((v: string) => `'${String(v).replace(/'/g, "''")}'`).join(",");
        if (isScalar) {
          clauses.push(`"${field}" IN (${values})`);
        } else {
          clauses.push(`EXISTS (
                    SELECT 1 FROM resources_mv m 
                    WHERE m.id = resources.id 
                    AND m.field = '${field}' 
                    AND m.val IN (${values})
                )`);
        }
      }

      if (condition.all && Array.isArray(condition.all) && condition.all.length > 0) {
        const values = condition.all.map((v: string) => `'${String(v).replace(/'/g, "''")}'`).join(",");
        const count = condition.all.length;
        clauses.push(`(
                SELECT count(DISTINCT m.val) 
                FROM resources_mv m
                WHERE m.id = resources.id
                AND m.field = '${field}'
                AND m.val IN (${values})
             ) = ${count}`);
      }

      if (condition.gte !== undefined) clauses.push(`CAST("${field}" AS INTEGER) >= ${Number(condition.gte)}`);
      if (condition.lte !== undefined) clauses.push(`CAST("${field}" AS INTEGER) <= ${Number(condition.lte)}`);
    }
  }
  return { sql: clauses.join(" AND ") };
}

export async function exportAardvarkJsonZip(): Promise<Blob | null> {
  const resources = await queryResources();
  return zipResources(resources);
}

export async function exportFilteredResults(req: FacetedSearchRequest, format: 'json' | 'csv'): Promise<Blob | null> {
  const ctx = await getDuckDbContext();
  if (!ctx) return null;
  const { conn } = ctx;

  // 1. Get IDs
  const where = compileFacetedWhere(req).sql;
  const idsRes = await conn.query(`SELECT id FROM resources WHERE ${where}`);
  const ids = idsRes.toArray().map((r: any) => r.id);

  console.log(`Exporting ${ids.length} resources as ${format}...`);

  // 2. Fetch Data
  const resources = await fetchResourcesByIds(conn, ids);

  // 3. Format
  if (format === 'json') {
    return zipResources(resources);
  } else {
    return csvResources(resources);
  }
}
export async function saveDb() {
  const ctx = await getDuckDbContext();
  if (!ctx) return;

  // Force flush to virtual disk
  try { await ctx.conn.query("CHECKPOINT"); } catch (e) { console.warn("Checkpoint failed", e); }

  const buffer = await ctx.db.copyFileToBuffer(DB_FILENAME);
  if (buffer.byteLength === 0) {
    console.warn("Attempted to save 0-byte DB. Skipping.");
    return;
  }
  await saveToIndexedDB(buffer);
  console.log("DB Saved to IndexedDB");
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

// *** Query Functions ***

export interface SearchResult {
  resources: Resource[];
  total: number;
}

export async function searchResources(
  page: number = 1,
  pageSize: number = 10,
  sortBy: string = "id",
  sortOrder: "asc" | "desc" = "asc",
  search: string = ""
): Promise<SearchResult> {
  const ctx = await getDuckDbContext();
  if (!ctx) return { resources: [], total: 0 };
  const { conn } = ctx;

  // Build WHERE clause
  let where = "1=1";
  if (search) {
    const safeSearch = search.replace(/'/g, "''");
    where += ` AND (
        id ILIKE '%${safeSearch}%' OR 
        dct_title_s ILIKE '%${safeSearch}%' OR
        EXISTS (SELECT 1 FROM resources_mv mv WHERE mv.id = resources.id AND mv.val ILIKE '%${safeSearch}%')
    )`;
  }

  // Count
  const countRes = await conn.query(`SELECT COUNT(*) as total FROM resources WHERE ${where}`);
  const total = Number(countRes.toArray()[0].total);

  // Fetch IDs first for paging
  const safeSort = sortBy.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = (page - 1) * pageSize;

  const idsSql = `
    SELECT id FROM resources 
    WHERE ${where}
    ORDER BY "${safeSort}" ${sortOrder.toUpperCase()}
    LIMIT ${pageSize} OFFSET ${offset}
`;
  const idsRes = await conn.query(idsSql);
  const ids = idsRes.toArray().map((r: any) => r.id);

  if (ids.length === 0) return { resources: [], total };

  // Now fetch full data for these IDs
  const idList = ids.map((id: string) => `'${id}'`).join(",");

  const scalarSql = `SELECT * FROM resources WHERE id IN (${idList})`;
  const mvSql = `SELECT * FROM resources_mv WHERE id IN (${idList})`;
  const distSql = `SELECT * FROM distributions WHERE resource_id IN (${idList})`;

  const [scalarRes, mvRes, distRes] = await Promise.all([
    conn.query(scalarSql),
    conn.query(mvSql),
    conn.query(distSql)
  ]);

  const scalars = scalarRes.toArray();
  const mvs = mvRes.toArray();
  const dists = distRes.toArray();

  const mvMap = new Map<string, Array<{ field: string, val: string }>>();
  for (const row of mvs) {
    if (!mvMap.has(row.id)) mvMap.set(row.id, []);
    mvMap.get(row.id)?.push(row);
  }

  const distMap = new Map<string, any[]>();
  for (const row of dists) {
    if (!distMap.has(row.resource_id)) distMap.set(row.resource_id, []);
    distMap.get(row.resource_id)?.push(row);
  }

  const resourceMap = new Map<string, Resource>();
  for (const row of scalars) {
    const r: any = {};
    for (const k of SCALAR_FIELDS) {
      r[k] = row[k];
    }

    const myMvs = mvMap.get(r.id) || [];
    for (const mv of myMvs) {
      if (!r[mv.field]) r[mv.field] = [];
      r[mv.field].push(mv.val);
    }

    const myDists = distMap.get(r.id) || [];
    resourceMap.set(r.id, resourceFromRow(r, myDists));
  }

  const resources = ids.map((id: string) => resourceMap.get(id)!).filter(Boolean);

  return { resources, total };
}

export async function queryResources(): Promise<Resource[]> {
  const { resources } = await searchResources(1, 100000);
  return resources;
}

export async function getDistinctValues(
  column: string,
  search: string = "",
  limit: number = 20
): Promise<string[]> {
  const ctx = await getDuckDbContext();
  if (!ctx) return [];
  const { conn } = ctx;

  const safeCol = column.replace(/[^a-zA-Z0-9_]/g, "");
  const safeSearch = search.replace(/'/g, "''");

  // Check if scalar or MV
  let sql = "";
  if (SCALAR_FIELDS.includes(safeCol) || safeCol === 'id') {
    sql = `
    SELECT DISTINCT "${safeCol}" as val 
    FROM resources 
    WHERE "${safeCol}" ILIKE '%${safeSearch}%'
    LIMIT ${limit}
  `;
  } else {
    // MV
    sql = `
    SELECT DISTINCT val 
    FROM resources_mv 
    WHERE field = '${safeCol}' AND val ILIKE '%${safeSearch}%'
    LIMIT ${limit}
  `;
  }

  try {
    const res = await conn.query(sql);
    return res.toArray().map((r: any) => String(r.val));
  } catch (e) {
    console.warn("getDistinctValues failed", e);
    return [];
  }
}

export async function executeQuery(sql: string): Promise<Record<string, any>[]> {
  const ctx = await getDuckDbContext();
  if (!ctx) return [];
  const { conn } = ctx;
  try {
    const res = await conn.query(sql);
    return res.toArray().map((row: any) => {
      const r: any = {};
      // Arrow row to obj
      if (row.toJSON) return row.toJSON();
      // manual
      for (const key of Object.keys(row)) {
        r[key] = row[key];
      }
      return r;
    });
  } catch (e) {
    console.warn("executeQuery failed", e);
    return [];
  }
}


export async function queryResourceById(id: string): Promise<Resource | null> {
  const ctx = await getDuckDbContext();
  if (!ctx) return null;
  const { conn } = ctx;

  const safeId = id.replace(/'/g, "''");

  // Check if ID exists
  const res = await conn.query(`SELECT id FROM resources WHERE id = '${safeId}'`);
  if (res.toArray().length === 0) return null;

  // Fetch full
  const scalarSql = `SELECT * FROM resources WHERE id = '${safeId}'`;
  const mvSql = `SELECT * FROM resources_mv WHERE id = '${safeId}'`;
  const distSql = `SELECT * FROM distributions WHERE resource_id = '${safeId}'`;

  const [scalarRes, mvRes, distRes] = await Promise.all([
    conn.query(scalarSql),
    conn.query(mvSql),
    conn.query(distSql)
  ]);

  const scalarRows = scalarRes.toArray();
  if (scalarRows.length === 0) return null;
  const scalarRow = scalarRows[0];

  const mvs = mvRes.toArray();
  const dists = distRes.toArray();

  const r: any = {};
  for (const k of SCALAR_FIELDS) {
    r[k] = scalarRow[k];
  }

  for (const mv of mvs) {
    if (!r[mv.field]) r[mv.field] = [];
    r[mv.field].push(mv.val);
  }

  return resourceFromRow(r, dists);
}

// *** Import Function ***

export async function importCsv(file: File): Promise<{ success: boolean, message: string, count?: number }> {
  const ctx = await getDuckDbContext();
  if (!ctx) return { success: false, message: `DB not available${initError ? `: ${initError.message}` : ""}` };
  const { db, conn } = ctx;

  try {
    await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);

    const tempTable = `temp_${Date.now()}`;
    await conn.query(`CREATE TABLE ${tempTable} AS SELECT * FROM read_csv_auto('${file.name}', all_varchar=true)`);

    const schemaRes = await conn.query(`DESCRIBE ${tempTable}`);
    // Verify headers to detect type
    const headerRes = await conn.query(`SELECT * FROM ${tempTable} LIMIT 0`);
    const csvHeaders = headerRes.schema.fields.map(f => f.name);

    console.log("CSV Headers:", csvHeaders);

    // Heuristic: Is this a Distributions CSV?
    // Expect: ID, Type, URL. (Label optional). And commonly NOT "Title" or "dct_title_s"
    const hasDistId = csvHeaders.includes("ID");
    const hasType = csvHeaders.includes("Type");
    const hasUrl = csvHeaders.includes("URL");
    const hasTitle = csvHeaders.includes("Title") || csvHeaders.includes("dct_title_s");

    if (hasDistId && hasType && hasUrl && !hasTitle) {
      console.log("Detected Distributions CSV.");

      // Insert into distributions table
      // Schema: resource_id | relation_key | url
      // CSV: ID | Type | URL

      // Count before
      const preCount = await conn.query("SELECT count(*) as c FROM distributions");
      console.log(`Rows in distributions before insert: ${preCount.toArray()[0].c}`);

      await conn.query(`
        INSERT INTO distributions (resource_id, relation_key, url)
        SELECT "ID", "Type", "URL" FROM ${tempTable}
    `);

      const postCount = await conn.query("SELECT count(*) as c FROM distributions");
      const added = Number(postCount.toArray()[0].c) - Number(preCount.toArray()[0].c);

      await saveDb();

      return { success: true, message: `Imported ${added} distributions.`, count: added };
    }

    // Otherwise, assume Resources CSV (existing logic)
    console.log("Detected Resources CSV.");

    const columns = schemaRes.toArray().map((r: any) => r.column_name);

    // Helper to find column in CSV (either exact or mapped)
    const findCsvCol = (targetField: string): string | undefined => {
      if (csvHeaders.includes(targetField)) return targetField;
      // Search mapping
      const mappedEntry = Object.entries(CSV_HEADER_MAPPING).find(([k, v]) => v === targetField);
      if (mappedEntry && csvHeaders.includes(mappedEntry[0])) return mappedEntry[0];
      return undefined;
    };

    const scalarColsToInsert: { target: string, source: string }[] = [];
    for (const field of SCALAR_FIELDS) {
      const source = findCsvCol(field);
      if (source) {
        scalarColsToInsert.push({ target: field, source });
      }
    }

    // 1. Insert Scalars
    if (scalarColsToInsert.length > 0) {
      if (!scalarColsToInsert.some(c => c.target === 'id')) {
        throw new Error("CSV missing 'id' column");
      }

      const targetCols = scalarColsToInsert.map(c => `"${c.target}"`).join(",");
      const sourceCols = scalarColsToInsert.map(c => `"${c.source}"`).join(",");

      console.log(`Inserting columns: ${targetCols} from sources: ${sourceCols}`);

      // We need to DELETE existing resources that match the new IDs to avoid unique constraints (if any) or stale data
      // For now, let's just do INSERT OR REPLACE if possible? DuckDB supports generic INSERT OR REPLACE?
      // Actually standard SQL is DELETE then INSERT or UPSERT.
      // Let's use the delete-then-insert strategy for the batch? 
      // Or just DELETE * WHERE id IN (SELECT id FROM temp)

      const idSource = scalarColsToInsert.find(c => c.target === 'id')!.source;
      await conn.query(`DELETE FROM resources WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`);

      // Also delete from MVs and Distributions if we are replacing the resource?
      // Yes, if we are re-importing the resource, we should probably clear its old MVs.
      // Distributions... maybe keep them if this is just a Metadata Update? 
      // Risky. Usually "Full Import" implies replacement.
      // But user specifically asked for "Distributions Import".
      // If this is "Resources Import", we should probably clear associated MVs.
      await conn.query(`DELETE FROM resources_mv WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`);
      // Warning: We do NOT delete distributions here, assuming Resources csv only updates metadata.

      const preCount = await conn.query("SELECT count(*) as c FROM resources");
      console.log(`Rows in resources before insert: ${preCount.toArray()[0].c}`);

      // Explicit insert
      await conn.query(`INSERT INTO resources (${targetCols}) SELECT ${sourceCols} FROM ${tempTable}`);

      const postCount = await conn.query("SELECT count(*) as c FROM resources");
      console.log(`Rows in resources after insert: ${postCount.toArray()[0].c}`);

      // Post-insert: Populate GEOMETRY column from dcat_bbox (ENVELOPE format)
      // dcat_bbox format: ENVELOPE(minX, maxX, maxY, minY) -> (w, e, n, s)
      // ST_MakeEnvelope(minX, minY, maxX, maxY) -> (w, s, e, n)
      try {
        await conn.query(`
          UPDATE resources
          SET geom = ST_MakeEnvelope(
            CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE), -- w (minX)
            CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE), -- s (minY)
            CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE), -- e (maxX)
            CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)  -- n (maxY)
          )
          WHERE dcat_bbox LIKE 'ENVELOPE(%'
          AND id IN (SELECT "${idSource}" FROM ${tempTable})
        `);
      } catch (e) {
        console.warn("Failed to populate geom from dcat_bbox", e);
      }

    } else {
      console.warn("No scalar columns to insert!");
    }

    // 2. Insert MV
    for (const field of REPEATABLE_STRING_FIELDS) {
      const sourceCol = findCsvCol(field);
      // Skip if source column doesn't exist in CSV
      if (!sourceCol) continue;

      // We need ID for MV delete/insert. Assuming ID is always present if we got past scalar check.
      const idCol = findCsvCol('id');
      if (!idCol) continue; // Should have been caught above

      await conn.query(`
            DELETE FROM resources_mv 
            WHERE field = '${field}' 
            AND id IN (SELECT "${idCol}" FROM ${tempTable})
        `);

      await conn.query(`
            INSERT INTO resources_mv (id, field, val)
            SELECT 
                "${idCol}" as id, 
                '${field}' as field, 
                unnest(string_split("${sourceCol}", '|')) as val
            FROM ${tempTable}
            WHERE "${sourceCol}" IS NOT NULL AND "${sourceCol}" != ''
        `);
    }

    // 3. Distributions
    if (columns.includes("dct_references_s")) {
      await conn.query(`
            DELETE FROM distributions
            WHERE resource_id IN (SELECT id FROM ${tempTable})
        `);

      const refs = await conn.query(`SELECT id, dct_references_s FROM ${tempTable} WHERE dct_references_s IS NOT NULL`);
      for (const row of refs.toArray()) {
        const id = row.id;
        try {
          const json = JSON.parse(row.dct_references_s);
          // Insert each key-value
          const stmt = await conn.prepare(`INSERT INTO distributions VALUES (?, ?, ?)`);
          for (const [key, url] of Object.entries(json)) {
            await stmt.query(id, key, String(url));
          }
          await stmt.close();
        } catch (e) {
          console.warn(`Failed to parse references for ${id}`, e);
        }
      }
    }

    const result = await conn.query(`SELECT count(*) as count FROM ${tempTable}`);
    const rowCount = Number(result.toArray()[0].count);
    console.log(`Imported ${rowCount} rows from ${file.name}`);

    await conn.query(`DROP TABLE ${tempTable}`);
    await saveDb();

    return { success: true, message: `Imported ${columns.length} columns and ${rowCount} rows.`, count: rowCount };

  } catch (err: any) {
    console.error("Import failed", err);
    return { success: false, message: err.message || "Import failed" };
  }
}

export interface ValidationIssue {
  row: number;
  col: string;
  reason: string;
}

export interface DistributionResult {
  distributions: any[]; // Joined with resource title
  total: number;
}

export async function queryDistributions(
  page: number = 1,
  pageSize: number = 20,
  sortBy: string = "resource_id",
  sortOrder: "asc" | "desc" = "asc",
  keyword: string = ""
): Promise<DistributionResult> {
  const ctx = await getDuckDbContext();
  if (!ctx) return { distributions: [], total: 0 };
  const { conn } = ctx;

  const offset = (page - 1) * pageSize;

  let whereClause = "";
  if (keyword) {
    const k = keyword.replace(/'/g, "''").toLowerCase();
    // search in resource_id, relation_key, url, and title (via join)
    // Note: r.dct_title_s is joined below.
    // BUT for countQuery we also need the join if we filter by title! 
    // AND for filtering by resource fields we generally need the join.
    // So we must propagate the JOIN to the count query if filtering, 
    // OR just duplicate logic.

    whereClause = `
    WHERE lower(d.resource_id) LIKE '%${k}%' 
       OR lower(d.relation_key) LIKE '%${k}%'
       OR lower(d.url) LIKE '%${k}%'
       OR lower(r.dct_title_s) LIKE '%${k}%'
  `;
  }

  // Join with resources to get title
  const dataQuery = `
  SELECT 
      d.resource_id, 
      d.relation_key, 
      d.url, 
      d.label,
      r.dct_title_s
  FROM distributions d
  LEFT JOIN resources r ON d.resource_id = r.id
  ${whereClause}
  ORDER BY "${sortBy}" ${sortOrder}
  LIMIT ${pageSize} OFFSET ${offset}
`;

  const countQuery = `
  SELECT count(*) as c 
  FROM distributions d 
  LEFT JOIN resources r ON d.resource_id = r.id
  ${whereClause}
`;

  const [dataRes, countRes] = await Promise.all([
    conn.query(dataQuery),
    conn.query(countQuery)
  ]);

  const distributions = dataRes.toArray().map((r: any) => ({
    resource_id: r.resource_id,
    relation_key: r.relation_key,
    url: r.url,
    label: r.label,
    dct_title_s: r.dct_title_s
  }));

  const total = Number(countRes.toArray()[0].c);

  return { distributions, total };
}

export async function queryDistributionsForResource(resourceId: string): Promise<Distribution[]> {
  const ctx = await getDuckDbContext();
  if (!ctx) return [];

  const safeId = resourceId.replace(/'/g, "''");
  const res = await ctx.conn.query(`SELECT * FROM distributions WHERE resource_id = '${safeId}'`);

  return res.toArray().map((r: any) => ({
    resource_id: r.resource_id,
    relation_key: r.relation_key,
    url: r.url,
    label: r.label
  }));
}

export async function upsertResource(resource: Resource, distributions: Distribution[] = [], options: { skipSave?: boolean } = {}): Promise<void> {
  const ctx = await getDuckDbContext();
  if (!ctx) throw new Error("DB not available");
  const { conn } = ctx;

  const id = resource.id;
  if (!id) throw new Error("Resource ID is required");

  // Delete existing
  const safeId = id.replace(/'/g, "''");

  await conn.query(`DELETE FROM resources WHERE id = '${safeId}'`);
  await conn.query(`DELETE FROM resources_mv WHERE id = '${safeId}'`);
  await conn.query(`DELETE FROM distributions WHERE resource_id = '${safeId}'`);

  // Insert Scalars
  const scalarCols: string[] = [];
  const scalarVals: string[] = [];

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;

    // @ts-ignore
    let val = resource[field];

    if (val === undefined || val === null) {
      continue;
    }

    scalarCols.push(`"${field}"`);
    const safeVal = String(val).replace(/'/g, "''");
    scalarVals.push(`'${safeVal}'`);
  }

  if (scalarCols.length > 0) {
    const query = `INSERT INTO resources (${scalarCols.join(",")}) VALUES (${scalarVals.join(",")})`;
    await conn.query(query);

    // Update geometry if bbox present
    if (resource.dcat_bbox && resource.dcat_bbox.startsWith("ENVELOPE(")) {
      try {
        await conn.query(`
          UPDATE resources
          SET geom = ST_MakeEnvelope(
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
            CAST((str_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
          )
          WHERE id = '${safeId}'
        `);
      } catch (e) {
        console.warn("Failed to update geom in upsert", e);
      }
    }
  }

  // Insert MVs
  for (const field of REPEATABLE_STRING_FIELDS) {
    // @ts-ignore
    const values = resource[field] as string[];
    if (values && Array.isArray(values)) {
      for (const v of values) {
        if (!v) continue;
        const safeVal = v.replace(/'/g, "''");
        await conn.query(`INSERT INTO resources_mv (id, field, val) VALUES ('${safeId}', '${field}', '${safeVal}')`);
      }
    }
  }

  // Insert Distributions
  if (distributions.length > 0) {
    for (const d of distributions) {
      const k = d.relation_key.replace(/'/g, "''");
      const u = d.url.replace(/'/g, "''");
      const l = d.label ? `'${d.label.replace(/'/g, "''")}'` : 'NULL';
      // Ensure we use the resource ID from the main resource, just in case
      await conn.query(`INSERT INTO distributions (resource_id, relation_key, url, label) VALUES ('${safeId}', '${k}', '${u}', ${l})`);
    }
  }

  // Insert search_index (FTS)
  await conn.query(`DELETE FROM search_index WHERE id = '${safeId}'`);
  // Concatenate TEXT fields
  const parts: string[] = [resource.dct_title_s || ""];
  if (resource.dct_description_sm) parts.push(...resource.dct_description_sm);
  if (resource.dct_subject_sm) parts.push(...resource.dct_subject_sm);
  if (resource.dcat_keyword_sm) parts.push(...resource.dcat_keyword_sm);

  const content = parts.join(" ").replace(/'/g, "''").replace(/\n/g, " ");
  await conn.query(`INSERT INTO search_index (id, content) VALUES ('${safeId}', '${content}')`);

  if (!options.skipSave) {
    await saveDb();
  }
}


// *** IndexedDB Helpers ***

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
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

async function saveToIndexedDB(buffer: Uint8Array): Promise<void> {
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


// ... existing code ...

export async function importJsonData(json: any, options: { skipSave?: boolean } = {}): Promise<number> {
  const records = Array.isArray(json) ? json : [json];
  let count = 0;

  // Invert mapping for fast lookup: URI -> key
  const uriToKey = new Map<string, string>();
  for (const [key, uri] of Object.entries(REFERENCE_URI_MAPPING)) {
    uriToKey.set(uri, key);
  }

  for (const record of records) {
    if (!record.id) {
      console.warn("Skipping record without ID:", record);
      continue;
    }

    // Extract Distributions from dct_references_s
    // Aardvark spec: dct_references_s is a JSON string: "{\"http://.../wms\":\"http://url...\"}"
    const distributions: Distribution[] = [];
    if (record.dct_references_s) {
      try {
        const refs = JSON.parse(record.dct_references_s);
        for (const [uri, value] of Object.entries(refs)) {
          // Check if URI is a known relation type
          const relKey = uriToKey.get(uri);
          if (relKey) {

            // Normalize to array
            const items = Array.isArray(value) ? value : [value];

            for (const item of items) {
              let finalUrl = "";
              let label: string | undefined = undefined;

              if (typeof item === 'string') {
                finalUrl = item;
              } else if (typeof item === 'object' && item !== null) {
                // unexpected object
                if ('url' in item) {
                  finalUrl = String((item as any).url);
                  if ('label' in item) label = String((item as any).label);
                } else {
                  // Unknown structure?
                  console.warn(`Encountered unknown object in dct_references_s for ${record.id} key ${uri}:`, item);
                  finalUrl = JSON.stringify(item);
                }
              } else {
                finalUrl = String(item);
              }

              if (finalUrl) {
                distributions.push({
                  resource_id: record.id,
                  relation_key: relKey,
                  url: finalUrl,
                  label: label
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn(`Failed to parse dct_references_s for ${record.id}`, e);
      }
    }

    // Prepare Resource object
    const res: Resource = {
      id: record.id,
      dct_title_s: record.dct_title_s || "",
      dct_description_sm: Array.isArray(record.dct_description_sm) ? record.dct_description_sm : (record.dct_description_sm ? [record.dct_description_sm] : []),
      gbl_resourceClass_sm: Array.isArray(record.gbl_resourceClass_sm) ? record.gbl_resourceClass_sm : [],
      dct_accessRights_s: record.dct_accessRights_s || "Public",
      ...record
    };

    const listFields = [
      "dct_alternative_sm", "dct_description_sm", "dct_language_sm",
      "gbl_displayNote_sm", "dct_creator_sm", "dct_publisher_sm",
      "gbl_resourceType_sm", "dct_subject_sm", "dcat_theme_sm",
      "dcat_keyword_sm", "dct_temporal_sm", "gbl_dateRange_drsim",
      "gbl_indexYear_im", "dct_spatial_sm", "dct_identifier_sm",
      "dct_rights_sm", "dct_rightsHolder_sm", "dct_license_sm",
      "pcdm_memberOf_sm", "dct_isPartOf_sm", "dct_source_sm",
      "dct_isVersionOf_sm", "dct_replaces_sm", "dct_isReplacedBy_sm",
      "dct_relation_sm"
    ];

    for (const field of listFields) {
      if (res[field as keyof Resource] !== undefined && !Array.isArray(res[field as keyof Resource])) {
        // Cast to array
        (res as any)[field] = [res[field as keyof Resource]];
      }
    }

    // Upsert
    // ALWAYS skip save inside loop to allow batch optimization
    await upsertResource(res, distributions, { skipSave: true });
    count++;
  }

  // Only save once at the end if not instructed to skip
  if (!options.skipSave) {
    await saveDb();
  }

  return count;
}


// *** Faceted Search DSL ***

export interface FacetedSearchRequest {
  q?: string;
  filters?: Record<string, any>; // { field: { any: [], all: [], gte: n, lte: n } }
  sort?: { field: string; dir: "asc" | "desc" }[];
  page?: { size: number; from: number };
  facets?: { field: string; limit?: number }[];
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface FacetedSearchResponse {
  results: Resource[];
  facets: Record<string, { value: string; count: number }[]>;
  total: number;
}

export async function facetedSearch(req: FacetedSearchRequest): Promise<FacetedSearchResponse> {
  const ctx = await getDuckDbContext();
  if (!ctx) return { results: [], facets: {}, total: 0 };
  const { conn } = ctx;

  const limit = req.page?.size ?? 20;
  const offset = req.page?.from ?? 0;
  const sort = req.sort?.[0] ?? { field: "dct_title_s", dir: "asc" };

  // 1. Define Global Filters (Q + BBox)
  // These apply to ALL queries (results + facets).
  // We materialize these into a lightweight Temp Table of IDs to avoid repeating expensive FTS/Spatial checks.

  const globalClauses: string[] = ["1=1"];
  let useGlobal = false;

  if (req.q && req.q.trim()) {
    useGlobal = true;
    const k = req.q.replace(/'/g, "''");
    // Use ILIKE on flattened content - robust and fast enough (Avoiding FTS sync issues)
    globalClauses.push(`id IN (SELECT id FROM search_index WHERE content ILIKE '%${k}%')`);
  }

  if (req.bbox) {
    useGlobal = true;
    const { minX, minY, maxX, maxY } = req.bbox;
    // Use ST_Intersects with geom column
    // req.bbox is minX, minY, maxX, maxY (West, South, East, North)
    // ST_MakeEnvelope takes (minX, minY, maxX, maxY) -> (w, s, e, n)
    globalClauses.push(`ST_Intersects(geom, ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY}))`);
  }

  const globalHitsTable = `global_hits_${Math.random().toString(36).substring(7)}`;

  try {
    // Create Temp Table if Global Filters exist
    // Use explicit table name to avoid CTE optimization issues
    if (useGlobal) {
      const globalWhere = globalClauses.join(" AND ");
      await conn.query(`CREATE TEMP TABLE ${globalHitsTable} AS SELECT id FROM resources WHERE ${globalWhere}`);
    }

    // Helper to construct "Main Where" (Facets only)
    // If useGlobal, we don't re-emit Q/BBox logic, we just join global_hits
    const compileMainWhere = (omit: string | null) => compileFacetedWhere(req, omit, false).sql;

    // --- A. Results Query ---
    const baseWhere = compileMainWhere(null);

    // Sort Logic
    // Sort Logic
    let orderBy = `resources."dct_title_s" ASC`; // Default (Relevance fallback)

    // Spatial Relevance (IoU) calculation if BBox is present
    let spatialScore = "";
    if (req.bbox) {
      const { minX, minY, maxX, maxY } = req.bbox;
      const bboxEnv = `ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY})`;
      // IoU = Area(Intersection) / Area(Union)
      // Union Area = Area(A) + Area(B) - Area(Intersection)
      // geom might be null (though filtered out by WHERE usually), handle safely.
      spatialScore = `
         (ST_Area(ST_Intersection(resources.geom, ${bboxEnv})) / 
         (ST_Area(resources.geom) + ST_Area(${bboxEnv}) - ST_Area(ST_Intersection(resources.geom, ${bboxEnv}))))
       `;
    }

    if (sort.field === 'gbl_indexYear_im') {
      const dir = sort.dir.toUpperCase();
      orderBy = `TRY_CAST(resources."gbl_indexYear_im" AS INTEGER) ${dir} NULLS LAST, resources."dct_title_s" ASC`;
    } else if (sort.field === 'dct_title_s') {
      // If BBox is present, "Relevance" (Title) becomes "Spatial Relevance" (IoU)
      if (spatialScore) {
        orderBy = `${spatialScore} DESC, resources."dct_title_s" ASC`;
      } else {
        orderBy = `resources."dct_title_s" ${sort.dir.toUpperCase()}`;
      }
    } else {
      // Generic
      const safeSortCol = sort.field.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeSortCol) {
        orderBy = `resources."${safeSortCol}" ${sort.dir.toUpperCase()}, resources."dct_title_s" ASC`;
      }
    }

    let idsQuery = "";
    let countQuery = "";

    if (useGlobal) {
      idsQuery = `
            SELECT resources.id 
            FROM resources
            JOIN ${globalHitsTable} gh ON resources.id = gh.id
            WHERE ${baseWhere}
            ORDER BY ${orderBy}
            LIMIT ${limit} OFFSET ${offset}
          `;
      countQuery = `
            SELECT count(*) as c 
            FROM resources
            JOIN ${globalHitsTable} gh ON resources.id = gh.id
            WHERE ${baseWhere}
          `;
    } else {
      idsQuery = `
            SELECT id FROM resources
            WHERE ${baseWhere}
            ORDER BY ${orderBy}
            LIMIT ${limit} OFFSET ${offset}
          `;
      countQuery = `SELECT count(*) as c FROM resources WHERE ${baseWhere}`;
    }

    const [idsRes, countRes] = await Promise.all([
      conn.query(idsQuery),
      conn.query(countQuery)
    ]);

    const total = Number(countRes.toArray()[0].c);
    const ids = idsRes.toArray().map((r: any) => r.id);

    // Hydrate
    const resources = await fetchResourcesByIds(conn, ids);


    // --- B. Facets Query ---
    const facets: Record<string, { value: string; count: number }[]> = {};

    if (req.facets) {
      await Promise.all(req.facets.map(async (f) => {
        const limit = f.limit ?? 10;
        const fWhere = compileMainWhere(f.field); // Omit THIS field

        let fSql = "";
        // We need to JOIN global_hits if useGlobal is true

        if (SCALAR_FIELDS.includes(f.field)) {

          // Special handling for Year Timeline
          const isYear = f.field === 'gbl_indexYear_im';
          const facetLimit = isYear ? 5000 : limit;
          const orderBy = isYear ? 'val ASC' : 'c DESC, val ASC';

          if (useGlobal) {
            fSql = `
                   SELECT resources."${f.field}" as val, count(*) as c 
                   FROM resources
                   JOIN ${globalHitsTable} gh ON resources.id = gh.id
                   WHERE resources."${f.field}" IS NOT NULL AND resources."${f.field}" != ''
                   AND ${fWhere}
                   GROUP BY resources."${f.field}"
                   ORDER BY ${orderBy}
                   LIMIT ${facetLimit}
                 `;
          } else {
            fSql = `
                   SELECT "${f.field}" as val, count(*) as c 
                   FROM resources 
                   WHERE "${f.field}" IS NOT NULL AND "${f.field}" != ''
                   AND ${fWhere}
                   GROUP BY "${f.field}"
                   ORDER BY ${orderBy}
                   LIMIT ${facetLimit}
                 `;
          }
        } else {
          // MV Field

          // Special handling for Year Timeline: High limit, Sort by Year ASC
          const isYear = f.field === 'gbl_indexYear_im';
          const facetLimit = isYear ? 5000 : limit;
          const orderBy = isYear ? 'm.val ASC' : 'c DESC, m.val ASC';

          if (useGlobal) {
            // ... (optimized global query)
            // Simplified for brevity in replacement, but retaining logic
            fSql = `
                    SELECT m.val, count(DISTINCT m.id) as c
                    FROM resources_mv m
                    JOIN ${globalHitsTable} gh ON m.id = gh.id
                    JOIN resources ON resources.id = m.id
                    WHERE m.field = '${f.field}'
                    AND ${fWhere}
                    GROUP BY m.val
                    ORDER BY ${orderBy}
                    LIMIT ${facetLimit}
                 `;
          } else {
            fSql = `
                   WITH filtered AS (SELECT id FROM resources WHERE ${fWhere})
                   SELECT m.val, count(DISTINCT m.id) as c
                   FROM resources_mv m
                   JOIN filtered f ON f.id = m.id
                   WHERE m.field = '${f.field}'
                   GROUP BY m.val
                   ORDER BY ${orderBy}
                   LIMIT ${facetLimit}
                `;
          }
        }

        try {
          const fRes = await conn.query(fSql);
          facets[f.field] = fRes.toArray().map((r: any) => ({
            value: String(r.val),
            count: Number(r.c)
          }));
        } catch (e) {
          console.warn(`Facet query failed for ${f.field}`, e);
          facets[f.field] = [];
        }
      }));
    }

    return { results: resources, facets, total };

  } finally {
    // Cleanup Temp Table
    if (useGlobal) {
      try { await conn.query(`DROP TABLE IF EXISTS ${globalHitsTable}`); } catch { }
    }
  }
}

export async function getDistributionsForResource(resourceId: string): Promise<Distribution[]> {
  const ctx = await getDuckDbContext();
  if (!ctx) return [];

  // Basic sanitization
  const safeId = resourceId.replace(/'/g, "''");
  try {
    const res = await ctx.conn.query(`SELECT * FROM distributions WHERE resource_id = '${safeId}'`);
    return res.toArray().map((r: any) => ({
      resource_id: String(r.resource_id),
      relation_key: String(r.relation_key),
      url: String(r.url)
    }));
  } catch (e) {
    console.warn(`Failed to fetch distributions for ${resourceId}`, e);
    return [];
  }
}

// --- Static Map Cache Helpers ---

export async function upsertStaticMap(id: string, data: Blob): Promise<void> {
  const ctx = await getDuckDbContext();
  if (!ctx) return;
  const { conn } = ctx;

  const buf = await data.arrayBuffer();
  // Convert to Base64 to be safe with WASM boundary
  let binary = '';
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const now = Date.now();

  // Simple overwrite logic
  // Since we changed schema, we might need to drop table if it was BLOB. 
  // Ideally migration runs, but for dev we assume "CREATE IF NOT EXISTS" is fine 
  // IF the user reloads and we have migration logic. 
  // We'll rely on the fact that we can just delete and insert.
  // If the table is old schema (BLOB), this insert might fail or behave oddly if we try to insert string into blob?
  // DuckDB auto-casts string to blob maybe? 
  // But we want to store VARCHAR.

  // To be safe, let's just delete and insert.

  await conn.query(`DELETE FROM static_maps WHERE id = '${id}'`);

  // Insert Base64 string
  // We use direct SQL string construction for Base64 (it's safe-ish characters, but we can parameterize if needed)
  // But wait, parameterizing is what caused the crash.
  // Let's use string interpolation but safe. Base64 is safe chars.

  await conn.query(`INSERT INTO static_maps (id, data, last_updated) VALUES ('${id}', '${base64}', ${now})`);
}

export async function getStaticMap(id: string): Promise<string | null> {
  // Returns Object URL for the image
  const ctx = await getDuckDbContext();
  if (!ctx) return null;
  const result = await ctx.conn.query(`SELECT data FROM static_maps WHERE id = '${id}'`);
  if (result.numRows === 0) return null;

  const row = result.get(0);
  if (!row || !row['data']) return null;

  try {
    const base64 = row['data'];
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/png' });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn("Failed to decode map image", e);
    return null;
  }
}

export async function hasStaticMap(id: string): Promise<boolean> {
  const ctx = await getDuckDbContext();
  if (!ctx) return false;
  const result = await ctx.conn.query(`SELECT 1 FROM static_maps WHERE id = '${id}'`);
  return result.numRows > 0;
}


export interface SuggestResult {
  text: string;
  type: string;
}

export async function suggest(text: string, limit: number = 10): Promise<SuggestResult[]> {
  const ctx = await getDuckDbContext();
  if (!ctx || !text || text.trim().length === 0) return [];
  const { conn } = ctx;

  const safeText = text.replace(/'/g, "''").toLowerCase();

  // Union query across multiple fields
  // We want: Text, Type (e.g. Title, Subject, Keyword)
  // Limited by relevance (matching start of string is better?)

  const queries: string[] = [];

  // 1. Titles
  queries.push(`
        SELECT match, 'Title' as type, 2 as priority 
        FROM (SELECT DISTINCT dct_title_s as match FROM resources WHERE lower(dct_title_s) LIKE '%${safeText}%' LIMIT ${limit})
    `);

  // 2. Subjects (MV)
  queries.push(`
        SELECT match, 'Subject' as type, 1 as priority
        FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dct_subject_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})
    `);

  // 3. Keywords (MV)
  queries.push(`
        SELECT match, 'Keyword' as type, 1 as priority
        FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dcat_keyword_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})
    `);

  // 4. Themes (MV)
  queries.push(`
        SELECT match, 'Theme' as type, 1 as priority
        FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dcat_theme_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})
    `);

  // 5. Spatial (MV)
  queries.push(`
        SELECT match, 'Place' as type, 3 as priority
        FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dct_spatial_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})
    `);

  const fullQuery = `
        SELECT match, type 
        FROM (${queries.join(' UNION ALL ')}) as matches
        ORDER BY priority DESC, length(match) ASC
        LIMIT ${limit}
    `;

  try {
    const res = await conn.query(fullQuery);
    return res.toArray().map((r: any) => ({
      text: r.match,
      type: r.type
    }));
  } catch (e) {
    console.warn("Suggest query failed", e);
    return [];
  }
}
