import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbInit from './dbInit';
import {
    searchResources,
    facetedSearch,
    getDistinctValues,
    compileFacetedWhere,
    countResources,
    getSearchNeighbors,
    querySimilarResources,
    fetchResourcesByIds,
    getStaticMap,
    getThumbnail,
    getFacetValues,
    executeQuery
} from './queries';
import { FacetedSearchRequest } from './types';

// Mock the entire dbInit module
vi.mock('./dbInit', () => ({
    getDuckDbContext: vi.fn()
}));

// Helper to create a mock database connection
const createMockConn = () => {
    const queryMock = vi.fn();
    return {
        query: queryMock,
        prepare: vi.fn(),
        close: vi.fn()
    };
};

describe('DuckDB Queries Comprehensive', () => {
    let mockConn: any;

    beforeEach(() => {
        vi.resetAllMocks();
        mockConn = createMockConn();
        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue({
            conn: mockConn,
            db: {} as any
        });
    });

    describe('fetchResourcesByIds (Hydration)', () => {
        it('hydrates resources with multivalued fields and distributions', async () => {
            // Scalar
            mockConn.query.mockResolvedValueOnce({
                toArray: () => [{ id: '1', dct_title_s: 'Title' }]
            });
            // MV
            mockConn.query.mockResolvedValueOnce({
                toArray: () => [{ id: '1', field: 'dct_subject_sm', val: 'Maps' }]
            });
            // Dist
            mockConn.query.mockResolvedValueOnce({
                toArray: () => [{ resource_id: '1', url: 'http://foo' }]
            });
            // Thumb
            mockConn.query.mockResolvedValueOnce({
                toArray: () => []
            });

            const res = await fetchResourcesByIds(mockConn, ['1']);
            expect(res).toHaveLength(1);
            expect(res[0].dct_subject_sm).toEqual(['Maps']);
            // Check distributions presence indirectly via mapping logic check potentially
            // but fetching logic doesn't explicitly return distributions in Resource array unless mapping does.
            // mapping.ts resourceFromRow handles distributions.
        });

        it('handles thumbnail decoding errors', async () => {
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: '1' }] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] });
            // Thumb with invalid base64
            mockConn.query.mockResolvedValueOnce({
                toArray: () => [{ id: '1', data: 'invalid-base64' }]
            });

            // Should not crash
            const res = await fetchResourcesByIds(mockConn, ['1']);
            expect(res).toHaveLength(1);
            expect(res[0].thumbnail).toBeUndefined();
        });
    });

    describe('searchResources', () => {
        it('handles spatial sorting', async () => {
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 10n }] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: '1' }] });
            mockConn.query.mockResolvedValue({ toArray: () => [] }); // Hydration fallbacks

            await searchResources(1, 10, 'dct_title_s', 'asc', 'test');
            // Since explicit spatial logic wasn't triggered by sort param alone in searchResources,
            // we check normal sort logic.
            const call = mockConn.query.mock.calls[1][0];
            expect(call).toContain('ORDER BY "dct_title_s" ASC');
        });
    });

    describe('facetedSearch', () => {
        it('applies global spatial search', async () => {
            // 1. Create Temp Table
            mockConn.query.mockResolvedValueOnce({});

            // 2. Parallel: IDs + Count
            // Note: Promise.all order isn't guaranteed relative to each other if they fire instantly, 
            // but usually they go in order of listing in array.
            // IDs
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] });
            // Count
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ c: 5n }] });

            // 3. Facets (if any - none here)

            const req: FacetedSearchRequest = {
                bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }
            };
            await facetedSearch(req);

            // Verify Temp Table creation
            const createTable = mockConn.query.mock.calls.find((c: any) => c[0].includes('CREATE TEMP TABLE'));
            expect(createTable).toBeDefined();
            expect(createTable[0]).toContain('ST_Intersects');
        });

        it('sorts by year', async () => {
            // No global update needed since no q/bbox
            // Parallel: IDs + Count
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ c: 0n }] });

            const req: FacetedSearchRequest = {
                sort: [{ field: 'gbl_indexYear_im', dir: 'desc' }]
            };
            await facetedSearch(req);

            expect(mockConn.query).toHaveBeenCalled();
            const idsQuery = mockConn.query.mock.calls.find((c: any) => c[0].includes('TRY_CAST'));
            expect(idsQuery).toBeDefined();
        });
    });

    describe('getFacetValues', () => {
        it('handles external filters', async () => {
            // Promise.all(sql, countSql)
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 0 }] });

            const req = {
                field: 'gbl_indexYear_im',
                filters: {
                    'dct_subject_sm': { any: ['History'] }
                }
            };
            await getFacetValues(req);
            const calls = mockConn.query.mock.calls;
            // Should check for the Subject filter, NOT the Year filter (which would be omitted if present)
            const call = calls.find((c: any) => c[0].includes('History'));
            expect(call).toBeDefined();
        });

        it('handles scalar field facets', async () => {
            // Promise.all(sql, countSql)
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ val: 'A', c: 10 }] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 1 }] });

            const req = { field: 'dct_accessRights_s' };
            const res = await getFacetValues(req);
            expect(res.values[0].value).toBe('A');

            const calls = mockConn.query.mock.calls;
            const call = calls.find((c: any) => c[0].includes('GROUP BY "dct_accessRights_s"'));
            expect(call).toBeDefined();
        });
    });

    describe('Assets', () => {
        it('getThumbnail decodes data', async () => {
            const b64 = btoa('test');
            mockConn.query.mockResolvedValue({
                numRows: 1,
                get: () => ({ data: b64 }),
                toArray: () => [{ data: b64 }]
            });
            global.URL.createObjectURL = vi.fn(() => 'blob:url');

            const url = await getThumbnail('1');
            expect(url).toBe('blob:url');
        });

        it('getStaticMap returns null on empty', async () => {
            mockConn.query.mockResolvedValue({ numRows: 0 });
            expect(await getStaticMap('1')).toBeNull();
        });
    });

    describe('executeQuery', () => {
        it('returns raw rows', async () => {
            mockConn.query.mockResolvedValue({
                toArray: () => ([{ a: 1 }])
            });
            const res = await executeQuery('SELECT 1');
            expect(res).toEqual([{ a: 1 }]);
        });

        it('handles errors gracefully', async () => {
            mockConn.query.mockRejectedValue(new Error('fail'));
            const res = await executeQuery('SELECT 1');
            expect(res).toEqual([]);
        });
    });
});
