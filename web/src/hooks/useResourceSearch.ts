import { useState, useCallback, useMemo, useEffect } from "react";
import { Resource } from "../aardvark/model";
import { FacetedSearchRequest, facetedSearch } from "../duckdb/duckdbClient";
import { useUrlState } from "./useUrlState";

export interface FacetConfig {
    field: string;
    label: string;
    limit: number;
}

export interface SearchState {
    q: string;
    page: number;
    facets: Record<string, string[]>;
    sort: string;
    bbox: string | undefined; // "minX,minY,maxX,maxY"
    yearRange: string | undefined; // "min,max"
    view: 'list' | 'gallery' | 'map';
}

const DEFAULT_STATE: SearchState = {
    q: "",
    page: 1,
    facets: {},
    sort: "relevance",
    bbox: undefined,
    yearRange: undefined,
    view: 'list'
};

export function useResourceSearch(facetsConfig: FacetConfig[], pageSize: number = 20) {
    const [resources, setResources] = useState<Resource[]>([]);
    const [facetsData, setFacetsData] = useState<Record<string, { value: string; count: number }[]>>({});
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    const [state, setState] = useUrlState<SearchState>(
        DEFAULT_STATE,
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
                const view = (viewParam === 'gallery' || viewParam === 'map') ? (viewParam as 'gallery' | 'map') : 'list';

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

                    // Legacy f.field support
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

    const activeFilters = useMemo(() => {
        const filters: Record<string, any> = {};
        for (const [key, values] of Object.entries(state.facets)) {
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
    }, [state.facets, state.yearRange]);

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
                q: state.q,
                filters,
                // Request limit + 1 to detect "More..."
                facets: facetsConfig.map(f => ({ field: f.field, limit: f.limit + 1 })),
                page: { size: pageSize, from: (state.page - 1) * pageSize },
                sort: [sortObj],
                bbox
            };

            const res = await facetedSearch(req);

            if (state.view === 'gallery' && state.page > 1) {
                setResources(prev => [...prev, ...res.results]);
            } else {
                setResources(res.results);
            }

            setFacetsData(res.facets);
            setTotal(res.total);
        } catch (err) {
            console.error("Search failed", err);
        } finally {
            setLoading(false);
        }
    }, [state.q, activeFilters, state.page, state.sort, state.bbox, state.view, facetsConfig, pageSize]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const toggleFacet = useCallback((field: string, value: string, mode: 'include' | 'exclude' = 'include') => {
        const key = mode === 'exclude' ? `-${field}` : field;
        const oppositeKey = mode === 'exclude' ? field : `-${field}`;

        setState(prev => {
            const currentObj = { ...prev.facets };
            const currentVals = currentObj[key] || [];

            let newVals;
            if (currentVals.includes(value)) {
                newVals = currentVals.filter(v => v !== value);
            } else {
                newVals = [...currentVals, value];
            }

            if (newVals.length > 0) currentObj[key] = newVals;
            else delete currentObj[key];

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
    }, [setState]);

    return {
        resources,
        facetsData, // Now typing matches
        total,
        loading,
        state,
        setState,
        activeFilters,
        toggleFacet,
        refresh: fetchData
    };
}
