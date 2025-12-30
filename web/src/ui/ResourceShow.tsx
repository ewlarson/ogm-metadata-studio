import React, { useEffect, useState } from 'react';
import { Resource } from '../aardvark/model';
import { queryResourceById, querySimilarResources, getSearchNeighbors, FacetedSearchRequest } from '../duckdb/duckdbClient';
import { MapContainer, TileLayer, Rectangle } from 'react-leaflet';
import { ResourceViewer } from './ResourceViewer';
import { Link } from './Link';
import 'leaflet/dist/leaflet.css';
import { LatLngBoundsExpression } from 'leaflet';


interface ResourceShowProps {
    id: string;

    onBack?: () => void;
}

// Fields that should become faceted links
const FACETABLE_FIELDS = [
    'dct_subject_sm',
    'dct_creator_sm',
    'dcat_theme_sm',
    'dct_spatial_sm',
    'gbl_resourceClass_sm',
    'gbl_resourceType_sm',
    'dct_publisher_sm',
    'dct_language_sm',
    'dct_format_s'
];

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
            className="flex-shrink-0 p-2 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 bg-gray-50 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-gray-200 dark:border-slate-700 rounded transition-colors"
            title="Copy to clipboard"
        >
            {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-emerald-500">
                    <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M15.988 3.012A2.25 2.25 0 0118 5.25v6.5A2.25 2.25 0 0115.75 14H13.5V7A2.5 2.5 0 0011 4.5H8.128a2.252 2.252 0 011.884-1.488A2.25 2.25 0 0112.25 1h1.5a2.25 2.25 0 012.238 2.012zM11.5 3.25a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75v.25h-3v-.25z" clipRule="evenodd" />
                    <path fillRule="evenodd" d="M2 7a1 1 0 011-1h8a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V7zm2 3.25a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75zm0 3.5a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                </svg>
            )}
        </button>
    );
};

