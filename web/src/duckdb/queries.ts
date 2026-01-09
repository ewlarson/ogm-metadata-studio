import { getDuckDbContext } from "./dbInit";
import { Resource, SCALAR_FIELDS, Distribution } from "../aardvark/model";
import { resourceFromRow } from "../aardvark/mapping";
import {
    SearchResult, FacetedSearchRequest, FacetedSearchResponse,
    DistributionResult, SuggestResult, FacetValueRequest, FacetValueResult
} from "./types";
import * as duckdb from "@duckdb/duckdb-wasm";

// Helper: Fetch full resource objects by ID
export async function fetchResourcesByIds(conn: duckdb.AsyncDuckDBConnection, ids: string[]): Promise<Resource[]> {
    if (ids.length === 0) return [];

    const idList = ids.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");

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
        try {
            const base64 = r.data;
            if (base64) {
                const binaryString = atob(base64);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: 'image/jpeg' });
                thumbMap.set(r.id, URL.createObjectURL(blob));
            }
        } catch {
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

    // Sort resources to match input IDs order
    const idMap = new Map(resources.map(r => [r.id, r]));
    return ids.map(id => idMap.get(id)).filter(r => r !== undefined) as Resource[];
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

    let where = "1=1";
    if (search) {
        const safeSearch = search.replace(/'/g, "''");
        where += ` AND (
        id ILIKE '%${safeSearch}%' OR 
        dct_title_s ILIKE '%${safeSearch}%' OR
        EXISTS (SELECT 1 FROM resources_mv mv WHERE mv.id = resources.id AND mv.val ILIKE '%${safeSearch}%')
    )`;
    }

    const countRes = await conn.query(`SELECT COUNT(*) as total FROM resources WHERE ${where}`);
    const total = Number(countRes.toArray()[0].total);

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

    const resources = await fetchResourcesByIds(conn, ids);
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

    let sql = "";
    if (SCALAR_FIELDS.includes(safeCol) || safeCol === 'id') {
        sql = `
    SELECT DISTINCT "${safeCol}" as val 
    FROM resources 
    WHERE "${safeCol}" ILIKE '%${safeSearch}%'
    LIMIT ${limit}
  `;
    } else {
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
            if (row.toJSON) return row.toJSON();
            const r: any = {};
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

    // Slight redundancy with fetchResourcesByIds but simpler for single item
    const resources = await fetchResourcesByIds(conn, [id]);
    return resources.length > 0 ? resources[0] : null;
}

export async function countResources(): Promise<number> {
    const ctx = await getDuckDbContext();
    if (!ctx) return 0;
    try {
        const res = await ctx.conn.query('SELECT count(*) as c FROM resources');
        if (res.numRows === 0) return 0;
        return Number(res.toArray()[0]['c']);
    } catch (e) {
        console.warn("Count resources failed", e);
        return 0;
    }
}

export function compileFacetedWhere(req: FacetedSearchRequest, omitField: string | null = null, emitGlobal: boolean = true): { sql: string } {
    const clauses: string[] = ["1=1"];

    if (emitGlobal && req.q && req.q.trim()) {
        const k = req.q.replace(/'/g, "''");
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
                    clauses.push(`EXISTS ( SELECT 1 FROM resources_mv m WHERE m.id = resources.id AND m.field = '${field}' AND m.val IN (${values}) )`);
                }
            }

            if (condition.none && Array.isArray(condition.none) && condition.none.length > 0) {
                const values = condition.none.map((v: string) => `'${String(v).replace(/'/g, "''")}'`).join(",");
                if (isScalar) {
                    clauses.push(`("${field}" IS NULL OR "${field}" NOT IN (${values}))`);
                } else {
                    clauses.push(`NOT EXISTS ( SELECT 1 FROM resources_mv m WHERE m.id = resources.id AND m.field = '${field}' AND m.val IN (${values}) )`);
                }
            }

            if (condition.all && Array.isArray(condition.all) && condition.all.length > 0) {
                const values = condition.all.map((v: string) => `'${String(v).replace(/'/g, "''")}'`).join(",");
                const count = condition.all.length;
                clauses.push(`( SELECT count(DISTINCT m.val) FROM resources_mv m WHERE m.id = resources.id AND m.field = '${field}' AND m.val IN (${values}) ) = ${count}`);
            }

            if (condition.gte !== undefined) clauses.push(`CAST("${field}" AS INTEGER) >= ${Number(condition.gte)}`);
            if (condition.lte !== undefined) clauses.push(`CAST("${field}" AS INTEGER) <= ${Number(condition.lte)}`);
        }
    }
    return { sql: clauses.join(" AND ") };
}

