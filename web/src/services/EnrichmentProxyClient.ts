import type { Distribution } from "../aardvark/model";
import type { ProxyModelProfile, ProxyStorageProfile, ProxyVisionProfile, StagedAsset } from "../duckdb/enrichments";
import { safeJsonStringify } from "../duckdb/json";

const DEFAULT_PROXY_URL = (import.meta.env.VITE_ENRICHMENT_PROXY_URL as string | undefined) || "http://localhost:8787";
const CONFIG_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 45_000;
const ENRICHMENT_TIMEOUT_MS = 15 * 60_000;
const LARGE_UPLOAD_TIMEOUT_MS = 60 * 60_000;

export interface ProxyConfig {
    storageProfiles: ProxyStorageProfile[];
    modelProfiles: ProxyModelProfile[];
    visionProfiles: ProxyVisionProfile[];
}

export interface ProxyDerivative {
    id: string;
    kind: string;
    dataUri?: string;
    width?: number;
    height?: number;
    mimeType?: string;
    bytes?: number;
    status: string;
    error?: string;
}

export interface HistoricalMapRunRequest {
    storageProfileId: string;
    modelProfileId: string;
    visionProfileId?: string;
    textExtractionModelProfileId?: string;
    asset: StagedAsset;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    modelParams: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
}

export interface HistoricalMapRunResponse {
    parsedResponse: unknown;
    rawResponse: unknown;
    derivatives: ProxyDerivative[];
    usage?: unknown;
    confidence?: number | null;
}

export interface UploadedImageFilePayload {
    name: string;
    type: string;
    size: number;
    checksum: string;
    base64: string;
    modifiedAt?: string;
}

export interface UploadedPackageFilePayload {
    name: string;
    type: string;
    size: number;
    checksum: string;
    base64: string;
    sourceFileCount?: number;
}

export interface CompanionMetadataPayload {
    name: string;
    type: string;
    size: number;
    text: string;
}

export interface ProcessUploadedImageRequest {
    jobId: string;
    storageProfileId: string;
    modelProfileId: string;
    visionProfileId?: string;
    textExtractionModelProfileId?: string;
    resourceId?: string;
    preserveResourceId?: boolean;
    file: UploadedImageFilePayload;
    checksum: string;
    forceReprocess?: boolean;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    modelParams: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    batchDefaults: Record<string, unknown>;
    metadataDocuments?: CompanionMetadataPayload[];
}

export interface ProcessUploadedImageResponse {
    cached: boolean;
    checksum: string;
    resourceId?: string;
    fileName: string;
    artifacts: {
        originalUrl: string;
        thumbnailUrl: string;
        iiifInfoUrl: string;
        extractionUrl: string;
        aiEnrichmentsUrl?: string;
        aardvarkUrl: string;
        cogUrl?: string;
        archivalSupplementUrl?: string;
        archivalSupplementJsonUrl?: string;
    };
    archivalSupplement?: unknown;
    extraction: unknown;
    rawResponse?: unknown;
    usage?: unknown;
    confidence?: number | null;
    aardvarkJson: Record<string, unknown>;
    distributions: Distribution[];
    aardvarkEvidence?: Array<Record<string, unknown>>;
    derivatives?: ProxyDerivative[];
    proxyMilestones?: Array<{
        at: string;
        elapsed_ms: number;
        label: string;
        detail?: Record<string, unknown>;
    }>;
    iiif?: {
        serviceUrl: string;
        infoUrl: string;
        thumbnailUrl: string;
        width: number;
        height: number;
        tileCount: number;
        scaleFactors: number[];
    };
}

export interface ProcessGeospatialPackageRequest {
    jobId: string;
    storageProfileId: string;
    modelProfileId: string;
    visionProfileId?: string;
    textExtractionModelProfileId?: string;
    resourceId?: string;
    file: UploadedPackageFilePayload;
    checksum: string;
    forceReprocess?: boolean;
    systemPrompt?: string;
    userPrompt?: string;
    model: string;
    modelParams: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    batchDefaults: Record<string, unknown>;
    metadataDocuments?: CompanionMetadataPayload[];
}

export interface CreateGeospatialUploadSessionRequest {
    jobId: string;
    storageProfileId: string;
    modelProfileId: string;
    visionProfileId?: string;
    textExtractionModelProfileId?: string;
    resourceId?: string;
    systemPrompt?: string;
    userPrompt?: string;
    model: string;
    modelParams: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    batchDefaults: Record<string, unknown>;
    metadataDocuments?: CompanionMetadataPayload[];
    forceReprocess?: boolean;
    fileName: string;
}

