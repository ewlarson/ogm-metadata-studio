import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cellToBoundary, gridDisk } from "h3-js";
import { DUCKDB_RESTORED_EVENT } from "../duckdb/dbInit";
import { databaseService } from "../services/DatabaseService";
import { zoomToResolution } from "../utils/h3Resolution";

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const HEX_SOURCE_ID = "h3-hexes";
const HEX_LAYER_ID = "h3-hexes-fill";

const HEX_RAMP_COLORS = [
    "#DBEAFE", "#BFDBFE", "#93C5FD", "#7AB3FD", "#60A5FA",
    "#3B82F6", "#2563EB", "#1D4ED8", "#1E40AF", "#003C5B",
];
const HEX_RAMP_THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Return MapLibre bounds covering all given H3 cells, or null if empty. */
function boundsOfHexes(hexIndexes: string[]): maplibregl.LngLatBounds | null {
    if (hexIndexes.length === 0) return null;
    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;
    for (const h3 of hexIndexes) {
        const vs = cellToBoundary(h3);
        for (const [lat, lng] of vs) {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
        }
    }
    if (minLat > maxLat || minLng > maxLng) return null;
    return new maplibregl.LngLatBounds([minLng, minLat], [maxLng, maxLat]);
}

function hexCenter(h3: string): [number, number] | null {
    const boundary = cellToBoundary(h3);
    if (boundary.length === 0) return null;
    let latSum = 0;
    let lngSum = 0;
    for (const [lat, lng] of boundary) {
        latSum += lat;
        lngSum += lng;
    }
    return [lngSum / boundary.length, latSum / boundary.length];
}

function weightedCenterOfHexes(hexData: { h3: string; count: number }[]): [number, number] | null {
    if (hexData.length === 0) return null;
    let totalWeight = 0;
    let lngSum = 0;
    let latSum = 0;
    for (const hex of hexData) {
        const center = hexCenter(hex.h3);
        if (!center) continue;
        const weight = Math.max(hex.count, 1);
        lngSum += center[0] * weight;
        latSum += center[1] * weight;
        totalWeight += weight;
    }
    if (totalWeight === 0) return null;
    return [lngSum / totalWeight, latSum / totalWeight];
}

function dominantCluster(hexData: { h3: string; count: number }[]): { h3: string; count: number }[] {
    if (hexData.length <= 1) return hexData;

    const byId = new Map(hexData.map((h) => [h.h3, h]));
    const visited = new Set<string>();
    let best: { hexes: { h3: string; count: number }[]; weight: number; size: number; peak: number } | null = null;

    for (const { h3 } of hexData) {
        if (visited.has(h3)) continue;

        const queue = [h3];
        const component: { h3: string; count: number }[] = [];
        let weight = 0;
        let peak = 0;
        visited.add(h3);

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            const datum = byId.get(current);
            if (!datum) continue;

            component.push(datum);
            weight += datum.count;
            peak = Math.max(peak, datum.count);

            for (const neighbor of gridDisk(current, 1)) {
                if (!byId.has(neighbor) || visited.has(neighbor)) continue;
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }

        const candidate = { hexes: component, weight, size: component.length, peak };
        if (
            best == null ||
            candidate.weight > best.weight ||
            (candidate.weight === best.weight && candidate.size > best.size) ||
            (candidate.weight === best.weight && candidate.size === best.size && candidate.peak > best.peak)
        ) {
            best = candidate;
        }
    }

    return best?.hexes ?? hexData;
}

function dominantClusterView(hexData: { h3: string; count: number }[]): { bounds: maplibregl.LngLatBounds | null; center: [number, number] | null } {
    const cluster = dominantCluster(hexData);
    return {
        bounds: boundsOfHexes(cluster.map((hex) => hex.h3)),
        center: weightedCenterOfHexes(cluster),
    };
}

function applyAutoFit(
    map: maplibregl.Map,
    view: { bounds: maplibregl.LngLatBounds; center: [number, number] | null }
) {
    map.fitBounds(view.bounds, { padding: 40, maxZoom: 6, duration: 0 });
    if (view.center) {
        map.jumpTo({
            center: view.center,
            zoom: Math.max(map.getZoom() - 1, 2),
        });
    }
}