export async function facetedSearch(req: FacetedSearchRequest): Promise<FacetedSearchResponse> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { results: [], facets: {}, total: 0 };
    const { conn } = ctx;

    const limit = req.page?.size ?? 20;
    const offset = req.page?.from ?? 0;
    const sort = req.sort?.[0] ?? { field: "dct_title_s", dir: "asc" };

    const globalClauses: string[] = ["1=1"];
    let useGlobal = false;

    if (req.q && req.q.trim()) {
        useGlobal = true;
        globalClauses.push(`id IN (SELECT id FROM search_index WHERE content ILIKE '%${req.q.replace(/'/g, "''")}%')`);
    }

    if (req.bbox) {
        useGlobal = true;
        const { minX, minY, maxX, maxY } = req.bbox;
        globalClauses.push(`ST_Intersects(geom, ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY}))`);
    }

    const globalHitsTable = `global_hits_${Math.random().toString(36).substring(7)}`;

    try {
        if (useGlobal) {
            const globalWhere = globalClauses.join(" AND ");
            await conn.query(`CREATE TEMP TABLE ${globalHitsTable} AS SELECT id FROM resources WHERE ${globalWhere}`);
        }

        const compileMainWhere = (omit: string | null) => compileFacetedWhere(req, omit, false).sql;
        const baseWhere = compileMainWhere(null);

        let orderBy = `resources."dct_title_s" ASC`;
        let spatialScore = "";
        if (req.bbox) {
            const { minX, minY, maxX, maxY } = req.bbox;
            const bboxEnv = `ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY})`;
            spatialScore = `(ST_Area(ST_Intersection(resources.geom, ${bboxEnv})) / (ST_Area(resources.geom) + ST_Area(${bboxEnv}) - ST_Area(ST_Intersection(resources.geom, ${bboxEnv}))))`;
        }

        if (sort.field === 'gbl_indexYear_im') {
            const dir = sort.dir.toUpperCase();
            orderBy = `TRY_CAST(resources."gbl_indexYear_im" AS INTEGER) ${dir} NULLS LAST, resources."dct_title_s" ASC`;
        } else if (sort.field === 'dct_title_s') {
            if (spatialScore) {
                orderBy = `${spatialScore} DESC, resources."dct_title_s" ASC`;
            } else {
                orderBy = `resources."dct_title_s" ${sort.dir.toUpperCase()}`;
            }
        } else {
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
        const resources = await fetchResourcesByIds(conn, ids);

        const facets: Record<string, { value: string; count: number }[]> = {};

        if (req.facets) {
            await Promise.all(req.facets.map(async (f) => {
                const limit = f.limit ?? 10;
                const fWhere = compileMainWhere(f.field);
                const isYear = f.field === 'gbl_indexYear_im';
                const facetLimit = isYear ? 5000 : limit;
                let fSql = "";

                if (SCALAR_FIELDS.includes(f.field)) {
                    const orderBy = isYear ? 'val ASC' : 'c DESC, val ASC';
                    if (useGlobal) {
                        fSql = `SELECT resources."${f.field}" as val, count(*) as c FROM resources JOIN ${globalHitsTable} gh ON resources.id = gh.id WHERE resources."${f.field}" IS NOT NULL AND resources."${f.field}" != '' AND ${fWhere} GROUP BY resources."${f.field}" ORDER BY ${orderBy} LIMIT ${facetLimit}`;
                    } else {
                        fSql = `SELECT "${f.field}" as val, count(*) as c FROM resources WHERE "${f.field}" IS NOT NULL AND "${f.field}" != '' AND ${fWhere} GROUP BY "${f.field}" ORDER BY ${orderBy} LIMIT ${facetLimit}`;
                    }
                } else {
                    const orderBy = isYear ? 'm.val ASC' : 'c DESC, m.val ASC';
                    if (useGlobal) {
                        fSql = `SELECT m.val, count(DISTINCT m.id) as c FROM resources_mv m JOIN ${globalHitsTable} gh ON m.id = gh.id JOIN resources ON resources.id = m.id WHERE m.field = '${f.field}' AND ${fWhere} GROUP BY m.val ORDER BY ${orderBy} LIMIT ${facetLimit}`;
                    } else {
                        fSql = `WITH filtered AS (SELECT id FROM resources WHERE ${fWhere}) SELECT m.val, count(DISTINCT m.id) as c FROM resources_mv m JOIN filtered f ON f.id = m.id WHERE m.field = '${f.field}' GROUP BY m.val ORDER BY ${orderBy} LIMIT ${facetLimit}`;
                    }
                }

                try {
                    const fRes = await conn.query(fSql);
                    facets[f.field] = fRes.toArray().map((r: any) => ({
                        value: String(r.val),
                        count: Number(r.c)
                    }));
                } catch (e) {
                    facets[f.field] = [];
                }
            }));
        }

        return { results: resources, facets, total };

    } finally {
        if (useGlobal) {
            try { await conn.query(`DROP TABLE IF EXISTS ${globalHitsTable}`); } catch { /* ignore */ }
        }
    }
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
        whereClause = `
    WHERE lower(d.resource_id) LIKE '%${k}%' 
       OR lower(d.relation_key) LIKE '%${k}%'
       OR lower(d.url) LIKE '%${k}%'
       OR lower(r.dct_title_s) LIKE '%${k}%'
  `;
    }

    const dataQuery = `
  SELECT d.resource_id, d.relation_key, d.url, d.label, r.dct_title_s
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

    const [dataRes, countRes] = await Promise.all([conn.query(dataQuery), conn.query(countQuery)]);

    return {
        distributions: dataRes.toArray().map((r: any) => ({ ...r })),
        total: Number(countRes.toArray()[0].c)
    };
}

export async function getDistributionsForResource(resourceId: string): Promise<Distribution[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    const safeId = resourceId.replace(/'/g, "''");
    const res = await ctx.conn.query(`SELECT * FROM distributions WHERE resource_id = '${safeId}'`);

    return res.toArray().map((r: any) => ({
        resource_id: String(r.resource_id),
        relation_key: String(r.relation_key),
        url: String(r.url),
        label: r.label
    }));
}

export const queryDistributionsForResource = getDistributionsForResource;

export async function hasStaticMap(id: string): Promise<boolean> {
    const ctx = await getDuckDbContext();
    if (!ctx) return false;
    const result = await ctx.conn.query(`SELECT 1 FROM static_maps WHERE id = '${id}'`);
    return result.numRows > 0;
}

export async function getStaticMap(id: string): Promise<string | null> {
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
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.warn("Failed to load thumbnail", e);
        return null;
    }
}

export async function suggest(text: string, limit: number = 10): Promise<SuggestResult[]> {
    const ctx = await getDuckDbContext();
    if (!ctx || !text || text.trim().length === 0) return [];
    const { conn } = ctx;
    const safeText = text.replace(/'/g, "''").toLowerCase();

    const queries: string[] = [
        `SELECT match, 'Title' as type, 2 as priority FROM (SELECT DISTINCT dct_title_s as match FROM resources WHERE lower(dct_title_s) LIKE '%${safeText}%' LIMIT ${limit})`,
        `SELECT match, 'Subject' as type, 1 as priority FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dct_subject_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})`,
        `SELECT match, 'Keyword' as type, 1 as priority FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dcat_keyword_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})`,
        `SELECT match, 'Theme' as type, 1 as priority FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dcat_theme_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})`,
        `SELECT match, 'Place' as type, 3 as priority FROM (SELECT DISTINCT val as match FROM resources_mv WHERE field='dct_spatial_sm' AND lower(val) LIKE '%${safeText}%' LIMIT ${limit})`
    ];

    const fullQuery = `SELECT match, type FROM (${queries.join(' UNION ALL ')}) as matches ORDER BY priority DESC, length(match) ASC LIMIT ${limit}`;
    try {
        const res = await conn.query(fullQuery);
        return res.toArray().map((r: any) => ({ text: r.match, type: r.type }));
    } catch (e) {
        return [];
    }
}

export async function getSearchNeighbors(req: FacetedSearchRequest, currentId: string): Promise<{ prevId?: string, nextId?: string, position: number, total: number }> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { position: 0, total: 0 };
    const { conn } = ctx;

    const sort = req.sort?.[0] ?? { field: "dct_title_s", dir: "asc" };
    const safeId = currentId.replace(/'/g, "''");
    const { sql: where } = compileFacetedWhere(req, null, true);

    let orderBy = `resources."dct_title_s" ASC`;
    let spatialScore = "";

    if (req.bbox) {
        const { minX, minY, maxX, maxY } = req.bbox;
        const bboxEnv = `ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY})`;
        spatialScore = `(ST_Area(ST_Intersection(resources.geom, ${bboxEnv})) / (ST_Area(resources.geom) + ST_Area(${bboxEnv}) - ST_Area(ST_Intersection(resources.geom, ${bboxEnv}))))`;
    }

    if (sort.field === 'gbl_indexYear_im') {
        orderBy = `TRY_CAST(resources."gbl_indexYear_im" AS INTEGER) ${sort.dir.toUpperCase()} NULLS LAST, resources."dct_title_s" ASC`;
    } else if (sort.field === 'dct_title_s') {
        if (spatialScore) orderBy = `${spatialScore} DESC, resources."dct_title_s" ASC`;
        else orderBy = `resources."dct_title_s" ${sort.dir.toUpperCase()}`;
    } else {
        const safeSortCol = sort.field.replace(/[^a-zA-Z0-9_]/g, "");
        if (safeSortCol) orderBy = `resources."${safeSortCol}" ${sort.dir.toUpperCase()}, resources."dct_title_s" ASC`;
    }

    const sql = `
        WITH sorted_ids AS (
            SELECT resources.id, ROW_NUMBER() OVER (ORDER BY ${orderBy}) as rn
            FROM resources WHERE ${where}
        ),
        target AS ( SELECT rn FROM sorted_ids WHERE id = '${safeId}' )
        SELECT (SELECT COUNT(*) FROM sorted_ids) as total, t.rn as current_pos, prev.id as prev_id, next.id as next_id
        FROM target t
        LEFT JOIN sorted_ids prev ON prev.rn = t.rn - 1
        LEFT JOIN sorted_ids next ON next.rn = t.rn + 1
    `;

    try {
        const res = await conn.query(sql);
        if (res.numRows === 0) return { position: 0, total: 0 };
        const row: any = res.get(0);
        return {
            total: Number(row.total),
            position: Number(row.current_pos),
            prevId: row.prev_id ? String(row.prev_id) : undefined,
            nextId: row.next_id ? String(row.next_id) : undefined
        };
    } catch (e) {
        return { position: 0, total: 0 };
    }
}

export async function getFacetValues(req: FacetValueRequest): Promise<FacetValueResult> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { values: [], total: 0 };
    const { conn } = ctx;

    const limit = req.pageSize ?? 20;
    const offset = ((req.page ?? 1) - 1) * limit;
    const sort = req.sort ?? "count_desc";
    const fQuery = req.facetQuery ? req.facetQuery.replace(/'/g, "''").toLowerCase() : "";

    const filters = { ...req.filters };
    if (req.yearRange) {
        const parts = req.yearRange.split(",").map(Number);
        if (parts.length === 2) {
            filters['gbl_indexYear_im'] = { ...filters['gbl_indexYear_im'], gte: parts[0], lte: parts[1] };
        }
    }

    const dummyReq: FacetedSearchRequest = { q: req.q, filters, bbox: req.bbox };
    const whereClause = compileFacetedWhere(dummyReq, req.field, true).sql;

    let sql = "";
    let countSql = "";
    let orderBy = "c DESC, val ASC";

    switch (sort) {
        case "count_asc": orderBy = "c ASC, val ASC"; break;
        case "alpha_asc": orderBy = "val ASC"; break;
        case "alpha_desc": orderBy = "val DESC"; break;
        case "count_desc": default: orderBy = "c DESC, val ASC"; break;
    }

    const field = req.field;
    const isScalar = SCALAR_FIELDS.includes(field);

    if (isScalar) {
        sql = `SELECT "${field}" as val, count(*) as c FROM resources WHERE "${field}" IS NOT NULL AND "${field}" != '' AND ${whereClause} ${fQuery ? `AND lower("${field}") LIKE '%${fQuery}%'` : ""} GROUP BY "${field}" ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
        countSql = `SELECT count(DISTINCT "${field}") as total FROM resources WHERE "${field}" IS NOT NULL AND "${field}" != '' AND ${whereClause} ${fQuery ? `AND lower("${field}") LIKE '%${fQuery}%'` : ""}`;
    } else {
        sql = `WITH filtered AS (SELECT id FROM resources WHERE ${whereClause}) SELECT m.val, count(DISTINCT m.id) as c FROM resources_mv m JOIN filtered f ON f.id = m.id WHERE m.field = '${field}' ${fQuery ? `AND lower(m.val) LIKE '%${fQuery}%'` : ""} GROUP BY m.val ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
        countSql = `WITH filtered AS (SELECT id FROM resources WHERE ${whereClause}) SELECT count(DISTINCT m.val) as total FROM resources_mv m JOIN filtered f ON f.id = m.id WHERE m.field = '${field}' ${fQuery ? `AND lower(m.val) LIKE '%${fQuery}%'` : ""}`;
    }

    try {
        const [res, countRes] = await Promise.all([conn.query(sql), conn.query(countSql)]);
        return {
            values: res.toArray().map((r: any) => ({ value: String(r.val), count: Number(r.c) })),
            total: Number(countRes.toArray()[0].total)
        };
    } catch (e) {
        return { values: [], total: 0 };
    }
}

export async function querySimilarResources(id: string, limit: number = 12): Promise<Resource[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    const { conn } = ctx;

    const safeId = id.replace(/'/g, "''");

    const sql = `
    SELECT m.id, SUM(weight) as score
    FROM resources_mv m
    JOIN (
      SELECT field, val, CASE 
        WHEN field='dct_subject_sm' THEN 3 
        WHEN field='dct_creator_sm' THEN 2 
        WHEN field='dcat_theme_sm' THEN 2 
        WHEN field='dct_spatial_sm' THEN 1 
        WHEN field='gbl_resourceClass_sm' THEN 1 
        ELSE 1 END as weight
      FROM resources_mv 
      WHERE id = '${safeId}'
      AND field IN ('dct_subject_sm', 'dct_creator_sm', 'dcat_theme_sm', 'dct_spatial_sm', 'gbl_resourceClass_sm')
    ) target
    ON m.field = target.field AND m.val = target.val
    WHERE m.id != '${safeId}'
    GROUP BY m.id
    ORDER BY score DESC
    LIMIT ${limit}
  `;

    try {
        const similarRes = await conn.query(sql);
        const similarIds = similarRes.toArray().map((r: any) => r.id);
        return fetchResourcesByIds(conn, similarIds);
    } catch (e) {
        console.warn("Similarity query failed", e);
        return [];
    }
}
