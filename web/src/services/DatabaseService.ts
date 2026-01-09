import * as queries from "../duckdb/queries";
import * as mutations from "../duckdb/mutations";
import * as imprt from "../duckdb/import";
import * as exprt from "../duckdb/export";
import * as lifec from "../duckdb/lifecycle";
import { getDuckDbContext } from "../duckdb/dbInit";
import { FacetedSearchRequest, FacetedSearchResponse, SearchResult, SuggestResult, FacetValueRequest, FacetValueResult, DistributionResult } from "../duckdb/types";
import { Resource, Distribution, AardvarkJson } from "../aardvark/model";

export class DatabaseService {

    // Singleton instance access if needed, but we export a const instance below.

    // --- Lifecycle ---
    async init() {
        return getDuckDbContext();
    }

    async save() {
        return lifec.saveDb();
    }

    // --- Queries ---
    async searchResources(page?: number, pageSize?: number, sortBy?: string, sortOrder?: "asc" | "desc", search?: string): Promise<SearchResult> {
        return queries.searchResources(page, pageSize, sortBy, sortOrder, search);
    }

    async facetedSearch(req: FacetedSearchRequest): Promise<FacetedSearchResponse> {
        return queries.facetedSearch(req);
    }

    async queryResourceById(id: string): Promise<Resource | null> {
        return queries.queryResourceById(id);
    }

    async suggest(text: string, limit?: number): Promise<SuggestResult[]> {
        return queries.suggest(text, limit);
    }

    async getDistinctValues(column: string, search?: string, limit?: number): Promise<string[]> {
        return queries.getDistinctValues(column, search, limit);
    }

    async getFacetValues(req: FacetValueRequest): Promise<FacetValueResult> {
        return queries.getFacetValues(req);
    }

    async executeQuery(sql: string): Promise<Record<string, any>[]> {
        return queries.executeQuery(sql);
    }

    async getSearchNeighbors(req: FacetedSearchRequest, currentId: string) {
        return queries.getSearchNeighbors(req, currentId);
    }

    async queryDistributions(page?: number, pageSize?: number, sortBy?: string, sortOrder?: "asc" | "desc", keyword?: string): Promise<DistributionResult> {
        return queries.queryDistributions(page, pageSize, sortBy, sortOrder, keyword);
    }

    async getDistributionsForResource(resourceId: string): Promise<Distribution[]> {
        return queries.getDistributionsForResource(resourceId);
    }

    async countResources(): Promise<number> {
        return queries.countResources();
    }

    // --- Asset Queries ---
    async hasStaticMap(id: string): Promise<boolean> {
        return queries.hasStaticMap(id);
    }

    async getStaticMap(id: string): Promise<string | null> {
        return queries.getStaticMap(id);
    }

    async getThumbnail(id: string): Promise<string | null> {
        return queries.getThumbnail(id);
    }

    // --- Mutations ---
    async upsertResource(resource: Resource) {
        return mutations.upsertResource(resource);
    }

    async deleteResource(id: string) {
        return mutations.deleteResource(id);
    }

    async upsertStaticMap(id: string, blob: Blob) {
        return mutations.upsertStaticMap(id, blob);
    }

    async upsertThumbnail(id: string, blob: Blob) {
        return mutations.upsertThumbnail(id, blob);
    }

    // --- Import / Export ---
    async importJsonData(data: AardvarkJson | AardvarkJson[], options?: { skipSave?: boolean }) {
        return imprt.importJsonData(data, options);
    }

    async importCsv(file: File): Promise<number> {
        const result = await imprt.importCsv(file);
        if (typeof result === 'number') return result;
        return result.count || 0;
    }

    async importDuckDbFile(file: File): Promise<{ success: boolean, message: string, count?: number }> {
        return imprt.importDuckDbFile(file);
    }

    async exportDbBlob(): Promise<Blob | null> {
        return lifec.exportDbBlob();
    }

    async exportAardvarkJsonZip(): Promise<Blob | null> {
        return exprt.exportAardvarkJsonZip();
    }

    async exportFilteredResults(req: FacetedSearchRequest, format: 'json' | 'csv'): Promise<Blob | null> {
        return exprt.exportFilteredResults(req, format);
    }
}

export const databaseService = new DatabaseService();
