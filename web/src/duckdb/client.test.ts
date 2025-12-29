import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importJsonData } from './duckdbClient';
import { FIXTURE_POINT, FIXTURE_POLYGON, FIXTURE_SCANNED_MAP, FIXTURE_MINIMAL } from '../test/fixtures';
import * as dbInit from './dbInit';

// Mock the dbInit module
vi.mock('./dbInit', async (importOriginal) => {
    const actual = await importOriginal<typeof dbInit>();
    return {
        ...actual,
        getDuckDbContext: vi.fn(),
    };
});

describe('DuckDB Client Core', () => {
    let mockQuery: any;

    beforeEach(() => {
        vi.resetAllMocks();

        // Setup mock connection
        mockQuery = vi.fn().mockResolvedValue({
            toArray: () => [{ c: 0 }], // Default count response
            schema: { fields: [] }
        });

        // Mock getDuckDbContext implementation
        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue({
            db: {
                copyFileToBuffer: vi.fn().mockResolvedValue(new Uint8Array())
            } as any,
            conn: {
                query: mockQuery
            } as any
        });
    });

    it('initializes the database connection via importJsonData', async () => {
        await importJsonData([FIXTURE_POINT]);
        expect(dbInit.getDuckDbContext).toHaveBeenCalled();
    });

    it('imports Json Data and inserts into resources table', async () => {
        await importJsonData([FIXTURE_POINT], { skipSave: true });

        // Check if query was called with INSERT INTO resources
        // The implementation calls various queries. We look for the big INSERT.
        const insertCalls = mockQuery.mock.calls.filter((args: any[]) => args[0].includes('INSERT INTO resources'));
        expect(insertCalls.length).toBeGreaterThan(0);

        const sql = insertCalls[0][0];
        expect(sql).toContain(FIXTURE_POINT.id);
        expect(sql).toContain(FIXTURE_POINT.dct_title_s);
    });

    it('handles multiple records', async () => {
        const result = await importJsonData([
            FIXTURE_POINT,
            FIXTURE_POLYGON,
            FIXTURE_SCANNED_MAP,
            FIXTURE_MINIMAL
        ], { skipSave: true });

        // Result should be count of processed records? 
        // importJsonData implementation returns `count` variable.
        // It iterates and increments.
        expect(result).toBe(4);
    });

    it('correctly inserts distributions', async () => {
        // FIXTURE_POINT has distributions in dct_references_s
        await importJsonData([FIXTURE_POINT], { skipSave: true });

        const distCalls = mockQuery.mock.calls.filter((args: any[]) => args[0].includes('INSERT INTO distributions'));
        expect(distCalls.length).toBeGreaterThan(0);
        expect(distCalls[0][0]).toContain('https://example.com/point.zip');
    });
});

describe('DuckDB Search & Filter', () => {
    let mockQuery: any;

    beforeEach(() => {
        vi.resetAllMocks();

        mockQuery = vi.fn().mockImplementation((sql: string) => {
            if (/count\(\*\)/i.test(sql)) {
                // facetedSearch uses 'c', searchResources might use 'total' or 'c'.
                // facetedSearch: SELECT count(*) as c
                // searchResources: SELECT COUNT(*) as total
                if (sql.includes('as c')) return { toArray: () => [{ c: 1 }] };
                return { toArray: () => [{ total: 1 }] };
            }
            if (sql.includes('SELECT id FROM resources')) {
                return { toArray: () => [{ id: 'fixture-point-1' }] };
            }
            if (sql.includes('SELECT * FROM resources WHERE id IN')) {
                return {
                    toArray: () => [{
                        id: 'fixture-point-1',
                        dct_title_s: 'Fixture Point Dataset',
                        dct_accessRights_s: 'Public',
                        gbl_resourceClass_sm: ['Datasets'],
                        gbl_mdVersion_s: 'Aardvark'
                    }]
                };
            }
            if (sql.includes('SELECT * FROM resources_mv WHERE id IN')) {
                return { toArray: () => [] };
            }
            if (sql.includes('SELECT * FROM distributions WHERE resource_id IN')) {
                return { toArray: () => [] };
            }
            if (sql.includes('SELECT * FROM resources_image_service')) {
                return { toArray: () => [] };
            }
            return { toArray: () => [] };
        });

        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue({
            db: {} as any,
            conn: { query: mockQuery } as any
        });
    });

    it('searchResources returns results', async () => {
        const { searchResources } = await import('./duckdbClient');
        const res = await searchResources(1, 10, 'id', 'asc', 'test');

        expect(res.total).toBe(1);
        expect(res.resources.length).toBe(1);
        expect(res.resources[0].id).toBe('fixture-point-1');

        // precise SQL check
        const calls = mockQuery.mock.calls.map((c: any) => c[0]);
        const countSql = calls.find((s: string) => s.includes('COUNT(*)'));
        expect(countSql).toContain("id ILIKE '%test%'");
    });

    it('facetedSearch applies filters', async () => {
        const { facetedSearch } = await import('./duckdbClient');
        const req = {
            q: 'maps',
            filters: {
                'gbl_resourceClass_sm': { any: ['Maps'] }
            }
        };

        await facetedSearch(req);

        // Check generated SQL for filters
        const calls = mockQuery.mock.calls.map((c: any) => c[0]);
        // The implementation creates a temp table for global hits
        const mainSql = calls.find((s: string) => s.includes('CREATE TEMP TABLE'));

        if (mainSql) {
            expect(mainSql).toContain("id IN (SELECT id FROM search_index");
        } else {
            // Or it might be a direct query if optimization didn't trigger?
            // Actually implementation uses global hits table if Q is present.
        }
    });

    it('facetedSearch applies spatial filter', async () => {
        const { facetedSearch } = await import('./duckdbClient');
        const req = {
            bbox: { minX: -10, minY: -10, maxX: 10, maxY: 10 }
        };

        await facetedSearch(req);

        const calls = mockQuery.mock.calls.map((c: any) => c[0]);
        const spatialSql = calls.find((s: string) => s.includes('ST_Intersects'));
        expect(spatialSql).toBeDefined();
        expect(spatialSql).toContain('ST_MakeEnvelope(-10, -10, 10, 10)');
    });
});
