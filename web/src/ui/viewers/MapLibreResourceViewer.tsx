import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getBoundsFromGeometry } from './maplibreBounds';

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

export interface MapLibreResourceViewerProps {
    protocol: string;
    url: string;
    layerId?: string;
    mapGeom?: string;
    options?: { opacity?: number };
}

function buildWmsGetMapUrl(baseUrl: string, layerId: string, bounds: { getSouth: () => number; getWest: () => number; getNorth: () => number; getEast: () => number }, width: number, height: number): string {
    const miny = bounds.getSouth();
    const minx = bounds.getWest();
    const maxy = bounds.getNorth();
    const maxx = bounds.getEast();
    const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        LAYERS: layerId,
        CRS: 'EPSG:4326',
        BBOX: `${miny},${minx},${maxy},${maxx}`,
        WIDTH: String(width),
        HEIGHT: String(height),
        FORMAT: 'image/png',
        TRANSPARENT: 'true',
    });
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${params.toString()}`;
}

function addWmsLayer(map: maplibregl.Map, url: string, layerId: string, opacity: number): () => void {
    const sourceId = 'wms-overlay';
    const layerIdFill = 'wms-overlay-layer';

    const updateImage = () => {
        const bounds = map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const raw = (map as unknown as { getSize?: () => { width?: number; height?: number; x?: number; y?: number } }).getSize?.();
        const w = raw && (typeof (raw as any).width === 'number' ? (raw as any).width : (raw as any).x);
        const h = raw && (typeof (raw as any).height === 'number' ? (raw as any).height : (raw as any).y);
        if (typeof w !== 'number' || typeof h !== 'number') return;
        const getMapUrl = buildWmsGetMapUrl(url, layerId || '', bounds, w, h);
        const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
        if (source) {
            source.updateImage({
                url: getMapUrl,
                coordinates: [
                    [sw.lng, sw.lat],
                    [ne.lng, sw.lat],
                    [ne.lng, ne.lat],
                    [sw.lng, ne.lat],
                ],
            });
        }
    };

    map.addSource(sourceId, {
        type: 'image',
        url: '',
        coordinates: [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
        ],
    });
    map.addLayer({
        id: layerIdFill,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });

    map.on('moveend', updateImage);
    updateImage();

    return () => {
        map.off('moveend', updateImage);
        if (map.getLayer(layerIdFill)) map.removeLayer(layerIdFill);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function addXyzLayer(map: maplibregl.Map, url: string, opacity: number): () => void {
    const sourceId = 'xyz-overlay';
    const layerId = 'xyz-overlay-layer';
    const tileUrl = url.replace(/\{ *([sxyz]) *\}/gi, (_, s) => {
        const lower = s.toLowerCase();
        if (lower === 's') return 'a';
        return `{${lower}}`;
    });
    map.addSource(sourceId, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
    });
    map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });
    return () => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function addEsriTiledLayer(map: maplibregl.Map, url: string, opacity: number): () => void {
    const base = url.replace(/\/$/, '');
    const tileUrl = `${base}/tile/{z}/{y}/{x}`;
    return addXyzLayer(map, tileUrl, opacity);
}

function buildEsriExportUrl(baseUrl: string, bounds: { getSouth: () => number; getWest: () => number; getNorth: () => number; getEast: () => number }, width: number, height: number, layerIds?: string): string {
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
    const params = new URLSearchParams({
        bbox,
        size: `${width},${height}`,
        f: 'image',
        format: 'png',
        transparent: 'true',
    });
    if (layerIds) params.set('layers', `show:${layerIds}`);
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl.replace(/\/$/, '')}/export${sep}${params.toString()}`;
}

