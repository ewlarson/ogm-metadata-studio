import { getDuckDbContext } from "./dbInit";
import { saveDb } from "./lifecycle";
import { upsertResource, parseCentroidForH3 } from "./mutations";
import { Resource, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS, CSV_HEADER_MAPPING, REFERENCE_URI_MAPPING, Distribution } from "../aardvark/model";
import * as duckdb from "@duckdb/duckdb-wasm";
import { latLngToCell } from "h3-js";
import { H3_RES_COLUMNS } from "./schema";
import { formatCentroid, getCentroidFromGeometry } from "../ui/resource/viewerConfig";

export async function importCsv(file: File): Promise<{ success: boolean, message: string, count?: number }> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { success: false, message: `DB not available. Check console for initialization errors.` };
    const { db, conn } = ctx;

    try {
        await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);

        const tempTable = `temp_${Date.now()}`;
        await conn.query(`CREATE TABLE ${tempTable} AS SELECT * FROM read_csv_auto('${file.name}', all_varchar=true)`);

        const schemaRes = await conn.query(`DESCRIBE ${tempTable}`);
        const headerRes = await conn.query(`SELECT * FROM ${tempTable} LIMIT 0`);
        const csvHeaders = headerRes.schema.fields.map(f => f.name);

        console.log("CSV Headers:", csvHeaders);

        // Heuristic: Is this a Distributions CSV?
        const hasDistId = csvHeaders.includes("ID");
        const hasType = csvHeaders.includes("Type");
        const hasUrl = csvHeaders.includes("URL");
        const hasTitle = csvHeaders.includes("Title") || csvHeaders.includes("dct_title_s");

        if (hasDistId && hasType && hasUrl && !hasTitle) {
            console.log("Detected Distributions CSV.");
            await conn.query(`
                INSERT INTO distributions (resource_id, relation_key, url)
                SELECT "ID", "Type", "URL" FROM ${tempTable}
            `);

            await saveDb();
            const count = await conn.query("SELECT count(*) as c FROM distributions"); // total count, imprecise metric but ok
            return { success: true, message: `Imported distributions.`, count: Number(count.toArray()[0].c) };
        }

        console.log("Detected Resources CSV.");
        const columns = schemaRes.toArray().map((r: any) => r.column_name);

        const findCsvCol = (targetField: string): string | undefined => {
            if (csvHeaders.includes(targetField)) return targetField;
            const mappedEntry = Object.entries(CSV_HEADER_MAPPING).find(([, v]) => v === targetField);
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

        if (scalarColsToInsert.length > 0) {
            if (!scalarColsToInsert.some(c => c.target === 'id')) {
                throw new Error("CSV missing 'id' column");
            }

            const targetCols = scalarColsToInsert.map(c => `"${c.target}"`).join(",");
            const sourceCols = scalarColsToInsert.map(c => `"${c.source}"`).join(",");
            const idSource = scalarColsToInsert.find(c => c.target === 'id')!.source;

            await conn.query(`DELETE FROM resources WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`);
            await conn.query(`DELETE FROM resources_mv WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`);

            await conn.query(`INSERT INTO resources (${targetCols}) SELECT ${sourceCols} FROM ${tempTable}`);

            try {
                await conn.query(`
                  UPDATE resources
                  SET geom = ST_MakeEnvelope(
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
                  )
                  WHERE dcat_bbox LIKE 'ENVELOPE(%'
                  AND id IN (SELECT "${idSource}" FROM ${tempTable})
                `);
            } catch (e) {
                console.warn("Failed to populate geom from dcat_bbox", e);
            }

            // Populate dcat_centroid from bbox center where missing
            try {
                await conn.query(`
                  UPDATE resources
                  SET dcat_centroid = '{"type":"Point","coordinates":[' ||
                    (CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE) + CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE)) / 2 || ',' ||
                    (CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE) + CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE)) / 2 || ']}'
                  WHERE dcat_bbox LIKE 'ENVELOPE(%'
                  AND (dcat_centroid IS NULL OR trim(dcat_centroid) = '')
                  AND id IN (SELECT "${idSource}" FROM ${tempTable})
                `);
            } catch (e) {
                console.warn("Failed to populate dcat_centroid from bbox", e);
            }

            // H3 indices from centroid for batch
            try {
                const rows = await conn.query(`
                  SELECT id, dcat_centroid FROM resources
                  WHERE id IN (SELECT "${idSource}" FROM ${tempTable})
                  AND dcat_centroid IS NOT NULL AND trim(dcat_centroid) != ''
                `);
                for (const row of rows.toArray() as { id: string; dcat_centroid: string }[]) {
                    const centroid = parseCentroidForH3(row.dcat_centroid);
                    if (!centroid) continue;
                    const [lat, lng] = centroid;
                    const updates = H3_RES_COLUMNS.map((col, i) => {
                        const res = i + 2;
                        const h3 = latLngToCell(lat, lng, res);
                        return `"${col}" = '${h3.replace(/'/g, "''")}'`;
                    });
                    const safeId = row.id.replace(/'/g, "''");
                    await conn.query(`UPDATE resources SET ${updates.join(", ")} WHERE id = '${safeId}'`);
                }
            } catch (e) {
                console.warn("Failed to populate H3 from centroid in import", e);
            }
        }

        for (const field of REPEATABLE_STRING_FIELDS) {
            const sourceCol = findCsvCol(field);
            if (!sourceCol) continue;
            const idCol = findCsvCol('id');
            if (!idCol) continue;

            await conn.query(`DELETE FROM resources_mv WHERE field = '${field}' AND id IN (SELECT "${idCol}" FROM ${tempTable})`);
            await conn.query(`
                INSERT INTO resources_mv (id, field, val)
                SELECT "${idCol}", '${field}', unnest(string_split("${sourceCol}", '|')) 
                FROM ${tempTable} WHERE "${sourceCol}" IS NOT NULL AND "${sourceCol}" != ''
            `);
        }

        if (columns.includes("dct_references_s")) {
            await conn.query(`DELETE FROM distributions WHERE resource_id IN (SELECT id FROM ${tempTable})`);
            const refs = await conn.query(`SELECT id, dct_references_s FROM ${tempTable} WHERE dct_references_s IS NOT NULL`);
            for (const row of refs.toArray()) {
                const id = row.id;
                try {
                    const json = JSON.parse(row.dct_references_s);
                    const stmt = await conn.prepare(`INSERT INTO distributions VALUES (?, ?, ?, ?)`);
                    // Note: distributions table mismatch? (resource_id, relation_key, url, label).
                    // Original code: INSERT INTO distributions VALUES (?, ?, ?) - ONLY 3 columns?
                    // Let's check dbInit schema: (resource_id, relation_key, url, label). 4 columns.
                    // But original code (Line 937) used VALUES (?, ?, ?) which implies it might have been missing label or using default?
                    // Actually Line 937 in duckdbClient.ts used `await stmt.query(id, key, String(url))`.
                    // The schema has 4 columns. If I insert 3 values, it might fail or fill first 3.
                    // Label is last.
                    // I should check if I need to pass NULL for label.

                    for (const [key, url] of Object.entries(json)) {
                        await stmt.query(id, key, String(url), null); // Explicitly pass null for label
                    }
                    await stmt.close();
                } catch { /* ignore */ }
            }
        }

        const result = await conn.query(`SELECT count(*) as count FROM ${tempTable}`);
        const rowCount = Number(result.toArray()[0].count);

        await conn.query(`DROP TABLE ${tempTable}`);
        await saveDb();

        return { success: true, message: `Imported ${rowCount} rows.`, count: rowCount };

    } catch (err: any) {
        console.error("Import failed", err);
        return { success: false, message: err.message || "Import failed" };
    }
}

