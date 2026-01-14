import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaticMapService } from './StaticMapService';
import { Resource } from '../aardvark/model';

// Mock Canvas
const mockContext = {
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: ''
};

const mockCanvas = {
    getContext: vi.fn().mockReturnValue(mockContext),
    width: 200,
    height: 200,
    toBlob: vi.fn().mockImplementation((cb) => cb(new Blob(['img'], { type: 'image/png' })))
};

/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
(global as any).document = {
    createElement: vi.fn().mockReturnValue(mockCanvas)
};

// Mock Fetch and CreateImageBitmap
(global as any).fetch = vi.fn();
(global as any).createImageBitmap = vi.fn();

// Mock OffscreenCanvas to avoid ReferenceError
class MockOffscreenCanvas {
    getContext() { return mockContext; }
    convertToBlob() { return Promise.resolve(new Blob(['img'], { type: 'image/png' })); }
}
(global as any).OffscreenCanvas = MockOffscreenCanvas;

describe('StaticMapService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Setup successful fetch/bitmap
        (global.fetch as any).mockResolvedValue({
            blob: async () => new Blob(['Bytes'])
        });
        (global.createImageBitmap as any).mockResolvedValue({});
    });

    it('returns null if no geometry', async () => {
        const res: Resource = { id: '1', dct_title_s: 'T' };
        const svc = new StaticMapService(res);
        const blob = await svc.generate();
        expect(blob).toBeNull();
    });

    it('parses ENVELOPE and generates map', async () => {
        const res: Resource = {
            id: '1', dct_title_s: 'T',
            dcat_bbox: 'ENVELOPE(-10, 10, 20, -20)' // W, E, N, S
        };
        const svc = new StaticMapService(res);

        const blob = await svc.generate(200, 200);

        // Should try to fetch tiles
        expect(global.fetch).toHaveBeenCalled();
        // Should draw image
        // Wait for async promises in implementation?
        // Service awaits Promise.all(promises), so by the time generate returns, it's done.

        expect(mockContext.drawImage).toHaveBeenCalled();
        expect(mockContext.rect).toHaveBeenCalled(); // BBox drawing
        expect(blob).toBeDefined();
    });

    it('parses CSV bbox and generates map', async () => {
        const res: Resource = {
            id: '1', dct_title_s: 'T',
            dcat_bbox: '-10, -20, 10, 20' // minX, minY, maxX, maxY
        };
        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect(global.fetch).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('handles image load failure gracefully', async () => {
        const res: Resource = {
            id: '1', dct_title_s: 'T', dcat_bbox: '-10,-10,10,10'
        };
        (global.fetch as any).mockRejectedValue(new Error('Net error'));

        const svc = new StaticMapService(res);
        await svc.generate();
        // Should not throw, should just skip tiles
        // But bbox should still draw
        expect(mockContext.rect).toHaveBeenCalled();
    });
});
