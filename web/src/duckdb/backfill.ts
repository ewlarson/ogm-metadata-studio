import { getDuckDbContext } from "./dbInit";
import { saveDb } from "./lifecycle";
import { parseCentroidForH3 } from "./mutations";
import { latLngToCell } from "h3-js";
import { H3_RES_COLUMNS, RESOURCES_TABLE } from "./schema";

/**
 * Backfill dcat_centroid and H3 columns for existing resources that have geometry
 * but were imported before centroid/H3 logic existed. Run when DB is ready so the
 * map facet hexagons show for existing data.
 */
export async function backfillCentroidAndH3(): Promise<{ centroidFilled: number; h3Filled: number }> {
    const ctx = await getDuckDbContext();
    if (!ctx) return { centroidFilled: 0, h3Filled: 0 };
    const { conn } = ctx;
    let centroidFilled = 0;
    let h3Filled = 0;

    try {
        // 1) Populate geom from dcat_bbox where missing
        await conn.query(`
            UPDATE ${RESOURCES_TABLE}
            SET geom = ST_MakeEnvelope(
                CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
                CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
                CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
                CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
            )
            WHERE dcat_bbox LIKE 'ENVELOPE(%' AND geom IS NULL
        `);
        // DuckDB UPDATE doesn't return row count in same way; ignore

        // 2) Populate geom from locn_geometry (GeoJSON) where geom still null
        const needGeomFromJson = await conn.query(`
            SELECT id, locn_geometry FROM ${RESOURCES_TABLE}
            WHERE geom IS NULL AND locn_geometry IS NOT NULL AND trim(locn_geometry) != ''
            AND locn_geometry LIKE '%"type"%' AND locn_geometry LIKE '%"coordinates"%'
        `);
        for (const row of needGeomFromJson.toArray() as { id: string; locn_geometry: string }[]) {
            try {
                const safe = row.locn_geometry.replace(/'/g, "''");
                const safeId = row.id.replace(/'/g, "''");
                await conn.query(`UPDATE ${RESOURCES_TABLE} SET geom = ST_GeomFromGeoJSON('${safe}') WHERE id = '${safeId}'`);
            } catch {
                // skip invalid GeoJSON
            }
        }

        // 3) dcat_centroid from bbox center where centroid null and dcat_bbox present
        await conn.query(`
            UPDATE ${RESOURCES_TABLE}
            SET dcat_centroid = '{"type":"Point","coordinates":[' ||
                (CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE) + CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE)) / 2 || ',' ||
                (CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE) + CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE)) / 2 || ']}'
            WHERE dcat_bbox LIKE 'ENVELOPE(%'
            AND (dcat_centroid IS NULL OR trim(dcat_centroid) = '')
        `);

        // 4) dcat_centroid from geom center where still null (e.g. geometry-only rows)
        try {
            await conn.query(`
                UPDATE ${RESOURCES_TABLE}
                SET dcat_centroid = '{"type":"Point","coordinates":[' ||
                    (ST_XMin(geom) + ST_XMax(geom)) / 2 || ',' ||
                    (ST_YMin(geom) + ST_YMax(geom)) / 2 || ']}'
                WHERE geom IS NOT NULL AND (dcat_centroid IS NULL OR trim(dcat_centroid) = '')
            `);
        } catch {
            // DuckDB spatial may not expose ST_XMin/ST_XMax in all builds; skip this step
        }

        const centroidCount = await conn.query(`
            SELECT count(*) as c FROM ${RESOURCES_TABLE}
            WHERE dcat_centroid IS NOT NULL AND trim(dcat_centroid) != ''
        `);
        centroidFilled = Number(centroidCount.toArray()[0].c);

        // 5) H3 indices for all rows with centroid (batch by row)
        const rows = await conn.query(`
            SELECT id, dcat_centroid FROM ${RESOURCES_TABLE}
            WHERE dcat_centroid IS NOT NULL AND trim(dcat_centroid) != ''
            AND (h3_res2 IS NULL OR h3_res2 = '')
        `);
        const toUpdate = rows.toArray() as { id: string; dcat_centroid: string }[];
        for (const row of toUpdate) {
            const centroid = parseCentroidForH3(row.dcat_centroid);
            if (!centroid) continue;
            const [lat, lng] = centroid;
            const updates = H3_RES_COLUMNS.map((col, i) => {
                const res = i + 2;
                const h3 = latLngToCell(lat, lng, res);
                return `"${col}" = '${h3.replace(/'/g, "''")}'`;
            });
            const safeId = row.id.replace(/'/g, "''");
            await conn.query(`UPDATE ${RESOURCES_TABLE} SET ${updates.join(", ")} WHERE id = '${safeId}'`);
            h3Filled++;
        }

        if (centroidFilled > 0 || h3Filled > 0) {
            await saveDb();
        }
    } catch (e) {
        console.warn("Backfill centroid/H3 failed", e);
    }
    return { centroidFilled, h3Filled };
}
