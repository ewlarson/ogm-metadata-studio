import React, { useLayoutEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Resource } from '../../aardvark/model';
import { CopyButton } from './CopyButton';

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

interface ResourceSidebarProps {
    resource: Resource;
}

type Bounds = [[number, number], [number, number]]; // [[minY, minX], [maxY, maxX]] (lat,lng)

export const ResourceSidebar: React.FC<ResourceSidebarProps> = ({ resource }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    // Parse Bounds for Mini Map (lat,lng for display; MapLibre uses [lng, lat])
    const bounds = useMemo<Bounds | null>(() => {
        if (!resource.dcat_bbox) return null;
        const bboxStr = resource.dcat_bbox;
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
    }, [resource.dcat_bbox]);

    useLayoutEffect(() => {
        if (mapRef.current) {
            mapRef.current.remove();
            mapRef.current = null;
        }
        if (!bounds || !containerRef.current) return;
        const el = containerRef.current;
        const map = new maplibregl.Map({
            container: el,
            style: MAP_STYLE,
            center: [(bounds[0][1] + bounds[1][1]) / 2, (bounds[0][0] + bounds[1][0]) / 2],
            zoom: 4,
            scrollZoom: false,
            dragPan: false,
            doubleClickZoom: false,
        });
        mapRef.current = map;
        map.on('load', () => {
            const [minY, minX] = bounds[0];
            const [maxY, maxX] = bounds[1];
            map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 20 });
            map.addSource('bbox', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
                    },
                },
            });
            map.addLayer({
                id: 'bbox-fill',
                type: 'fill',
                source: 'bbox',
                paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.2 },
            });
            map.addLayer({
                id: 'bbox-line',
                type: 'line',
                source: 'bbox',
                paint: { 'line-color': '#3b82f6', 'line-width': 1 },
            });
        });
        return () => {
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, [bounds]);

    const downloadLink = useMemo(() => {
        if (!resource.dct_references_s) return null;
        try {
            const refs = JSON.parse(resource.dct_references_s);
            return refs["http://schema.org/downloadUrl"] || refs["http://schema.org/url"];
        } catch { return null; }
    }, [resource.dct_references_s]);

    const citationText = useMemo(() => {
        const parts = [];
        if (resource.dct_creator_sm?.length) parts.push(resource.dct_creator_sm.join(", "));
        parts.push(resource.gbl_indexYear_im ? `(${resource.gbl_indexYear_im})` : "(n.d.)");
        parts.push(resource.dct_title_s);
        if (resource.dct_publisher_sm?.length) parts.push(resource.dct_publisher_sm.join(", "));
        parts.push(window.location.href);
        return parts.join(". ") + ".";
    }, [resource]);

    return (
        <div className="w-full lg:w-96 p-6 flex flex-col gap-6 bg-gray-50 dark:bg-slate-900/50">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 overflow-hidden">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Location</div>
                <div className="h-64 relative z-0">
                    {bounds ? (
                        <div ref={containerRef} className="h-full w-full" />
                    ) : (
                        <div className="h-full flex items-center justify-center text-slate-400 text-sm">No map extent available</div>
                    )}
                </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Downloads</div>
                <div className="p-4">
                    {downloadLink ? (
                        <a
                            href={downloadLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block w-full text-center bg-indigo-600 hover:bg-indigo-700 text-white rounded py-2 text-sm font-medium transition-colors"
                        >
                            Download Resource
                        </a>
                    ) : (
                        <span className="text-sm text-slate-500">No direct download available.</span>
                    )}
                </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Cite & Reference</div>
                <div className="p-4 space-y-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Citation</label>
                        <div className="flex gap-2">
                            <div className="flex-1 min-w-0 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded p-2 text-xs text-slate-700 dark:text-slate-300 break-words font-mono">
                                {citationText}
                            </div>
                            <CopyButton text={citationText} />
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Share Link</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                readOnly
                                value={window.location.href}
                                className="flex-1 min-w-0 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded p-2 text-xs text-slate-700 dark:text-slate-300 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                onClick={(e) => e.currentTarget.select()}
                            />
                            <CopyButton text={window.location.href} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
