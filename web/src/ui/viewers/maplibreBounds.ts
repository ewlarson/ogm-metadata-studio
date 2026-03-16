/**
 * Parse GeoJSON (geometry or bbox) to MapLibre LngLatBounds-like [[west, south], [east, north]].
 */
export function geoJsonToBounds(geojson: string | undefined): [[number, number], [number, number]] | null {
    if (!geojson) return null;
    let obj: { bbox?: number[]; type?: string; coordinates?: number[][][] | number[][] };
    try {
        obj = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
    } catch {
        return null;
    }
    if (obj.bbox && Array.isArray(obj.bbox) && obj.bbox.length >= 4) {
        const [minX, minY, maxX, maxY] = obj.bbox;
        return [[minX, minY], [maxX, maxY]];
    }
    if (obj.type === 'Polygon' && Array.isArray(obj.coordinates)) {
        const ring = obj.coordinates[0];
        if (!ring || !Array.isArray(ring) || ring.length < 3) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of ring) {
            const [x, y] = Array.isArray(pt) ? pt : [];
            if (typeof x === 'number' && typeof y === 'number') {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
        if (minX === Infinity) return null;
        return [[minX, minY], [maxX, maxY]];
    }
    return null;
}

const DEFAULT_BOUNDS: [[number, number], [number, number]] = [[-100, -30], [100, 30]];

export function getBoundsFromGeometry(geometry: string | undefined): [[number, number], [number, number]] {
    return geoJsonToBounds(geometry) ?? DEFAULT_BOUNDS;
}
