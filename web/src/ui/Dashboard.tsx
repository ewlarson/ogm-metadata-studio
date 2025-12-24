import React, { useEffect, useState, useCallback } from "react";
import { Resource } from "../aardvark/model";
import {
    FacetedSearchRequest, facetedSearch, exportFilteredResults,
    SuggestResult
} from "../duckdb/duckdbClient";
import { ProjectConfig } from "../github/client";
import { useUrlState } from "../hooks/useUrlState";
import { useThumbnailQueue } from "../hooks/useThumbnailQueue";
import { useStaticMapQueue } from "../hooks/useStaticMapQueue";
import { ResourceList } from "./ResourceList";
import { AutosuggestInput } from "./AutosuggestInput";
import { ActiveFilterBar } from "./ActiveFilterBar";
import { MapFacet } from "./MapFacet";
import { TimelineFacet } from "./TimelineFacet";
import { ErrorBoundary } from "./ErrorBoundary";

interface DashboardProps {
    project: ProjectConfig | null;
    onEdit: (id: string) => void;
    onCreate: () => void;
}

const FACETS = [
    { field: "gbl_resourceClass_sm", label: "Resource Class", limit: 5 },
    { field: "gbl_resourceType_sm", label: "Resource Type", limit: 5 },
    { field: "dct_spatial_sm", label: "Place", limit: 5 },
    { field: "dct_subject_sm", label: "Subject", limit: 5 },
    { field: "dcat_theme_sm", label: "Theme", limit: 5 },
    { field: "gbl_indexYear_im", label: "Year", limit: 10 },
    { field: "dct_language_sm", label: "Language", limit: 5 },
    { field: "dct_publisher_sm", label: "Publisher", limit: 5 },
    { field: "dct_creator_sm", label: "Creator", limit: 5 },
    { field: "dct_format_s", label: "Format", limit: 5 },
];

