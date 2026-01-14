import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importCsv, importJsonData, importDuckDbFile } from './import';
import * as dbInit from './dbInit';
import * as lifecycle from './lifecycle';
import * as mutations from './mutations';

// Mock dependencies
vi.mock('./dbInit', () => ({
    getDuckDbContext: vi.fn(),
}));

vi.mock('./lifecycle', () => ({
    saveDb: vi.fn(),
}));

vi.mock('./mutations', () => ({
    upsertResource: vi.fn(),
}));

vi.mock('@duckdb/duckdb-wasm', () => ({
    DuckDBDataProtocol: { BROWSER_FILEREADER: 1 }
}));

const mockConn = {
    query: vi.fn(),
    prepare: vi.fn(),
};

const mockDb = {
    registerFileHandle: vi.fn(),
};

const mockCtx = {
    conn: mockConn,
    db: mockDb,
};

describe('DuckDB Import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue(mockCtx as any);
        mockConn.query.mockReset();
        mockConn.prepare.mockReset();
    });

    describe('importJsonData', () => {
        it('iterates records and upserts', async () => {
            const data = [
                { id: '1', dct_title_s: 'One' },
                { id: '2', dct_title_s: 'Two' }
            ];

            const count = await importJsonData(data);

            expect(count).toBe(2);
            expect(mutations.upsertResource).toHaveBeenCalledTimes(2);
            expect(lifecycle.saveDb).toHaveBeenCalled();
        });

        it('handles single object', async () => {
            const data = { id: '1', dct_title_s: 'One' };
            await importJsonData(data);
            expect(mutations.upsertResource).toHaveBeenCalledTimes(1);
        });

        it('normalizes list fields', async () => {
            const data = { id: '1', dct_subject_sm: 'History' }; // string instead of array
            await importJsonData(data);

            expect(mutations.upsertResource).toHaveBeenCalledWith(
                expect.objectContaining({ dct_subject_sm: ['History'] }),
                expect.any(Array),
                expect.any(Object)
            );
        });
    });

    describe('importCsv', () => {
        it('imports resources CSV', async () => {
            const file = new File(['id,dct_title_s\n1,Test'], 'test.csv', { type: 'text/csv' });

            // Mock sequence of queries
            mockConn.query
                // CREATE TABLE
                .mockResolvedValueOnce(undefined)
                // DESCRIBE -> columns
                .mockResolvedValueOnce({
                    toArray: () => [{ column_name: 'id' }, { column_name: 'dct_title_s' }]
                })
                // SELECT LIMIT 0 -> headers
                .mockResolvedValueOnce({
                    schema: { fields: [{ name: 'id' }, { name: 'dct_title_s' }] }
                })
                // DELETE old
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                // INSERT
                .mockResolvedValueOnce(undefined)
                // Geom Update
                .mockResolvedValueOnce(undefined)
                // Count
                .mockResolvedValueOnce({ toArray: () => [{ count: 1 }] });

            const result = await importCsv(file);

            expect(result.success).toBe(true);
            expect(result.count).toBe(1);
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO resources'));
        });

        it('imports distributions CSV', async () => {
            // Heuristic triggers: ID, Type, URL
            const file = new File(['ID,Type,URL\n1,file,http://x'], 'dist.csv', { type: 'text/csv' });

            mockConn.query
                .mockResolvedValueOnce(undefined) // Create table
                // Describe (ignored if heuristic hits early? No, used for headers)
                .mockResolvedValueOnce({ toArray: () => [] })
                // Headers 
                .mockResolvedValueOnce({
                    schema: { fields: [{ name: 'ID' }, { name: 'Type' }, { name: 'URL' }] }
                })
                // INSERT distributions
                .mockResolvedValueOnce(undefined)
                // Count
                .mockResolvedValueOnce({ toArray: () => [{ c: 5 }] });

            const result = await importCsv(file);

            expect(result.success).toBe(true);
            expect(result.message).toContain('distributions');
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO distributions'));
        });
    });

    describe('importDuckDbFile', () => {
        it('restores database from file', async () => {
            const file = new File(['...'], 'backup.duckdb');

            mockConn.query.mockResolvedValue({ toArray: () => [{ c: 10 }] }); // Default for count

            const result = await importDuckDbFile(file);

            expect(result.success).toBe(true);
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('ATTACH'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('BEGIN TRANSACTION'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO resources SELECT *'));
            expect(lifecycle.saveDb).toHaveBeenCalled();
        });
    });
});