type JsonImportMode = "upsert" | "replace";

function sqlLiteral(value: unknown): string {
    if (value === undefined || value === null) return "NULL";
    return `'${String(value).replace(/'/g, "''")}'`;
}

function chunk<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out;
}

function searchContentFor(resource: Resource): string {
    const parts: string[] = [resource.dct_title_s || ""];
    if (resource.dct_description_sm) parts.push(...resource.dct_description_sm);
    if (resource.dct_subject_sm) parts.push(...resource.dct_subject_sm);
    if (resource.dcat_keyword_sm) parts.push(...resource.dcat_keyword_sm);
    return parts.join(" ").replace(/\n/g, " ");
}

function normalizeRecord(record: any, uriToKey: Map<string, string>) {
    const distributions = extractDistributions(record, uriToKey);
    let resource = prepareResource(record);
    if (!resource.dcat_centroid || String(resource.dcat_centroid).trim() === "") {
        const centroid = getCentroidFromGeometry(resource);
        if (centroid) {
            resource = { ...resource, dcat_centroid: formatCentroid(centroid[0], centroid[1]) };
        }
    }
    const centroid = parseCentroidForH3(resource.dcat_centroid);
    const h3Values = H3_RES_COLUMNS.map((_, i) => {
        if (!centroid) return null;
        const res = i + 2;
        return latLngToCell(centroid[0], centroid[1], res);
    });
    return { resource, distributions, h3Values, content: searchContentFor(resource) };
}

