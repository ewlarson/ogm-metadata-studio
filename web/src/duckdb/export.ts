import { getDuckDbContext } from "./dbInit";
import { Resource, resourceToJson, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS, CSV_HEADER_MAPPING } from "../aardvark/model";
import { queryResources, compileFacetedWhere, fetchResourcesByIds } from "./queries";
import { FacetedSearchRequest } from "./types";
import JSZip from "jszip";

export async function generateParquet(resources: Resource[]): Promise<Uint8Array | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const { db, conn } = ctx;

    const tempJson = `temp_export_${Date.now()}.json`;
    const tempParquet = `temp_export_${Date.now()}.parquet`;

    try {
        await db.registerFileText(tempJson, JSON.stringify(resources));
        await conn.query(`COPY (SELECT * FROM read_json_auto('${tempJson}')) TO '${tempParquet}' (FORMAT PARQUET)`);
        const buffer = await db.copyFileToBuffer(tempParquet);

        // Cleanup
        await db.dropFile(tempJson);
        await db.dropFile(tempParquet);

        return buffer;
    } catch (e) {
        console.warn("Failed to generate parquet", e);
        return null;
    }
}

export async function zipResources(resources: Resource[], parquetBuffer: Uint8Array | null = null): Promise<Blob> {
    const zip = new JSZip();
    let count = 0;
    for (const res of resources) {
        if (!res.id) continue;
        const json = resourceToJson(res);

        // Determine folder name based on primary Resource Class
        let folder = "Uncategorized";
        if (res.gbl_resourceClass_sm && res.gbl_resourceClass_sm.length > 0) {
            folder = res.gbl_resourceClass_sm[0];
        }

        // Clean folder name to be safe
        folder = folder.replace(/[^a-zA-Z0-9 _-]/g, "");

        zip.file(`metadata-aardvark/${folder}/${res.id}.json`, JSON.stringify(json, null, 2));
        count++;
    }

    if (parquetBuffer) {
        zip.file(`metadata-aardvark/metadata.parquet`, parquetBuffer);
        console.log("Added metadata.parquet to zip");
    }

    // Also include schema.md or docs?
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


export async function exportAardvarkJsonZip(): Promise<Blob | null> {
    const resources = await queryResources();
    const parquet = await generateParquet(resources);
    return zipResources(resources, parquet);
}

export async function exportFilteredResults(req: FacetedSearchRequest, format: 'json' | 'csv'): Promise<Blob | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const { conn } = ctx;

    const where = compileFacetedWhere(req).sql;
    const idsRes = await conn.query(`SELECT id FROM resources WHERE ${where}`);
    const ids = idsRes.toArray().map((r: any) => r.id);

    console.log(`Exporting ${ids.length} resources as ${format}...`);

    const resources = await fetchResourcesByIds(conn, ids);

    if (format === 'json') {
        const parquet = await generateParquet(resources);
        return zipResources(resources, parquet);
    } else {
        return csvResources(resources);
    }
}
