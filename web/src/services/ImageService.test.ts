import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageService } from './ImageService';
import { Resource, Distribution } from '../aardvark/model';

describe('ImageService', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource',
        gbl_resourceClass_sm: ['Datasets'],
        dct_accessRights_s: 'Public',
        gbl_mdVersion_s: 'Aardvark'
    } as any;

    it('returns cached thumbnail if present', async () => {
        const res = { ...mockResource, thumbnail: 'cached_thumb.jpg' };
        const service = new ImageService(res, []);
        expect(await service.getThumbnailUrl()).toBe('cached_thumb.jpg');
    });

    it('returns null if validation fails (restricted)', async () => {
        const res = { ...mockResource, dct_accessRights_s: 'Restricted' };
        const service = new ImageService(res, []);
        expect(await service.getThumbnailUrl()).toBeNull();
    });

    it('resolves explicit thumbnail from references', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://schema.org/thumbnailUrl',
            url: 'http://example.com/thumb.png',
            label: 'Thumb'
        }];
        const service = new ImageService(mockResource, dists);
        expect(await service.getThumbnailUrl()).toBe('http://example.com/thumb.png');
    });

    it('constructs IIIF Image API thumbnail', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'iiif',
            url: 'http://example.com/iiif/service/info.json',
            label: 'IIIF'
        }];
        const service = new ImageService(mockResource, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/iiif/service/full/200,/0/default.jpg');
    });

    it('fetches and resolves IIIF Manifest thumbnail', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://iiif.io/api/presentation#manifest',
            url: 'http://example.com/manifest.json',
            label: 'Manifest'
        }];

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                thumbnail: {
                    '@id': 'http://example.com/iiif/image/full/200,/0/default.jpg'
                }
            })
        });

        const service = new ImageService(mockResource, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/iiif/image/full/200,/0/default.jpg');
    });

    it('constructs WMS thumbnail', async () => {
        const res = { ...mockResource, gbl_wxsIdentifier_s: 'layer1' };
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://www.opengis.net/def/serviceType/ogc/wms',
            url: 'http://example.com/wms',
            label: 'WMS'
        }];
        const service = new ImageService(res, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/wms/reflect?FORMAT=image/png&TRANSPARENT=TRUE&WIDTH=200&HEIGHT=200&LAYERS=layer1');
    });
});
