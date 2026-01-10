import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDuckDbContext, loadFromIndexedDB, saveToIndexedDB } from './dbInit';
import * as duckdb from "@duckdb/duckdb-wasm";
import { ensureSchema } from './schema';

// Mock schema
vi.mock('./schema', () => ({
    ensureSchema: vi.fn()
}));

// Mock Workers
class MockWorker {
    terminate = vi.fn();
}
vi.stubGlobal('Worker', MockWorker);

// Mock duckdb-wasm
const mockConn = {
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn()
};

const mockDb = {
    open: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockConn),
    registerFileBuffer: vi.fn(),
    dropFile: vi.fn(),
    instantiate: vi.fn()
};

vi.mock('@duckdb/duckdb-wasm', () => {
    return {
        AsyncDuckDB: vi.fn(() => mockDb),
        ConsoleLogger: vi.fn()
    };
});

// Mock IndexedDB
const mockIDB = {
    open: vi.fn()
};
vi.stubGlobal('indexedDB', mockIDB);

describe('dbInit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset singleton? dbInit has a singleton `cached`.
        // We might need to restart the module context or just accept we're testing the singleton.
        // Since `cached` isn't exported, we can't reset it easily.
        // This makes testing `getDuckDbContext` multiple times tricky if it returns the same promise.
        // However, we can test the helper functions `loadFromIndexedDB` and `saveToIndexedDB`.
    });

    describe('IndexedDB Helpers', () => {
        it('loadFromIndexedDB resolves null on error', async () => {
            const req = { onerror: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = loadFromIndexedDB();
            req.onerror({ target: { error: 'fail' } } as any);

            await expect(promise).resolves.toBeNull();
        });

        it('loadFromIndexedDB resolves data if found', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = loadFromIndexedDB();

            // Trigger success
            const mockStore = {
                get: vi.fn().mockReturnValue({
                    onsuccess: null,
                    result: new Uint8Array([1, 2, 3])
                })
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore)
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);

            // Trigger store get success
            const getReq = mockStore.get.mock.results[0].value;
            getReq.onsuccess();

            const result = await promise;
            expect(result).toEqual(new Uint8Array([1, 2, 3]));
        });

        it('saveToIndexedDB saves data', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = saveToIndexedDB(new Uint8Array([1]));

            const mockStore = {
                put: vi.fn().mockReturnValue({ onsuccess: null })
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore)
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);

            const putReq = mockStore.put.mock.results[0].value;
            putReq.onsuccess();

            await expect(promise).resolves.toBeUndefined();
        });
    });

    // Validating the main logic is hard due to the singleton cache.
    // Ideally we'd refactor dbInit to export a `reset` function for testing,
    // or we skip the singleton test and focus on the parts we can reach.
    // But let's try to mock the *imports* for the first run if we can, but likely it's already evaluated.
});
