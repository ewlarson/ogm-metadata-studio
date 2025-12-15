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
        process.exit(1);
    }
}

buildDatabase();