export const ResourceShow: React.FC<ResourceShowProps> = ({ id }) => {
    const [resource, setResource] = useState<Resource | null>(null);
    const [similarResources, setSimilarResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    // const [error, setError] = useState<string | null>(null); // Unused
    const [pagination, setPagination] = useState<{ prevId?: string, nextId?: string, position: number, total: number }>({ position: 0, total: 0 });

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            // setError(null);
            try {
                const r = await queryResourceById(id);
                setResource(r);

                if (r) {
                    // Fetch similar resources (Metadata Overlap)
                    querySimilarResources(id).then(setSimilarResources);

                    // Search Pagination Logic
                    const params = new URLSearchParams(window.location.search);
                    const req: FacetedSearchRequest = { filters: {} };

                    if (params.get("q")) req.q = params.get("q")!;
                    if (params.get("bbox")) {
                        const [minX, minY, maxX, maxY] = params.get("bbox")!.split(',').map(Number);
                        if (!isNaN(minX)) req.bbox = { minX, minY, maxX, maxY };
                    }
                    if (params.get("sort")) {
                        const s = params.get("sort")!;
                        if (s === "year_desc") req.sort = [{ field: "gbl_indexYear_im", dir: "desc" }];
                        else if (s === "year_asc") req.sort = [{ field: "gbl_indexYear_im", dir: "asc" }];
                        else if (s === "title_asc") req.sort = [{ field: "dct_title_s", dir: "asc" }];
                        else if (s === "title_desc") req.sort = [{ field: "dct_title_s", dir: "desc" }];
                        else req.sort = [{ field: "dct_title_s", dir: "asc" }];
                    }

                    for (const [key, val] of params.entries()) {
                        const includeMatch = key.match(/^include_filters\[([^\]]+)\]\[\]$/);
                        if (includeMatch) {
                            const field = includeMatch[1];
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].any) req.filters![field].any = [];
                            req.filters![field].any!.push(val);
                            continue;
                        }
                        const excludeMatch = key.match(/^exclude_filters\[([^\]]+)\]\[\]$/);
                        if (excludeMatch) {
                            const field = excludeMatch[1];
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].none) req.filters![field].none = [];
                            req.filters![field].none!.push(val);
                            continue;
                        }
                        if (key.startsWith("f.")) {
                            const field = key.substring(2).trim();
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].any) req.filters![field].any = [];
                            req.filters![field].any!.push(val);
                        }
                    }

                    getSearchNeighbors(req, id).then(setPagination);
                }
            } catch (e) {
                // setError("Failed to load resource");
                console.error("Failed to load resource", e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [id]);

    const navigateToId = (targetId: string) => {
        const search = window.location.search;
        const url = `/resources/${encodeURIComponent(targetId)}${search}`;
        window.history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
    };

    if (loading) {
        return <div className="p-8 text-center text-slate-500">Loading resource...</div>;
    }

    if (!resource) {
        return <div className="p-8 text-center text-red-500">Resource not found: {id}</div>;
    }

    // Parse Bounds for Mini Map
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

    const breadcrumbItems = [
        { label: resource.gbl_resourceClass_sm?.[0], field: 'gbl_resourceClass_sm' },
        { label: resource.gbl_resourceType_sm?.[0], field: 'gbl_resourceType_sm' },
        { label: resource.dct_spatial_sm?.[0], field: 'dct_spatial_sm' },
    ].filter(item => item.label);

    const downloadLink = resource.dct_references_s ? (() => {
        try {
            const refs = JSON.parse(resource.dct_references_s);
            return refs["http://schema.org/downloadUrl"] || refs["http://schema.org/url"];
        } catch { return null; }
    })() : null;

    return (
        <div className="max-w-7xl mx-auto w-full bg-white dark:bg-slate-900 min-h-full">
            {/* Header / Breadcrumb */}
            <div className="border-b border-gray-200 dark:border-slate-800 p-6">
                <div className="flex items-center text-sm text-slate-500 dark:text-slate-400 mb-2">
                    {/* Left: Breadcrumbs */}
                    <div className="flex items-center gap-2 overflow-hidden flex-1">
                        {breadcrumbItems.map((item, idx) => {
                            // Build cumulative filters up to this index
                            const params = new URLSearchParams();
                            for (let i = 0; i <= idx; i++) {
                                const prev = breadcrumbItems[i];
                                params.append(`include_filters[${prev.field}][]`, prev.label!);
                            }
                            const href = `/?${params.toString()}`;

                            return (
                                <React.Fragment key={idx}>
                                    {idx > 0 && <span>&rsaquo;</span>}
                                    <Link
                                        href={href}
                                        className="hover:text-indigo-600 dark:hover:text-indigo-400 truncate whitespace-nowrap"
                                    >
                                        {item.label}
                                    </Link>
                                </React.Fragment>
                            );
                        })}
                    </div>

                    {/* Right: Navigation Controls */}
                    <div className="flex items-center gap-4 shrink-0 ml-4">
                        {/* Back to Results */}
                        <Link
                            href={`/?${window.location.search.substring(1)}`}
                            className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clipRule="evenodd" />
                                <path d="M8.707 7.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l2-2a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" />
                                {/* Actually let's use a standard back arrow icon */}
                                <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                            </svg>
                            Back
                        </Link>

                        {/* Pagination */}
                        {pagination.total > 0 && (
                            <>
                                <div className="h-4 w-px bg-gray-300 dark:bg-slate-700 mx-2"></div>
                                <button
                                    onClick={() => pagination.prevId && navigateToId(pagination.prevId)}
                                    disabled={!pagination.prevId}
                                    className="flex items-center gap-1 disabled:opacity-30 hover:text-indigo-600 disabled:cursor-not-allowed transition-colors"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                                    </svg>
                                    Prev
                                </button>
                                <span className="text-slate-900 dark:text-slate-200 font-medium">
                                    {pagination.position} of {pagination.total}
                                </span>
                                <button
                                    onClick={() => pagination.nextId && navigateToId(pagination.nextId)}
                                    disabled={!pagination.nextId}
                                    className="flex items-center gap-1 disabled:opacity-30 hover:text-indigo-600 disabled:cursor-not-allowed transition-colors"
                                >
                                    Next
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                                    </svg>
                                </button>
                                <div className="h-4 w-px bg-gray-300 dark:bg-slate-700 mx-2"></div>
                            </>
                        )}

                        {/* Clear Search */}
                        <Link
                            href="/"
                            className="flex items-center gap-1 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        >
                            Clear
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                            </svg>
                        </Link>
                    </div>
                </div>
                <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{resource.dct_title_s}</h1>
                <div className="flex flex-wrap gap-4 text-sm text-slate-600 dark:text-slate-400 items-center">
                    {resource.dct_publisher_sm?.[0] && (
                        <span>{resource.dct_publisher_sm[0]}</span>
                    )}
                    {resource.gbl_indexYear_im && (
                        <span>&middot; {resource.gbl_indexYear_im}</span>
                    )}

                    <div className="flex-1"></div>

                    <Link
                        href={`/resources/${resource.id}/edit`}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
                            <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
                        </svg>
                        Edit Resource
                    </Link>
                    <Link
                        href={`/resources/${resource.id}/admin`}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                        </svg>
                        Admin
                    </Link>
                </div>
            </div>

            {/* Resource Viewer */}
            <div className="px-6 pt-6">
                <ResourceViewer resource={resource} />
            </div>

            <div className="flex flex-col lg:flex-row">
                {/* Main Content: Metadata */}
                <div className="flex-1 min-w-0 p-6 border-r border-gray-200 dark:border-slate-800">
                    <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-white">Full Details</h2>

                    <dl className="grid grid-cols-[160px_1fr] gap-y-4 text-sm">
                        {Object.entries(resource).map(([key, value]) => {
                            if (!value || (Array.isArray(value) && value.length === 0) || key === 'id' || key === 'dct_references_s' || key.startsWith('_')) return null;
                            // Basic label formatting
                            const label = key.replace(/^[a-z]+_/, '').replace(/_[a-z]+$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());

                            return (
                                <React.Fragment key={key}>
                                    <dt className="font-medium text-slate-500 dark:text-slate-400">{label}</dt>
                                    <dd className="text-slate-900 dark:text-slate-200 break-all">
                                        {(() => {
                                            const isFacetable = FACETABLE_FIELDS.includes(key);
                                            const values = Array.isArray(value) ? value : [String(value)];

                                            return values.map((val, idx) => (
                                                <React.Fragment key={idx}>
                                                    {idx > 0 && ", "}
                                                    {isFacetable ? (
                                                        <Link
                                                            href={`/?include_filters[${key}][]=${encodeURIComponent(val)}`}
                                                            className="text-indigo-600 dark:text-indigo-400 hover:underline"
                                                        >
                                                            {val}
                                                        </Link>
                                                    ) : (
                                                        val
                                                    )}
                                                </React.Fragment>
                                            ));
                                        })()}
                                    </dd>
                                </React.Fragment>
                            );
                        })}
                    </dl>
                </div>

                {/* Sidebar */}
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
                                        {(() => {
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
                                        })()}
                                    </div>
                                    <CopyButton text={(() => {
                                        const parts = [];
                                        if (resource.dct_creator_sm && resource.dct_creator_sm.length > 0) parts.push(resource.dct_creator_sm.join(", "));
                                        const date = resource.gbl_indexYear_im ? `(${resource.gbl_indexYear_im})` : "(n.d.)";
                                        parts.push(date);
                                        parts.push(resource.dct_title_s);
                                        if (resource.dct_publisher_sm && resource.dct_publisher_sm.length > 0) parts.push(resource.dct_publisher_sm.join(", "));
                                        parts.push(window.location.href);
                                        return parts.join(". ") + ".";
                                    })()} />
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
            </div>

            {/* Similar Items Carousel */}
            {similarResources.length > 0 && (
                <div className="mt-12 mb-8 px-6 pb-6">
                    <h2 className="text-2xl font-bold mb-6 text-slate-900 dark:text-gray-100">Similar Items</h2>
                    <Carousel items={similarResources} />
                </div>
            )}
        </div>
    );
};

