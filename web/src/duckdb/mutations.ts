import { getDuckDbContext } from "./dbInit";
import { saveDb } from "./lifecycle";
import { Resource, Distribution, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS } from "../aardvark/model";
import { fetchResourcesByIds } from "./queries";
import embeddingWorkerUrl from "../workers/embedding.worker?worker&url";

// *** Image Service Mutations ***

export async function upsertThumbnail(id: string, data: Blob): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const { conn } = ctx;

    const buf = await data.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const now = Date.now();

    try {
        await conn.query(`DELETE FROM resources_image_service WHERE id = '${id}'`);
        await conn.query(`INSERT INTO resources_image_service (id, data, last_updated) VALUES ('${id}', '${base64}', ${now})`);
    } catch (e) {
        console.warn("Failed to cache thumbnail", e);
    }
}

export async function upsertStaticMap(id: string, data: Blob): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const { conn } = ctx;

    const buf = await data.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const now = Date.now();

    await conn.query(`DELETE FROM static_maps WHERE id = '${id}'`);
    await conn.query(`INSERT INTO static_maps (id, data, last_updated) VALUES ('${id}', '${base64}', ${now})`);
}

// *** Resource Mutations ***

export async function deleteResource(id: string): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const { conn } = ctx;
    const safeId = id.replace(/'/g, "''");

    await conn.query(`DELETE FROM resources WHERE id = '${safeId}'`);
    await conn.query(`DELETE FROM resources_mv WHERE id = '${safeId}'`);
    await conn.query(`DELETE FROM distributions WHERE resource_id = '${safeId}'`);
    await conn.query(`DELETE FROM search_index WHERE id = '${safeId}'`);

    await saveDb();
}

export async function upsertResource(resource: Resource, distributions: Distribution[] = [], options: { skipSave?: boolean } = {}): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const { conn } = ctx;

    const id = resource.id;
    if (!id) throw new Error("Resource ID is required");

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
        const val = resource[field];
        if (val === undefined || val === null) continue;

        scalarCols.push(`"${field}"`);
        const safeVal = String(val).replace(/'/g, "''");
        scalarVals.push(`'${safeVal}'`);
    }

    if (scalarCols.length > 0) {
        const query = `INSERT INTO resources (${scalarCols.join(",")}) VALUES (${scalarVals.join(",")})`;
        await conn.query(query);

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
            await conn.query(`INSERT INTO distributions (resource_id, relation_key, url, label) VALUES ('${safeId}', '${k}', '${u}', ${l})`);
        }
    }

    // Insert search_index (FTS)
    await conn.query(`DELETE FROM search_index WHERE id = '${safeId}'`);
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

// *** Vector Embedding Engine ***

let embeddingWorker: Worker | null = null;
const embeddingCallbacks = new Map<string, (success: boolean) => void>();

function getEmbeddingWorker(): Worker {
    if (!embeddingWorker) {
        embeddingWorker = new Worker(embeddingWorkerUrl, { type: "module" });
        embeddingWorker.onmessage = async (e: MessageEvent) => {
            const { id, embedding, success, error } = e.data;

            if (success && embedding) {
                try {
                    const ctx = await getDuckDbContext();
                    if (ctx) {
                        await ctx.conn.query(`UPDATE resources SET embedding = [${embedding.join(',')}] WHERE id = '${id.replace(/'/g, "''")}'`);
                    }
                } catch (dbErr) {
                    console.error("Failed to save embedding for " + id, dbErr);
                }
            } else {
                console.warn(`Embedding failed for ${id}:`, error);
            }

            const cb = embeddingCallbacks.get(id);
            if (cb) {
                cb(success);
                embeddingCallbacks.delete(id);
            }
        };
    }
    return embeddingWorker;
}

export async function ensureEmbeddings(priorityId?: string): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const { conn } = ctx;

    const idsToProcess: string[] = [];
    let priorityPromise: Promise<void> | null = null;

    if (priorityId) {
        const safePriorityId = priorityId.replace(/'/g, "''");
        const check = await conn.query(`SELECT id FROM resources WHERE id = '${safePriorityId}' AND embedding IS NULL`);
        if (check.numRows > 0) {
            idsToProcess.push(priorityId);
            priorityPromise = new Promise((resolve) => {
                embeddingCallbacks.set(priorityId, () => resolve());
            });
        }
    }

    const batchSize = 5;
    const limit = batchSize - idsToProcess.length;

    if (limit > 0) {
        const where = priorityId ? `AND id != '${priorityId.replace(/'/g, "''")}'` : "";
        const res = await conn.query(`SELECT id FROM resources WHERE embedding IS NULL ${where} LIMIT ${limit}`);
        const otherIds = res.toArray().map((r: any) => r.id);
        idsToProcess.push(...otherIds);
    }

    if (idsToProcess.length === 0) return;

    console.log(`Generating embeddings for ${idsToProcess.length} resources...`);

    const resources = await fetchResourcesByIds(conn, idsToProcess);
    const worker = getEmbeddingWorker();

    for (const r of resources) {
        const textPieces = [
            `Title: ${r.dct_title_s || ''}`,
            `Alternative Title: ${(r.dct_alternative_sm || []).join(', ')}`,
            `Description: ${(r.dct_description_sm || []).join(' ')}`,
            `Subjects: ${(r.dct_subject_sm || []).join(', ')}`,
            `Keywords: ${(r.dcat_keyword_sm || []).join(', ')}`,
            `Themes: ${(r.dcat_theme_sm || []).join(', ')}`,
            `Creators: ${(r.dct_creator_sm || []).join(', ')}`,
            `Publisher: ${(r.dct_publisher_sm || []).join(', ')}`,
            `Language: ${(r.dct_language_sm || []).join(', ')}`,
            `Resource Class: ${(r.gbl_resourceClass_sm || []).join(', ')}`,
            `Resource Type: ${(r.gbl_resourceType_sm || []).join(', ')}`,
            `Place: ${(r.dct_spatial_sm || []).join(', ')}`,
            `Year: ${r.gbl_indexYear_im || ''}`
        ];
        const text = textPieces.map(s => s.trim()).filter(s => !s.endsWith(':')).join('. ');
        worker.postMessage({ id: r.id, text });
    }

    if (priorityPromise) {
        await priorityPromise;
    }
}