export interface ProcessGeospatialPackageResponse {
    cached: boolean;
    checksum: string;
    resourceId?: string;
    fileName: string;
    artifacts: {
        originalUrl: string;
        originalPackageUrl?: string;
        manifestUrl: string;
        aardvarkUrl: string;
        aiEnrichmentsUrl?: string;
        iiifInfoUrl?: string;
        extractionUrl?: string;
        geojsonUrl?: string;
        geoParquetUrl?: string;
        pmtilesUrl?: string;
        cogUrl?: string;
        thumbnailUrl?: string;
        archivalSupplementUrl?: string;
        archivalSupplementJsonUrl?: string;
    };
    manifest: unknown;
    archivalSupplement?: unknown;
    rawResponse?: unknown;
    usage?: unknown;
    aardvarkJson: Record<string, unknown>;
    distributions: Distribution[];
    aardvarkEvidence?: Array<Record<string, unknown>>;
    proxyMilestones?: Array<{
        at: string;
        elapsed_ms: number;
        label: string;
        detail?: Record<string, unknown>;
    }>;
}

export interface UploadJobProgressMilestone {
    at: string;
    elapsed_ms: number;
    label: string;
    detail?: Record<string, unknown>;
}

export interface UploadJobProgressResponse {
    jobId: string;
    fileName: string;
    status: "active" | "complete" | "error";
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    error?: string;
    summary?: {
        kind: "crop" | "milestone";
        label: string;
        percent?: number | null;
        provider?: string;
        phase?: string;
        cropCount?: number;
        started?: number;
        completed?: number;
        failed?: number;
        labels?: number;
        claims?: number;
        cacheHits?: number;
    } | null;
    milestones: UploadJobProgressMilestone[];
}

export interface ProcessedS3Resource {
    resourceId: string;
    root: string;
    fileName: string;
    originalKey?: string;
    hasAardvark: boolean;
    hasExtraction: boolean;
    hasAiEnrichments?: boolean;
    hasThumbnail: boolean;
    hasIiif: boolean;
    hasArchivalSupplement?: boolean;
    metadataSourceCount: number;
    updatedAt?: string;
    sizeBytes?: number;
    keys: {
        root: string;
        original: string;
        iiif: string;
        thumbnail: string;
        metadataSources: string;
        extraction: string;
        aiEnrichments?: string;
        archivalSupplement?: string;
        archivalSupplementJson?: string;
        aardvark: string;
    };
    artifacts: {
        originalUrl: string;
        thumbnailUrl: string;
        iiifInfoUrl: string;
        extractionUrl: string;
        aiEnrichmentsUrl?: string;
        archivalSupplementUrl?: string;
        archivalSupplementJsonUrl?: string;
        aardvarkUrl: string;
    };
}

export interface RegenerateAardvarkRequest {
    jobId: string;
    storageProfileId: string;
    modelProfileId: string;
    resource: ProcessedS3Resource;
    model: string;
    modelParams: Record<string, unknown>;
    batchDefaults: Record<string, unknown>;
    metadataDocuments?: CompanionMetadataPayload[];
}

export interface RegenerateAardvarkResponse {
    resourceId: string;
    fileName: string;
    root: string;
    artifacts: ProcessUploadedImageResponse["artifacts"];
    extraction: unknown;
    aardvarkJson: Record<string, unknown>;
    distributions: Distribution[];
    aardvarkEvidence?: Array<Record<string, unknown>>;
    proxyMilestones?: ProcessUploadedImageResponse["proxyMilestones"];
}

export interface RefreshWofConcordanceRequest {
    jobId: string;
    storageProfileId: string;
    resource: ProcessedS3Resource;
}

export interface RefreshWofConcordanceResponse {
    resourceId: string;
    fileName: string;
    root: string;
    artifacts: ProcessUploadedImageResponse["artifacts"];
    aiEnrichmentsUrl?: string;
    createdAiEnrichments?: boolean;
    wofConcordance?: {
        status?: string;
        matched?: number;
        ambiguous?: number;
        unmatched?: number;
        supplementalPlacenames?: number;
        boundarySupplementalPlacenames?: number;
        [key: string]: unknown;
    };
    osmConcordance?: {
        status?: string;
        matched?: number;
        ambiguous?: number;
        unmatched?: number;
        overlapPlacenames?: number;
        supplementalPlacenames?: number;
        [key: string]: unknown;
    };
    geonamesConcordance?: {
        status?: string;
        matched?: number;
        ambiguous?: number;
        unmatched?: number;
        overlapPlacenames?: number;
        supplementalPlacenames?: number;
        directConcordancePlacenames?: number;
        [key: string]: unknown;
    };
    removedSupplementalPlacenameCount?: number;
    aardvarkJson: Record<string, unknown>;
    distributions: Distribution[];
    proxyMilestones?: ProcessUploadedImageResponse["proxyMilestones"];
}

export interface FetchAardvarkFromS3Request {
    storageProfileId: string;
    resource: ProcessedS3Resource;
}

export interface FetchAardvarkFromS3Response {
    resourceId: string;
    fileName: string;
    root: string;
    artifacts: ProcessUploadedImageResponse["artifacts"];
    aardvarkJson: Record<string, unknown>;
    distributions: Distribution[];
}