function hexesToFeatureCollection(hexData: { h3: string; count: number }[]) {
    const maxCount = Math.max(...hexData.map((h) => h.count), 1);
    const features = hexData.map(({ h3, count }) => {
        const vs = cellToBoundary(h3);
        const ring = vs.map(([lat, lng]: [number, number]) => [lng, lat] as [number, number]);
        ring.push(ring[0]);
        const intensity = maxCount > 0 ? Math.log(count + 1) / Math.log(maxCount + 1) : 0;
        return {
            type: "Feature" as const,
            properties: { h3, count, intensity },
            geometry: { type: "Polygon" as const, coordinates: [ring] },
        };
    });
    return { type: "FeatureCollection" as const, features };
}

function removeHexLayer(map: maplibregl.Map) {
    if (map.getLayer(HEX_LAYER_ID)) map.removeLayer(HEX_LAYER_ID);
    if (map.getSource(HEX_SOURCE_ID)) map.removeSource(HEX_SOURCE_ID);
}

function upsertHexLayer(map: maplibregl.Map, hexData: { h3: string; count: number }[]) {
    const fc = hexesToFeatureCollection(hexData);
    if (map.getSource(HEX_SOURCE_ID)) {
        (map.getSource(HEX_SOURCE_ID) as maplibregl.GeoJSONSource).setData(fc);
        return;
    }
    map.addSource(HEX_SOURCE_ID, { type: "geojson", data: fc });
    const colorStops: (number | string)[] = [0, HEX_RAMP_COLORS[0]];
    HEX_RAMP_THRESHOLDS.forEach((t, i) => {
        colorStops.push(t, HEX_RAMP_COLORS[i + 1]);
    });
    colorStops.push(1, HEX_RAMP_COLORS[HEX_RAMP_COLORS.length - 1]);
    map.addLayer({
        id: HEX_LAYER_ID,
        type: "fill",
        source: HEX_SOURCE_ID,
        paint: {
            "fill-color": ["interpolate", ["linear"], ["get", "intensity"], ...colorStops],
            "fill-opacity": 0.65,
            "fill-outline-color": "white",
        },
    });
}

interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface MapFacetProps {
    bbox?: BBox;
    onChange: (bbox: BBox | undefined) => void;
    q?: string;
    filters?: Record<string, unknown>;
}

