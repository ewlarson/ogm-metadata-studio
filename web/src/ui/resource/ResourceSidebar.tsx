import React, { useMemo } from 'react';
import { Resource } from '../../aardvark/model';
import { MapContainer, TileLayer, Rectangle } from 'react-leaflet';
import { LatLngBoundsExpression } from 'leaflet';
import { CopyButton } from './CopyButton';

interface ResourceSidebarProps {
    resource: Resource;
}

export const ResourceSidebar: React.FC<ResourceSidebarProps> = ({ resource }) => {
    // Parse Bounds for Mini Map
    const bounds = useMemo<LatLngBoundsExpression | null>(() => {
        if (!resource.dcat_bbox) return null;
        const bboxStr = resource.dcat_bbox;
        // Try ENVELOPE(minX, maxX, maxY, minY)
        const envelopeMatch = bboxStr.match(/ENVELOPE\s*\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/i);
        if (envelopeMatch) {
            const minX = parseFloat(envelopeMatch[1]);
            const maxX = parseFloat(envelopeMatch[2]);
            const maxY = parseFloat(envelopeMatch[3]);
            const minY = parseFloat(envelopeMatch[4]);
            return [[minY, minX], [maxY, maxX]];
        } else {
            const parts = bboxStr.split(',').map(s => parseFloat(s.trim()));
            if (parts.length === 4 && parts.every(n => !isNaN(n))) {
                return [[parts[1], parts[0]], [parts[3], parts[2]]];
            }
        }
        return null;
    }, [resource.dcat_bbox]);

    const downloadLink = useMemo(() => {
        if (!resource.dct_references_s) return null;
        try {
            const refs = JSON.parse(resource.dct_references_s);
            return refs["http://schema.org/downloadUrl"] || refs["http://schema.org/url"];
        } catch { return null; }
    }, [resource.dct_references_s]);

    const citationText = useMemo(() => {
        const parts = [];
        // Author
        if (resource.dct_creator_sm && resource.dct_creator_sm.length > 0) {
            parts.push(resource.dct_creator_sm.join(", "));
        }
        // Date
        const date = resource.gbl_indexYear_im ? `(${resource.gbl_indexYear_im})` : "(n.d.)";
        parts.push(date);
        // Title
        parts.push(resource.dct_title_s);
        // Publisher
        if (resource.dct_publisher_sm && resource.dct_publisher_sm.length > 0) {
            parts.push(resource.dct_publisher_sm.join(", "));
        }
        // URL
        parts.push(window.location.href);

        return parts.join(". ") + ".";
    }, [resource]);

    return (
        <div className="w-full lg:w-96 p-6 flex flex-col gap-6 bg-gray-50 dark:bg-slate-900/50">
            {/* Location Map */}
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 overflow-hidden">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Location</div>
                <div className="h-64 relative z-0">
                    {bounds ? (
                        <MapContainer bounds={bounds as any} className="h-full w-full" scrollWheelZoom={false} dragging={false} zoomControl={false} doubleClickZoom={false}>
                            <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" />
                            <Rectangle bounds={bounds} pathOptions={{ color: '#3b82f6', weight: 1, fillOpacity: 0.2 }} />
                        </MapContainer>
                    ) : (
                        <div className="h-full flex items-center justify-center text-slate-400 text-sm">No map extent available</div>
                    )}
                </div>
            </div>

            {/* Downloads */}
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

            {/* Cite & Reference */}
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Cite & Reference</div>
                <div className="p-4 space-y-4">
                    {/* Citation */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Citation</label>
                        <div className="flex gap-2">
                            <div className="flex-1 min-w-0 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded p-2 text-xs text-slate-700 dark:text-slate-300 break-words font-mono">
                                {citationText}
                            </div>
                            <CopyButton text={citationText} />
                        </div>
                    </div>

                    {/* Share Link */}
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
