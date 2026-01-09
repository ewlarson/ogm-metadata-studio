import { Resource } from "../aardvark/model";

export interface SearchResult {
    resources: Resource[];
    total: number;
}

export interface FacetedSearchRequest {
    q?: string;
    filters?: Record<string, any>; // { field: { any: [], all: [], none: [], gte: n, lte: n } }
    sort?: { field: string; dir: "asc" | "desc" }[];
    page?: { size: number; from: number };
    facets?: { field: string; limit?: number }[];
    bbox?: { minX: number; minY: number; maxX: number; maxY: number };
    yearRange?: string; // "min,max" - Helper for UI, converted to filters
}

export interface FacetedSearchResponse {
    results: Resource[];
    facets: Record<string, { value: string; count: number }[]>;
    total: number;
}

export interface DistributionResult {
    distributions: any[]; // Joined with resource title
    total: number;
}

export interface SuggestResult {
    text: string;
    type: string;
}

export interface FacetValueRequest {
    field: string;
    q?: string; // Global Search
    filters?: Record<string, any>; // Global Filters
    bbox?: { minX: number; minY: number; maxX: number; maxY: number };
    yearRange?: string; // "min,max"

    facetQuery?: string; // Search within facet values
    sort?: "count_desc" | "count_asc" | "alpha_asc" | "alpha_desc"; // Sort order
    page?: number;
    pageSize?: number;
}

export interface FacetValueResult {
    values: { value: string; count: number }[];
    total: number;
}