export const MapFacet: React.FC<MapFacetProps> = ({ bbox, onChange, q = "", filters = {} }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const [hexLoading, setHexLoading] = useState(false);
    const [hexData, setHexData] = useState<{ h3: string; count: number }[]>([]);
    const hasInitialFitRef = useRef(false);
    const lastGlobalContextRef = useRef<string | null>(null);
    const pendingAutoFitViewRef = useRef<{ bounds: maplibregl.LngLatBounds; center: [number, number] | null } | null>(null);
    const hexDataRef = useRef<{ h3: string; count: number }[]>([]);
    const bboxRef = useRef<BBox | undefined>(bbox);

    hexDataRef.current = hexData;
    bboxRef.current = bbox;

    const fetchHexes = useCallback(async () => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        const bounds = map.getBounds();
        const zoom = map.getZoom();
        const resolution = zoomToResolution(zoom);
        const bboxReq = {
            minX: bounds.getWest(),
            minY: bounds.getSouth(),
            maxX: bounds.getEast(),
            maxY: bounds.getNorth(),
        };
        setHexLoading(true);
        try {
            const res = await databaseService.getMapH3({
                bbox: bboxReq,
                resolution,
                q: q.trim() || undefined,
                filters: Object.keys(filters).length ? filters : undefined,
            });
            setHexData(res.hexes);
        } catch {
            setHexData([]);
        } finally {
            setHexLoading(false);
        }
    }, [q, filters]);

    useLayoutEffect(() => {
        if (mapRef.current) {
            mapRef.current.remove();
            mapRef.current = null;
        }
        if (!containerRef.current) return;
        const map = new maplibregl.Map({
            container: containerRef.current,
            style: MAP_STYLE,
            center: [-96, 37.8],
            zoom: 3,
        });
        mapRef.current = map;
        map.on("load", () => {
            if (hexDataRef.current.length > 0) {
                upsertHexLayer(map, hexDataRef.current);
            }
            if (!bboxRef.current && pendingAutoFitViewRef.current) {
                hasInitialFitRef.current = true;
                applyAutoFit(map, pendingAutoFitViewRef.current);
                pendingAutoFitViewRef.current = null;
            }
        });
        return () => {
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!bbox || !mapRef.current) return;
        const map = mapRef.current;
        if (!map.isStyleLoaded()) {
            map.once('load', () => fit());
        } else {
            fit();
        }
        function fit() {
            if (bbox) map.fitBounds([[bbox.minX, bbox.minY], [bbox.maxX, bbox.maxY]], { padding: 10 });
        }
    }, [bbox]);

    // Fetch H3 hexes on load and when map moves/zooms or search context changes
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const onReady = () => {
            void fetchHexes();
        };
        if (map.isStyleLoaded()) {
            onReady();
        } else {
            map.once("load", onReady);
        }
        map.on("moveend", fetchHexes);
        map.on("zoomend", fetchHexes);
        return () => {
            map.off("moveend", fetchHexes);
            map.off("zoomend", fetchHexes);
        };
    }, [fetchHexes]);

    useEffect(() => {
        const handleRestored = () => {
            void fetchHexes();
        };
        window.addEventListener(DUCKDB_RESTORED_EVENT, handleRestored);
        return () => window.removeEventListener(DUCKDB_RESTORED_EVENT, handleRestored);
    }, [fetchHexes]);

    // On query/filters change with no explicit bbox, fetch global hex coverage
    // and fit the map to that cluster once. This ensures searches like "Japan"
    // jump the map to the primary hex cluster instead of staying over the US.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || bbox) return;

        const ctxKey = JSON.stringify({ q: q.trim() || "", filters: filters || {} });
        if (lastGlobalContextRef.current === ctxKey) return;
        lastGlobalContextRef.current = ctxKey;
        hasInitialFitRef.current = false;

        let cancelled = false;
        const run = async () => {
            setHexLoading(true);
            try {
                const res = await databaseService.getMapH3({
                    // Use a slightly finer resolution so the dominant cluster localizes
                    // to a region/state instead of collapsing to a continental footprint.
                    resolution: 4,
                    q: q.trim() || undefined,
                    filters: Object.keys(filters || {}).length ? filters : undefined,
                    // No bbox: query uses full extent so we can see all matching hexes
                });
                if (cancelled) return;
                setHexData(res.hexes);
                const view = dominantClusterView(res.hexes);
                if (view.bounds) {
                    pendingAutoFitViewRef.current = view as { bounds: maplibregl.LngLatBounds; center: [number, number] | null };
                }
            } catch {
                if (!cancelled) setHexData([]);
            } finally {
                if (!cancelled) setHexLoading(false);
            }
        };

        // If style not yet loaded, wait for map load first
        if (!map.isStyleLoaded()) {
            map.once("load", run);
        } else {
            void run();
        }

        return () => {
            cancelled = true;
        };
    }, [q, filters, bbox]);

    // Update GeoJSON layer when hexData changes
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        if (hexData.length === 0) {
            removeHexLayer(map);
            return;
        }
        upsertHexLayer(map, hexData);

        // Fit only after hexes are present on the map.
        if (!bbox && pendingAutoFitViewRef.current && !hasInitialFitRef.current) {
            hasInitialFitRef.current = true;
            applyAutoFit(map, pendingAutoFitViewRef.current);
            pendingAutoFitViewRef.current = null;
        }
    }, [hexData, bbox]);

    const handleSearchHere = () => {
        const map = mapRef.current;
        if (!map) return;
        const b = map.getBounds();
        onChange({
            minX: b.getWest(),
            minY: b.getSouth(),
            maxX: b.getEast(),
            maxY: b.getNorth(),
        });
    };

    return (
        <div className="w-full h-72 rounded overflow-hidden border border-gray-200 dark:border-slate-800 relative z-0 mb-6">
            <div ref={containerRef} className="w-full h-full" />
            {hexLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/10 rounded z-[500] pointer-events-none">
                    <span className="text-xs text-slate-600 dark:text-slate-300">Loading…</span>
                </div>
            )}
            <div className="absolute top-2 right-2 z-[1000]">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleSearchHere();
                    }}
                    className="bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-3 py-1.5 rounded shadow-md border border-gray-300 dark:border-slate-600 text-xs font-semibold hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                >
                    Search Here
                </button>
            </div>
            {bbox && (
                <div className="absolute bottom-1 left-1 z-[1000]">
                    <button
                        type="button"
                        onClick={() => onChange(undefined)}
                        className="bg-red-500 text-white px-2 py-1 rounded text-[10px] shadow opacity-80 hover:opacity-100"
                    >
                        Clear Map
                    </button>
                </div>
            )}
        </div>
    );
};