function addEsriExportLayer(map: maplibregl.Map, url: string, layerId: string, opacity: number): () => void {
    const sourceId = 'esri-export-overlay';
    const layerIdRaster = 'esri-export-overlay-layer';

    const updateImage = () => {
        const bounds = map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const raw = (map as unknown as { getSize?: () => { width?: number; height?: number; x?: number; y?: number } }).getSize?.();
        const w = raw && (typeof (raw as any).width === 'number' ? (raw as any).width : (raw as any).x);
        const h = raw && (typeof (raw as any).height === 'number' ? (raw as any).height : (raw as any).y);
        if (typeof w !== 'number' || typeof h !== 'number') return;
        const exportUrl = buildEsriExportUrl(url, bounds, w, h, layerId || undefined);
        const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
        if (source) {
            source.updateImage({
                url: exportUrl,
                coordinates: [
                    [sw.lng, sw.lat],
                    [ne.lng, sw.lat],
                    [ne.lng, ne.lat],
                    [sw.lng, ne.lat],
                ],
            });
        }
    };

    map.addSource(sourceId, {
        type: 'image',
        url: '',
        coordinates: [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
        ],
    });
    map.addLayer({
        id: layerIdRaster,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });

    map.on('moveend', updateImage);
    updateImage();

    return () => {
        map.off('moveend', updateImage);
        if (map.getLayer(layerIdRaster)) map.removeLayer(layerIdRaster);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function addBoundsOverlay(map: maplibregl.Map, mapGeom: string | undefined): () => void {
    const parsed = mapGeom ? (() => {
        try {
            return JSON.parse(mapGeom) as { type: string; coordinates?: number[][][] };
        } catch {
            return null;
        }
    })() : null;
    if (!parsed || parsed.type !== 'Polygon' || !parsed.coordinates?.[0]) return () => {};

    const sourceId = 'bounds-overlay';
    const fillId = 'bounds-fill';
    const lineId = 'bounds-line';
    const coords = parsed.coordinates[0];
    const [minLng, minLat] = coords[0];
    let maxLng = minLng, maxLat = minLat;
    for (const c of coords) {
        maxLng = Math.max(maxLng, c[0]);
        maxLat = Math.max(maxLat, c[1]);
    }
    map.addSource(sourceId, {
        type: 'geojson',
        data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: parsed.coordinates },
        },
    });
    map.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': '#3388ff', 'fill-opacity': 0 },
    });
    map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': '#3388ff', 'line-width': 2, 'line-dasharray': [5, 5] },
    });
    return () => {
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getLayer(fillId)) map.removeLayer(fillId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

export const MapLibreResourceViewer: React.FC<MapLibreResourceViewerProps> = ({
    protocol,
    url,
    layerId = '',
    mapGeom,
    options = {},
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const cleanupOverlayRef = useRef<(() => void) | null>(null);
    const [opacity, setOpacity] = useState(options.opacity ?? 0.75);
    const [error, setError] = useState<string | null>(null);

    const addOverlay = useCallback((map: maplibregl.Map) => {
        if (cleanupOverlayRef.current) {
            cleanupOverlayRef.current();
            cleanupOverlayRef.current = null;
        }
        const op = opacity;
        try {
            if (protocol === 'wms') {
                cleanupOverlayRef.current = addWmsLayer(map, url, layerId, op);
            } else if (protocol === 'xyz') {
                cleanupOverlayRef.current = addXyzLayer(map, url, op);
            } else if (protocol === 'arcgis_tiled_map_layer') {
                cleanupOverlayRef.current = addEsriTiledLayer(map, url, op);
            } else if (protocol === 'arcgis_dynamic_map_layer' || protocol === 'arcgis_image_map_layer') {
                cleanupOverlayRef.current = addEsriExportLayer(map, url, layerId, op);
            } else if (protocol === 'arcgis_feature_layer') {
                setError('Feature layer (GeoJSON) support coming soon');
            } else {
                cleanupOverlayRef.current = addXyzLayer(map, url, op);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to add layer');
        }
    }, [protocol, url, layerId, opacity]);

    useLayoutEffect(() => {
        if (mapRef.current) {
            if (cleanupOverlayRef.current) {
                cleanupOverlayRef.current();
                cleanupOverlayRef.current = null;
            }
            mapRef.current.remove();
            mapRef.current = null;
        }
        setError(null);
        if (!containerRef.current) return;

        const bounds = getBoundsFromGeometry(mapGeom);
        const center: [number, number] = [
            (bounds[0][0] + bounds[1][0]) / 2,
            (bounds[0][1] + bounds[1][1]) / 2,
        ];

        const map = new maplibregl.Map({
            container: containerRef.current,
            style: MAP_STYLE,
            center,
            zoom: 2,
        });
        mapRef.current = map;

        map.addControl(new maplibregl.FullscreenControl());

        map.on('load', () => {
            map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
            addOverlay(map);
            const hasOverlay = ['wms', 'xyz', 'arcgis_tiled_map_layer', 'arcgis_dynamic_map_layer', 'arcgis_image_map_layer'].includes(protocol);
            if (!hasOverlay && mapGeom) addBoundsOverlay(map, mapGeom);
        });

        return () => {
            if (cleanupOverlayRef.current) {
                cleanupOverlayRef.current();
                cleanupOverlayRef.current = null;
            }
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, [protocol, url, layerId, mapGeom]);

    useLayoutEffect(() => {
        const map = mapRef.current;
        if (!map || !map.getStyle()) return;
        const layerIdRaster = ['wms-overlay-layer', 'xyz-overlay-layer', 'esri-export-overlay-layer'].find(id => map.getLayer(id));
        if (layerIdRaster) map.setPaintProperty(layerIdRaster, 'raster-opacity', opacity);
    }, [opacity]);

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full min-h-[400px]" />
            {error && (
                <div className="absolute bottom-2 left-2 right-2 bg-red-100 dark:bg-red-900/80 text-red-800 dark:text-red-200 text-sm p-2 rounded">
                    {error}
                </div>
            )}
            <div className="absolute bottom-2 left-2 flex items-center gap-2 bg-white dark:bg-slate-800 shadow rounded px-2 py-1">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Opacity</label>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                    className="w-20 h-1.5"
                />
            </div>
        </div>
    );
};
