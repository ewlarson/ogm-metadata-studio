import React, { useEffect, useState, useCallback } from "react";
import { Resource } from "../aardvark/model";
import { facetedSearch, FacetedSearchRequest, exportFilteredResults } from "../duckdb/duckdbClient";
import { ProjectConfig } from "../github/client";
import { useUrlState } from "../hooks/useUrlState";

interface DashboardProps {
    project: ProjectConfig | null;
    onEdit: (id: string) => void;
    onCreate: () => void;
}

const FACETS = [
    { field: "schema_provider_s", label: "Provider" },
    { field: "gbl_resourceClass_sm", label: "Resource Class" },
    { field: "dct_subject_sm", label: "Subject", limit: 30 },
    { field: "gbl_indexYear_im", label: "Year" }, // Treat as discrete text facet for now, or range later?
    { field: "dct_format_s", label: "Format" },
    { field: "dct_accessRights_s", label: "Access Rights" },
];

export const Dashboard: React.FC<DashboardProps> = ({ project, onEdit, onCreate }) => {
    const [resources, setResources] = useState<Resource[]>([]);
    const [facetsData, setFacetsData] = useState<Record<string, { value: string; count: number }[]>>({});
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);

    // URL State Definition
    interface DashboardState {
        q: string;
        page: number;
        facets: Record<string, string[]>;
    }

    const [state, setState] = useUrlState<DashboardState>(
        { q: "", page: 1, facets: {} },
        {
            toUrl: (s) => {
                const params = new URLSearchParams();
                if (s.q) params.set("q", s.q);
                if (s.page > 1) params.set("page", String(s.page));

                // Facets
                for (const [key, vals] of Object.entries(s.facets)) {
                    for (const v of vals) {
                        params.append(`f.${key}`, v);
                    }
                }
                // Preserve other params like 'view'?
                // The hook tries to manage its own params. 
                // We need to merge with existing params in the hook logic, 
                // but here we just produce WHAT WE WANT. 
                // The hook (my implementation above) was naive. 
                // Let's rely on the hook's ability to merge if we improve it, 
                // OR simpler: read existing params in toUrl? No that's circular.

                // For now, let's assume Dashboard takes over params OR explicitly pass 'view' if known.
                // Actually App.tsx manages 'view'. 
                // If we overwrite URLParams, we lose 'view'.
                // We need a smarter hook or just manage all in App.

                return params;
            },
            fromUrl: (params) => {
                const q = params.get("q") || "";
                const page = Number(params.get("page")) || 1;
                const facets: Record<string, string[]> = {};

                for (const [key, val] of params.entries()) {
                    if (key.startsWith("f.")) {
                        const field = key.substring(2);
                        if (!facets[field]) facets[field] = [];
                        facets[field].push(val);
                    }
                }
                return { q, page, facets };
            },
            cleanup: (params) => {
                params.delete("q");
                params.delete("page");
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

    // Sync input value if URL changes externally (popstate)
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
                    // Using "any" logic (OR) for standard facets
                    filters[field] = { any: values };
                }
            }

            const req: FacetedSearchRequest = {
                q: q, // use q from URL state (which is debounced-ish via input)
                filters,
                facets: FACETS.map(f => ({ field: f.field, limit: f.limit })),
                page: { size: pageSize, from: (page - 1) * pageSize },
                sort: [{ field: "dct_title_s", dir: "asc" }]
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
    }, [q, selectedFacets, page]); // Depend on URL state

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Toggle Facet Handler
    const toggleFacet = (field: string, value: string) => {
        setState(prev => {
            const currentFacets = prev.facets[field] || [];
            let newFieldFacets;
            if (currentFacets.includes(value)) {
                newFieldFacets = currentFacets.filter(v => v !== value);
            } else {
                newFieldFacets = [...currentFacets, value];
            }

            return {
                ...prev,
                page: 1, // reset page on filter change
                facets: {
                    ...prev.facets,
                    [field]: newFieldFacets
                }
            };
        });
    };

    const handleExport = async (format: 'json' | 'csv') => {
        setIsExporting(true);
        try {
            const filters: Record<string, any> = {};
            for (const [field, values] of Object.entries(selectedFacets)) {
                if (values.length > 0) {
                    filters[field] = { any: values };
                }
            }

            const req: FacetedSearchRequest = {
                q: q,
                filters,
                facets: [],
                page: { size: 1000, from: 0 },
                sort: []
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

    return (
        <div className="flex bg-slate-900 h-full">
            {/* Sidebar: Facets */}
            <div className="w-64 flex-shrink-0 border-r border-slate-800 p-4 overflow-y-auto">
                <h3 className="text-sm font-semibold text-slate-400 mb-4 uppercase tracking-wider">Refine Results</h3>

                <div className="space-y-6">
                    {FACETS.map(f => {
                        const data = facetsData[f.field] || [];
                        // If we have selected items that are NOT in the list (due to disjunctive or limits), force show them?
                        // Actually disjunctive facets usually show all selected items plus top counts.
                        // For now just show returned data + checked items if missing (DSL handles disjunctive counts correctly).

                        // Check if we have data or if it is selected
                        if (data.length === 0 && (!selectedFacets[f.field] || selectedFacets[f.field].length === 0)) return null;

                        return (
                            <div key={f.field}>
                                <h4 className="text-sm font-medium text-slate-300 mb-2">{f.label}</h4>
                                <ul className="space-y-1">
                                    {data.map(item => {
                                        const isChecked = selectedFacets[f.field]?.includes(item.value);
                                        return (
                                            <li key={item.value}>
                                                <label className="flex items-center text-sm text-slate-400 hover:text-slate-200 cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        className="mr-2 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0 focus:ring-offset-0"
                                                        checked={isChecked}
                                                        onChange={() => toggleFacet(f.field, item.value)}
                                                    />
                                                    <span className="flex-1 truncate" title={item.value}>{item.value || "<Empty>"}</span>
                                                    <span className="ml-2 text-xs text-slate-600 font-mono">{item.count}</span>
                                                </label>
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
                <div className="border-b border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between">
                    <div className="flex-1 max-w-2xl relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            {/* Icon */}
                            <svg className="h-5 w-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </div>
                        <input
                            type="text"
                            className="block w-full rounded-md border border-slate-700 bg-slate-950 pl-10 pr-3 py-2 text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm"
                            placeholder="Search by keyword..."
                            value={inputValue}
                            onChange={e => setInputValue(e.target.value)}
                        />
                    </div>
                    <div className="ml-4 flex items-center gap-4">
                        <span className="text-sm text-slate-400">
                            Found <span className="text-white font-medium">{total}</span> results
                        </span>

                        <div className="flex items-center bg-slate-800 rounded-md p-0.5 border border-slate-700">
                            <button
                                onClick={() => handleExport('json')}
                                disabled={isExporting || total === 0}
                                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                title="Download as Zip of JSON files"
                            >
                                JSON
                            </button>
                            <div className="w-px bg-slate-700 h-4 mx-0.5"></div>
                            <button
                                onClick={() => handleExport('csv')}
                                disabled={isExporting || total === 0}
                                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                title="Download as CSV"
                            >
                                CSV
                            </button>
                        </div>

                        <button
                            onClick={onCreate}
                            className="ml-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                        >
                            Create New
                        </button>
                    </div>
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
                                <div key={r.id} className="group relative flex flex-col sm:flex-row gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4 hover:border-slate-700 hover:bg-slate-900/60 transition-colors">
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-medium text-indigo-400 group-hover:text-indigo-300">
                                            <button onClick={() => onEdit(r.id)} className="text-left focus:outline-none">
                                                {r.dct_title_s || "Untitled"}
                                            </button>
                                        </h3>
                                        <p className="mt-1 text-sm text-slate-400 line-clamp-2">
                                            {r.dct_description_sm?.[0] || "No description."}
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            {r.gbl_resourceClass_sm?.slice(0, 3).map(c => (
                                                <span key={c} className="inline-flex items-center rounded-sm bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300 border border-slate-700">
                                                    {c}
                                                </span>
                                            ))}
                                            {r.schema_provider_s && (
                                                <span className="inline-flex items-center rounded-sm bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300 border border-slate-700">
                                                    {r.schema_provider_s}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex-shrink-0 flex flex-col items-end justify-between gap-2">
                                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${r.dct_accessRights_s === "Public" ? "bg-emerald-900/30 text-emerald-400" : "bg-amber-900/30 text-amber-400"}`}>
                                            {r.dct_accessRights_s}
                                        </span>
                                        <div className="text-xs text-slate-500 font-mono">{r.id}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="border-t border-slate-800 bg-slate-900 p-4 flex items-center justify-between">
                        <button
                            disabled={page <= 1}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page - 1 }))}
                            className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-300 disabled:opacity-50 hover:bg-slate-700"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-slate-400">Page {page} of {totalPages}</span>
                        <button
                            disabled={page >= totalPages}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page + 1 }))}
                            className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-300 disabled:opacity-50 hover:bg-slate-700"
                        >
                            Next
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