async function ingestJsonData(recordsInput: any[], options: { skipSave?: boolean } = {}, mode: JsonImportMode = "upsert"): Promise<number> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const { conn } = ctx;

    const uriToKey = new Map<string, string>();
    for (const [key, uri] of Object.entries(REFERENCE_URI_MAPPING)) {
        uriToKey.set(uri, key);
    }

    const normalized = recordsInput
        .filter((record) => record && record.id)
        .map((record) => normalizeRecord(record, uriToKey));

    if (normalized.length === 0) return 0;

    const ids = normalized.map(({ resource }) => resource.id);
    const scalarColumns = SCALAR_FIELDS.filter((field) => field !== "dct_references_s");
    const resourceColumns = [...scalarColumns, ...H3_RES_COLUMNS];

    await conn.query("BEGIN TRANSACTION");
    try {
        if (mode === "replace") {
            await conn.query("DELETE FROM resources");
            await conn.query("DELETE FROM resources_mv");
            await conn.query("DELETE FROM distributions");
            await conn.query("DELETE FROM search_index");
        } else {
            for (const idGroup of chunk(ids, 500)) {
                const idList = idGroup.map(sqlLiteral).join(",");
                await conn.query(`DELETE FROM resources WHERE id IN (${idList})`);
                await conn.query(`DELETE FROM resources_mv WHERE id IN (${idList})`);
                await conn.query(`DELETE FROM distributions WHERE resource_id IN (${idList})`);
                await conn.query(`DELETE FROM search_index WHERE id IN (${idList})`);
            }
        }

        for (const group of chunk(normalized, 100)) {
            const values = group.map(({ resource, h3Values }) => {
                const scalarVals = scalarColumns.map((field) => {
                    const val = resource[field as keyof Resource];
                    return sqlLiteral(val);
                });
                const h3Literals = h3Values.map(sqlLiteral);
                return `(${[...scalarVals, ...h3Literals].join(",")})`;
            }).join(",");
            await conn.query(`INSERT INTO resources (${resourceColumns.map((c) => `"${c}"`).join(",")}) VALUES ${values}`);
        }

        for (const idGroup of chunk(ids, 500)) {
            const idList = idGroup.map(sqlLiteral).join(",");
            try {
                await conn.query(`
                  UPDATE resources
                  SET geom = ST_MakeEnvelope(
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
                  )
                  WHERE id IN (${idList}) AND dcat_bbox LIKE 'ENVELOPE(%'
                `);
            } catch (e) {
                console.warn("Failed to populate geom from dcat_bbox in bulk import", e);
            }
            try {
                await conn.query(`
                  UPDATE resources
                  SET geom = ST_GeomFromGeoJSON(locn_geometry)
                  WHERE id IN (${idList})
                  AND geom IS NULL
                  AND locn_geometry IS NOT NULL
                  AND trim(locn_geometry) != ''
                `);
            } catch (e) {
                console.warn("Failed to populate geom from locn_geometry in bulk import", e);
            }
        }

        const mvRows: string[] = [];
        for (const { resource } of normalized) {
            const safeId = sqlLiteral(resource.id);
            for (const field of REPEATABLE_STRING_FIELDS) {
                const values = resource[field as keyof Resource] as unknown;
                if (!Array.isArray(values)) continue;
                for (const value of values) {
                    if (!value) continue;
                    mvRows.push(`(${safeId},${sqlLiteral(field)},${sqlLiteral(value)})`);
                }
            }
        }
        for (const group of chunk(mvRows, 1000)) {
            if (group.length === 0) continue;
            await conn.query(`INSERT INTO resources_mv (id, field, val) VALUES ${group.join(",")}`);
        }

        const distRows: string[] = [];
        for (const { distributions } of normalized) {
            for (const d of distributions) {
                distRows.push(`(${sqlLiteral(d.resource_id)},${sqlLiteral(d.relation_key)},${sqlLiteral(d.url)},${sqlLiteral(d.label ?? null)})`);
            }
        }
        for (const group of chunk(distRows, 1000)) {
            if (group.length === 0) continue;
            await conn.query(`INSERT INTO distributions (resource_id, relation_key, url, label) VALUES ${group.join(",")}`);
        }

        const searchRows = normalized.map(({ resource, content }) => `(${sqlLiteral(resource.id)},${sqlLiteral(content)})`);
        for (const group of chunk(searchRows, 1000)) {
            if (group.length === 0) continue;
            await conn.query(`INSERT INTO search_index (id, content) VALUES ${group.join(",")}`);
        }

        await conn.query("COMMIT");
    } catch (error) {
        try {
            await conn.query("ROLLBACK");
        } catch {
            // ignore rollback failure
        }
        throw error;
    }

    if (!options.skipSave) {
        await saveDb();
    }
    return normalized.length;
}