export const Dashboard: React.FC<DashboardProps> = ({ project, onEdit, onCreate }) => {
    const [resources, setResources] = useState<Resource[]>([]);
    const [facetsData, setFacetsData] = useState<Record<string, { value: string; count: number }[]>>({});
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);

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
    }

    const [state, setState] = useUrlState<DashboardState>(
        { q: "", page: 1, facets: {}, sort: "relevance", bbox: undefined, yearRange: undefined },
        {
            toUrl: (s) => {
                const params = new URLSearchParams();
                if (s.q) params.set("q", s.q);
                if (s.page > 1) params.set("page", String(s.page));
                if (s.sort && s.sort !== "relevance") params.set("sort", s.sort);
                if (s.bbox) params.set("bbox", s.bbox);
                if (s.yearRange) params.set("yearRange", s.yearRange);
                for (const [key, vals] of Object.entries(s.facets)) {
                    for (const v of vals) {
                        params.append(`f.${key} `, v);
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
                const facets: Record<string, string[]> = {};
                for (const [key, val] of params.entries()) {
                    if (key.startsWith("f.")) {
                        const field = key.substring(2).trim();
                        if (!facets[field]) facets[field] = [];
                        facets[field].push(val);
                    }
                }
                return { q, page, facets, sort, bbox, yearRange };
            },
            cleanup: (params) => {
                params.delete("q");
                params.delete("page");
                params.delete("sort");
                params.delete("bbox");
                params.delete("yearRange");
                const keysToDelete: string[] = [];
                for (const key of params.keys()) {
                    if (key.startsWith("f.")) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(k => params.delete(k));
            }
        }
    );

    const { q, page, facets: selectedFacets } = state;

    // Local input state for debounce
    const [inputValue, setInputValue] = useState(q);

    // Sync input value if URL changes externally
    useEffect(() => {
        setInputValue(q);
    }, [q]);

    // Debounce update to URL
    useEffect(() => {
        const handler = setTimeout(() => {
            if (inputValue !== q) {
                setState(prev => ({ ...prev, q: inputValue, page: 1 }));
            }
        }, 400);
        return () => clearTimeout(handler);
    }, [inputValue, q, setState]);

    const pageSize = 20;

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const filters: Record<string, any> = {};

            // Convert UI Facets state to DSL filters
            for (const [field, values] of Object.entries(selectedFacets)) {
                if (values.length > 0) {
                    filters[field] = { any: values };
                }
            }

            // Add Year Range Filter
            if (state.yearRange) {
                const parts = state.yearRange.split(",").map(Number);
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                    filters['gbl_indexYear_im'] = { gte: parts[0], lte: parts[1] };
                }
            }

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
                facets: FACETS.map(f => ({ field: f.field, limit: f.limit })),
                page: { size: pageSize, from: (page - 1) * pageSize },
                sort: [sortObj],
                bbox
            };

            const res = await facetedSearch(req);
            setResources(res.results);
            setFacetsData(res.facets);
            setTotal(res.total);
        } catch (err) {
            console.error("Dashboard search failed", err);
        } finally {
            setLoading(false);
        }
    }, [q, selectedFacets, page, state.sort, state.bbox, state.yearRange]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const toggleFacet = (field: string, value: string) => {
        setState(prev => {
            const currentFacets = prev.facets[field] || [];
            let newFieldFacets;
            if (currentFacets.includes(value)) {
                newFieldFacets = currentFacets.filter(v => v !== value);
            } else {
                newFieldFacets = [...currentFacets, value];
            }

            // Clean up empty keys
            const newFacets = {
                ...prev.facets,
                [field]: newFieldFacets
            };
            if (newFieldFacets.length === 0) {
                delete newFacets[field];
            }

            return {
                ...prev,
                page: 1,
                facets: newFacets
            };
        });
    };

    const removeQuery = () => setState(s => ({ ...s, q: "", page: 1 }));
    const removeFacet = (field: string, val: string) => toggleFacet(field, val); // Reuse toggle logic
    const clearAll = () => setState(s => ({ ...s, q: "", facets: {}, page: 1 }));

    const handleExport = async (format: 'json' | 'csv') => {
        setIsExporting(true);
        try {
            const filters: Record<string, any> = {};
            for (const [field, values] of Object.entries(selectedFacets)) {
                if (values.length > 0) {
                    filters[field] = { any: values };
                }
            }
            if (currentYearRange) {
                filters['gbl_indexYear_im'] = { gte: currentYearRange[0], lte: currentYearRange[1] };
            }
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

    const handleAutosuggest = (val: string, suggestion?: SuggestResult) => {
        if (suggestion) {
            let field = "";
            switch (suggestion.type) {
                case 'Place': field = 'dct_spatial_sm'; break;
                case 'Subject': field = 'dct_subject_sm'; break;
                case 'Theme': field = 'dcat_theme_sm'; break;
                case 'Publisher': field = 'dct_publisher_sm'; break;
                case 'Creator': field = 'dct_creator_sm'; break;
                // Title and Keyword remain as text search (q)
            }

            if (field) {
                // Apply Facet Filter and CLEAR any existing query text to avoid double filtering
                setState(prev => {
                    const currentFacets = prev.facets[field] || [];
                    if (!currentFacets.includes(suggestion.text)) {
                        return {
                            ...prev,
                            facets: { ...prev.facets, [field]: [...currentFacets, suggestion.text] },
                            q: "", // Clear text to rely on strict facet
                            page: 1
                        };
                    }
                    return { ...prev, q: "", page: 1 }; // Even if already selected, clear text
                });
                return;
            }
        }

        // Default: Text Search
        setState(prev => ({ ...prev, q: val, page: 1 }));
    };

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

                <div className="space-y-6">
                    {FACETS.filter(f => f.field !== 'gbl_indexYear_im').map(f => {
                        const data = facetsData[f.field] || [];
                        if (data.length === 0 && (!selectedFacets[f.field] || selectedFacets[f.field].length === 0)) return null;
                        return (
                            <div key={f.field}>
                                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-300 mb-2">{f.label}</h4>
                                <ul className="space-y-1">
                                    {data.map(item => {
                                        const isChecked = selectedFacets[f.field]?.includes(item.value);
                                        return (
                                            <li key={item.value}>
                                                <div
                                                    onClick={() => toggleFacet(f.field, item.value)}
                                                    className={`flex items-center text-sm cursor-pointer py-0.5 ${isChecked ? "font-bold text-indigo-600 dark:text-indigo-400" : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"}`}
                                                >
                                                    <span className="flex-1 truncate" title={item.value}>{item.value || "<Empty>"}</span>
                                                    <span className="ml-2 text-xs text-slate-400 dark:text-slate-600 font-mono">{item.count}</span>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Main: Results */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Top Bar */}
                <div className="z-10 relative border-b border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 p-4 flex flex-col gap-4 backdrop-blur-sm">
                    {/* Search Input Row */}
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 max-w-2xl relative">
                            <AutosuggestInput
                                value={inputValue}
                                onChange={setInputValue}
                                onSearch={handleAutosuggest}
                                placeholder="Search by keyword, subject, theme..."
                            />
                        </div>
                        <div className="flex items-center gap-4 flex-shrink-0">
                            <span className="text-sm text-slate-500 dark:text-slate-400 hidden sm:inline">
                                Found <span className="text-slate-900 dark:text-white font-medium">{total}</span> results
                            </span>

                            <select
                                value={state.sort || "relevance"}
                                onChange={(e) => setState(prev => ({ ...prev, sort: e.target.value, page: 1 }))}
                                className="text-xs sm:text-sm rounded border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:ring-1 focus:ring-indigo-500 py-1.5 pl-2 pr-8"
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

                {/* Results Grid/List */}
                <div className="flex-1 overflow-y-auto p-4">
                    {loading ? (
                        <div className="flex h-64 items-center justify-center text-slate-500">Loading...</div>
                    ) : resources.length === 0 ? (
                        <div className="flex h-64 items-center justify-center text-slate-500">No results found.</div>
                    ) : (
                        <div className="space-y-4">
                            {resources.map(r => (
                                <div key={r.id} className="group relative grid grid-cols-[1fr] sm:grid-cols-[auto_1fr_auto] gap-4 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4 hover:border-gray-300 dark:hover:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-900/60 transition-colors shadow-sm hover:shadow-md">
                                    {/* Thumbnail */}
                                    <div className="hidden sm:flex w-52 h-52 bg-gray-100 dark:bg-slate-950 rounded border border-gray-200 dark:border-slate-800 items-center justify-center overflow-hidden flex-shrink-0">
                                        {thumbnails[r.id] ? (
                                            <img src={thumbnails[r.id]!} alt="" className="w-full h-full object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} referrerPolicy="no-referrer" />
                                        ) : (
                                            <span className="text-3xl opacity-20 grayscale select-none">
                                                {r.gbl_resourceClass_sm?.includes("Maps") ? "🗺️" : "📄"}
                                            </span>
                                        )}
                                    </div>

                                    {/* Content */}
                                    <div className="min-w-0 flex flex-col justify-between">
                                        <div>
                                            <h3 className="text-lg font-medium text-indigo-600 dark:text-indigo-400 group-hover:text-indigo-700 dark:group-hover:text-indigo-300">
                                                <button onClick={() => onEdit(r.id)} className="text-left focus:outline-none hover:underline">
                                                    {r.dct_title_s || "Untitled"}
                                                </button>
                                            </h3>
                                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 line-clamp-2">
                                                {r.dct_description_sm?.[0] || "No description."}
                                            </p>
                                        </div>
                                        <div className="flex items-center justify-between mt-2 pt-2 border-t border-dashed border-gray-100 dark:border-slate-800">
                                            <div className="flex flex-wrap gap-2">
                                                {r.gbl_resourceClass_sm?.slice(0, 3).map(c => (
                                                    <span key={c} className="inline-flex items-center rounded-sm bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700">
                                                        {c}
                                                    </span>
                                                ))}
                                                {r.schema_provider_s && (
                                                    <span className="inline-flex items-center rounded-sm bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700">
                                                        {r.schema_provider_s}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate max-w-[150px]" title={r.id}>
                                                {r.id}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Static Map & Metadata */}
                                    <div className="w-52 hidden sm:flex flex-col gap-2">
                                        <div className="h-52 w-full bg-gray-100 dark:bg-slate-950 rounded border border-gray-200 dark:border-slate-800 overflow-hidden relative">
                                            {mapUrls[r.id] ? (
                                                <img
                                                    src={mapUrls[r.id]!}
                                                    alt="Location Map"
                                                    className="w-full h-full object-cover opacity-90 hover:opacity-100 transition-opacity"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                                                    No Map
                                                </div>
                                            )}
                                            <div className="absolute top-1 right-1">
                                                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-md bg-white/80 dark:bg-slate-900/80 ${r.dct_accessRights_s === "Public" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
                                                    {r.dct_accessRights_s}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 p-4 flex items-center justify-between">
                        <button
                            disabled={page <= 1}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page - 1 }))}
                            className="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-sm text-slate-700 dark:text-slate-300 disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-slate-700 shadow-sm"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-slate-500 dark:text-slate-400">Page {page} of {totalPages}</span>
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
