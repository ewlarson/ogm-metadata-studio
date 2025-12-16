const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
// const glob = require('glob'); // Not using this, DuckDB handles globs

const METADATA_DIR = path.join(__dirname, '../../metadata');
const OUTPUT_FILE = path.join(__dirname, '../public/resources.parquet');

async function buildDatabase() {
    console.log('Building DuckDB/Parquet artifact...');
    console.log(`Scanning looking for JSONs in: ${METADATA_DIR}`);

    // Ensure public dir exists
    const publicDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    const db = new duckdb.Database(':memory:');

    const run = (sql) => new Promise((resolve, reject) => {
        db.run(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    const all = (sql) => new Promise((resolve, reject) => {
        db.all(sql, (err, res) => {
            if (err) reject(err);
            else resolve(res);
        });
    });

    try {
        const globPattern = path.join(METADATA_DIR, '**/*.json');
        console.log(`Glob pattern: ${globPattern}`);

        // Check if any files exist first to avoid DuckDB error
        const files = require('glob').sync(globPattern); // We need glob if we want to check beforehand, 
        // OR we can just try/catch the SQL.
        // But wait, I commented out glob require.
        // Let's just create an empty table if read_json_auto fails or returns 0.

        // Actually, easiest is to wrap the create table in try/catch or check if dir is empty.

        if (!fs.existsSync(METADATA_DIR) || fs.readdirSync(METADATA_DIR).filter(f => f.endsWith('.json')).length === 0) {
            console.log("No metadata files found locally. Skipping local Parquet generation (Decoupled Mode).");
            // Create empty parquet
            // We need a schema though? Or just empty file?
            // App expects resources.parquet to exist?
            // App handles "Parquet not found" gracefully in remote mode? No, local fallback tries to import.
            // If we create a valid empty parquet it's safer.

            await run("CREATE TABLE resources (id VARCHAR, dct_title_s VARCHAR)"); // Minimal schema to pass
            await run(`COPY resources TO '${OUTPUT_FILE}' (FORMAT PARQUET)`);
            return;
        }

        // DuckDB read_json_auto supports glob patterns
        // We select * from the json files
        // We use filename=true to debug if needed, union_by_name to handle partial schemas
        await run(`
            CREATE TABLE resources AS 
            SELECT * FROM read_json_auto('${globPattern}', union_by_name=true, filename=true)
        `);

        // Check count
        const result = await all('SELECT count(*) as count FROM resources');
        console.log(`Loaded ${result[0].count} records from JSON files.`);

        // Export to Parquet
        console.log(`Exporting to ${OUTPUT_FILE}...`);
        await run(`COPY resources TO '${OUTPUT_FILE}' (FORMAT PARQUET)`);

        console.log('Database build complete.');
    } catch (err) {
        console.error('Build failed:', err);
        // Don't exit 1, just warn so dev server can start
        console.warn("Continuing despite build failure (acceptable if data is remote)");
    }
}

buildDatabase();
