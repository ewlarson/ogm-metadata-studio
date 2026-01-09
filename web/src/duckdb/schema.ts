import * as duckdb from "@duckdb/duckdb-wasm";
import { SCALAR_FIELDS } from "../aardvark/model";

export const RESOURCES_TABLE = "resources";
export const RESOURCES_MV_TABLE = "resources_mv";
export const DISTRIBUTIONS_TABLE = "distributions";
export const IMAGE_SERVICE_TABLE = "resources_image_service";

export async function ensureSchema(conn: duckdb.AsyncDuckDBConnection) {
    // 1. Resources Table (Scalars)
    // We treat all scalars as VARCHAR for flexibility, plus specific types where needed (geom, embedding)
    const scalarCols = SCALAR_FIELDS.map(f => `"${f}" VARCHAR`).join(", ");

    // Create Main Table
    await conn.query(`CREATE TABLE IF NOT EXISTS ${RESOURCES_TABLE} (${scalarCols}, geom GEOMETRY, embedding FLOAT[])`);

    // Ensure columns exist (Schema Migration / Evolution)
    const resInfo = await conn.query(`DESCRIBE ${RESOURCES_TABLE}`);
    const resCols = resInfo.toArray().map((r: any) => r.column_name);

    if (!resCols.includes('geom')) {
        await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN geom GEOMETRY`);
    }
    if (!resCols.includes('embedding')) {
        await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN embedding FLOAT[]`);
    }

    // 2. Multivalue Table (EAV pattern for arrays)
    await conn.query(`CREATE TABLE IF NOT EXISTS ${RESOURCES_MV_TABLE} (id VARCHAR, field VARCHAR, val VARCHAR)`);

    // 3. Distributions Table
    await conn.query(`CREATE TABLE IF NOT EXISTS ${DISTRIBUTIONS_TABLE} (resource_id VARCHAR, relation_key VARCHAR, url VARCHAR, label VARCHAR)`);

    // 4. Image Service / Thumbnail Cache
    await conn.query(`CREATE TABLE IF NOT EXISTS ${IMAGE_SERVICE_TABLE} (id VARCHAR, data VARCHAR, last_updated UBIGINT)`);

    // Indexes (Optional but good for performance)
    // Note: DuckDB indexes are currently limited, but let's try creating one on ID
    try {
        await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON ${RESOURCES_TABLE} (id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_resources_mv_id ON ${RESOURCES_MV_TABLE} (id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_resources_mv_field ON ${RESOURCES_MV_TABLE} (field)`);
    } catch (e) {
        console.warn("Index creation failed (might be not supported in this DuckDB WASM version)", e);
    }
}