const ITEMS_PER_PAGE = 4;

const Carousel: React.FC<{ items: Resource[] }> = ({ items }) => {
    const [currentPage, setCurrentPage] = useState(0);
    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

    const handlePrev = () => {
        setCurrentPage(p => Math.max(0, p - 1));
    };

    const handleNext = () => {
        setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    };

    const currentItems = items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);

    if (items.length === 0) return null;

    return (
        <div className="relative group">
            {/* Grid for items */}
            <div className="grid grid-cols-4 gap-6 mb-6">
                {currentItems.map((item) => (
                    <Link
                        key={item.id}
                        href={`/resources/${item.id}`}
                        className="group/card focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-lg"
                    >
                        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 border border-gray-200 dark:border-slate-700 h-full flex flex-col overflow-hidden">
                            {/* Thumbnail */}
                            <div className="h-40 bg-gray-100 dark:bg-slate-700 overflow-hidden relative">
                                {item.thumbnail ? (
                                    <img
                                        src={item.thumbnail}
                                        alt=""
                                        className="w-full h-full object-cover transition-transform duration-500 group-hover/card:scale-105"
                                        loading="lazy"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                                        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                    </div>
                                )}
                            </div>

                            {/* Content */}
                            <div className="p-4 flex-1 flex flex-col">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-gray-100 line-clamp-2 mb-2 group-hover/card:text-indigo-600 dark:group-hover/card:text-indigo-400">
                                    {item.dct_title_s}
                                </h3>
                                <div className="mt-auto text-xs text-slate-500 dark:text-slate-400">
                                    {item.dct_publisher_sm?.[0] || 'Unknown Publisher'}
                                    <span className="mx-1">&middot;</span>
                                    {item.gbl_indexYear_im || 'n.d.'}
                                </div>
                            </div>
                        </div>
                    </Link>
                ))}
            </div>

            {/* Controls */}
            {totalPages > 1 && (
                <div className="flex items-center justify-center gap-4">
                    <button
                        onClick={handlePrev}
                        disabled={currentPage === 0}
                        className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                        aria-label="Previous page"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-600 dark:text-slate-400">
                            <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
                        </svg>
                    </button>

                    <div className="flex gap-2">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button
                                key={i}
                                onClick={() => setCurrentPage(i)}
                                className={`w-2 h-2 rounded-full transition-colors ${i === currentPage
                                    ? 'bg-indigo-600 dark:bg-indigo-400'
                                    : 'bg-gray-300 dark:bg-slate-700 hover:bg-gray-400 dark:hover:bg-slate-600'
                                    }`}
                                aria-label={`Go to page ${i + 1}`}
                                aria-current={i === currentPage ? 'page' : undefined}
                            />
                        ))}
                    </div>

                    <button
                        onClick={handleNext}
                        disabled={currentPage === totalPages - 1}
                        className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                        aria-label="Next page"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-600 dark:text-slate-400">
                            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
};
