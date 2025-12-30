import React, { useEffect, useState } from 'react';
import { Resource } from '../aardvark/model';
import { queryResourceById } from '../duckdb/duckdbClient';
import { MapContainer, TileLayer, Rectangle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { LatLngBoundsExpression } from 'leaflet';
import { Link } from './Link';

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ResourceAdminProps {
    id: string;
    onBack?: () => void;
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleCopy}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded transition-colors"
            title="Copy JSON to clipboard"
        >
            {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-emerald-500">
                    <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                    <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
                </svg>
            )}
        </button>
    );
};

export const ResourceAdmin: React.FC<ResourceAdminProps> = ({ id, onBack }) => {
    const [resource, setResource] = useState<Resource | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const r = await queryResourceById(id);
                setResource(r);
            } catch (e) {
                console.error("Failed to load resource", e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [id]);

    if (loading) {
        return <div className="p-8 text-center text-slate-500">Loading resource...</div>;
    }

    if (!resource) {
        return <div className="p-8 text-center text-red-500">Resource not found: {id}</div>;
    }

    // Parse Bounds for Mini Map (Copied from ResourceShow.tsx)
    let bounds: LatLngBoundsExpression | null = null;
    if (resource.dcat_bbox) {
        const bboxStr = resource.dcat_bbox;
        // Try ENVELOPE(minX, maxX, maxY, minY)
        const envelopeMatch = bboxStr.match(/ENVELOPE\s*\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/i);
        if (envelopeMatch) {
            const minX = parseFloat(envelopeMatch[1]);
            const maxX = parseFloat(envelopeMatch[2]);
            const maxY = parseFloat(envelopeMatch[3]);
            const minY = parseFloat(envelopeMatch[4]);
            bounds = [[minY, minX], [maxY, maxX]];
        } else {
            const parts = bboxStr.split(',').map(s => parseFloat(s.trim()));
            if (parts.length === 4 && parts.every(n => !isNaN(n))) {
                bounds = [[parts[1], parts[0]], [parts[3], parts[2]]];
            }
        }
    }

    return (
        <div className="max-w-7xl mx-auto w-full bg-white dark:bg-slate-900 min-h-full p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Admin View: {resource.dct_title_s}</h1>
                <button
                    onClick={onBack}
                    className="flex items-center gap-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                    </svg>
                    Back to Resource
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                {/* Thumbnail Section */}
                <div className="bg-gray-50 dark:bg-slate-800 rounded-lg p-4 border border-gray-200 dark:border-slate-700">
                    <h3 className="font-semibold mb-2 text-slate-900 dark:text-gray-100">Thumbnail</h3>
                    {resource.thumbnail ? (
                        <img
                            src={resource.thumbnail}
                            alt="Resource Thumbnail"
                            className="max-w-full h-auto rounded border border-gray-200 dark:border-slate-600"
                        />
                    ) : (
                        <div className="text-slate-500 dark:text-slate-400 italic">No thumbnail available</div>
                    )}
                </div>

                {/* Map Section */}
                <div className="bg-gray-50 dark:bg-slate-800 rounded-lg p-4 border border-gray-200 dark:border-slate-700">
                    <h3 className="font-semibold mb-2 text-slate-900 dark:text-gray-100">Static Map</h3>
                    <div className="h-64 relative z-0 rounded border border-gray-200 dark:border-slate-600 overflow-hidden">
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
            </div>

            {/* JSON Section */}
            <div className="bg-slate-900 rounded-lg overflow-hidden border border-slate-700">
                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/50">
                    <h3 className="font-semibold text-white text-sm">OpenGeoMetadata JSON</h3>
                    <CopyButton text={JSON.stringify(resource, null, 2)} />
                </div>
                <div className="text-sm font-mono text-slate-200">
                    <SyntaxHighlighter
                        language="json"
                        style={vscDarkPlus}
                        customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
                    >
                        {JSON.stringify(resource, null, 2)}
                    </SyntaxHighlighter>
                </div>
            </div>
        </div>
    );
};
