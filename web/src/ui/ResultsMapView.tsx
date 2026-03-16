import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Resource } from '../aardvark/model';

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

interface ResultsMapViewProps {
    resources: Resource[];
    onEdit: (id: string) => void;
    onSelect?: (id: string) => void;
    highlightedResourceId?: string | null;
}

type BoundsLike = [[number, number], [number, number]];

function parseBounds(bboxStr: string): BoundsLike | null {
    const envelopeMatch = bboxStr.match(/ENVELOPE\s*\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/i);
    if (envelopeMatch) {
        const minX = parseFloat(envelopeMatch[1]);
        const maxX = parseFloat(envelopeMatch[2]);
        const maxY = parseFloat(envelopeMatch[3]);
        const minY = parseFloat(envelopeMatch[4]);
        return [[minY, minX], [maxY, maxX]];
    }
    const parts = bboxStr.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
        return [[parts[1], parts[0]], [parts[3], parts[2]]];
    }
    return null;
}

export const ResultsMapView: React.FC<ResultsMapViewProps> = ({
    resources,
    onEdit,
    onSelect,
    highlightedResourceId,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const popupRef = useRef<maplibregl.Popup | null>(null);
    const featuresRef = useRef<{ resource: Resource; bounds: BoundsLike }[]>([]);

    const features = useMemo(() => resources.map(r => {
        if (!r.dcat_bbox) return null;
        const bounds = parseBounds(r.dcat_bbox);
        if (!bounds) return null;
        return { resource: r, bounds };
    }).filter((f): f is { resource: Resource; bounds: BoundsLike } => f !== null), [resources]);

    const geojson = useMemo(() => ({
        type: 'FeatureCollection' as const,
        features: features.map(f => ({
            type: 'Feature' as const,
            id: f.resource.id,
            properties: { title: f.resource.dct_title_s },
            geometry: {
                type: 'Polygon' as const,
                coordinates: [[
                    [f.bounds[0][1], f.bounds[0][0]],
                    [f.bounds[1][1], f.bounds[0][0]],
                    [f.bounds[1][1], f.bounds[1][0]],
                    [f.bounds[0][1], f.bounds[1][0]],
                    [f.bounds[0][1], f.bounds[0][0]],
                ]],
            },
        })),
    }), [features]);

    featuresRef.current = features;

    useLayoutEffect(() => {
        if (mapRef.current) {
            popupRef.current?.remove();
            mapRef.current.remove();
            mapRef.current = null;
        }
        if (!containerRef.current || features.length === 0) return;

        const map = new maplibregl.Map({
            container: containerRef.current,
            style: MAP_STYLE,
            center: [0, 0],
            zoom: 2,
        });
        mapRef.current = map;

        map.on('load', () => {
            map.addSource('bboxes', {
                type: 'geojson',
                data: geojson,
                promoteId: 'id',
            });
            map.addLayer({
                id: 'bboxes-fill',
                type: 'fill',
                source: 'bboxes',
                paint: {
                    'fill-color': ['case', ['boolean', ['feature-state', 'highlight'], false], '#f59e0b', '#6366f1'],
                    'fill-opacity': ['case', ['boolean', ['feature-state', 'highlight'], false], 0.3, 0.1],
                },
            });
            map.addLayer({
                id: 'bboxes-line',
                type: 'line',
                source: 'bboxes',
                paint: {
                    'line-color': ['case', ['boolean', ['feature-state', 'highlight'], false], '#f59e0b', '#6366f1'],
                    'line-width': ['case', ['boolean', ['feature-state', 'highlight'], false], 3, 1],
                },
            });

            const allBounds = features.reduce(
                (acc, f) => acc.extend([[f.bounds[0][1], f.bounds[0][0]], [f.bounds[1][1], f.bounds[1][0]]]),
                new maplibregl.LngLatBounds()
            );
            if (allBounds.getWest() !== Infinity) map.fitBounds(allBounds, { padding: 50 });

            map.on('click', 'bboxes-fill', (e) => {
                const id = e.features?.[0]?.id != null ? String(e.features[0].id) : undefined;
                if (!id) return;
                onSelect?.(id);
                const feat = featuresRef.current.find(f => f.resource.id === id);
                if (!feat) return;
                const popup = new maplibregl.Popup({ closeButton: true })
                    .setLngLat(e.lngLat)
                    .setHTML(
                        `<div class="text-xs">
                          <strong class="block mb-1">${escapeHtml(feat.resource.dct_title_s)}</strong>
                          <span class="text-slate-500">${escapeHtml(id)}</span>
                          <div class="mt-2 text-indigo-600 cursor-pointer hover:underline edit-link" data-id="${escapeHtml(id)}">Edit Record</div>
                        </div>`
                    )
                    .addTo(map);
                popupRef.current?.remove();
                popupRef.current = popup;
                popup.getElement()?.querySelector('.edit-link')?.addEventListener('click', () => {
                    onEdit(id);
                    popup.remove();
                    popupRef.current = null;
                });
            });
            map.getCanvas().style.cursor = 'pointer';
        });
        return () => {
            popupRef.current?.remove();
            popupRef.current = null;
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, [geojson, features.length]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.getSource('bboxes')) return;
        const source = map.getSource('bboxes') as maplibregl.GeoJSONSource;
        if (!source) return;
        featuresRef.current.forEach(f => {
            map.setFeatureState({ source: 'bboxes', id: f.resource.id }, { highlight: f.resource.id === highlightedResourceId });
        });
    }, [highlightedResourceId, features]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded() || features.length === 0) return;
            if (highlightedResourceId) {
            const feat = features.find(f => f.resource.id === highlightedResourceId);
            if (feat) {
                map.fitBounds([[feat.bounds[0][1], feat.bounds[0][0]], [feat.bounds[1][1], feat.bounds[1][0]]], {
                    padding: 100,
                    maxZoom: 8,
                    duration: 500,
                });
            }
        } else {
            const allBounds = features.reduce(
                (acc, f) => acc.extend([[f.bounds[0][1], f.bounds[0][0]], [f.bounds[1][1], f.bounds[1][0]]]),
                new maplibregl.LngLatBounds()
            );
            if (allBounds.getWest() !== Infinity) map.fitBounds(allBounds, { padding: 50, duration: 500 });
        }
    }, [highlightedResourceId, features]);

    if (features.length === 0) {
        return (
            <div className="flex h-64 items-center justify-center text-slate-500 bg-gray-50 dark:bg-slate-900">
                No mappable results found in this page.
            </div>
        );
    }

    return (
        <div className="h-full w-full bg-slate-100 dark:bg-slate-900 relative z-0">
            <div ref={containerRef} className="h-full w-full" />
        </div>
    );
};

function escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}
