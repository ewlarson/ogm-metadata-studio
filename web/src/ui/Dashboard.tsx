import React, { useEffect, useState, useCallback } from "react";
import { Resource } from "../aardvark/model";
import {
    FacetedSearchRequest, facetedSearch, exportFilteredResults
} from "../duckdb/duckdbClient";
import { useUrlState } from "../hooks/useUrlState";
import { useThumbnailQueue } from "../hooks/useThumbnailQueue";
import { useStaticMapQueue } from "../hooks/useStaticMapQueue";
import { GalleryView } from "./GalleryView";
import { ResultsMapView } from "./ResultsMapView";
import { DashboardResultsList } from "./DashboardResultsList";


import { ActiveFilterBar } from "./ActiveFilterBar";
import { MapFacet } from "./MapFacet";
import { TimelineFacet } from "./TimelineFacet";
import { ErrorBoundary } from "./ErrorBoundary";
import { FacetModal } from "./FacetModal";

interface DashboardProps {
    onEdit: (id: string) => void;
    onSelect?: (id: string) => void;
}

const FACETS = [
    { field: "dct_spatial_sm", label: "Place", limit: 5 },
    { field: "gbl_resourceClass_sm", label: "Resource Class", limit: 5 },
    { field: "gbl_resourceType_sm", label: "Resource Type", limit: 5 },
    { field: "dct_subject_sm", label: "Subject", limit: 5 },
    { field: "dcat_theme_sm", label: "Theme", limit: 5 },
    { field: "gbl_indexYear_im", label: "Year", limit: 10 },
    { field: "dct_language_sm", label: "Language", limit: 5 },
    { field: "dct_creator_sm", label: "Creator", limit: 5 },
    { field: "schema_provider_s", label: "Provider", limit: 5 },
    { field: "dct_accessRights_s", label: "Access", limit: 5 },
    { field: "gbl_georeferenced_b", label: "Georeferenced", limit: 5 },
];

