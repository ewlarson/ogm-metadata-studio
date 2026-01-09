import { getDuckDbContext } from "./dbInit";
import { saveDb } from "./lifecycle";
import { upsertResource } from "./mutations";
import { Resource, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS, CSV_HEADER_MAPPING, REFERENCE_URI_MAPPING, Distribution } from "../aardvark/model";
import * as duckdb from "@duckdb/duckdb-wasm";

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

export async function importJsonData(json: any, options: { skipSave?: boolean } = {}): Promise<number> {
    const records = Array.isArray(json) ? json : [json];
    let count = 0;
    const uriToKey = new Map<string, string>();
    for (const [key, uri] of Object.entries(REFERENCE_URI_MAPPING)) {
        uriToKey.set(uri, key);
    }

    for (const record of records) {
        if (!record.id) continue;
        const distributions = extractDistributions(record, uriToKey);
        const res = prepareResource(record);
        await upsertResource(res, distributions, { skipSave: true });
        count++;
    }

    if (!options.skipSave) {
        await saveDb();
    }
    return count;
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