export async function importJsonData(json: any, options: { skipSave?: boolean } = {}): Promise<number> {
    const records = Array.isArray(json) ? json : [json];
    return ingestJsonData(records, options, "upsert");
}

export async function replaceAllJsonData(json: any[], options: { skipSave?: boolean } = {}): Promise<number> {
    return ingestJsonData(json, options, "replace");
}

function extractDistributions(record: any, uriToKey: Map<string, string>): Distribution[] {
    const distributions: Distribution[] = [];
    if (record.dct_references_s) {
        try {
            const refs = JSON.parse(record.dct_references_s);
            for (const [uri, value] of Object.entries(refs)) {
                const relKey = uriToKey.get(uri);
                if (relKey) {
                    const items = Array.isArray(value) ? value : [value];
                    for (const item of items) {
                        let finalUrl = "";
                        let label: string | undefined = undefined;
                        if (typeof item === 'string') {
                            finalUrl = item;
                        } else if (typeof item === 'object' && item !== null) {
                            if ('url' in item) {
                                finalUrl = String((item as any).url);
                                if ('label' in item) label = String((item as any).label);
                            } else {
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
        } catch { /* ignore */ }
    }
    return distributions;
}

function prepareResource(record: any): Resource {
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
            (res as any)[field] = [res[field as keyof Resource]];
        }
    }
    return res;
}


export async function importDuckDbFile(file: File): Promise<{ success: boolean, message: string, count?: number }> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { success: false, message: "DB not initialized" };
    const { db, conn } = ctx;

    try {
        await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
        const alias = `import_${Date.now()}`;
        await conn.query(`ATTACH '${file.name}' AS ${alias}`);
        await conn.query("BEGIN TRANSACTION");

        try {
            await conn.query("DELETE FROM resources");
            await conn.query("DELETE FROM resources_mv");
            await conn.query("DELETE FROM distributions");
            await conn.query("DELETE FROM search_index");
            await conn.query("DELETE FROM static_maps");

            await conn.query(`INSERT INTO resources SELECT * FROM ${alias}.resources`);
            await conn.query(`INSERT INTO resources_mv SELECT * FROM ${alias}.resources_mv`);
            await conn.query(`INSERT INTO distributions SELECT * FROM ${alias}.distributions`);
            await conn.query(`INSERT INTO search_index SELECT * FROM ${alias}.search_index`);

            try {
                await conn.query(`INSERT INTO static_maps SELECT * FROM ${alias}.static_maps`);
            } catch { /* ignore */ }

            await conn.query("COMMIT");
        } catch (txErr) {
            await conn.query("ROLLBACK");
            throw txErr;
        } finally {
            await conn.query(`DETACH ${alias}`);
        }

        await saveDb();
        const res = await conn.query("SELECT count(*) as c FROM resources");
        const count = Number(res.toArray()[0].c);
        return { success: true, message: `Database restored successfully.`, count };

    } catch (err: any) {
        console.error("Restore failed", err);
        return { success: false, message: err.message || "Restore failed" };
    }
}