export const Dashboard: React.FC<DashboardProps> = ({ onEdit, onSelect }) => {
    const [resources, setResources] = useState<Resource[]>([]);
    const [facetsData, setFacetsData] = useState<Record<string, { value: string; count: number }[]>>({});
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);
    const [modalState, setModalState] = useState<{ field: string; label: string } | null>(null);
    const [hoveredResourceId, setHoveredResourceId] = useState<string | null>(null);

    // Asset Queues
    const { thumbnails, register } = useThumbnailQueue();
    const { mapUrls, register: registerStaticMap } = useStaticMapQueue();

    // Register resources for asset fetching
    useEffect(() => {
        resources.forEach(r => {
            register(r.id, r);
            registerStaticMap(r.id, r);
        });
    }, [resources, register, registerStaticMap]);

    // URL State Definition
    interface DashboardState {
        q: string;
        page: number;
        facets: Record<string, string[]>;
        sort: string;
        bbox: string | undefined; // "minX,minY,maxX,maxY"
        yearRange: string | undefined; // "min,max"
        view: 'list' | 'gallery' | 'map';
    }

    const [state, setState] = useUrlState<DashboardState>(
        { q: "", page: 1, facets: {}, sort: "relevance", bbox: undefined, yearRange: undefined, view: 'list' },
        {
            toUrl: (s) => {
                const params = new URLSearchParams();
                if (s.q) params.set("q", s.q);
                if (s.page > 1) params.set("page", String(s.page));
                if (s.sort && s.sort !== "relevance") params.set("sort", s.sort);
                if (s.bbox) params.set("bbox", s.bbox);
                if (s.yearRange) params.set("yearRange", s.yearRange);
                if (s.view && s.view !== 'list') params.set("view", s.view);

                for (const [key, vals] of Object.entries(s.facets)) {
                    if (key.startsWith("-")) {
                        const field = key.substring(1);
                        for (const v of vals) {
                            params.append(`exclude_filters[${field}][]`, v);
                        }
                    } else {
                        for (const v of vals) {
                            params.append(`include_filters[${key}][]`, v);
                        }
                    }
                }
                return params;
            },
            fromUrl: (params) => {
                const q = params.get("q") || "";
                const page = Number(params.get("page")) || 1;
                const sort = params.get("sort") || "relevance";
                const bbox = params.get("bbox") || undefined;
                const yearRange = params.get("yearRange") || undefined;
                const viewParam = params.get("view");
                const view = (viewParam === 'gallery' || viewParam === 'map') ? viewParam : 'list';

                const facets: Record<string, string[]> = {};
                for (const [key, val] of params.entries()) {
                    // Match include_filters[field][]
                    const includeMatch = key.match(/^include_filters\[([^\]]+)\]\[\]$/);
                    if (includeMatch) {
                        const field = includeMatch[1];
                        if (!facets[field]) facets[field] = [];
                        facets[field].push(val);
                        continue;
                    }

                    // Match exclude_filters[field][]
                    const excludeMatch = key.match(/^exclude_filters\[([^\]]+)\]\[\]$/);
                    if (excludeMatch) {
                        const field = excludeMatch[1];
                        const internalKey = `-${field}`;
                        if (!facets[internalKey]) facets[internalKey] = [];
                        facets[internalKey].push(val);
                        continue;
                    }

                    // Legacy f.field support for graceful migration (optional, but good for safety)
                    if (key.startsWith("f.")) {
                        const field = key.substring(2).trim();
                        if (!facets[field]) facets[field] = [];
                        facets[field].push(val);
                    }
                }
                return { q, page, facets, sort, bbox, yearRange, view };
            },
            cleanup: (params) => {
                params.delete("q");
                params.delete("page");
                params.delete("sort");
                params.delete("bbox");
                params.delete("yearRange");
                params.delete("view");
                const keysToDelete: string[] = [];
                for (const key of params.keys()) {
                    if (key.startsWith("include_filters") || key.startsWith("exclude_filters") || key.startsWith("f.")) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(k => params.delete(k));
            }
        }
    );

    const { q, page, facets: selectedFacets } = state;


    const pageSize = 20;

    const activeFilters = React.useMemo(() => {
        const filters: Record<string, any> = {};
        for (const [key, values] of Object.entries(selectedFacets)) {
            if (values.length > 0) {
                if (key.startsWith("-")) {
                    const field = key.substring(1);
                    if (!filters[field]) filters[field] = {};
                    filters[field].none = values;
                } else {
                    if (!filters[key]) filters[key] = {};
                    filters[key].any = values;
                }
            }
        }
        if (state.yearRange) {
            const parts = state.yearRange.split(",").map(Number);
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                filters['gbl_indexYear_im'] = { ...filters['gbl_indexYear_im'], gte: parts[0], lte: parts[1] };
            }
        }
        return filters;
    }, [selectedFacets, state.yearRange]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const filters = activeFilters;

            let sortObj = { field: "dct_title_s", dir: "asc" } as any;
            if (state.sort === "year_desc") sortObj = { field: "gbl_indexYear_im", dir: "desc" };
            else if (state.sort === "year_asc") sortObj = { field: "gbl_indexYear_im", dir: "asc" };
            else if (state.sort === "title_asc") sortObj = { field: "dct_title_s", dir: "asc" };
            else if (state.sort === "title_desc") sortObj = { field: "dct_title_s", dir: "desc" };
            else if (state.sort === "relevance") {
                // Relevance = Title ASC fallback, relying on backend default if valid
                sortObj = { field: "dct_title_s", dir: "asc" };
            }

            let bbox = undefined;
            if (state.bbox) {
                const parts = state.bbox.split(",").map(Number);
                if (parts.length === 4 && parts.every(n => !isNaN(n))) {
                    bbox = { minX: parts[0], minY: parts[1], maxX: parts[2], maxY: parts[3] };
                }
            }

            const req: FacetedSearchRequest = {
                q: q,
                filters,
                // Request limit + 1 to detect "More..."
                facets: FACETS.map(f => ({ field: f.field, limit: f.limit + 1 })),
                page: { size: pageSize, from: (page - 1) * pageSize },
                sort: [sortObj],
                bbox
            };

            const res = await facetedSearch(req);
            if (state.view === 'gallery' && page > 1) {
                setResources(prev => [...prev, ...res.results]);
            } else {
                setResources(res.results);
            }

            setFacetsData(res.facets);
            setTotal(res.total);
        } catch (err) {
            console.error("Dashboard search failed", err);
        } finally {
            setLoading(false);
        }
    }, [q, activeFilters, page, state.sort, state.bbox, state.view]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const toggleFacet = (field: string, value: string, mode: 'include' | 'exclude' = 'include') => {
        const key = mode === 'exclude' ? `-${field}` : field;
        // Construct opposite key to ensure we don't have same value in both include and exclude
        const oppositeKey = mode === 'exclude' ? field : `-${field}`;

        setState(prev => {
            const currentObj = { ...prev.facets };
            const currentVals = currentObj[key] || [];

            // Toggle value in target key
            let newVals;
            if (currentVals.includes(value)) {
                newVals = currentVals.filter(v => v !== value);
            } else {
                newVals = [...currentVals, value];
            }

            if (newVals.length > 0) currentObj[key] = newVals;
            else delete currentObj[key];

            // Remove from opposite key if present
            if (currentObj[oppositeKey] && currentObj[oppositeKey].includes(value)) {
                const oppositeVals = currentObj[oppositeKey].filter(v => v !== value);
                if (oppositeVals.length > 0) currentObj[oppositeKey] = oppositeVals;
                else delete currentObj[oppositeKey];
            }

            return {
                ...prev,
                page: 1,
                facets: currentObj
            };
        });
    };

    const handleExport = async (format: 'json' | 'csv') => {
        setIsExporting(true);
        try {
            const filters = activeFilters;
            const req: FacetedSearchRequest = {
                q: q,
                filters,
                facets: [],
                page: { size: 1000, from: 0 },
                sort: [],
                bbox: currentBBox // Reuse the parsed BBox
            };
            const blob = await exportFilteredResults(req, format);
            if (!blob) throw new Error("Export yielded no data");

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aardvark_export_${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'zip' : 'csv'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Export failed", e);
            alert("Export failed. See console.");
        } finally {
            setIsExporting(false);
        }
    };

    const totalPages = Math.ceil(total / pageSize);

    const currentBBox = state.bbox ? (() => {
        const p = state.bbox.split(",").map(Number);
        if (p.length === 4 && p.every(n => !isNaN(n))) return { minX: p[0], minY: p[1], maxX: p[2], maxY: p[3] };
        return undefined;
    })() : undefined;

    const currentYearRange = state.yearRange ? (() => {
        const p = state.yearRange.split(",").map(Number);
        if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return [p[0], p[1]] as [number, number];
        return undefined;
    })() : undefined;


    return (
        <div className="flex bg-gray-50 dark:bg-slate-900 h-full transition-colors duration-200">
            {/* Sidebar: Facets */}
            <div className="hidden md:block w-96 flex-shrink-0 border-r border-gray-200 dark:border-slate-800 p-4 overflow-y-auto bg-white dark:bg-transparent">
                <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 mb-4 uppercase tracking-wider">Refine Results</h3>
                <ErrorBoundary>
                    <MapFacet
                        bbox={currentBBox}
                        onChange={(b) => setState(prev => ({
                            ...prev,
                            bbox: b ? `${b.minX},${b.minY},${b.maxX},${b.maxY}` : undefined,
                            page: 1
                        }))}
                    />
                </ErrorBoundary>
                <ErrorBoundary>
                    <TimelineFacet
                        data={facetsData['gbl_indexYear_im'] || []}
                        range={currentYearRange}
                        onChange={(r) => setState(prev => ({
                            ...prev,
                            yearRange: r ? `${r[0]},${r[1]}` : undefined,
                            page: 1
                        }))}
                    />
                </ErrorBoundary>

                <div className="space-y-4">
                    {FACETS.filter(f => f.field !== 'gbl_indexYear_im').map((f, index) => {
                        const rawData = facetsData[f.field] || [];
                        const hasMore = rawData.length > f.limit;
                        const data = rawData.slice(0, f.limit);

                        const selectedValues = selectedFacets[f.field] || [];
                        const excludedValues = selectedFacets[`-${f.field}`] || [];

                        // Pass down selection/data + defaultOpen logic
                        // First 5 (index 0-4) default open, rest closed.
                        // UNLESS active selection exists, then force open.

                        return (
                            <FacetSection
                                key={f.field}
                                field={f.field}
                                label={f.label}
                                data={data}
                                selectedValues={selectedValues}
                                excludedValues={excludedValues}
                                onToggle={toggleFacet}
                                defaultOpen={index < 5}
                                onShowMore={hasMore ? () => setModalState({ field: f.field, label: f.label }) : undefined}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Facet Modal */}
            {modalState && (
                <FacetModal
                    field={modalState.field}
                    label={modalState.label}
                    isOpen={true}
                    onClose={() => setModalState(null)}
                    q={q}
                    filters={activeFilters}
                    bbox={state.bbox}
                    yearRange={state.yearRange}
                    selectedValues={selectedFacets[modalState.field] || []}
                    excludedValues={selectedFacets[`-${modalState.field}`] || []}
                    onToggle={toggleFacet}
                />
            )}

            {/* Main: Results */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Top Bar */}
                <div className="z-10 relative border-b border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 p-4 flex flex-col gap-4 backdrop-blur-sm">
                    {/* Top Bar removed inputs, now just counts/view toggle? */
                        /* Actually we want the count and view toggle to remain. Input is gone. */
                    }
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-4 flex-shrink-0">
                            {/* Breadcrumb or Active Filters could go here? For now just the count. */}
                            <span className="text-sm text-slate-500 dark:text-slate-400">
                                Found <span className="text-slate-900 dark:text-white font-medium">{total}</span> results
                            </span>
                        </div>
                        <div className="flex items-center gap-4 flex-shrink-0">

                            <div className="flex bg-gray-100 dark:bg-slate-800 rounded-md p-0.5 border border-gray-200 dark:border-slate-700 mr-2">
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'list' }))}
                                    className={`px-2 py-1.5 rounded text-xs transition-colors ${state.view === 'list' || !state.view ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400 font-medium' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                    title="List View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M2.5 4.75A.75.75 0 013.25 4h14.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2.5 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 10z" clipRule="evenodd" />
                                    </svg>
                                </button>
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'gallery' }))}
                                    className={`px-2 py-1.5 rounded text-xs transition-colors ${state.view === 'gallery' ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400 font-medium' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                    title="Gallery View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M1 2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1V2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1V2zM1 7a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1V7zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1V7zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1V7zM1 12a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1v-2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1v-2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1v-2z" clipRule="evenodd" />
                                    </svg>
                                </button>
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'map' }))}
                                    className={`px-2 py-1.5 rounded text-xs transition-colors ${state.view === 'map' ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400 font-medium' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                    title="Map View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.006.003.002.001.003.001a.79.79 0 00.01.003zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                                    </svg>
                                </button>
                            </div>

                            <select
                                value={state.sort || "relevance"}
                                onChange={(e) => setState(prev => ({ ...prev, sort: e.target.value, page: 1 }))}
                                className="text-xs sm:text-sm rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:ring-1 focus:ring-indigo-500 py-1.5 pl-2 pr-8"
                            >
                                <option value="relevance">Relevance</option>
                                <option value="year_desc">Year (Newest)</option>
                                <option value="year_asc">Year (Oldest)</option>
                                <option value="title_asc">Title (A-Z)</option>
                                <option value="title_desc">Title (Z-A)</option>
                            </select>
                            <div className="flex items-center bg-gray-100 dark:bg-slate-800 rounded-md p-0.5 border border-gray-200 dark:border-slate-700">
                                <button onClick={() => handleExport('json')} disabled={isExporting || total === 0} className="px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm hover:shadow">JSON</button>
                                <div className="w-px bg-gray-300 dark:bg-slate-700 h-4 mx-0.5"></div>
                                <button onClick={() => handleExport('csv')} disabled={isExporting || total === 0} className="px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm hover:shadow">CSV</button>
                            </div>
                        </div>
                    </div>

                    {/* Active Filters */}
                    <ActiveFilterBar
                        query={state.q}
                        facets={selectedFacets}
                        yearRange={state.yearRange}
                        onRemoveQuery={() => setState(prev => ({ ...prev, q: '', page: 1 }))}
                        onRemoveFacet={(field, value) => setState(prev => {
                            const existing = prev.facets[field] || [];
                            const next = existing.filter(v => v !== value);
                            const newFacets = { ...prev.facets };
                            if (next.length > 0) newFacets[field] = next;
                            else delete newFacets[field];
                            return { ...prev, facets: newFacets, page: 1 };
                        })}
                        onRemoveYearRange={() => setState(prev => ({ ...prev, yearRange: undefined, page: 1 }))}
                        onClearAll={() => setState(prev => ({ ...prev, q: '', facets: {}, yearRange: undefined, page: 1 }))}
                    />
                </div>

                {/* Results Grid/List/Map */}
                {/* Results Grid/List/Map */}
                {state.view === 'map' ? (
                    <div className="flex-1 flex items-start">
                        {/* Condensed List Column */}
                        <div className="w-[32rem] flex-shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 pb-20">
                            {loading ? (
                                <div className="flex h-64 items-center justify-center text-slate-500">Loading...</div>
                            ) : (
                                <ul className="divide-y divide-gray-100 dark:divide-slate-800">
                                    {resources.map(r => (
                                        <li
                                            key={r.id}
                                            className="p-3 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors group cursor-pointer"
                                            onMouseEnter={() => setHoveredResourceId(r.id)}
                                            onMouseLeave={() => setHoveredResourceId(null)}
                                            onClick={() => onSelect?.(r.id)}
                                        >
                                            <div className="flex gap-3">
                                                {/* Thumbnail */}
                                                <div className="w-16 h-16 flex-shrink-0 bg-gray-100 dark:bg-slate-800 rounded overflow-hidden relative border border-gray-200 dark:border-slate-700">
                                                    {thumbnails[r.id] ? (
                                                        <img src={thumbnails[r.id] || undefined} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        <div className="flex items-center justify-center h-full text-slate-300 dark:text-slate-600">
                                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
                                                                <path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25v9.5A2.25 2.25 0 0116.75 17H3.25A2.25 2.25 0 011 14.75v-9.5zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 00.75-.75v-2.69l-2.22-2.219a.75.75 0 00-1.06 0l-1.91 1.909.47.47a.75.75 0 11-1.06 1.06L6.53 8.091a.75.75 0 00-1.06 0l-2.97 2.97z" clipRule="evenodd" />
                                                            </svg>
                                                        </div>
                                                    )}
                                                </div>
                                                {/* Meta */}
                                                <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                    <h4 className="text-sm font-medium text-slate-900 dark:text-white truncate" title={r.dct_title_s}>
                                                        {r.dct_title_s}
                                                    </h4>
                                                    <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                                                        <span>{r.gbl_indexYear_im || "n.d."}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        {/* Map Column */}
                        <div className="flex-1 sticky top-[88px] h-[calc(100vh-100px)]">
                            {loading ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-gray-50/50 dark:bg-slate-900/50 backdrop-blur-sm z-10">Loading...</div>
                            ) : (
                                <ResultsMapView resources={resources} onEdit={onEdit} onSelect={onSelect} highlightedResourceId={hoveredResourceId} />
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto p-4">
                        {loading && resources.length === 0 ? (
                            <div className="flex h-64 items-center justify-center text-slate-500">Loading...</div>
                        ) : state.view === 'gallery' ? (
                            <>
                                <GalleryView
                                    resources={resources}
                                    thumbnails={thumbnails}
                                    onSelect={onSelect}
                                    onLoadMore={() => !loading && setState(prev => ({ ...prev, page: prev.page + 1 }))}
                                    hasMore={resources.length < total}
                                />
                                {loading && (
                                    <div className="py-8 flex justify-center">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <DashboardResultsList resources={resources} thumbnails={thumbnails} mapUrls={mapUrls} onSelect={onSelect} onAddFilter={(f, v) => toggleFacet(f, v, 'include')} page={page} />
                        )}
                    </div>
                )}

                {/* Pagination */}
                {totalPages > 1 && state.view !== 'gallery' && (
                    <div className="border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 p-4 flex items-center justify-between">
                        <button
                            disabled={page <= 1}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page - 1 }))}
                            className="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-sm text-slate-700 dark:text-slate-300 disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-slate-700 shadow-sm"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-slate-500 dark:text-slate-400">
                            Showing <span className="font-medium text-slate-900 dark:text-white">{(page - 1) * 20 + 1}</span> to{" "}
                            <span className="font-medium text-slate-900 dark:text-white">{Math.min(page * 20, total)}</span> of{" "}
                            <span className="font-medium text-slate-900 dark:text-white">{total}</span> results
                        </span>
                        <button
                            disabled={page >= totalPages}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page + 1 }))}
                            className="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-sm text-slate-700 dark:text-slate-300 disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-slate-700 shadow-sm"
                        >
                            Next
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

const FacetSection: React.FC<{
    field: string;
    label: string;
    data: { value: string; count: number }[];
    selectedValues: string[];
    excludedValues: string[];
    onToggle: (type: string, value: string, mode: 'include' | 'exclude') => void;
    defaultOpen: boolean;
    onShowMore?: () => void;
}> = ({ field, label, data, selectedValues, excludedValues, onToggle, defaultOpen, onShowMore }) => {
    const hasActiveSelection = selectedValues.length > 0 || excludedValues.length > 0;
    const [isOpen, setIsOpen] = useState(defaultOpen || hasActiveSelection);

    useEffect(() => {
        if (hasActiveSelection) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsOpen(true);
        }
    }, [hasActiveSelection]);

    if (data.length === 0 && !hasActiveSelection) return null;

    return (
        <div className="border-b border-gray-200 dark:border-slate-800 pb-2 last:border-0 last:pb-0">
            <button
                className="flex items-center justify-between w-full py-2 group"
                onClick={() => setIsOpen(!isOpen)}
            >
                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                    {label}
                </h4>
                <span className={`text-slate-400 dark:text-slate-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                    </svg>
                </span>
            </button>

            {isOpen && (
                <ul className="space-y-1 mb-2">
                    {data.map(item => {
                        const isIncluded = selectedValues.includes(item.value);
                        const isExcluded = excludedValues.includes(item.value);

                        return (
                            <li key={item.value} className="flex items-center justify-between group/item">
                                <button
                                    onClick={() => onToggle(field, item.value, 'include')}
                                    className={`flex-1 flex items-center text-sm cursor-pointer py-0.5 text-left min-w-0 ${isIncluded
                                        ? "font-bold text-indigo-600 dark:text-indigo-400"
                                        : isExcluded
                                            ? "text-red-500 line-through decoration-red-500 opacity-70"
                                            : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                                        }`}
                                >
                                    <span className="flex-1 truncate" title={item.value}>{item.value || "<Empty>"}</span>
                                    <span className="ml-2 text-xs text-slate-400 dark:text-slate-600 font-mono flex-shrink-0">{item.count}</span>
                                </button>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onToggle(field, item.value, 'exclude');
                                    }}
                                    className={`ml-1 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600 transition-colors opacity-0 group-hover/item:opacity-100 focus:opacity-100 ${isExcluded ? 'text-red-600 opacity-100' : ''}`}
                                    title="Exclude this value"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clipRule="evenodd" />
                                    </svg>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {isOpen && onShowMore && (
                <button
                    onClick={onShowMore}
                    className="w-full text-left text-xs text-indigo-600 dark:text-indigo-400 hover:underline pl-1 py-1"
                >
                    More {label.endsWith('s') ? `${label}es` : `${label}s`}...
                </button>
            )}
        </div >
    );
};