async function parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
        throw new Error(body?.error || body?.message || `Proxy request failed (${res.status})`);
    }
    return body as T;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = CONFIG_TIMEOUT_MS, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    let canceled = false;
    const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const abortFromExternalSignal = () => {
        canceled = true;
        controller.abort();
    };
    if (externalSignal?.aborted) abortFromExternalSignal();
    else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error: any) {
        if (error?.name === "AbortError") {
            if (canceled && !timedOut) throw new Error("Proxy request canceled.");
            throw new Error(`Proxy request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }
        if (error instanceof TypeError && String(error.message || "").includes("fetch")) {
            throw new Error("Could not reach the enrichment proxy. The proxy may have stopped during processing; restart npm run proxy and check the proxy terminal for the active upload job.");
        }
        throw error;
    } finally {
        window.clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
}

export class EnrichmentProxyClient {
    constructor(private readonly baseUrl = DEFAULT_PROXY_URL) { }

    async getConfig(): Promise<ProxyConfig> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/config`);
        return parseResponse<ProxyConfig>(res);
    }

    async saveConfig(config: ProxyConfig): Promise<ProxyConfig> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/config`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(config),
        });
        return parseResponse<ProxyConfig>(res);
    }

    async testStorageProfile(profileId: string): Promise<{ ok: boolean; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/config/test-storage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        }, SYNC_TIMEOUT_MS);
        return parseResponse(res);
    }

    async testModelProfile(profileId: string): Promise<{ ok: boolean; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/config/test-model`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        });
        return parseResponse(res);
    }

    async testVisionProfile(profileId: string): Promise<{ ok: boolean; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/config/test-vision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        }, SYNC_TIMEOUT_MS);
        return parseResponse(res);
    }

    async syncStorageProfile(profileId: string, signal?: AbortSignal): Promise<{ assets: StagedAsset[]; skipped: number; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/storage/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        }, SYNC_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async runHistoricalMapExtraction(request: HistoricalMapRunRequest, signal?: AbortSignal): Promise<HistoricalMapRunResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/enrich/historical-map`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, LARGE_UPLOAD_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async getUploadJobProgress(jobId: string, signal?: AbortSignal): Promise<UploadJobProgressResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/jobs/${encodeURIComponent(jobId)}/progress`, {}, SYNC_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async processUploadedImage(request: ProcessUploadedImageRequest, signal?: AbortSignal): Promise<ProcessUploadedImageResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/process-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, LARGE_UPLOAD_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async processGeospatialPackage(request: ProcessGeospatialPackageRequest, signal?: AbortSignal): Promise<ProcessGeospatialPackageResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/process-geospatial-package`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, LARGE_UPLOAD_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async createGeospatialUploadSession(request: CreateGeospatialUploadSessionRequest, signal?: AbortSignal): Promise<{ sessionId: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/geospatial-sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, CONFIG_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async uploadGeospatialSessionFile(sessionId: string, pathName: string, file: File, signal?: AbortSignal): Promise<{ path: string; size: number; checksum: string }> {
        const url = new URL(`${this.baseUrl}/api/uploads/geospatial-sessions/${encodeURIComponent(sessionId)}/files`);
        url.searchParams.set("path", pathName);
        if (Number.isFinite(file.lastModified) && file.lastModified > 0) {
            url.searchParams.set("modifiedAt", new Date(file.lastModified).toISOString());
        }
        const res = await fetchWithTimeout(url.toString(), {
            method: "PUT",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
        }, LARGE_UPLOAD_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async completeGeospatialUploadSession(sessionId: string, request: CreateGeospatialUploadSessionRequest, signal?: AbortSignal): Promise<ProcessGeospatialPackageResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/geospatial-sessions/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify({ sessionId, request }),
        }, LARGE_UPLOAD_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async listProcessedS3Resources(storageProfileId: string, signal?: AbortSignal): Promise<{ resources: ProcessedS3Resource[]; count: number; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/processed-resources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify({ storageProfileId }),
        }, SYNC_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async listS3UploadInventory(storageProfileId: string, signal?: AbortSignal): Promise<{ resources: ProcessedS3Resource[]; count: number; message: string }> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/processed-resources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify({ storageProfileId, includeIncomplete: true }),
        }, SYNC_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async regenerateAardvark(request: RegenerateAardvarkRequest, signal?: AbortSignal): Promise<RegenerateAardvarkResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/regenerate-aardvark`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, ENRICHMENT_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async refreshWofConcordance(request: RefreshWofConcordanceRequest, signal?: AbortSignal): Promise<RefreshWofConcordanceResponse> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/refresh-wof-concordance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, ENRICHMENT_TIMEOUT_MS, signal);
        return parseResponse(res);
    }

    async fetchAardvarkFromS3(request: FetchAardvarkFromS3Request, signal?: AbortSignal): Promise<FetchAardvarkFromS3Response> {
        const res = await fetchWithTimeout(`${this.baseUrl}/api/uploads/aardvark-json`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: safeJsonStringify(request),
        }, SYNC_TIMEOUT_MS, signal);
        return parseResponse(res);
    }
}

export const enrichmentProxyClient = new EnrichmentProxyClient();
