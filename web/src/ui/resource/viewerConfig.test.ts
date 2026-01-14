import { describe, it, expect } from 'vitest';
import { detectViewerConfig, getViewerGeometry } from './viewerConfig';
import { Resource } from '../../aardvark/model';

describe('viewerConfig', () => {
    describe('detectViewerConfig', () => {
        const baseResource: Resource = {
            id: 'test-1',
            dct_title_s: 'Test',
            gbl_resourceClass_sm: ['Map'],
            // Add required fields to satisfy type if strict
        } as Partial<Resource> as Resource;

        it('returns null if no references', () => {
            expect(detectViewerConfig(baseResource)).toBeNull();
        });

        it('returns null if references are invalid JSON', () => {
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const resource = { ...baseResource, dct_references_s: 'invalid' };
            expect(detectViewerConfig(resource)).toBeNull();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it('detects IIIF Manifest', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://iiif.io/api/presentation#manifest": "http://example.com/manifest" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_manifest",
                endpoint: "http://example.com/manifest"
            });
        });

        it('detects IIIF Manifest (short key)', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "iiif_manifest": "http://example.com/manifest" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_manifest",
                endpoint: "http://example.com/manifest"
            });
        });

        it('detects WMS', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://www.opengis.net/def/serviceType/ogc/wms": "http://example.com/wms" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "wms",
                endpoint: "http://example.com/wms",
                geometry: undefined // No geometry in this mock
            });
        });

        it('detects XYZ Tiles', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "xyz_tiles": "http://example.com/xyz" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "xyz",
                endpoint: "http://example.com/xyz",
                geometry: undefined
            });
        });

        it('detects ArcGIS Feature Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_feature_layer": "http://example.com/feature" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_feature_layer",
                endpoint: "http://example.com/feature",
                geometry: undefined
            });
        });

        it('detects ArcGIS Tiled Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_tiled_map_layer": "http://example.com/tiled" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_tiled_map_layer",
                endpoint: "http://example.com/tiled",
                geometry: undefined
            });
        });

        it('detects ArcGIS Dynamic Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_dynamic_map_layer": "http://example.com/dynamic" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_dynamic_map_layer",
                endpoint: "http://example.com/dynamic",
                geometry: undefined
            });
        });

        it('detects ArcGIS Image Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_image_map_layer": "http://example.com/image" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_image_map_layer",
                endpoint: "http://example.com/image",
                geometry: undefined
            });
        });

        it('returns null if no known protocol', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "unknown": "http://example.com" }) };
            expect(detectViewerConfig(resource)).toBeNull();
        });
    });

    describe('getViewerGeometry', () => {
        const base: Resource = { id: '1' } as Resource;

        it('parses locn_geometry as JSON', () => {
            const geojson = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}';
            const resource = { ...base, locn_geometry: geojson };
            expect(getViewerGeometry(resource)).toEqual(geojson);
        });

        it('parses locn_geometry as ENVELOPE', () => {
            // ENVELOPE(minX, maxX, maxY, minY)
            const resource = { ...base, locn_geometry: 'ENVELOPE(-10, 10, 20, -20)' };
            const result = getViewerGeometry(resource);
            const parsed = JSON.parse(result!);
            expect(parsed.type).toBe('Polygon');
            // Check coordinates: w, n -> -10, 20...
            // Logic: w= -10, e= 10, n= 20, s= -20
            expect(parsed.coordinates[0][0]).toEqual([-10, 20]);
        });

        it('falls back to dcat_bbox if locn_geometry is missing', () => {
            const resource = { ...base, dcat_bbox: 'ENVELOPE(-5, 5, 10, -10)' };
            const result = getViewerGeometry(resource);
            expect(result).not.toBeUndefined();
            const parsed = JSON.parse(result!);
            expect(parsed.coordinates[0][0]).toEqual([-5, 10]);
        });

        it('returns undefined if no geometry', () => {
            expect(getViewerGeometry(base)).toBeUndefined();
        });

        it('returns undefined if ENVELOPE is invalid', () => {
            const resource = { ...base, locn_geometry: 'INVALID' };
            expect(getViewerGeometry(resource)).toBeUndefined();
        });
    });
});
