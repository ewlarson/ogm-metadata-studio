import { describe, it, expect, vi, beforeEach } from 'vitest';
import { databaseService } from './DatabaseService';
import * as queries from '../duckdb/queries';
import * as mutations from '../duckdb/mutations';
import * as imprt from '../duckdb/import';
import * as exprt from '../duckdb/export';
import * as lifec from '../duckdb/lifecycle';
import * as dbInit from '../duckdb/dbInit';

// Mock all dependencies
vi.mock('../duckdb/queries');
vi.mock('../duckdb/mutations');
vi.mock('../duckdb/import');
vi.mock('../duckdb/export');
vi.mock('../duckdb/lifecycle');
vi.mock('../duckdb/dbInit');

describe('DatabaseService', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe('Lifecycle', () => {
        it('init calls getDuckDbContext', async () => {
            await databaseService.init();
            expect(dbInit.getDuckDbContext).toHaveBeenCalled();
        });

        it('save calls saveDb', async () => {
            await databaseService.save();
            expect(lifec.saveDb).toHaveBeenCalled();
        });
    });

    describe('Queries', () => {
        it('searchResources delegates correctly', async () => {
            await databaseService.searchResources(1, 20, 'id', 'asc', 'test');
            expect(queries.searchResources).toHaveBeenCalledWith(1, 20, 'id', 'asc', 'test');
        });

        it('facetedSearch delegates correctly', async () => {
            const req: any = { q: 'test' };
            await databaseService.facetedSearch(req);
            expect(queries.facetedSearch).toHaveBeenCalledWith(req);
        });

        it('queryResourceById delegates correctly', async () => {
            await databaseService.queryResourceById('123');
            expect(queries.queryResourceById).toHaveBeenCalledWith('123');
        });

        it('suggest delegates correctly', async () => {
            await databaseService.suggest('geo', 5);
            expect(queries.suggest).toHaveBeenCalledWith('geo', 5);
        });

        it('getDistinctValues delegates correctly', async () => {
            await databaseService.getDistinctValues('field', 'q', 10);
            expect(queries.getDistinctValues).toHaveBeenCalledWith('field', 'q', 10);
        });

        it('getFacetValues delegates correctly', async () => {
            const req: any = { facet: 'test' };
            await databaseService.getFacetValues(req);
            expect(queries.getFacetValues).toHaveBeenCalledWith(req);
        });

        it('executeQuery delegates correctly', async () => {
            await databaseService.executeQuery('SELECT 1');
            expect(queries.executeQuery).toHaveBeenCalledWith('SELECT 1');
        });

        it('getSearchNeighbors delegates correctly', async () => {
            const req: any = {};
            await databaseService.getSearchNeighbors(req, 'curr');
            expect(queries.getSearchNeighbors).toHaveBeenCalledWith(req, 'curr');
        });

        it('queryDistributions delegates correctly', async () => {
            await databaseService.queryDistributions(1, 10);
            expect(queries.queryDistributions).toHaveBeenCalledWith(1, 10, undefined, undefined, undefined);
        });

        it('getDistributionsForResource delegates correctly', async () => {
            await databaseService.getDistributionsForResource('123');
            expect(queries.getDistributionsForResource).toHaveBeenCalledWith('123');
        });

        it('countResources delegates correctly', async () => {
            await databaseService.countResources();
            expect(queries.countResources).toHaveBeenCalled();
        });
    });

    describe('Asset Queries', () => {
        it('hasStaticMap delegates correctly', async () => {
            await databaseService.hasStaticMap('1');
            expect(queries.hasStaticMap).toHaveBeenCalledWith('1');
        });

        it('getStaticMap delegates correctly', async () => {
            await databaseService.getStaticMap('1');
            expect(queries.getStaticMap).toHaveBeenCalledWith('1');
        });

        it('getThumbnail delegates correctly', async () => {
            await databaseService.getThumbnail('1');
            expect(queries.getThumbnail).toHaveBeenCalledWith('1');
        });
    });

    describe('Mutations', () => {
        it('upsertResource delegates correctly', async () => {
            const res: any = { id: '1' };
            await databaseService.upsertResource(res);
            expect(mutations.upsertResource).toHaveBeenCalledWith(res);
        });

        it('deleteResource delegates correctly', async () => {
            await databaseService.deleteResource('1');
            expect(mutations.deleteResource).toHaveBeenCalledWith('1');
        });

        it('upsertStaticMap delegates correctly', async () => {
            const blob = new Blob([]);
            await databaseService.upsertStaticMap('1', blob);
            expect(mutations.upsertStaticMap).toHaveBeenCalledWith('1', blob);
        });

        it('upsertThumbnail delegates correctly', async () => {
            const blob = new Blob([]);
            await databaseService.upsertThumbnail('1', blob);
            expect(mutations.upsertThumbnail).toHaveBeenCalledWith('1', blob);
        });
    });

    describe('Import/Export', () => {
        it('importJsonData delegates correctly', async () => {
            const data: any = {};
            await databaseService.importJsonData(data);
            expect(imprt.importJsonData).toHaveBeenCalledWith(data, undefined);
        });

        it('importCsv delegates correctly', async () => {
            const file = new File([], 'test.csv');
            vi.mocked(imprt.importCsv).mockResolvedValue({ count: 10, errors: [] });
            await databaseService.importCsv(file);
            expect(imprt.importCsv).toHaveBeenCalledWith(file);
        });

        it('importDuckDbFile delegates correctly', async () => {
            const file = new File([], 'test.db');
            await databaseService.importDuckDbFile(file);
            expect(imprt.importDuckDbFile).toHaveBeenCalledWith(file);
        });

        it('exportDbBlob delegates correctly', async () => {
            await databaseService.exportDbBlob();
            expect(lifec.exportDbBlob).toHaveBeenCalled();
        });

        it('exportAardvarkJsonZip delegates correctly', async () => {
            await databaseService.exportAardvarkJsonZip();
            expect(exprt.exportAardvarkJsonZip).toHaveBeenCalled();
        });

        it('exportFilteredResults delegates correctly', async () => {
            const req: any = {};
            await databaseService.exportFilteredResults(req, 'json');
            expect(exprt.exportFilteredResults).toHaveBeenCalledWith(req, 'json');
        });
    });
});
