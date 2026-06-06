import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
    ensureDefaultEnrichmentData,
    getHistoricalMapDefinition,
    ProxyModelProfile,
    ProxyStorageProfile,
    ProxyVisionProfile,
    syncProxyProfilesToDuckDb,
} from "../../duckdb/duckdbClient";
import {
    enrichmentProxyClient,
    ProcessedS3Resource,
    type ProcessGeospatialPackageResponse,
    type ProcessUploadedImageResponse,
    ProxyConfig,
    type UploadJobProgressResponse,
} from "../../services/EnrichmentProxyClient";
import { DUCKDB_RESTORED_EVENT, DUCKDB_RESTORE_PROGRESS_EVENT, getDuckDbRestoreStatus } from "../../duckdb/dbInit";
import { safeJsonStringify } from "../../duckdb/json";
import { useToast } from "../shared/ToastContext";
import { IiifImageViewer } from "../viewers/IiifImageViewer";
import { normalizeTextExtractionAnnotations } from "../viewers/textExtractionOverlay";
import { withBasePath } from "../../utils/basePath";
import { publishAardvarkResponseToLocalCatalog } from "../../services/processedResourceRecovery";
import {
    basenameFromPath,
    fileDisplayName,
    fileWithRelativePath,
    filesFromDataTransfer,
    filesFromDirectoryHandle,
    relativePathForFile,
    type FileSystemDirectoryHandleLike,
} from "./uploadDirectory";

type Panel = "upload" | "config" | "inventory";
type BusyOperation = "" | "upload" | "regenerate" | "refresh" | "wof";
type EnrichmentPhase = "starting" | "requesting" | "storing" | "completed" | "failed";
type UploadStatus = "queued" | "hashing" | "processing" | "publishing" | "completed" | "cached" | "failed";
type UploadKind = "image" | "geospatial";

const STREAMING_GEOSPATIAL_THRESHOLD_BYTES = 512 * 1024 * 1024;

interface EnrichmentMilestone {
    id: string;
    at: string;
    status: "active" | "done" | "error";
    label: string;
    detail?: string;
}

interface EnrichmentProgress {
    kind: "regeneration" | "refresh" | "wof";
    total: number;
    completed: number;
    failed: number;
    currentIndex: number;
    currentAsset: string;
    phase: EnrichmentPhase;
    phaseProgress: number;
    message: string;
    startedAt: number;
    updatedAt: number;
    finishedAt?: number;
    milestones: EnrichmentMilestone[];
}

interface UploadItem {
    id: string;
    kind: UploadKind;
    file: File;
    files?: File[];
    name: string;
    sourcePath?: string;
    size: number;
    sourceFileCount?: number;
    status: UploadStatus;
    message: string;
    checksum?: string;
    resourceId?: string;
    confidence?: number | null;
    extraction?: unknown;
    artifacts?: {
        originalUrl: string;
        thumbnailUrl?: string;
        iiifInfoUrl?: string;
        extractionUrl?: string;
        aiEnrichmentsUrl?: string;
        manifestUrl?: string;
        aardvarkUrl: string;
        geojsonUrl?: string;
        geoParquetUrl?: string;
        pmtilesUrl?: string;
        cogUrl?: string;
        archivalSupplementUrl?: string;
        archivalSupplementJsonUrl?: string;
    };
    error?: string;
    milestones?: EnrichmentMilestone[];
}

interface MetadataUploadItem {
    id: string;
    file: File;
    name: string;
    sourcePath?: string;
    size: number;
}

interface FolderScanSummaryItem {
    name: string;
    kind: "file" | "directory";
    fileCount: number;
    size: number;
}

interface FolderScanSummary {
    rootName: string;
    totalFiles: number;
    imageCount: number;
    geospatialCount: number;
    metadataCount: number;
    ignoredCount: number;
    topLevelItems: FolderScanSummaryItem[];
}

const blankStorageProfile = (): ProxyStorageProfile => ({
    id: `s3-${crypto.randomUUID()}`,
    name: "New S3 profile",
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "",
    prefixes: [""],
    forcePathStyle: true,
    publicBaseUrl: "",
    metadataIdPrefix: "unr",
    metadataProvider: "",
    accessKeyIdEnv: "AWS_ACCESS_KEY_ID",
    secretAccessKeyEnv: "AWS_SECRET_ACCESS_KEY",
    sessionTokenEnv: "",
});

const blankModelProfile = (): ProxyModelProfile => ({
    id: `openai-${crypto.randomUUID()}`,
    name: "OpenAI profile",
    provider: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    modelParams: {},
});

const blankGeminiModelProfile = (): ProxyModelProfile => ({
    id: `gemini-${crypto.randomUUID()}`,
    name: "Gemini label extraction",
    provider: "gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash",
    modelParams: {},
});

const blankKimiModelProfile = (): ProxyModelProfile => ({
    id: `kimi-${crypto.randomUUID()}`,
    name: "Kimi K2.6 cached map-agent swarm",
    provider: "kimi",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.6",
    modelParams: { thinking: { type: "disabled" } },
});

const blankOpenAIReconciliationProfile = (): ProxyModelProfile => ({
    id: `openai-reconcile-${crypto.randomUUID()}`,
    name: "OpenAI mini label reconciliation",
    provider: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.4-mini",
    modelParams: {},
});

const blankVisionProfile = (): ProxyVisionProfile => ({
    id: `vision-${crypto.randomUUID()}`,
    name: "Google Cloud Vision",
    provider: "google_cloud_vision",
    apiKeyEnv: "GOOGLE_CLOUD_VISION_API_KEY",
    endpoint: "https://vision.googleapis.com/v1/images:annotate",
    featureType: "DOCUMENT_TEXT_DETECTION",
    languageHints: [],
});

const defaultTextReconciliationProfileId = (profiles: ProxyModelProfile[]) => (
    profiles.find((profile) => (profile.provider || "openai") === "openai" && /mini|nano|reconciliation/i.test(`${profile.name} ${profile.defaultModel}`))?.id
    || profiles.find((profile) => profile.provider === "gemini")?.id
    || profiles.find((profile) => profile.provider === "kimi")?.id
    || ""
);

const defaultBatchDefaults = {
    provider: "",
    metadataIdPrefix: "unr",
    publisher: "",
    creator: "",
    accessRights: "Public",
    license: "",
    rights: "",
    rightsHolder: "",
    memberOf: "",
    isPartOf: "",
    language: "eng",
    resourceClass: ["Maps"],
    resourceType: ["Cartographic materials"],
    subjects: [],
    themes: [],
};

function cleanMetadataIdPrefix(value: unknown): string {
    const cleaned = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned || "unr";
}

function defaultBatchDefaultsPayload(storageProfile?: ProxyStorageProfile) {
    return {
        ...defaultBatchDefaults,
        provider: storageProfile?.metadataProvider || defaultBatchDefaults.provider,
        metadataIdPrefix: cleanMetadataIdPrefix(storageProfile?.metadataIdPrefix || defaultBatchDefaults.metadataIdPrefix),
        resourceClass: [...defaultBatchDefaults.resourceClass],
        resourceType: [...defaultBatchDefaults.resourceType],
        subjects: [...defaultBatchDefaults.subjects],
        themes: [...defaultBatchDefaults.themes],
    };
}

function parseJsonField<T>(text: string, fallback: T): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
}

function pretty(value: unknown): string {
    return safeJsonStringify(value, 2);
}

function profileSummary(profile: ProxyStorageProfile): string {
    return [profile.bucket, (profile.prefixes ?? []).filter(Boolean).join(", ")].filter(Boolean).join(" / ") || "Not configured";
}

function normalizeModelParams(model: string, params: Record<string, unknown> = {}): Record<string, unknown> {
    const next = { ...params };
    if (/^gpt-5/i.test(model)) delete next.temperature;
    return next;
}

function formatElapsed(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function checksumArrayBuffer(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isImageUpload(file: File): boolean {
    return file.type.startsWith("image/") || /\.(jpe?g|png|webp|tiff?|jp2|j2k)$/i.test(file.name);
}

function isZipUpload(file: File): boolean {
    return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function isIgnoredArchiveEntryName(name: string): boolean {
    const normalized = name.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const basename = parts[parts.length - 1] || "";
    return parts.includes("__MACOSX") || basename === ".DS_Store" || basename === "Thumbs.db" || basename.startsWith("._");
}

function isShapefileSidecar(file: File): boolean {
    return /\.(shp|shx|dbf|prj|cpg|sbn|sbx|qix)$/i.test(file.name) || /\.shp\.xml$/i.test(file.name);
}

function isGeospatialRasterSource(file: File): boolean {
    return /\.(tiff?|sid|img|jp2|j2k)$/i.test(file.name);
}

function isGeospatialRasterSidecar(file: File): boolean {
    return /\.(tfw|tifw|jgw|j2w|sdw|wld|prj|aux|ovr|rrd|met)$/i.test(file.name)
        || /\.(tif|tiff|sid|img|jp2|j2k|aux)\.xml$/i.test(file.name)
        || /\.(tif|tiff|sid|img|jp2|j2k)\.aux\.xml$/i.test(file.name);
}

function isMetadataUpload(file: File): boolean {
    return file.type.includes("xml") || file.type.startsWith("text/") || /\.(txt|xml|fgdc|iso|met)$/i.test(file.name);
}

function isMetadataEntryName(name: string): boolean {
    return /\.(txt|xml|fgdc|iso|met)$/i.test(name);
}

function metadataContentTypeForName(name: string): string {
    return /\.(xml|fgdc|iso)$/i.test(name) ? "application/xml" : "text/plain";
}

function stripKnownRasterExtension(name: string): string {
    return name
        .replace(/\.(tif|tiff|sid|img|jp2|j2k)\.aux\.xml$/i, "")
        .replace(/\.(tif|tiff|sid|img|jp2|j2k|aux)\.xml$/i, "")
        .replace(/\.(tfw|tifw|jgw|j2w|sdw|wld|prj|aux|ovr|rrd|met)$/i, "")
        .replace(/\.(tiff?|sid|img|jp2|j2k)$/i, "");
}

function shapefileGroupKey(file: File): string {
    const pathName = relativePathForFile(file);
    const directory = pathName.includes("/") ? pathName.slice(0, pathName.lastIndexOf("/") + 1) : "";
    const base = basenameFromPath(pathName).replace(/\.shp\.xml$/i, "").replace(/\.(shp|shx|dbf|prj|cpg|sbn|sbx|qix)$/i, "");
    return `${directory}${base}`.toLowerCase();
}

function geospatialPackageNameFromGroup(files: File[]): string {
    const shp = files.find((file) => /\.shp$/i.test(file.name));
    const base = basenameFromPath(relativePathForFile((shp || files[0])))
        .replace(/\.shp$/i, "")
        .replace(/\.[^.]+$/i, "") || "geospatial_package";
    return `${base}.zip`;
}

function groupShapefileSidecars(files: File[]): File[][] {
    const grouped = new Map<string, File[]>();
    for (const file of files) {
        const key = shapefileGroupKey(file);
        grouped.set(key, [...(grouped.get(key) || []), file]);
    }
    return Array.from(grouped.values()).filter((group) => group.some((file) => /\.shp$/i.test(file.name)));
}

function rasterGroupKey(file: File): string {
    const pathName = relativePathForFile(file);
    const directory = pathName.includes("/") ? pathName.slice(0, pathName.lastIndexOf("/") + 1) : "";
    return `${directory}${stripKnownRasterExtension(basenameFromPath(pathName))}`.toLowerCase();
}

function geospatialRasterPackageNameFromGroup(files: File[]): string {
    const source = files.find(isGeospatialRasterSource) || files[0];
    const base = stripKnownRasterExtension(basenameFromPath(relativePathForFile(source))) || "geospatial_raster";
    return `${base}.zip`;
}

function groupGeospatialRasterFiles(files: File[]): File[][] {
    const grouped = new Map<string, File[]>();
    for (const file of files) {
        const key = rasterGroupKey(file);
        grouped.set(key, [...(grouped.get(key) || []), file]);
    }
    return Array.from(grouped.values()).filter((group) => {
        const sources = group.filter(isGeospatialRasterSource);
        if (sources.length === 0) return false;
        const hasSidecar = group.some((file) => !sources.includes(file));
        return hasSidecar || sources.some((file) => /\.(sid|img)$/i.test(file.name));
    });
}

function archiveHasGeospatialDataset(entryNames: string[]): boolean {
    if (entryNames.some((name) => /\.shp$/i.test(name) && !/\.shp\.xml$/i.test(name))) return true;

    const grouped = new Map<string, string[]>();
    for (const name of entryNames) {
        const normalized = name.replace(/\\/g, "/");
        const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
        const key = `${directory}${stripKnownRasterExtension(basenameFromPath(normalized))}`.toLowerCase();
        grouped.set(key, [...(grouped.get(key) || []), normalized]);
    }

    return Array.from(grouped.values()).some((group) => {
        const sources = group.filter((name) => /\.(tiff?|sid|img|jp2|j2k)$/i.test(name));
        if (sources.length === 0) return false;
        const hasSidecar = group.some((name) => !sources.includes(name));
        return hasSidecar || sources.some((name) => /\.(sid|img)$/i.test(name));
    });
}

async function metadataFilesFromZip(file: File, zip: JSZip): Promise<File[]> {
    const files: File[] = [];
    const zipPath = relativePathForFile(file);
    const entries = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .filter((entry) => !isIgnoredArchiveEntryName(entry.name))
        .filter((entry) => isMetadataEntryName(entry.name));
    for (const entry of entries) {
        const buffer = await entry.async("arraybuffer");
        const name = basenameFromPath(entry.name);
        const metadataFile = new File([buffer], name, { type: metadataContentTypeForName(name) });
        files.push(fileWithRelativePath(metadataFile, `${zipPath}/${entry.name}`));
    }
    return files;
}

async function classifyZipUploads(zipFiles: File[]): Promise<{
    geospatialZipPackages: File[];
    metadataFiles: File[];
    unsupportedZipCount: number;
}> {
    const geospatialZipPackages: File[] = [];
    const metadataFiles: File[] = [];
    let unsupportedZipCount = 0;

    for (const file of zipFiles) {
        try {
            const zip = await JSZip.loadAsync(await file.arrayBuffer());
            const entryNames = Object.values(zip.files)
                .filter((entry) => !entry.dir)
                .map((entry) => entry.name)
                .filter((name) => !isIgnoredArchiveEntryName(name));
            if (archiveHasGeospatialDataset(entryNames)) {
                geospatialZipPackages.push(file);
                continue;
            }
            const extractedMetadata = await metadataFilesFromZip(file, zip);
            if (extractedMetadata.length > 0) {
                metadataFiles.push(...extractedMetadata);
                continue;
            }
            unsupportedZipCount += 1;
        } catch {
            unsupportedZipCount += 1;
        }
    }

    return { geospatialZipPackages, metadataFiles, unsupportedZipCount };
}

function fileStemForMetadataMatch(name: string): string {
    return basenameFromPath(name)
        .replace(/\.(jpe?g|png|webp|tiff?|jp2|j2k)\.(txt|xml|fgdc|iso|met)$/i, "")
        .replace(/\.(txt|xml|fgdc|iso|met)$/i, "")
        .replace(/\.(jpe?g|png|webp|tiff?|jp2|j2k)$/i, "")
        .replace(/\.[^.]+$/, "");
}

function normalizedBaseName(name: string): string {
    return fileStemForMetadataMatch(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedPathStem(name: string): string {
    const normalized = String(name || "").replace(/\\/g, "/");
    const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
    return `${directory}${fileStemForMetadataMatch(name)}`.toLowerCase().replace(/[^a-z0-9/]+/g, "");
}

function isIgnoredFilesystemFile(file: File): boolean {
    const name = basenameFromPath(relativePathForFile(file));
    return name === ".DS_Store" || name === "Thumbs.db" || name.startsWith("._");
}

function commonRootSegment(files: File[]): string {
    const firstSegments = files
        .map((file) => relativePathForFile(file).split("/").filter(Boolean))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0]);
    if (firstSegments.length === 0) return "";
    const first = firstSegments[0];
    return firstSegments.every((segment) => segment === first) ? first : "";
}

function topLevelPartsForPath(pathName: string, rootName: string): string[] {
    const parts = String(pathName || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (rootName && parts[0] === rootName) return parts.slice(1);
    return parts;
}

function normalizedPackageNameForDedupe(name: string): string {
    return basenameFromPath(name)
        .replace(/\.zip$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function zipPackageDedupeKey(file: File, rootName: string): string {
    const parts = topLevelPartsForPath(relativePathForFile(file), rootName);
    return normalizedPackageNameForDedupe(parts[parts.length - 1] || file.name);
}

function expandedGeospatialGroupDedupeKey(files: File[], rootName: string): string {
    const primary = files.find(isGeospatialRasterSource) || files.find((file) => /\.shp$/i.test(file.name)) || files[0];
    const parts = topLevelPartsForPath(relativePathForFile(primary), rootName);
    const packageName = parts.length > 1
        ? parts[0]
        : stripKnownRasterExtension(basenameFromPath(relativePathForFile(primary))).replace(/\.shp$/i, "").replace(/\.[^.]+$/i, "");
    return normalizedPackageNameForDedupe(packageName);
}

function imageDirectoryKey(file: File, rootName: string): string {
    const parts = topLevelPartsForPath(relativePathForFile(file), rootName);
    return parts.length > 1 ? parts.slice(0, -1).join("/").toLowerCase() : "";
}

function imageFamilyStemForDerivativeDedupe(file: File): string {
    return basenameFromPath(relativePathForFile(file))
        .replace(/\.(jpe?g|png|webp|tiff?|jp2|j2k)$/i, "")
        .replace(/[_-]\d+$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function isLikelyAccessDerivativeImage(file: File): boolean {
    return /\.(jpe?g)$/i.test(file.name);
}

function isPreferredSourceImage(file: File): boolean {
    return /\.(tiff?|jp2|j2k)$/i.test(file.name);
}

function derivativeImageDedupeKey(file: File, rootName: string): string {
    return `${imageDirectoryKey(file, rootName)}:${imageFamilyStemForDerivativeDedupe(file)}`;
}

function buildFolderScanSummary(
    files: File[],
    counts: Pick<FolderScanSummary, "imageCount" | "geospatialCount" | "metadataCount" | "ignoredCount">,
): FolderScanSummary | null {
    if (files.length === 0) return null;
    const rootName = commonRootSegment(files) || "Selected files";
    const groups = new Map<string, FolderScanSummaryItem>();
    for (const file of files) {
        const parts = topLevelPartsForPath(relativePathForFile(file), rootName);
        const name = parts[0] || file.name;
        const kind = parts.length > 1 ? "directory" : "file";
        const existing = groups.get(name);
        groups.set(name, {
            name,
            kind: existing?.kind === "directory" || kind === "directory" ? "directory" : "file",
            fileCount: (existing?.fileCount || 0) + 1,
            size: (existing?.size || 0) + file.size,
        });
    }
    return {
        rootName,
        totalFiles: files.length,
        ...counts,
        topLevelItems: Array.from(groups.values()).sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
        }),
    };
}

function resourcePageHref(resourceId: string | undefined): string {
    return resourceId ? withBasePath(`/resources/${encodeURIComponent(resourceId)}`) : "";
}

function metadataSourceGroupName(item: MetadataUploadItem, rootName: string): string {
    const parts = topLevelPartsForPath(item.sourcePath || item.name, rootName);
    return parts[0] || item.name;
}

async function readMetadataPayload(file: File) {
    return {
        name: file.name,
        type: file.type || (file.name.toLowerCase().endsWith(".xml") ? "application/xml" : "text/plain"),
        size: file.size,
        text: await file.text(),
    };
}

async function buildGeospatialPackageBuffer(item: UploadItem): Promise<{ buffer: ArrayBuffer; fileName: string; sourceFileCount: number }> {
    const files = item.files && item.files.length > 0 ? item.files : [item.file];
    if (files.length === 1 && isZipUpload(files[0])) {
        return {
            buffer: await files[0].arrayBuffer(),
            fileName: files[0].name,
            sourceFileCount: 1,
        };
    }
    const zip = new JSZip();
    for (const file of files) {
        const modified = Number.isFinite(file.lastModified) && file.lastModified > 0 ? new Date(file.lastModified) : undefined;
        zip.file(relativePathForFile(file), file, modified ? { date: modified } : undefined);
    }
    const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    return {
        buffer,
        fileName: item.name,
        sourceFileCount: files.length,
    };
}

function shouldStreamGeospatialItem(item: UploadItem): boolean {
    return item.kind === "geospatial"
        && item.size >= STREAMING_GEOSPATIAL_THRESHOLD_BYTES
        && Boolean(item.files && item.files.length > 1);
}

function milestoneTime(date = new Date()): string {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(value?: string | null): string {
    if (!value) return "not synced yet";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timeoutId: number | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutId = window.setTimeout(() => {
                    reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
}

export const EnrichmentWorkbench: React.FC = () => {
    const { addToast } = useToast();
    const inventoryAbortRef = useRef<AbortController | null>(null);
    const runAbortRef = useRef<AbortController | null>(null);
    const uploadAbortRef = useRef<AbortController | null>(null);
    const liveProxyMilestoneKeysRef = useRef<Record<string, Set<string>>>({});
    const directoryInputRef = useRef<HTMLInputElement | null>(null);
    const [activePanel, setActivePanel] = useState<Panel>("upload");
    const [config, setConfig] = useState<ProxyConfig>({ storageProfiles: [], modelProfiles: [], visionProfiles: [] });
    const [selectedStorageId, setSelectedStorageId] = useState("");
    const [selectedModelId, setSelectedModelId] = useState("");
    const [selectedVisionId, setSelectedVisionId] = useState("");
    const [selectedTextExtractionModelId, setSelectedTextExtractionModelId] = useState("");
    const [storageDraft, setStorageDraft] = useState<ProxyStorageProfile>(blankStorageProfile);
    const [modelDraft, setModelDraft] = useState<ProxyModelProfile>(blankModelProfile);
    const [visionDraft, setVisionDraft] = useState<ProxyVisionProfile>(blankVisionProfile);
    const [status, setStatus] = useState("");
    const [busyOperation, setBusyOperation] = useState<BusyOperation>("");
    const [runProgress, setRunProgress] = useState<EnrichmentProgress | null>(null);
    const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
    const [expandedTextReviewId, setExpandedTextReviewId] = useState<string | null>(null);
    const [metadataItems, setMetadataItems] = useState<MetadataUploadItem[]>([]);
    const [folderScanSummary, setFolderScanSummary] = useState<FolderScanSummary | null>(null);
    const [reprocessExistingUploads, setReprocessExistingUploads] = useState(false);
    const [inventoryResources, setInventoryResources] = useState<ProcessedS3Resource[]>([]);
    const [inventoryQuery, setInventoryQuery] = useState("");
    const [inventoryStatus, setInventoryStatus] = useState("");
    const [inventoryLoadedAt, setInventoryLoadedAt] = useState("");
    const [isInventoryLoading, setIsInventoryLoading] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [restoreStatus, setRestoreStatus] = useState(getDuckDbRestoreStatus);

    const selectedStorageProfile = useMemo(
        () => config.storageProfiles.find((profile) => profile.id === selectedStorageId),
        [config.storageProfiles, selectedStorageId],
    );
    const selectedModelProfile = useMemo(
        () => config.modelProfiles.find((profile) => profile.id === selectedModelId && (profile.provider || "openai") === "openai"),
        [config.modelProfiles, selectedModelId],
    );
    const selectedVisionProfile = useMemo(
        () => config.visionProfiles.find((profile) => profile.id === selectedVisionId),
        [config.visionProfiles, selectedVisionId],
    );
    const openAiModelProfiles = useMemo(
        () => config.modelProfiles.filter((profile) => (profile.provider || "openai") === "openai"),
        [config.modelProfiles],
    );
    const textReconciliationModelProfiles = useMemo(
        () => config.modelProfiles.filter((profile) => {
            const provider = profile.provider || "openai";
            return provider === "openai" || provider === "gemini" || provider === "kimi";
        }),
        [config.modelProfiles],
    );
    const selectedTextExtractionModelProfile = useMemo(
        () => config.modelProfiles.find((profile) => {
            const provider = profile.provider || "openai";
            return profile.id === selectedTextExtractionModelId && (provider === "openai" || provider === "gemini" || provider === "kimi");
        }),
        [config.modelProfiles, selectedTextExtractionModelId],
    );
    const inventoryRows = useMemo(() => {
        const query = inventoryQuery.trim().toLowerCase();
        if (!query) return inventoryResources;
        return inventoryResources.filter((resource) => [
            resource.resourceId,
            resource.fileName,
            resource.root,
            resource.originalKey,
        ].some((value) => String(value || "").toLowerCase().includes(query)));
    }, [inventoryQuery, inventoryResources]);
    const inventoryCompleteCount = useMemo(
        () => inventoryResources.filter((resource) => resource.hasAardvark && resource.hasExtraction && resource.hasThumbnail && resource.hasIiif).length,
        [inventoryResources],
    );
    const inventoryMissingCount = Math.max(0, inventoryResources.length - inventoryCompleteCount);
    const processableUploadCount = useMemo(
        () => uploadItems.filter((item) => ["queued", "failed"].includes(item.status)).length,
        [uploadItems],
    );
    const completedUploadCount = useMemo(
        () => uploadItems.filter((item) => item.status === "completed" || item.status === "cached").length,
        [uploadItems],
    );
    const metadataSourceGroups = useMemo(() => {
        const groups = new Map<string, { name: string; fileCount: number; size: number }>();
        const rootName = folderScanSummary?.rootName || "";
        for (const item of metadataItems) {
            const name = metadataSourceGroupName(item, rootName);
            const existing = groups.get(name);
            groups.set(name, {
                name,
                fileCount: (existing?.fileCount || 0) + 1,
                size: (existing?.size || 0) + item.size,
            });
        }
        return Array.from(groups.values()).sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
    }, [folderScanSummary?.rootName, metadataItems]);
    const isBusy = busyOperation !== "";
    const isUploading = busyOperation === "upload";
    const isRegenerating = busyOperation === "regenerate";
    const isRefreshing = busyOperation === "refresh";
    const isRefreshingWof = busyOperation === "wof";
    const isRestoring = restoreStatus.inProgress;
    const restoreLabel = restoreStatus.total > 0
        ? `Restoring local records into DuckDB: ${restoreStatus.processed.toLocaleString()} / ${restoreStatus.total.toLocaleString()}`
        : "Restoring local records into DuckDB.";
    const runProgressPercent = useMemo(() => {
        if (!runProgress?.total) return 0;
        const units = Math.min(runProgress.total, runProgress.completed + runProgress.failed + runProgress.phaseProgress);
        return Math.max(1, Math.min(100, Math.round((units / runProgress.total) * 100)));
    }, [runProgress]);
    const runElapsedLabel = useMemo(() => {
        if (!runProgress) return "0s";
        const end = runProgress.finishedAt ?? Date.now();
        const seconds = Math.max(elapsedSeconds, Math.floor((end - runProgress.startedAt) / 1000));
        return formatElapsed(seconds);
    }, [elapsedSeconds, runProgress]);

    const loadConfig = async () => {
        try {
            const next = await enrichmentProxyClient.getConfig();
            const normalized = { ...next, visionProfiles: next.visionProfiles || [] };
            setConfig(normalized);
            setSelectedStorageId(normalized.storageProfiles[0]?.id || "");
            setSelectedModelId(normalized.modelProfiles.find((profile) => (profile.provider || "openai") === "openai")?.id || normalized.modelProfiles[0]?.id || "");
            setSelectedVisionId(normalized.visionProfiles[0]?.id || "");
            setSelectedTextExtractionModelId(defaultTextReconciliationProfileId(normalized.modelProfiles));
            setStorageDraft(normalized.storageProfiles[0] || blankStorageProfile());
            setModelDraft(normalized.modelProfiles.find((profile) => (profile.provider || "openai") === "openai") || normalized.modelProfiles[0] || blankModelProfile());
            setVisionDraft(normalized.visionProfiles[0] || blankVisionProfile());
            await syncProxyProfilesToDuckDb(normalized.storageProfiles, normalized.modelProfiles);
            setStatus("Connected to enrichment proxy.");
        } catch (error: any) {
            setStatus(`Proxy unavailable: ${error.message}. Start it with npm run proxy from web/.`);
        }
    };

    const refreshS3Inventory = useCallback(async (showToast = true) => {
        if (!selectedStorageId) {
            setInventoryResources([]);
            setInventoryStatus("Choose a storage profile.");
            return;
        }
        inventoryAbortRef.current?.abort();
        const controller = new AbortController();
        inventoryAbortRef.current = controller;
        setIsInventoryLoading(true);
        setInventoryStatus(`Reading ${selectedStorageProfile?.name || "S3 bucket"}...`);
        try {
            const result = await enrichmentProxyClient.listS3UploadInventory(selectedStorageId, controller.signal);
            setInventoryResources(result.resources);
            setInventoryLoadedAt(new Date().toISOString());
            setInventoryStatus(result.message);
            if (showToast) addToast(`Loaded ${result.resources.length} S3 resource(s).`, "success");
        } catch (error: any) {
            if (String(error.message || "").includes("canceled")) {
                setInventoryStatus("Inventory refresh canceled.");
                if (showToast) addToast("Inventory refresh canceled.", "info");
            } else {
                setInventoryStatus(`Inventory refresh failed: ${error.message}`);
                if (showToast) addToast("Inventory refresh failed.", "error");
            }
        } finally {
            if (inventoryAbortRef.current === controller) inventoryAbortRef.current = null;
            setIsInventoryLoading(false);
        }
    }, [addToast, selectedStorageId, selectedStorageProfile?.name]);

    const cancelInventoryRefresh = () => {
        inventoryAbortRef.current?.abort();
        inventoryAbortRef.current = null;
        setIsInventoryLoading(false);
        setInventoryStatus("Inventory refresh canceled.");
    };

    useEffect(() => {
        void loadConfig();
        void ensureDefaultEnrichmentData();
    }, []);

    useEffect(() => {
        const handleRestoreProgress = (event: Event) => {
            const customEvent = event as CustomEvent<typeof restoreStatus>;
            setRestoreStatus(customEvent.detail ?? getDuckDbRestoreStatus());
        };
        const refreshAfterRestore = () => {
            setRestoreStatus(getDuckDbRestoreStatus());
            setStatus("Loaded restored local enrichment data.");
        };
        window.addEventListener(DUCKDB_RESTORE_PROGRESS_EVENT, handleRestoreProgress);
        window.addEventListener(DUCKDB_RESTORED_EVENT, refreshAfterRestore);
        return () => {
            window.removeEventListener(DUCKDB_RESTORE_PROGRESS_EVENT, handleRestoreProgress);
            window.removeEventListener(DUCKDB_RESTORED_EVENT, refreshAfterRestore);
        };
    }, []);

    useEffect(() => {
        if (activePanel === "inventory" && selectedStorageId) void refreshS3Inventory(false);
    }, [activePanel, selectedStorageId, refreshS3Inventory]);

    useEffect(() => {
        const next = config.storageProfiles.find((profile) => profile.id === selectedStorageId);
        if (next) setStorageDraft({ ...next, prefixes: [...(next.prefixes ?? [])] });
    }, [selectedStorageId, config.storageProfiles]);

    useEffect(() => {
        const next = config.modelProfiles.find((profile) => profile.id === selectedModelId);
        if (next) setModelDraft({ ...next, modelParams: { ...(next.modelParams ?? {}) } });
    }, [selectedModelId, config.modelProfiles]);

    useEffect(() => {
        const next = config.visionProfiles.find((profile) => profile.id === selectedVisionId);
        if (next) setVisionDraft({ ...next, languageHints: [...(next.languageHints ?? [])] });
    }, [selectedVisionId, config.visionProfiles]);

    useEffect(() => {
        const startedAt = runProgress?.startedAt;
        if (!startedAt || runProgress?.finishedAt) return;
        const tick = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
        tick();
        const interval = window.setInterval(tick, 1000);
        return () => window.clearInterval(interval);
    }, [runProgress?.startedAt, runProgress?.finishedAt]);

    const startRegenerationProgress = (total: number) => {
        const startedAt = Date.now();
        setElapsedSeconds(0);
        setRunProgress({
            kind: "regeneration",
            total,
            completed: 0,
            failed: 0,
            currentIndex: 0,
            currentAsset: "",
            phase: "starting",
            phaseProgress: 0.02,
            message: `Starting Aardvark regeneration for ${total} S3 resource(s).`,
            startedAt,
            updatedAt: startedAt,
            milestones: [{
                id: crypto.randomUUID(),
                at: milestoneTime(),
                status: "active",
                label: "Regeneration started",
                detail: `${total} processed S3 resource(s) queued for Aardvark regeneration.`,
            }],
        });
    };

    const startS3RefreshProgress = (total: number) => {
        const startedAt = Date.now();
        setElapsedSeconds(0);
        setRunProgress({
            kind: "refresh",
            total,
            completed: 0,
            failed: 0,
            currentIndex: 0,
            currentAsset: "",
            phase: "starting",
            phaseProgress: 0.02,
            message: `Starting local refresh for ${total} S3 resource(s).`,
            startedAt,
            updatedAt: startedAt,
            milestones: [{
                id: crypto.randomUUID(),
                at: milestoneTime(),
                status: "active",
                label: "S3 refresh started",
                detail: `${total} processed S3 resource(s) queued for local DuckDB refresh.`,
            }],
        });
    };

    const startWofRefreshProgress = (total: number) => {
        const startedAt = Date.now();
        setElapsedSeconds(0);
        setRunProgress({
            kind: "wof",
            total,
            completed: 0,
            failed: 0,
            currentIndex: 0,
            currentAsset: "",
            phase: "starting",
            phaseProgress: 0.02,
            message: `Starting gazetteer concordance persistence for ${total} S3 resource(s).`,
            startedAt,
            updatedAt: startedAt,
            milestones: [{
                id: crypto.randomUUID(),
                at: milestoneTime(),
                status: "active",
                label: "Gazetteer persistence started",
                detail: `${total} processed S3 resource(s) queued for WOF/OSM/GeoNames concordance refresh.`,
            }],
        });
    };

    const updateRunProgress = (updates: Partial<EnrichmentProgress>, milestone?: Omit<EnrichmentMilestone, "id" | "at">) => {
        setRunProgress((prev) => {
            if (!prev) return prev;
            const nextMilestones = milestone
                ? [{
                    id: crypto.randomUUID(),
                    at: milestoneTime(),
                    ...milestone,
                }, ...prev.milestones].slice(0, 12)
                : prev.milestones;
            return {
                ...prev,
                ...updates,
                updatedAt: Date.now(),
                milestones: nextMilestones,
            };
        });
    };

    const updateUploadItem = (id: string, updates: Partial<UploadItem>) => {
        setUploadItems((prev) => prev.map((item) => item.id === id ? { ...item, ...updates } : item));
    };

    const appendUploadMilestone = (
        id: string,
        status: EnrichmentMilestone["status"],
        label: string,
        detail?: string,
    ) => {
        const milestone = {
            id: crypto.randomUUID(),
            at: milestoneTime(),
            status,
            label,
            detail,
        };
        setUploadItems((prev) => prev.map((item) => (
            item.id === id
                ? { ...item, milestones: [milestone, ...(item.milestones || [])].slice(0, 20) }
                : item
        )));
        const item = uploadItems.find((candidate) => candidate.id === id);
        console.debug("[Upload pipeline]", { file: item?.name, status, label, detail });
    };

    const appendProxyMilestones = (
        id: string,
        proxyMilestones: Array<{ at: string; elapsed_ms: number; label: string; detail?: Record<string, unknown> }> = [],
    ) => {
        if (proxyMilestones.length === 0) return;
        const seen = liveProxyMilestoneKeysRef.current[id] ?? new Set<string>();
        liveProxyMilestoneKeysRef.current[id] = seen;
        const converted = proxyMilestones.filter((milestone) => {
            const key = `${milestone.at}|${milestone.label}|${safeJsonStringify(milestone.detail || {})}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice().reverse().map((milestone) => {
            const lower = milestone.label.toLowerCase();
            const status: EnrichmentMilestone["status"] = lower.includes("failed") || lower.includes("error")
                ? "error"
                : lower.includes("started") || lower.includes("waiting")
                    ? "active"
                    : "done";
            return {
                id: crypto.randomUUID(),
                at: milestoneTime(new Date(milestone.at)),
                status,
                label: `Proxy: ${milestone.label}`,
                detail: `${formatElapsed(Math.round(milestone.elapsed_ms / 1000))}${milestone.detail ? ` · ${safeJsonStringify(milestone.detail)}` : ""}`,
            };
        });
        if (converted.length === 0) return;
        setUploadItems((prev) => prev.map((item) => (
            item.id === id
                ? { ...item, milestones: [...converted, ...(item.milestones || [])].slice(0, 24) }
                : item
        )));
    };

    const proxyProgressMessage = (progress: UploadJobProgressResponse, elapsedSeconds: number, fallbackDetail: string) => {
        const summary = progress.summary;
        if (summary?.kind === "crop") {
            const extras = [
                typeof summary.labels === "number" ? `${summary.labels.toLocaleString()} labels` : "",
                typeof summary.claims === "number" && summary.claims > 0 ? `${summary.claims.toLocaleString()} claims` : "",
                typeof summary.cacheHits === "number" && summary.cacheHits > 0 ? `${summary.cacheHits.toLocaleString()} cache hit${summary.cacheHits === 1 ? "" : "s"}` : "",
            ].filter(Boolean).join(" · ");
            return `${formatElapsed(elapsedSeconds)} in proxy: ${summary.label}${extras ? ` · ${extras}` : ""}.`;
        }
        const latest = progress.milestones[progress.milestones.length - 1];
        if (latest) {
            return `${formatElapsed(Math.max(elapsedSeconds, Math.round(latest.elapsed_ms / 1000)))} in proxy: ${latest.label}${latest.detail ? ` · ${safeJsonStringify(latest.detail)}` : ""}`;
        }
        return `Still processing in proxy: ${fallbackDetail}`;
    };

    const pollUploadJobProgress = async (
        itemId: string,
        jobId: string,
        elapsedSeconds: number,
        fallbackDetail: string,
        signal: AbortSignal,
    ) => {
        try {
            const progress = await enrichmentProxyClient.getUploadJobProgress(jobId, signal);
            appendProxyMilestones(itemId, progress.milestones);
            updateUploadItem(itemId, { message: proxyProgressMessage(progress, elapsedSeconds, fallbackDetail) });
        } catch (error: any) {
            if (signal.aborted || String(error.message || "").includes("canceled")) return;
            console.debug("[Upload pipeline]", { jobId, phase: "proxy-progress-poll", error: error.message || String(error) });
        }
    };

    const metadataForImage = (item: UploadItem): MetadataUploadItem[] => {
        const imagePathStem = normalizedPathStem(item.sourcePath || item.name);
        const pathMatched = metadataItems.filter((metadata) => normalizedPathStem(metadata.sourcePath || metadata.name) === imagePathStem);
        if (pathMatched.length > 0) return pathMatched;
        const imageBase = normalizedBaseName(item.name);
        const matched = metadataItems.filter((item) => normalizedBaseName(item.name) === imageBase);
        if (matched.length > 0) return matched;
        return metadataItems.length === 1 ? metadataItems : [];
    };

    const addUploadFiles = async (fileList: FileList | File[]) => {
        const originalFiles = Array.from(fileList);
        const ignoredSystemFiles = originalFiles.filter(isIgnoredFilesystemFile).length;
        const incoming = originalFiles.filter((file) => !isIgnoredFilesystemFile(file));
        const rootName = commonRootSegment(incoming);
        const zipClassification = await classifyZipUploads(incoming.filter(isZipUpload));
        const zipPackages = zipClassification.geospatialZipPackages;
        const rasterCandidates = incoming.filter((file) => !isZipUpload(file) && (isGeospatialRasterSource(file) || isGeospatialRasterSidecar(file)));
        const rasterGroups = groupGeospatialRasterFiles(rasterCandidates);
        const groupedRasterFiles = new Set(rasterGroups.flat());
        const shapefileSidecars = incoming.filter((file) => !isZipUpload(file) && !groupedRasterFiles.has(file) && isShapefileSidecar(file));
        const shapefileGroups = groupShapefileSidecars(shapefileSidecars);
        const expandedPackageKeys = new Set(
            [...shapefileGroups, ...rasterGroups]
                .map((group) => expandedGeospatialGroupDedupeKey(group, rootName))
                .filter(Boolean),
        );
        const duplicateZipFiles = new Set(zipPackages.filter((file) => expandedPackageKeys.has(zipPackageDedupeKey(file, rootName))));
        const dedupedZipPackages = zipPackages.filter((file) => !duplicateZipFiles.has(file));
        const duplicateZipCount = zipPackages.length - dedupedZipPackages.length;
        const groupedSidecars = new Set(shapefileGroups.flat());
        const imageCandidates = incoming.filter((file) => !isZipUpload(file) && !groupedRasterFiles.has(file) && !groupedSidecars.has(file) && isImageUpload(file));
        const preferredImageKeys = new Set(
            [...imageCandidates, ...rasterGroups.flat()]
                .filter(isPreferredSourceImage)
                .map((file) => derivativeImageDedupeKey(file, rootName))
                .filter((key) => !key.endsWith(":")),
        );
        const derivativeImageFiles = new Set(
            imageCandidates.filter((file) => isLikelyAccessDerivativeImage(file) && preferredImageKeys.has(derivativeImageDedupeKey(file, rootName))),
        );
        const files = imageCandidates.filter((file) => !derivativeImageFiles.has(file));
        const derivativeImageCount = derivativeImageFiles.size;
        const metadataFiles = [
            ...incoming.filter((file) => !isZipUpload(file) && !groupedRasterFiles.has(file) && !groupedSidecars.has(file) && !imageCandidates.includes(file) && isMetadataUpload(file)),
            ...zipClassification.metadataFiles,
        ];
        const directMetadataFileCount = metadataFiles.length - zipClassification.metadataFiles.length;
        const orphanSidecars = shapefileSidecars.filter((file) => !groupedSidecars.has(file));
        const queuedNonZipFileCount = files.length + derivativeImageCount + rasterGroups.flat().length + shapefileGroups.flat().length + directMetadataFileCount + orphanSidecars.length;
        const nonZipFileCount = incoming.filter((file) => !isZipUpload(file)).length;
        const unsupportedFiles = Math.max(0, nonZipFileCount - queuedNonZipFileCount) + zipClassification.unsupportedZipCount;
        const folderSummary = buildFolderScanSummary(incoming.filter((file) => !duplicateZipFiles.has(file) && !derivativeImageFiles.has(file)), {
            imageCount: files.length,
            geospatialCount: dedupedZipPackages.length + shapefileGroups.length + rasterGroups.length,
            metadataCount: metadataFiles.length,
            ignoredCount: unsupportedFiles + ignoredSystemFiles + duplicateZipCount + derivativeImageCount,
        });
        setFolderScanSummary(folderSummary);
        if (files.length === 0 && metadataFiles.length === 0 && dedupedZipPackages.length === 0 && shapefileGroups.length === 0 && rasterGroups.length === 0) {
            const ignoredText = ignoredSystemFiles + unsupportedFiles + duplicateZipCount + derivativeImageCount > 0 ? ` Ignored ${ignoredSystemFiles + unsupportedFiles + duplicateZipCount + derivativeImageCount} unsupported, duplicate, derivative, or system file(s).` : "";
            addToast(`Choose image files, zipped geospatial packages, shapefile/raster sidecars, or companion metadata files.${ignoredText}`, "info");
            return;
        }
        if (orphanSidecars.length > 0) {
            addToast(`Ignored ${orphanSidecars.length} shapefile sidecar file(s) without a matching .shp.`, "info");
        }
        if (unsupportedFiles > 0 || ignoredSystemFiles > 0) {
            addToast(`Ignored ${unsupportedFiles + ignoredSystemFiles} unsupported or system file(s).`, "info");
        }
        if (duplicateZipCount > 0) {
            addToast(`Skipped ${duplicateZipCount} ZIP package(s) because matching expanded folder(s) were selected.`, "info");
        }
        if (derivativeImageCount > 0) {
            addToast(`Skipped ${derivativeImageCount} JPEG derivative(s) because matching TIFF/JPEG2000 source image(s) were selected.`, "info");
        }
        if (zipClassification.metadataFiles.length > 0) {
            addToast(`Expanded ${zipClassification.metadataFiles.length} companion metadata file(s) from ZIP archives.`, "success");
        }
        if (metadataFiles.length > 0) {
            setMetadataItems((prev) => [
                ...metadataFiles.map((file) => ({
                    id: `metadata-${crypto.randomUUID()}`,
                    file,
                    name: file.name,
                    sourcePath: fileDisplayName(file),
                    size: file.size,
                })),
                ...prev,
            ]);
        }
        const geospatialItems: UploadItem[] = [
            ...dedupedZipPackages.map((file) => ({
                id: `upload-${crypto.randomUUID()}`,
                kind: "geospatial" as const,
                file,
                files: [file],
                name: fileDisplayName(file),
                sourcePath: fileDisplayName(file),
                size: file.size,
                sourceFileCount: 1,
                status: "queued" as UploadStatus,
                message: "Ready to process geospatial package",
                milestones: [{
                    id: crypto.randomUUID(),
                    at: milestoneTime(),
                    status: "active" as const,
                    label: "Queued geospatial package",
                    detail: formatBytes(file.size),
                }],
            })),
            ...shapefileGroups.map((group) => {
                const size = group.reduce((sum, file) => sum + file.size, 0);
                const name = geospatialPackageNameFromGroup(group);
                return {
                    id: `upload-${crypto.randomUUID()}`,
                    kind: "geospatial" as const,
                    file: group[0],
                    files: group,
                    name,
                    sourcePath: relativePathForFile(group[0]),
                    size,
                    sourceFileCount: group.length,
                    status: "queued" as UploadStatus,
                    message: "Ready to zip and process shapefile package",
                    milestones: [{
                        id: crypto.randomUUID(),
                        at: milestoneTime(),
                        status: "active" as const,
                        label: "Queued shapefile sidecars",
                        detail: `${group.length} file(s), ${formatBytes(size)}`,
                    }],
                };
            }),
            ...rasterGroups.map((group) => {
                const size = group.reduce((sum, file) => sum + file.size, 0);
                const name = geospatialRasterPackageNameFromGroup(group);
                return {
                    id: `upload-${crypto.randomUUID()}`,
                    kind: "geospatial" as const,
                    file: group.find(isGeospatialRasterSource) || group[0],
                    files: group,
                    name,
                    sourcePath: relativePathForFile(group.find(isGeospatialRasterSource) || group[0]),
                    size,
                    sourceFileCount: group.length,
                    status: "queued" as UploadStatus,
                    message: "Ready to package and process geospatial raster",
                    milestones: [{
                        id: crypto.randomUUID(),
                        at: milestoneTime(),
                        status: "active" as const,
                        label: "Queued geospatial raster",
                        detail: `${group.length} file(s), ${formatBytes(size)}`,
                    }],
                };
            }),
        ];
        if (files.length > 0 || geospatialItems.length > 0) {
            setUploadItems((prev) => [
                ...geospatialItems,
                ...files.map((file) => ({
                    id: `upload-${crypto.randomUUID()}`,
                    kind: "image" as const,
                    file,
                    files: [file],
                    name: fileDisplayName(file),
                    sourcePath: fileDisplayName(file),
                    size: file.size,
                    status: "queued" as UploadStatus,
                    message: "Ready to process",
                    milestones: [{
                        id: crypto.randomUUID(),
                        at: milestoneTime(),
                        status: "active" as const,
                        label: "Queued",
                        detail: formatBytes(file.size),
                    }],
                })),
                ...prev,
            ]);
        }
        setActivePanel("upload");
        setStatus(`${files.length} image file(s), ${geospatialItems.length} geospatial package(s), and ${metadataFiles.length} companion metadata file(s) queued.`);
    };

    const handleChooseUploadDirectory = async () => {
        const picker = (window as Window & {
            showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandleLike>;
        }).showDirectoryPicker;
        if (typeof picker !== "function") {
            directoryInputRef.current?.click();
            return;
        }

        try {
            const directory = await picker({ mode: "read" });
            setStatus(`Walking ${directory.name}...`);
            const files = await filesFromDirectoryHandle(directory);
            if (files.length === 0) {
                setStatus(`${directory.name} did not contain any files.`);
                addToast("Selected folder did not contain any files.", "info");
                return;
            }
            await addUploadFiles(files);
        } catch (error: any) {
            if (error?.name === "AbortError") return;
            setStatus(`Folder scan failed: ${error.message || String(error)}`);
            addToast("Folder scan failed.", "error");
        }
    };

    const handleUploadDrop = async (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const transfer = event.dataTransfer;
        try {
            setStatus("Walking dropped files...");
            await addUploadFiles(await filesFromDataTransfer(transfer));
        } catch (error: any) {
            setStatus(`Drop scan failed: ${error.message || String(error)}`);
            addToast("Drop scan failed.", "error");
        }
    };

    const removeUploadItem = (id: string) => {
        setUploadItems((prev) => prev.filter((item) => item.id !== id));
        setExpandedTextReviewId((current) => current === id ? null : current);
    };

    const removeMetadataItem = (id: string) => {
        setMetadataItems((prev) => prev.filter((item) => item.id !== id));
    };

    const clearFinishedUploads = () => {
        setUploadItems((prev) => prev.filter((item) => item.status !== "completed" && item.status !== "cached"));
        setExpandedTextReviewId(null);
    };

    const cancelUpload = () => {
        uploadAbortRef.current?.abort();
        uploadAbortRef.current = null;
        setBusyOperation("");
        setStatus("Upload processing canceled. Completed resources remain published.");
        setUploadItems((prev) => prev.map((item) => (
            item.status === "hashing" || item.status === "processing" || item.status === "publishing"
                ? { ...item, status: "failed", message: "Canceled", error: "Upload processing canceled." }
                : item
        )));
    };

    const processUploads = async () => {
        if (isRestoring) {
            setStatus(`${restoreLabel}. Upload processing is available when restore finishes.`);
            addToast("Wait for local DuckDB restore to finish before processing uploads.", "info");
            return;
        }
        if (!selectedStorageProfile || !selectedModelProfile) {
            addToast("Choose storage and OpenAI profiles before uploading.", "info");
            return;
        }
        const queued = uploadItems.filter((item) => item.status === "queued" || item.status === "failed");
        if (queued.length === 0) {
            addToast("Queue one or more image files or geospatial packages first.", "info");
            return;
        }

        uploadAbortRef.current?.abort();
        const controller = new AbortController();
        uploadAbortRef.current = controller;
        setBusyOperation("upload");
        setStatus(`Processing ${queued.length} uploaded item(s).`);

        try {
            const needsHistoricalMapPrompt = queued.some((item) => item.kind === "image" || item.kind === "geospatial");
            const historicalMapPrompt = needsHistoricalMapPrompt
                ? await withTimeout(
                    getHistoricalMapDefinition(),
                    "Loading historical map prompt",
                    15_000,
                )
                : null;
            const outputSchema = historicalMapPrompt ? JSON.parse(historicalMapPrompt.definition.output_schema_json) : {};
            type HistoricalPromptPayload = {
                visionProfileId?: string;
                textExtractionModelProfileId?: string;
                systemPrompt: string;
                userPrompt: string;
                outputSchema: Record<string, unknown>;
            };
            const promptPayloadFor = (assetId: string, fileName: string, required: boolean): Partial<HistoricalPromptPayload> => {
                const promptVersion = historicalMapPrompt?.promptVersion;
                if (!promptVersion) {
                    if (required) throw new Error("Historical map prompt was not loaded.");
                    return {};
                }
                return {
                    visionProfileId: selectedVisionProfile?.id,
                    textExtractionModelProfileId: selectedVisionProfile ? selectedTextExtractionModelProfile?.id : undefined,
                    systemPrompt: String(promptVersion.system_prompt || ""),
                    userPrompt: String(promptVersion.user_prompt_template || "")
                        .replaceAll("{{asset_id}}", assetId)
                        .replaceAll("{{file_name}}", fileName),
                    outputSchema,
                };
            };
            const modelParams = normalizeModelParams(selectedModelProfile.defaultModel, selectedModelProfile.modelParams ?? {});
            const batchDefaults = defaultBatchDefaultsPayload(selectedStorageProfile);
            const textProvider = selectedTextExtractionModelProfile?.provider || "openai";
            const textExtractorLabel = selectedTextExtractionModelProfile
                ? ` + ${textProvider === "gemini" ? "Gemini" : textProvider === "kimi" ? "Kimi" : "OpenAI"} ${selectedTextExtractionModelProfile.defaultModel} label reconciliation`
                : "";
            const ocrEngineLabel = selectedVisionProfile
                ? `Google Cloud Vision ${selectedVisionProfile.featureType || "DOCUMENT_TEXT_DETECTION"}${textExtractorLabel || " + OpenAI vision augmentation"}`
                : "OpenAI vision extraction";
            let published = 0;
            let failed = 0;

            for (let index = 0; index < queued.length; index++) {
                const item = queued[index];
                try {
                    if (controller.signal.aborted) throw new Error("Upload processing canceled.");

                    setStatus(`Processing ${index + 1} / ${queued.length}: ${item.name}`);
                    const jobId = `upload-${crypto.randomUUID()}`;
                    appendUploadMilestone(item.id, "active", "Proxy request started", `Job ${jobId}. Watch the proxy terminal for [upload:${jobId}] logs.`);
                    const companionMetadata = item.kind === "image" ? metadataForImage(item) : [];
                    const metadataDocuments = await Promise.all(companionMetadata.map((metadata) => readMetadataPayload(metadata.file)));
                    if (metadataDocuments.length > 0) appendUploadMilestone(item.id, "done", "Companion metadata attached", metadataDocuments.map((document) => document.name).join(", "));

                    let response: ProcessUploadedImageResponse | ProcessGeospatialPackageResponse;
                    if (shouldStreamGeospatialItem(item)) {
                        const sourceFiles = item.files && item.files.length > 0 ? item.files : [item.file];
                        updateUploadItem(item.id, {
                            status: "processing",
                            message: `Streaming ${sourceFiles.length} large source file(s) to the proxy for packaging`,
                            error: undefined,
                        });
                        appendUploadMilestone(item.id, "active", "Streaming to proxy", "Large expanded geospatial packages are packaged by the proxy to avoid browser memory limits.");
                        let heartbeatCount = 0;
                        let streamingPhase = "streaming files to the proxy";
                        const heartbeat = window.setInterval(() => {
                            heartbeatCount += 1;
                            const elapsed = heartbeatCount * 20;
                            const detail = `${formatElapsed(elapsed)} while ${streamingPhase}. Large geospatial packages may spend most of their time in upload, ZIP packaging, S3 multipart upload, or COG generation.`;
                            updateUploadItem(item.id, { message: `Still processing in proxy: ${detail}` });
                            console.debug("[Upload pipeline]", { file: item.name, jobId, elapsedSeconds: elapsed, phase: "large-geospatial-stream" });
                            if (heartbeatCount % 3 === 0) appendUploadMilestone(item.id, "active", "Still waiting on proxy", detail);
                        }, 20_000);
                        try {
                            const session = await enrichmentProxyClient.createGeospatialUploadSession({
                                jobId,
                                storageProfileId: selectedStorageProfile.id,
                                modelProfileId: selectedModelProfile.id,
                                ...promptPayloadFor(jobId, item.name, false),
                                model: selectedModelProfile.defaultModel,
                                modelParams,
                                batchDefaults,
                                forceReprocess: reprocessExistingUploads,
                                fileName: item.name,
                            }, controller.signal);
                            for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
                                const sourceFile = sourceFiles[fileIndex];
                                const pathName = relativePathForFile(sourceFile);
                                streamingPhase = `streaming ${fileIndex + 1} / ${sourceFiles.length}: ${pathName}`;
                                updateUploadItem(item.id, { message: streamingPhase });
                                const uploaded = await enrichmentProxyClient.uploadGeospatialSessionFile(session.sessionId, pathName, sourceFile, controller.signal);
                                appendUploadMilestone(item.id, "done", "Streamed file", `${uploaded.path} · ${formatBytes(uploaded.size)} · sha256:${uploaded.checksum}`);
                            }
                            streamingPhase = "proxy-side ZIP packaging, checksumming, S3 upload, and derivative generation";
                            appendUploadMilestone(item.id, "active", "Proxy packaging started", "The proxy is creating the ZIP payload, computing checksums, uploading to S3, and generating derivatives.");
                            response = await enrichmentProxyClient.completeGeospatialUploadSession(session.sessionId, {
                                jobId,
                                storageProfileId: selectedStorageProfile.id,
                                modelProfileId: selectedModelProfile.id,
                                ...promptPayloadFor(jobId, item.name, false),
                                model: selectedModelProfile.defaultModel,
                                modelParams,
                                batchDefaults,
                                forceReprocess: reprocessExistingUploads,
                                fileName: item.name,
                            }, controller.signal);
                            updateUploadItem(item.id, { checksum: response.checksum });
                        } finally {
                            window.clearInterval(heartbeat);
                        }
                    } else {
                        updateUploadItem(item.id, { status: "hashing", message: item.kind === "geospatial" ? "Preparing package and calculating SHA-256 checksum" : "Calculating SHA-256 checksum" });
                        appendUploadMilestone(item.id, "active", item.kind === "geospatial" ? "Packaging" : "Hashing", item.kind === "geospatial" ? "Building one ZIP payload for the geospatial package." : "Calculating SHA-256 checksum in the browser.");
                        const packagePayload = item.kind === "geospatial"
                            ? await buildGeospatialPackageBuffer(item)
                            : { buffer: await item.file.arrayBuffer(), fileName: item.file.name, sourceFileCount: 1 };
                        const buffer = packagePayload.buffer;
                        const checksum = await checksumArrayBuffer(buffer);
                        appendUploadMilestone(item.id, "done", "Checksum ready", `sha256:${checksum}`);
                        if (controller.signal.aborted) throw new Error("Upload processing canceled.");

                        updateUploadItem(item.id, {
                            checksum,
                            status: "processing",
                            message: item.kind === "geospatial"
                                ? "Uploading package, analyzing GIS metadata, and creating vector derivatives"
                                : `Uploading original, building IIIF tiles, and extracting text with ${ocrEngineLabel}`,
                            error: undefined,
                        });
                        let heartbeatCount = 0;
                        let progressPollInFlight = false;
                        const heartbeat = window.setInterval(() => {
                            heartbeatCount += 1;
                            const elapsed = heartbeatCount * 5;
                            const detail = item.kind === "geospatial"
                                ? `${formatElapsed(elapsed)} waiting on proxy. The active step may be S3 upload, shapefile analysis, derivative generation, or Aardvark writing.`
                                : `${formatElapsed(elapsed)} waiting on proxy. The active step may be S3 upload, IIIF tile generation, or ${selectedVisionProfile ? selectedTextExtractionModelProfile ? "Google Vision OCR / label reconciliation" : "Google Vision OCR" : "OpenAI extraction"}.`;
                            if (!progressPollInFlight) {
                                progressPollInFlight = true;
                                void pollUploadJobProgress(item.id, jobId, elapsed, detail, controller.signal)
                                    .finally(() => { progressPollInFlight = false; });
                            } else if (heartbeatCount % 4 === 0) {
                                updateUploadItem(item.id, {
                                    message: `Still processing in proxy: ${detail}`,
                                });
                            }
                            console.debug("[Upload pipeline]", { file: item.name, jobId, elapsedSeconds: elapsed, phase: "proxy-wait" });
                            if (heartbeatCount % 12 === 0) {
                                appendUploadMilestone(item.id, "active", "Still waiting on proxy", detail);
                            }
                        }, 5_000);
                        try {
                            if (item.kind === "geospatial") {
                                response = await enrichmentProxyClient.processGeospatialPackage({
                                    jobId,
                                    storageProfileId: selectedStorageProfile.id,
                                    modelProfileId: selectedModelProfile.id,
                                    ...promptPayloadFor(checksum, packagePayload.fileName, false),
                                    file: {
                                        name: packagePayload.fileName,
                                        type: "application/zip",
                                        size: buffer.byteLength,
                                        checksum,
                                        base64: base64FromArrayBuffer(buffer),
                                        sourceFileCount: packagePayload.sourceFileCount,
                                    },
                                    checksum,
                                    forceReprocess: reprocessExistingUploads,
                                    model: selectedModelProfile.defaultModel,
                                    modelParams,
                                    outputSchema,
                                    batchDefaults,
                                }, controller.signal);
                            } else {
                                const imagePromptPayload = promptPayloadFor(checksum, item.file.name, true) as HistoricalPromptPayload;
                                response = await enrichmentProxyClient.processUploadedImage({
                                    jobId,
                                    storageProfileId: selectedStorageProfile.id,
                                    modelProfileId: selectedModelProfile.id,
                                    ...imagePromptPayload,
                                    file: {
                                        name: item.file.name,
                                        type: item.file.type,
                                        size: item.file.size,
                                        checksum,
                                        base64: base64FromArrayBuffer(buffer),
                                        modifiedAt: Number.isFinite(item.file.lastModified) && item.file.lastModified > 0 ? new Date(item.file.lastModified).toISOString() : undefined,
                                    },
                                    checksum,
                                    forceReprocess: reprocessExistingUploads,
                                    model: selectedModelProfile.defaultModel,
                                    modelParams,
                                    batchDefaults,
                                    metadataDocuments,
                                }, controller.signal);
                            }
                        } finally {
                            window.clearInterval(heartbeat);
                        }
                    }
                    appendProxyMilestones(item.id, response.proxyMilestones);
                    appendUploadMilestone(item.id, "done", "Proxy response received", item.kind === "geospatial" ? "Geospatial artifacts and Aardvark JSON returned." : response.cached ? "Existing S3 artifacts reused." : "S3 artifacts and extraction response returned.");
                    if (controller.signal.aborted) throw new Error("Upload processing canceled.");

                    updateUploadItem(item.id, { status: "publishing", message: "Publishing Aardvark metadata into DuckDB" });
                    appendUploadMilestone(item.id, "active", "Local catalog publish started", "Upserting resource rows and saving the restore overlay.");
                    const { resource } = await withTimeout(
                        publishAardvarkResponseToLocalCatalog(response, { label: item.name }),
                        `Publishing ${item.name}`,
                        30_000,
                    );
                    published += 1;
                    appendUploadMilestone(item.id, "done", "Local catalog save verified", `${resource.id} read back from DuckDB and IndexedDB.`);
                    const responseConfidence = "confidence" in response ? response.confidence : undefined;
                    const responseReviewPayload = item.kind === "geospatial"
                        ? ("manifest" in response ? response.manifest : undefined)
                        : ("extraction" in response ? response.extraction : undefined);

                    updateUploadItem(item.id, {
                        status: response.cached ? "cached" : "completed",
                        message: response.cached ? "Already processed; local DuckDB record refreshed" : "Processed and published",
                        resourceId: resource.id,
                        confidence: responseConfidence,
                        extraction: responseReviewPayload,
                        artifacts: response.artifacts,
                        error: undefined,
                    });
                    if (item.kind === "image") setExpandedTextReviewId(item.id);
                } catch (error: any) {
                    if (String(error.message || "").includes("canceled")) throw error;
                    failed += 1;
                    appendUploadMilestone(item.id, "error", "Upload failed", error.message || String(error));
                    updateUploadItem(item.id, {
                        status: "failed",
                        message: "Failed",
                        error: error.message || String(error),
                    });
                }
            }

            await ensureDefaultEnrichmentData();
            setStatus(`Upload workflow complete: ${published} resource(s) published${failed > 0 ? `, ${failed} failed` : ""}.`);
            addToast(failed > 0 ? `Published ${published}; ${failed} failed.` : `Published ${published} uploaded resource(s).`, failed > 0 ? "error" : "success");
        } catch (error: any) {
            if (String(error.message || "").includes("canceled")) {
                setStatus("Upload processing canceled.");
                addToast("Upload processing canceled.", "info");
            } else {
                setStatus(`Upload processing failed: ${error.message}`);
                setUploadItems((prev) => prev.map((item) => (
                    item.status === "hashing" || item.status === "processing" || item.status === "publishing"
                        ? { ...item, status: "failed", message: "Failed", error: error.message }
                        : item
                )));
                addToast("Upload processing failed.", "error");
            }
        } finally {
            if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
            setBusyOperation("");
        }
    };

    const regenerateAardvarkFromS3 = async () => {
        if (isRestoring) {
            setStatus(`${restoreLabel}. Aardvark regeneration is available when restore finishes.`);
            addToast("Wait for local DuckDB restore to finish before regenerating Aardvark.", "info");
            return;
        }
        if (!selectedStorageProfile || !selectedModelProfile) {
            addToast("Choose storage and OpenAI profiles before regenerating Aardvark.", "info");
            return;
        }

        runAbortRef.current?.abort();
        const controller = new AbortController();
        runAbortRef.current = controller;
        setBusyOperation("regenerate");
        setStatus(`Scanning ${selectedStorageProfile.name} for processed S3 resources...`);
        setRunProgress(null);

        try {
            const discovered = await enrichmentProxyClient.listProcessedS3Resources(selectedStorageProfile.id, controller.signal);
            const resources = discovered.resources;
            if (controller.signal.aborted) throw new Error("Aardvark regeneration canceled.");
            if (resources.length === 0) {
                setStatus("No processed S3 resources with Aardvark and extraction JSON were found.");
                addToast("No processed S3 resources found.", "info");
                return;
            }

            startRegenerationProgress(resources.length);
            const modelParams = normalizeModelParams(selectedModelProfile.defaultModel, selectedModelProfile.modelParams ?? {});
            const batchDefaults = defaultBatchDefaultsPayload(selectedStorageProfile);
            let published = 0;
            let failed = 0;

            for (let index = 0; index < resources.length; index++) {
                const s3Resource = resources[index];
                const name = s3Resource.fileName || s3Resource.resourceId;
                if (controller.signal.aborted) throw new Error("Aardvark regeneration canceled.");
                setStatus(`Regenerating ${index + 1} / ${resources.length}: ${name}`);
                updateRunProgress({
                    currentIndex: index,
                    currentAsset: name,
                    phase: "requesting",
                    phaseProgress: 0.35,
                    message: `Regenerating Aardvark for ${name}. Reading S3 artifacts and waiting on the metadata writer.`,
                }, {
                    status: "active",
                    label: `Regenerating ${name}`,
                    detail: s3Resource.root,
                });

                try {
                    const jobId = `regen-${crypto.randomUUID()}`;
                    let heartbeatCount = 0;
                    const heartbeat = window.setInterval(() => {
                        heartbeatCount += 1;
                        const waitSeconds = heartbeatCount * 20;
                        updateRunProgress({
                            phase: "requesting",
                            phaseProgress: Math.min(0.78, 0.35 + heartbeatCount * 0.05),
                            message: `Still regenerating Aardvark for ${name}. ${formatElapsed(waitSeconds)} elapsed in this request.`,
                        }, heartbeatCount % 3 === 0 ? {
                            status: "active",
                            label: "Still waiting on metadata writer",
                            detail: `${name} has been in regeneration for ${formatElapsed(waitSeconds)}.`,
                        } : undefined);
                    }, 20_000);
                    let response;
                    try {
                        response = await enrichmentProxyClient.regenerateAardvark({
                            jobId,
                            storageProfileId: selectedStorageProfile.id,
                            modelProfileId: selectedModelProfile.id,
                            resource: s3Resource,
                            model: selectedModelProfile.defaultModel,
                            modelParams,
                            batchDefaults,
                        }, controller.signal);
                    } finally {
                        window.clearInterval(heartbeat);
                    }
                    if (controller.signal.aborted) throw new Error("Aardvark regeneration canceled.");

                    updateRunProgress({
                        phase: "storing",
                        phaseProgress: 0.82,
                        message: `Publishing regenerated Aardvark for ${name} into DuckDB.`,
                    }, {
                        status: "done",
                        label: "Regenerated Aardvark JSON",
                        detail: response.resourceId,
                    });

                    const { resource } = await withTimeout(
                        publishAardvarkResponseToLocalCatalog(response, { label: name }),
                        `Publishing ${name}`,
                        30_000,
                    );
                    published += 1;
                    updateRunProgress({
                        completed: published,
                        currentIndex: index + 1,
                        phase: "completed",
                        phaseProgress: 0,
                        message: `Regenerated and published ${published} of ${resources.length} resource(s).`,
                    }, {
                        status: "done",
                        label: `Published ${resource.id}`,
                        detail: `${resource.dct_title_s || name} saved to DuckDB and IndexedDB.`,
                    });
                } catch (error: any) {
                    if (String(error.message || "").includes("canceled")) throw error;
                    failed += 1;
                    updateRunProgress({
                        failed,
                        currentIndex: index + 1,
                        phase: "failed",
                        phaseProgress: 0,
                        message: `Aardvark regeneration failed for ${name}: ${error.message}`,
                    }, {
                        status: "error",
                        label: `Failed ${name}`,
                        detail: error.message,
                    });
                }
            }

            if (activePanel === "inventory") void refreshS3Inventory(false);
            setStatus(`Aardvark regeneration complete: ${published} published${failed > 0 ? `, ${failed} failed` : ""}.`);
            updateRunProgress({
                phase: failed > 0 ? "failed" : "completed",
                phaseProgress: 0,
                completed: published,
                failed,
                message: `Aardvark regeneration complete: ${published} published, ${failed} failed.`,
                finishedAt: Date.now(),
            }, {
                status: failed > 0 ? "error" : "done",
                label: "Regeneration complete",
                detail: `${published} published, ${failed} failed.`,
            });
            addToast(failed > 0 ? `Regenerated ${published}; ${failed} failed.` : `Regenerated ${published} Aardvark record(s).`, failed > 0 ? "error" : "success");
        } catch (error: any) {
            if (String(error.message || "").includes("canceled")) {
                setStatus("Aardvark regeneration canceled.");
                addToast("Aardvark regeneration canceled.", "info");
            } else {
                setStatus(`Aardvark regeneration failed: ${error.message}`);
                updateRunProgress({
                    phase: "failed",
                    phaseProgress: 0,
                    message: `Aardvark regeneration failed: ${error.message}`,
                    finishedAt: Date.now(),
                }, {
                    status: "error",
                    label: "Regeneration failed",
                    detail: error.message,
                });
                addToast("Aardvark regeneration failed.", "error");
            }
        } finally {
            if (runAbortRef.current === controller) runAbortRef.current = null;
            setBusyOperation("");
        }
    };

    const refreshLocalAardvarkFromS3 = async () => {
        if (isRestoring) {
            setStatus(`${restoreLabel}. S3 refresh is available when restore finishes.`);
            addToast("Wait for local DuckDB restore to finish before refreshing from S3.", "info");
            return;
        }
        if (!selectedStorageProfile) {
            addToast("Choose a storage profile before refreshing from S3.", "info");
            return;
        }

        runAbortRef.current?.abort();
        const controller = new AbortController();
        runAbortRef.current = controller;
        setBusyOperation("refresh");
        setStatus(`Scanning ${selectedStorageProfile.name} for existing S3 Aardvark JSON...`);
        setRunProgress(null);

        try {
            const discovered = await enrichmentProxyClient.listProcessedS3Resources(selectedStorageProfile.id, controller.signal);
            const resources = discovered.resources;
            if (controller.signal.aborted) throw new Error("S3 refresh canceled.");
            if (resources.length === 0) {
                setStatus("No processed S3 resources with Aardvark JSON were found.");
                addToast("No processed S3 resources found.", "info");
                return;
            }

            startS3RefreshProgress(resources.length);
            let published = 0;
            let failed = 0;

            for (let index = 0; index < resources.length; index++) {
                const s3Resource = resources[index];
                const name = s3Resource.fileName || s3Resource.resourceId;
                if (controller.signal.aborted) throw new Error("S3 refresh canceled.");
                setStatus(`Refreshing ${index + 1} / ${resources.length}: ${name}`);
                updateRunProgress({
                    currentIndex: index,
                    currentAsset: name,
                    phase: "requesting",
                    phaseProgress: 0.35,
                    message: `Fetching existing Aardvark JSON for ${name} from S3.`,
                }, {
                    status: "active",
                    label: `Fetching ${name}`,
                    detail: s3Resource.root,
                });

                try {
                    const response = await enrichmentProxyClient.fetchAardvarkFromS3({
                        storageProfileId: selectedStorageProfile.id,
                        resource: s3Resource,
                    }, controller.signal);
                    if (controller.signal.aborted) throw new Error("S3 refresh canceled.");

                    updateRunProgress({
                        phase: "storing",
                        phaseProgress: 0.82,
                        message: `Publishing existing S3 Aardvark for ${name} into DuckDB.`,
                    }, {
                        status: "done",
                        label: "Fetched S3 Aardvark JSON",
                        detail: response.resourceId,
                    });

                    const { resource } = await withTimeout(
                        publishAardvarkResponseToLocalCatalog(response, { label: name }),
                        `Publishing ${name}`,
                        30_000,
                    );
                    published += 1;
                    updateRunProgress({
                        completed: published,
                        currentIndex: index + 1,
                        phase: "completed",
                        phaseProgress: 0,
                        message: `Refreshed and published ${published} of ${resources.length} resource(s).`,
                    }, {
                        status: "done",
                        label: `Published ${resource.id}`,
                        detail: `${resource.dct_title_s || name} saved to DuckDB and IndexedDB.`,
                    });
                } catch (error: any) {
                    if (String(error.message || "").includes("canceled")) throw error;
                    failed += 1;
                    updateRunProgress({
                        failed,
                        currentIndex: index + 1,
                        phase: "failed",
                        phaseProgress: 0,
                        message: `S3 refresh failed for ${name}: ${error.message}`,
                    }, {
                        status: "error",
                        label: `Failed ${name}`,
                        detail: error.message,
                    });
                }
            }

            await ensureDefaultEnrichmentData();
            if (activePanel === "inventory") void refreshS3Inventory(false);
            setStatus(`S3 refresh complete: ${published} published${failed > 0 ? `, ${failed} failed` : ""}.`);
            updateRunProgress({
                phase: failed > 0 ? "failed" : "completed",
                phaseProgress: 1,
                completed: published,
                failed,
                message: `S3 refresh complete: ${published} published, ${failed} failed.`,
                finishedAt: Date.now(),
            }, {
                status: failed > 0 ? "error" : "done",
                label: "S3 refresh complete",
                detail: `${published} published, ${failed} failed.`,
            });
            addToast(failed > 0 ? `Refreshed ${published}; ${failed} failed.` : `Refreshed ${published} local record(s) from S3.`, failed > 0 ? "error" : "success");
        } catch (error: any) {
            if (String(error.message || "").includes("canceled")) {
                setStatus("S3 refresh canceled.");
                addToast("S3 refresh canceled.", "info");
            } else {
                setStatus(`S3 refresh failed: ${error.message}`);
                updateRunProgress({
                    phase: "failed",
                    phaseProgress: 0,
                    message: `S3 refresh failed: ${error.message}`,
                    finishedAt: Date.now(),
                }, {
                    status: "error",
                    label: "S3 refresh failed",
                    detail: error.message,
                });
                addToast("S3 refresh failed.", "error");
            }
        } finally {
            if (runAbortRef.current === controller) runAbortRef.current = null;
            setBusyOperation("");
        }
    };

    const refreshWofConcordanceFromS3 = async () => {
        if (isRestoring) {
            setStatus(`${restoreLabel}. Gazetteer concordance persistence is available when restore finishes.`);
            addToast("Wait for local DuckDB restore to finish before refreshing gazetteer concordances.", "info");
            return;
        }
        if (!selectedStorageProfile) {
            addToast("Choose a storage profile before refreshing gazetteer concordances.", "info");
            return;
        }

        runAbortRef.current?.abort();
        const controller = new AbortController();
        runAbortRef.current = controller;
        setBusyOperation("wof");
        setStatus(`Scanning ${selectedStorageProfile.name} for processed S3 resources...`);
        setRunProgress(null);

        try {
            const discovered = await enrichmentProxyClient.listProcessedS3Resources(selectedStorageProfile.id, controller.signal);
            const resources = discovered.resources;
            if (controller.signal.aborted) throw new Error("Gazetteer concordance refresh canceled.");
            if (resources.length === 0) {
                setStatus("No processed S3 resources with Aardvark and extraction JSON were found.");
                addToast("No processed S3 resources found.", "info");
                return;
            }

            startWofRefreshProgress(resources.length);
            let published = 0;
            let failed = 0;
            let matchedTotal = 0;
            let supplementalTotal = 0;

            for (let index = 0; index < resources.length; index++) {
                const s3Resource = resources[index];
                const name = s3Resource.fileName || s3Resource.resourceId;
                if (controller.signal.aborted) throw new Error("Gazetteer concordance refresh canceled.");
                setStatus(`Persisting gazetteer matches ${index + 1} / ${resources.length}: ${name}`);
                updateRunProgress({
                    currentIndex: index,
                    currentAsset: name,
                    phase: "requesting",
                    phaseProgress: 0.35,
                    message: `Refreshing WOF/OSM/GeoNames concordance for ${name} and writing ai-enrichments.json back to S3.`,
                }, {
                    status: "active",
                    label: `Refreshing gazetteers ${name}`,
                    detail: s3Resource.root,
                });

                try {
                    const response = await enrichmentProxyClient.refreshWofConcordance({
                        jobId: `wof-${crypto.randomUUID()}`,
                        storageProfileId: selectedStorageProfile.id,
                        resource: s3Resource,
                    }, controller.signal);
                    if (controller.signal.aborted) throw new Error("Gazetteer concordance refresh canceled.");

                    const matched = Number(response.wofConcordance?.matched || 0) + Number(response.osmConcordance?.matched || 0) + Number(response.geonamesConcordance?.matched || 0);
                    const supplemental = Number(response.wofConcordance?.supplementalPlacenames || 0) + Number(response.osmConcordance?.supplementalPlacenames || 0) + Number(response.geonamesConcordance?.supplementalPlacenames || 0);
                    matchedTotal += matched;
                    supplementalTotal += supplemental;
                    updateRunProgress({
                        phase: "storing",
                        phaseProgress: 0.82,
                        message: `Publishing ${name} locally after persisting ${matched} gazetteer match(es).`,
                    }, {
                        status: "done",
                        label: "Persisted gazetteer concordance",
                        detail: `${matched} matched, ${supplemental} supplemental.`,
                    });

                    const { resource } = await withTimeout(
                        publishAardvarkResponseToLocalCatalog(response, { label: name }),
                        `Publishing ${name}`,
                        30_000,
                    );
                    published += 1;
                    updateRunProgress({
                        completed: published,
                        currentIndex: index + 1,
                        phase: "completed",
                        phaseProgress: 0,
                        message: `Persisted gazetteer concordances for ${published} of ${resources.length} resource(s).`,
                    }, {
                        status: "done",
                        label: `Published ${resource.id}`,
                        detail: `${resource.dct_title_s || name} saved to DuckDB and IndexedDB.`,
                    });
                } catch (error: any) {
                    if (String(error.message || "").includes("canceled")) throw error;
                    failed += 1;
                    updateRunProgress({
                        failed,
                        currentIndex: index + 1,
                        phase: "failed",
                        phaseProgress: 0,
                        message: `Gazetteer concordance refresh failed for ${name}: ${error.message}`,
                    }, {
                        status: "error",
                        label: `Failed ${name}`,
                        detail: error.message,
                    });
                }
            }

            await ensureDefaultEnrichmentData();
            if (activePanel === "inventory") void refreshS3Inventory(false);
            setStatus(`Gazetteer concordance persistence complete: ${published} published${failed > 0 ? `, ${failed} failed` : ""}.`);
            updateRunProgress({
                phase: failed > 0 ? "failed" : "completed",
                phaseProgress: 1,
                completed: published,
                failed,
                message: `Gazetteer concordance persistence complete: ${matchedTotal} total match(es), ${supplementalTotal} supplemental.`,
                finishedAt: Date.now(),
            }, {
                status: failed > 0 ? "error" : "done",
                label: "Gazetteer persistence complete",
                detail: `${published} published, ${failed} failed.`,
            });
            addToast(failed > 0 ? `Persisted gazetteers for ${published}; ${failed} failed.` : `Persisted gazetteer concordances for ${published} resource(s).`, failed > 0 ? "error" : "success");
        } catch (error: any) {
            if (String(error.message || "").includes("canceled")) {
                setStatus("Gazetteer concordance refresh canceled.");
                addToast("Gazetteer concordance refresh canceled.", "info");
            } else {
                setStatus(`Gazetteer concordance refresh failed: ${error.message}`);
                updateRunProgress({
                    phase: "failed",
                    phaseProgress: 0,
                    message: `Gazetteer concordance refresh failed: ${error.message}`,
                    finishedAt: Date.now(),
                }, {
                    status: "error",
                    label: "Gazetteer refresh failed",
                    detail: error.message,
                });
                addToast("Gazetteer concordance refresh failed.", "error");
            }
        } finally {
            if (runAbortRef.current === controller) runAbortRef.current = null;
            setBusyOperation("");
        }
    };

    const saveProxyConfig = async (nextConfig: ProxyConfig) => {
        try {
            const normalized = { ...nextConfig, visionProfiles: nextConfig.visionProfiles || [] };
            const saved = await enrichmentProxyClient.saveConfig(normalized);
            const savedConfig = { ...saved, visionProfiles: saved.visionProfiles || [] };
            setConfig(savedConfig);
            await syncProxyProfilesToDuckDb(savedConfig.storageProfiles, savedConfig.modelProfiles);
            addToast("Enrichment proxy config saved.", "success");
            return true;
        } catch (error: any) {
            setStatus(`Config save failed: ${error.message}`);
            addToast("Config save failed.", "error");
            return false;
        }
    };

    const saveStorageProfile = async () => {
        const nextProfiles = [
            ...config.storageProfiles.filter((profile) => profile.id !== storageDraft.id),
            storageDraft,
        ];
        if (await saveProxyConfig({ ...config, storageProfiles: nextProfiles })) {
            setSelectedStorageId(storageDraft.id);
        }
    };

    const saveModelProfile = async () => {
        const nextProfiles = [
            ...config.modelProfiles.filter((profile) => profile.id !== modelDraft.id),
            modelDraft,
        ];
        if (await saveProxyConfig({ ...config, modelProfiles: nextProfiles })) {
            if (modelDraft.provider === "gemini" || modelDraft.provider === "kimi" || /mini|nano|reconciliation/i.test(`${modelDraft.name} ${modelDraft.defaultModel}`)) {
                setSelectedTextExtractionModelId(modelDraft.id);
            } else {
                setSelectedModelId(modelDraft.id);
            }
        }
    };

    const saveVisionProfile = async () => {
        const draft = {
            ...visionDraft,
            endpoint: visionDraft.endpoint?.trim() || undefined,
            featureType: visionDraft.featureType || "DOCUMENT_TEXT_DETECTION",
            languageHints: (visionDraft.languageHints || []).map((hint) => hint.trim()).filter(Boolean),
        };
        const nextProfiles = [
            ...config.visionProfiles.filter((profile) => profile.id !== draft.id),
            draft,
        ];
        if (await saveProxyConfig({ ...config, visionProfiles: nextProfiles })) {
            setSelectedVisionId(draft.id);
        }
    };

    const deleteStorageProfile = async () => {
        const nextProfiles = config.storageProfiles.filter((profile) => profile.id !== selectedStorageId);
        if (await saveProxyConfig({ ...config, storageProfiles: nextProfiles })) {
            setSelectedStorageId(nextProfiles[0]?.id || "");
        }
    };

    const deleteModelProfile = async () => {
        const nextProfiles = config.modelProfiles.filter((profile) => profile.id !== selectedModelId);
        if (await saveProxyConfig({ ...config, modelProfiles: nextProfiles })) {
            setSelectedModelId(nextProfiles.find((profile) => (profile.provider || "openai") === "openai")?.id || nextProfiles[0]?.id || "");
            if (selectedTextExtractionModelId === selectedModelId) {
                setSelectedTextExtractionModelId(defaultTextReconciliationProfileId(nextProfiles));
            }
        }
    };

    const deleteVisionProfile = async () => {
        const nextProfiles = config.visionProfiles.filter((profile) => profile.id !== selectedVisionId);
        if (await saveProxyConfig({ ...config, visionProfiles: nextProfiles })) {
            setSelectedVisionId(nextProfiles[0]?.id || "");
        }
    };

    const testStorageProfile = async () => {
        if (!selectedStorageId) return;
        try {
            setStatus((await enrichmentProxyClient.testStorageProfile(selectedStorageId)).message);
        } catch (error: any) {
            setStatus(`Storage test failed: ${error.message}`);
            addToast("Storage test failed.", "error");
        }
    };

    const testModelProfile = async () => {
        if (!selectedModelId) return;
        try {
            setStatus((await enrichmentProxyClient.testModelProfile(selectedModelId)).message);
        } catch (error: any) {
            setStatus(`AI model test failed: ${error.message}`);
            addToast("AI model test failed.", "error");
        }
    };

    const testVisionProfile = async () => {
        if (!selectedVisionId) return;
        try {
            setStatus((await enrichmentProxyClient.testVisionProfile(selectedVisionId)).message);
        } catch (error: any) {
            setStatus(`Google Vision test failed: ${error.message}`);
            addToast("Google Vision test failed.", "error");
        }
    };

    const cancelRun = () => {
        const label = isRefreshingWof ? "Gazetteer concordance refresh" : isRefreshing ? "S3 refresh" : "Aardvark regeneration";
        runAbortRef.current?.abort();
        runAbortRef.current = null;
        setBusyOperation("");
        setStatus(`${label} canceled. Completed work remains available.`);
        updateRunProgress({
            phase: "failed",
            phaseProgress: 0,
            message: `${label} canceled by user. Completed work remains available.`,
            finishedAt: Date.now(),
        }, {
            status: "error",
            label: `${label} canceled`,
            detail: "The active proxy/OpenAI request was aborted from the browser.",
        });
    };

    const uploadActionControls = (
        <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={processUploads} disabled={isBusy || isRestoring || processableUploadCount === 0 || !selectedStorageId || !selectedModelProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                {isUploading ? "Processing..." : "Process Uploads"}
            </button>
            <button type="button" onClick={regenerateAardvarkFromS3} disabled={isBusy || isRestoring || !selectedStorageId || !selectedModelProfile} className="rounded border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 disabled:opacity-40 dark:border-indigo-700 dark:text-indigo-200">
                {isRegenerating ? "Regenerating..." : "Regenerate S3 Aardvark"}
            </button>
            <button type="button" onClick={refreshLocalAardvarkFromS3} disabled={isBusy || isRestoring || !selectedStorageId} className="rounded border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 disabled:opacity-40 dark:border-emerald-700 dark:text-emerald-200">
                {isRefreshing ? "Refreshing..." : "Refresh Local from S3"}
            </button>
            <button type="button" onClick={refreshWofConcordanceFromS3} disabled={isBusy || isRestoring || !selectedStorageId} className="rounded border border-sky-300 px-3 py-1.5 text-xs font-medium text-sky-700 disabled:opacity-40 dark:border-sky-700 dark:text-sky-200">
                {isRefreshingWof ? "Persisting Gazetteers..." : "Persist Gazetteer Matches"}
            </button>
            {isUploading && <button type="button" onClick={cancelUpload} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-200">Cancel</button>}
            {isRegenerating && <button type="button" onClick={cancelRun} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-200">Cancel Regeneration</button>}
            {isRefreshing && <button type="button" onClick={cancelRun} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-200">Cancel Refresh</button>}
            {isRefreshingWof && <button type="button" onClick={cancelRun} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-200">Cancel Gazetteers</button>}
            <button type="button" onClick={clearFinishedUploads} disabled={isUploading || completedUploadCount === 0} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Clear Finished</button>
            <label className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200">
                <input
                    type="checkbox"
                    checked={reprocessExistingUploads}
                    onChange={(event) => setReprocessExistingUploads(event.currentTarget.checked)}
                    disabled={isUploading}
                    className="h-3.5 w-3.5"
                />
                Re-process existing
            </label>
        </div>
    );

    return (
        <div className="ogm-enrichment-page flex h-full min-h-0 flex-col gap-4">
            <div className="ogm-tab-strip items-center">
                {([
                    { id: "upload", label: "Upload Pipeline" },
                    { id: "config", label: "Config" },
                    { id: "inventory", label: "Inventory" },
                ] as Array<{ id: Panel; label: string }>).map((panel) => (
                    <button
                        key={panel.id}
                        type="button"
                        onClick={() => setActivePanel(panel.id)}
                        className={`ogm-tab-button ${activePanel === panel.id ? "ogm-tab-button-active" : ""}`}
                    >
                        {panel.label}
                    </button>
                ))}
                <div className="ogm-section-label ml-auto">{status}</div>
            </div>

            {activePanel === "upload" && (
                <div className="flex min-h-0 flex-col gap-3">
                    {isRestoring && (
                        <div className="ogm-status-card px-3 py-2 text-xs">
                            {restoreLabel}. Upload processing is paused until restore finishes.
                        </div>
                    )}
                    {runProgress && (runProgress.kind === "regeneration" || runProgress.kind === "refresh" || runProgress.kind === "wof") && (
                        <div className="ogm-status-card p-3 text-xs" role="status" aria-live="polite">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <div className="font-semibold text-slate-900 dark:text-slate-100">{runProgress.kind === "wof" ? "Gazetteer Persistence Progress" : runProgress.kind === "refresh" ? "S3 Refresh Progress" : "Aardvark Regeneration Progress"}</div>
                                <div className="text-slate-500 dark:text-slate-400">{runProgressPercent}%</div>
                                <div className="ml-auto text-slate-500 dark:text-slate-400">Elapsed {runElapsedLabel}</div>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-slate-800">
                                <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${runProgressPercent}%` }} />
                            </div>
                            <div className="mt-2 text-slate-700 dark:text-slate-200">{runProgress.message}</div>
                            <div className="mt-2 text-slate-600 dark:text-slate-300">
                                {runProgress.completed} published · {runProgress.failed} failed · {runProgress.total} total
                                {runProgress.currentAsset ? ` · ${runProgress.currentAsset}` : ""}
                            </div>
                        </div>
                    )}
                    <div className="ogm-page-card sticky top-0 z-10 p-3 text-xs">
                        <div className="flex flex-wrap items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="font-semibold text-slate-900 dark:text-slate-100">Batch Actions</div>
                                <div className="text-slate-500 dark:text-slate-400">
                                    {processableUploadCount} waiting · {completedUploadCount} published · {metadataItems.length} companion metadata file{metadataItems.length === 1 ? "" : "s"}
                                    {!reprocessExistingUploads ? " · accessioned items will be skipped" : " · full reprocessing enabled"}
                                </div>
                            </div>
                            {uploadActionControls}
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(320px,420px)_1fr]">
                        <section className="ogm-page-card p-4">
                            <div className="grid grid-cols-1 gap-3 text-xs">
                                <select value={selectedStorageId} onChange={(e) => setSelectedStorageId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
                                    <option value="">Storage profile...</option>
                                    {config.storageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                                </select>
                                <select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
                                    <option value="">OpenAI metadata profile...</option>
                                    {openAiModelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profile.defaultModel}</option>)}
                                </select>
                                <select value={selectedVisionId} onChange={(e) => setSelectedVisionId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
                                    <option value="">OCR: OpenAI image extraction</option>
                                    {config.visionProfiles.map((profile) => <option key={profile.id} value={profile.id}>OCR: {profile.name} - {profile.featureType || "DOCUMENT_TEXT_DETECTION"}</option>)}
                                </select>
                                <select value={selectedTextExtractionModelId} onChange={(e) => setSelectedTextExtractionModelId(e.target.value)} disabled={!selectedVisionId} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950">
                                    <option value="">Label reconciliation: off</option>
                                    {textReconciliationModelProfiles.map((profile) => {
                                        const rawProvider = profile.provider || "openai";
                                        const provider = rawProvider === "gemini" ? "Gemini" : rawProvider === "kimi" ? "Kimi" : "OpenAI";
                                        return <option key={profile.id} value={profile.id}>{provider} labels: {profile.name} - {profile.defaultModel}</option>;
                                    })}
                                </select>
                                <label
                                    className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-indigo-200 bg-indigo-50/50 px-4 py-6 text-center text-slate-700 hover:bg-indigo-50 dark:border-indigo-900 dark:bg-indigo-950/20 dark:text-slate-200 dark:hover:bg-indigo-950/40"
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => void handleUploadDrop(event)}
                                >
                                    <input
                                        type="file"
                                        multiple
                                        accept="image/*,.tif,.tiff,.jp2,.j2k,.sid,.img,.zip,.shp,.shx,.dbf,.prj,.cpg,.sbn,.sbx,.qix,.tfw,.tifw,.jgw,.j2w,.sdw,.wld,.aux,.ovr,.rrd,.txt,.xml,.fgdc,.iso,.met"
                                        className="sr-only"
                                        onChange={(event) => {
                                            if (event.currentTarget.files) void addUploadFiles(event.currentTarget.files);
                                            event.currentTarget.value = "";
                                        }}
                                    />
                                    <span className="text-sm font-semibold">Drop Images or Data Packages</span>
                                    <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">Images, ZIP/SHP packages, or georeferenced raster sidecars for COGs</span>
                                </label>
                                <input
                                    ref={directoryInputRef}
                                    type="file"
                                    multiple
                                    className="sr-only"
                                    onChange={(event) => {
                                        if (event.currentTarget.files) void addUploadFiles(event.currentTarget.files);
                                        event.currentTarget.value = "";
                                    }}
                                    {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                                />
                                <button
                                    type="button"
                                    onClick={() => void handleChooseUploadDirectory()}
                                    disabled={isUploading}
                                    className="rounded border border-indigo-300 px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-700 dark:text-indigo-200 dark:hover:bg-indigo-950/30"
                                >
                                    Choose Folder
                                </button>
                                {folderScanSummary && (
                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-slate-800 dark:bg-slate-950/50">
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">Folder Scan</div>
                                                <div className="truncate font-medium text-slate-900 dark:text-slate-100">{folderScanSummary.rootName}</div>
                                            </div>
                                            <div className="text-right text-[11px] text-slate-500 dark:text-slate-400">
                                                {folderScanSummary.totalFiles.toLocaleString()} files
                                            </div>
                                        </div>
                                        <div className="mb-2 grid grid-cols-2 gap-1 text-[11px] text-slate-600 dark:text-slate-300">
                                            <span>{folderScanSummary.geospatialCount} geospatial package{folderScanSummary.geospatialCount === 1 ? "" : "s"}</span>
                                            <span>{folderScanSummary.imageCount} image{folderScanSummary.imageCount === 1 ? "" : "s"}</span>
                                            <span>{folderScanSummary.metadataCount} metadata file{folderScanSummary.metadataCount === 1 ? "" : "s"}</span>
                                            <span>{folderScanSummary.ignoredCount} ignored</span>
                                        </div>
                                        <div className="max-h-44 overflow-auto rounded border border-gray-100 bg-white dark:border-slate-800 dark:bg-slate-900">
                                            {folderScanSummary.topLevelItems.slice(0, 28).map((item) => (
                                                <div key={`${item.kind}:${item.name}`} className="flex items-center gap-2 border-b border-gray-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
                                                    <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
                                                    <span className="shrink-0 text-slate-500 dark:text-slate-400">
                                                        {item.kind === "directory" ? `${item.fileCount.toLocaleString()} files` : formatBytes(item.size)}
                                                    </span>
                                                </div>
                                            ))}
                                            {folderScanSummary.topLevelItems.length > 28 && (
                                                <div className="px-2 py-1 text-slate-500 dark:text-slate-400">
                                                    + {(folderScanSummary.topLevelItems.length - 28).toLocaleString()} more top-level item{folderScanSummary.topLevelItems.length - 28 === 1 ? "" : "s"}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {metadataItems.length > 0 && (
                                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-slate-800 dark:bg-slate-950/50">
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">Companion Metadata</div>
                                                <div className="text-slate-600 dark:text-slate-300">
                                                    {metadataItems.length.toLocaleString()} file{metadataItems.length === 1 ? "" : "s"} grouped by top-level source
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setMetadataItems([])}
                                                disabled={isUploading}
                                                className="rounded border border-gray-300 px-2 py-1 text-[11px] disabled:opacity-40 dark:border-slate-700"
                                            >
                                                Clear
                                            </button>
                                        </div>
                                        <div className="rounded border border-gray-100 bg-white dark:border-slate-800 dark:bg-slate-900">
                                            {metadataSourceGroups.slice(0, 10).map((group) => (
                                                <div key={group.name} className="flex items-center gap-2 border-b border-gray-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
                                                    <span className="min-w-0 flex-1 truncate font-mono">{group.name}</span>
                                                    <span className="shrink-0 text-slate-500 dark:text-slate-400">
                                                        {group.fileCount.toLocaleString()} file{group.fileCount === 1 ? "" : "s"} · {formatBytes(group.size)}
                                                    </span>
                                                </div>
                                            ))}
                                            {metadataSourceGroups.length > 10 && (
                                                <div className="px-2 py-1 text-slate-500 dark:text-slate-400">
                                                    + {(metadataSourceGroups.length - 10).toLocaleString()} more metadata source{metadataSourceGroups.length - 10 === 1 ? "" : "s"}
                                                </div>
                                            )}
                                        </div>
                                        <details className="mt-2">
                                            <summary className="cursor-pointer text-[11px] font-medium text-indigo-700 dark:text-indigo-300">Show individual files</summary>
                                            <div className="mt-2 max-h-52 overflow-auto rounded border border-gray-100 bg-white dark:border-slate-800 dark:bg-slate-900">
                                                {metadataItems.slice(0, 80).map((item) => (
                                                    <div key={item.id} className="flex items-center gap-2 border-b border-gray-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
                                                        <span className="min-w-0 flex-1 truncate font-mono">{item.sourcePath || item.name}</span>
                                                        <span className="shrink-0 text-slate-500 dark:text-slate-400">{formatBytes(item.size)}</span>
                                                        <button type="button" onClick={() => removeMetadataItem(item.id)} disabled={isUploading} className="shrink-0 rounded border border-gray-300 px-1.5 py-0.5 disabled:opacity-40 dark:border-slate-700">Remove</button>
                                                    </div>
                                                ))}
                                                {metadataItems.length > 80 && (
                                                    <div className="px-2 py-1 text-slate-500 dark:text-slate-400">
                                                        + {(metadataItems.length - 80).toLocaleString()} more file{metadataItems.length - 80 === 1 ? "" : "s"}
                                                    </div>
                                                )}
                                            </div>
                                        </details>
                                    </div>
                                )}
                            </div>
                        </section>

                        <section className="ogm-page-card min-h-0">
                            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3 text-xs dark:border-slate-800">
                                <h2 className="text-sm font-semibold">Upload Pipeline</h2>
                                <span className="text-slate-500 dark:text-slate-400">{uploadItems.length} queued · {completedUploadCount} published</span>
                                {uploadItems.length > 0 && (
                                    <div className="ml-auto flex min-w-40 items-center gap-2">
                                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                                            <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${Math.round((completedUploadCount / uploadItems.length) * 100)}%` }} />
                                        </div>
                                        <span className="text-slate-500 dark:text-slate-400">{Math.round((completedUploadCount / uploadItems.length) * 100)}%</span>
                                    </div>
                                )}
                            </div>
                            <div className="min-h-0 overflow-auto">
                                {uploadItems.map((item) => (
                                    <div key={item.id} className="border-b border-gray-100 p-4 text-xs last:border-b-0 dark:border-slate-800">
                                        <div className="flex flex-wrap items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{item.name}</div>
                                                    <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${item.status === "failed"
                                                        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200"
                                                        : item.status === "completed" || item.status === "cached"
                                                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
                                                            : "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200"
                                                        }`}>{item.status}</span>
                                                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{item.kind === "geospatial" ? "geospatial" : "image"}</span>
                                                    <span className="text-slate-500 dark:text-slate-400">{formatBytes(item.size)}{item.sourceFileCount && item.sourceFileCount > 1 ? ` · ${item.sourceFileCount} files` : ""}</span>
                                                </div>
                                                <div className="mt-1 text-slate-600 dark:text-slate-300">{item.message}</div>
                                                {item.error && <div className="mt-1 whitespace-pre-wrap font-mono text-red-700 dark:text-red-300">{item.error}</div>}
                                                {item.checksum && <div className="mt-1 truncate font-mono text-slate-500 dark:text-slate-400">sha256:{item.checksum}</div>}
                                                {item.resourceId && <div className="mt-1 truncate text-emerald-700 dark:text-emerald-300">Published {item.resourceId}{item.confidence != null ? ` · confidence ${item.confidence}` : ""}</div>}
                                                {item.artifacts && (
                                                    <div className="mt-2 flex flex-wrap gap-2">
                                                        {item.resourceId && <a className="rounded border border-emerald-200 px-2 py-1 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40" href={resourcePageHref(item.resourceId)} target="_blank" rel="noreferrer">Resource Page</a>}
                                                        <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.originalUrl} target="_blank" rel="noreferrer">Original</a>
                                                        {item.artifacts.thumbnailUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.thumbnailUrl} target="_blank" rel="noreferrer">Thumbnail</a>}
                                                        {item.artifacts.iiifInfoUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.iiifInfoUrl} target="_blank" rel="noreferrer">IIIF</a>}
                                                        {item.artifacts.extractionUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.extractionUrl} target="_blank" rel="noreferrer">Extraction</a>}
                                                        {item.artifacts.aiEnrichmentsUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.aiEnrichmentsUrl} target="_blank" rel="noreferrer">AI Enrichments</a>}
                                                        {item.artifacts.manifestUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.manifestUrl} target="_blank" rel="noreferrer">Manifest</a>}
                                                        {item.artifacts.geojsonUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.geojsonUrl} target="_blank" rel="noreferrer">GeoJSON</a>}
                                                        {item.artifacts.geoParquetUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.geoParquetUrl} target="_blank" rel="noreferrer">GeoParquet</a>}
                                                        {item.artifacts.pmtilesUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.pmtilesUrl} target="_blank" rel="noreferrer">PMTiles</a>}
                                                        {item.artifacts.cogUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.cogUrl} target="_blank" rel="noreferrer">COG</a>}
                                                        {item.artifacts.archivalSupplementUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.archivalSupplementUrl} target="_blank" rel="noreferrer">Accession</a>}
                                                        {item.artifacts.archivalSupplementJsonUrl && <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.archivalSupplementJsonUrl} target="_blank" rel="noreferrer">Accession JSON</a>}
                                                        <a className="rounded border border-gray-200 px-2 py-1 text-indigo-700 hover:bg-gray-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-slate-800" href={item.artifacts.aardvarkUrl} target="_blank" rel="noreferrer">Aardvark</a>
                                                    </div>
                                                )}
                                                {item.kind === "image" && item.artifacts?.iiifInfoUrl && item.extraction !== undefined && item.extraction !== null && (() => {
                                                    const textAnnotations = normalizeTextExtractionAnnotations(item.extraction);
                                                    if (textAnnotations.length === 0) return null;
                                                    const isExpanded = expandedTextReviewId === item.id;
                                                    return (
                                                        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950/50">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <div className="font-semibold text-slate-900 dark:text-slate-100">Text Review</div>
                                                                <span className="text-slate-500 dark:text-slate-400">{textAnnotations.length} extracted text box{textAnnotations.length === 1 ? "" : "es"}</span>
                                                                <button
                                                                    type="button"
                                                                    className="ml-auto rounded border border-gray-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                                                    onClick={() => setExpandedTextReviewId(isExpanded ? null : item.id)}
                                                                >
                                                                    {isExpanded ? "Hide View" : "Open View"}
                                                                </button>
                                                            </div>
                                                            {isExpanded && (
                                                                <IiifImageViewer
                                                                    infoUrl={item.artifacts.iiifInfoUrl}
                                                                    textAnnotations={textAnnotations}
                                                                    heightClassName="h-[460px]"
                                                                    className="mt-2 rounded-md"
                                                                />
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                                {item.milestones && item.milestones.length > 0 && (
                                                    <div className="mt-3 max-h-36 overflow-auto rounded border border-gray-100 bg-gray-50/70 dark:border-slate-800 dark:bg-slate-950/50">
                                                        {item.milestones.map((milestone) => (
                                                            <div key={milestone.id} className="grid grid-cols-[72px_54px_minmax(0,1fr)] gap-2 border-b border-gray-100 px-2 py-1.5 last:border-b-0 dark:border-slate-800">
                                                                <span className="text-slate-500 dark:text-slate-400">{milestone.at}</span>
                                                                <span className={`font-medium ${milestone.status === "error" ? "text-red-600 dark:text-red-300" : milestone.status === "active" ? "text-indigo-700 dark:text-indigo-300" : "text-emerald-700 dark:text-emerald-300"}`}>{milestone.status}</span>
                                                                <span className="min-w-0">
                                                                    <span className="font-medium">{milestone.label}</span>
                                                                    {milestone.detail && <span className="ml-2 break-words text-slate-500 dark:text-slate-400">{milestone.detail}</span>}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                            <button type="button" onClick={() => removeUploadItem(item.id)} disabled={isUploading && ["hashing", "processing", "publishing"].includes(item.status)} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-slate-700">Remove</button>
                                        </div>
                                    </div>
                                ))}
                                {uploadItems.length === 0 && (
                                    <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">No upload jobs queued.</div>
                                )}
                            </div>
                        </section>
                    </div>
                </div>
            )}

            {activePanel === "config" && (
                <div className="grid min-h-0 grid-cols-1 gap-4 overflow-auto xl:grid-cols-3">
                    <section className="ogm-page-card p-4">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">S3-Compatible Storage Profiles</h2>
                            <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setStorageDraft(blankStorageProfile())}>New</button>
                        </div>
                        <select className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" value={selectedStorageId} onChange={(e) => setSelectedStorageId(e.target.value)}>
                            <option value="">Choose profile...</option>
                            {config.storageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profileSummary(profile)}</option>)}
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.name} onChange={(e) => setStorageDraft({ ...storageDraft, name: e.target.value })} placeholder="Profile name" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.endpoint} onChange={(e) => setStorageDraft({ ...storageDraft, endpoint: e.target.value })} placeholder="Endpoint" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.region || ""} onChange={(e) => setStorageDraft({ ...storageDraft, region: e.target.value })} placeholder="Region" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.bucket} onChange={(e) => setStorageDraft({ ...storageDraft, bucket: e.target.value })} placeholder="Bucket" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={(storageDraft.prefixes || []).join("\n")} onChange={(e) => setStorageDraft({ ...storageDraft, prefixes: e.target.value.split(/\n|,/).map((v) => v.trim()) })} placeholder="Prefixes, comma or newline separated" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.publicBaseUrl || ""} onChange={(e) => setStorageDraft({ ...storageDraft, publicBaseUrl: e.target.value })} placeholder="Optional public base URL" />
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[96px_minmax(0,1fr)]">
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.metadataIdPrefix || "unr"} onChange={(e) => setStorageDraft({ ...storageDraft, metadataIdPrefix: cleanMetadataIdPrefix(e.target.value) })} placeholder="unr" aria-label="Metadata ID prefix" />
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.metadataProvider || ""} onChange={(e) => setStorageDraft({ ...storageDraft, metadataProvider: e.target.value })} placeholder="Metadata provider, e.g. University of Nevada, Reno" aria-label="Metadata provider" />
                            </div>
                            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                Enter environment variable names here, not secret values. Put actual credentials in web/.env or the shell that starts the proxy.
                            </p>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.accessKeyIdEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, accessKeyIdEnv: e.target.value })} placeholder="AWS_ACCESS_KEY_ID" aria-label="S3 access key environment variable name" />
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.secretAccessKeyEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, secretAccessKeyEnv: e.target.value })} placeholder="AWS_SECRET_ACCESS_KEY" aria-label="S3 secret access key environment variable name" />
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.sessionTokenEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, sessionTokenEnv: e.target.value })} placeholder="AWS_SESSION_TOKEN" aria-label="S3 session token environment variable name" />
                            </div>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={storageDraft.forcePathStyle !== false} onChange={(e) => setStorageDraft({ ...storageDraft, forcePathStyle: e.target.checked })} />
                                Force path-style URLs
                            </label>
                        </div>
                        <div className="mt-3 flex gap-2">
                            <button type="button" onClick={saveStorageProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                            <button type="button" onClick={deleteStorageProfile} disabled={!selectedStorageId} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Delete</button>
                            <button type="button" onClick={testStorageProfile} disabled={!selectedStorageId} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Test</button>
                        </div>
                    </section>

                    <section className="ogm-page-card p-4">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">AI Model Profiles</h2>
                            <div className="flex gap-1">
                                <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setModelDraft(blankModelProfile())}>New OpenAI</button>
                                <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setModelDraft(blankOpenAIReconciliationProfile())}>New Mini</button>
                                <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setModelDraft(blankGeminiModelProfile())}>New Gemini</button>
                                <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setModelDraft(blankKimiModelProfile())}>New Kimi</button>
                            </div>
                        </div>
                        <select className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)}>
                            <option value="">Choose profile...</option>
                            {config.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.provider || "openai"}: {profile.name} - {profile.defaultModel}</option>)}
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.name} onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })} placeholder="Profile name" />
                            <select
                                className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
                                value={modelDraft.provider || "openai"}
                                onChange={(e) => {
                                    const provider = e.target.value as ProxyModelProfile["provider"];
                                    setModelDraft({
                                        ...modelDraft,
                                        provider,
                                        apiKeyEnv: provider === "gemini" ? "GEMINI_API_KEY" : provider === "kimi" ? "MOONSHOT_API_KEY" : "OPENAI_API_KEY",
                                        defaultModel: provider === "gemini"
                                            ? "gemini-3.5-flash"
                                            : provider === "kimi"
                                                ? "kimi-k2.6"
                                                : modelDraft.provider === "openai" ? modelDraft.defaultModel || "gpt-5.5" : "gpt-5.5",
                                        modelParams: provider === "kimi" ? { thinking: { type: "disabled" } } : modelDraft.modelParams || {},
                                    });
                                }}
                            >
                                <option value="openai">OpenAI</option>
                                <option value="gemini">Gemini</option>
                                <option value="kimi">Kimi</option>
                            </select>
                            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                Env var name only. Put the API key value in web/.env or the shell, then reference it here.
                            </p>
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.apiKeyEnv} onChange={(e) => setModelDraft({ ...modelDraft, apiKeyEnv: e.target.value })} placeholder={modelDraft.provider === "gemini" ? "GEMINI_API_KEY" : modelDraft.provider === "kimi" ? "MOONSHOT_API_KEY" : "OPENAI_API_KEY"} aria-label="AI model API key environment variable name" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.defaultModel} onChange={(e) => setModelDraft({ ...modelDraft, defaultModel: e.target.value })} placeholder="Default model" />
                            <textarea className="h-28 rounded border px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" value={pretty(modelDraft.modelParams ?? {})} onChange={(e) => setModelDraft({ ...modelDraft, modelParams: parseJsonField(e.target.value, {}) })} />
                        </div>
                        <div className="mt-3 flex gap-2">
                            <button type="button" onClick={saveModelProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                            <button type="button" onClick={deleteModelProfile} disabled={!selectedModelId} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Delete</button>
                            <button type="button" onClick={testModelProfile} disabled={!selectedModelId} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Test</button>
                        </div>
                    </section>

                    <section className="ogm-page-card p-4">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">Google Vision OCR Profiles</h2>
                            <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setVisionDraft(blankVisionProfile())}>New</button>
                        </div>
                        <select className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" value={selectedVisionId} onChange={(e) => setSelectedVisionId(e.target.value)}>
                            <option value="">Choose profile...</option>
                            {config.visionProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profile.featureType || "DOCUMENT_TEXT_DETECTION"}</option>)}
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={visionDraft.name} onChange={(e) => setVisionDraft({ ...visionDraft, name: e.target.value })} placeholder="Profile name" />
                            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                                Env var name only. Put the Google Cloud Vision API key value in web/.env or the shell, then reference it here.
                            </p>
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={visionDraft.apiKeyEnv} onChange={(e) => setVisionDraft({ ...visionDraft, apiKeyEnv: e.target.value })} placeholder="GOOGLE_CLOUD_VISION_API_KEY" aria-label="Google Cloud Vision API key environment variable name" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={visionDraft.endpoint || ""} onChange={(e) => setVisionDraft({ ...visionDraft, endpoint: e.target.value })} placeholder="https://vision.googleapis.com/v1/images:annotate" />
                            <select className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={visionDraft.featureType || "DOCUMENT_TEXT_DETECTION"} onChange={(e) => setVisionDraft({ ...visionDraft, featureType: e.target.value as ProxyVisionProfile["featureType"] })}>
                                <option value="DOCUMENT_TEXT_DETECTION">DOCUMENT_TEXT_DETECTION</option>
                                <option value="TEXT_DETECTION">TEXT_DETECTION</option>
                            </select>
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={(visionDraft.languageHints || []).join(", ")} onChange={(e) => setVisionDraft({ ...visionDraft, languageHints: e.target.value.split(/[\s,]+/).map((hint) => hint.trim()).filter(Boolean) })} placeholder="Optional language hints, e.g. en, fr" />
                            <p className="rounded-md bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
                                Leave OCR unselected to use OpenAI for extraction. Choose a Vision profile to let Google produce the extracted text boxes before OpenAI writes the Aardvark record.
                            </p>
                        </div>
                        <div className="mt-3 flex gap-2">
                            <button type="button" onClick={saveVisionProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                            <button type="button" onClick={deleteVisionProfile} disabled={!selectedVisionId} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Delete</button>
                            <button type="button" onClick={testVisionProfile} disabled={!selectedVisionId} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Test</button>
                        </div>
                    </section>
                </div>
            )}

            {activePanel === "inventory" && (
                <div className="flex min-h-0 flex-col gap-3">
                    <div className="ogm-page-card flex flex-wrap items-center gap-3 p-3">
                        <select value={selectedStorageId} onChange={(e) => setSelectedStorageId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950">
                            <option value="">Storage profile...</option>
                            {config.storageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                        </select>
                        <input
                            value={inventoryQuery}
                            onChange={(event) => setInventoryQuery(event.target.value)}
                            className="min-w-56 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                            placeholder="Find UUID, file, or prefix..."
                        />
                        <button type="button" onClick={() => refreshS3Inventory()} disabled={isInventoryLoading || !selectedStorageId} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{isInventoryLoading ? "Refreshing..." : "Refresh Bucket"}</button>
                        {isInventoryLoading && <button type="button" onClick={cancelInventoryRefresh} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-200">Cancel</button>}
                        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{inventoryStatus || (inventoryLoadedAt ? `Loaded ${formatDateTime(inventoryLoadedAt)}` : "Bucket not loaded")}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div className="ogm-panel-card p-3">
                            <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">UUIDs</div>
                            <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">{inventoryResources.length.toLocaleString()}</div>
                        </div>
                        <div className="ogm-panel-card p-3">
                            <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">Complete</div>
                            <div className="mt-1 text-2xl font-semibold text-emerald-700 dark:text-emerald-300">{inventoryCompleteCount.toLocaleString()}</div>
                        </div>
                        <div className="ogm-panel-card p-3">
                            <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">Needs Attention</div>
                            <div className="mt-1 text-2xl font-semibold text-amber-700 dark:text-amber-300">{inventoryMissingCount.toLocaleString()}</div>
                        </div>
                    </div>
                    <div className="ogm-table-card min-h-0 overflow-auto">
                        <table className="ogm-table w-full text-left text-xs">
                            <thead className="sticky top-0">
                                <tr>
                                    <th className="p-2">UUID</th>
                                    <th className="p-2">Files</th>
                                    <th className="p-2">Original</th>
                                    <th className="p-2">Size</th>
                                    <th className="p-2">Updated</th>
                                    <th className="p-2">Prefix</th>
                                </tr>
                            </thead>
                            <tbody>
                                {inventoryRows.map((resource) => {
                                    const fileFlags = [
                                        { key: "original", ok: Boolean(resource.originalKey), href: resource.artifacts.originalUrl },
                                        { key: "thumbnail", ok: resource.hasThumbnail, href: resource.artifacts.thumbnailUrl },
                                        { key: "iiif", ok: resource.hasIiif, href: resource.artifacts.iiifInfoUrl },
                                        { key: "extraction", ok: resource.hasExtraction, href: resource.artifacts.extractionUrl },
                                        { key: "ai", ok: Boolean(resource.hasAiEnrichments), href: resource.artifacts.aiEnrichmentsUrl || "" },
                                        { key: "accession", ok: Boolean(resource.hasArchivalSupplement), href: resource.artifacts.archivalSupplementUrl || "" },
                                        { key: "aardvark", ok: resource.hasAardvark, href: resource.artifacts.aardvarkUrl },
                                    ];
                                    return (
                                        <tr key={resource.root} className="border-t border-gray-100 align-top dark:border-slate-800">
                                            <td className="max-w-64 p-2 font-mono">
                                                <div className="truncate" title={resource.resourceId}>{resource.resourceId}</div>
                                                {resource.metadataSourceCount > 0 && <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{resource.metadataSourceCount} metadata file(s)</div>}
                                            </td>
                                            <td className="p-2">
                                                <div className="flex max-w-md flex-wrap gap-1">
                                                    {fileFlags.map((flag) => flag.ok ? (
                                                        <a key={flag.key} href={flag.href} target="_blank" rel="noreferrer" className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                                                            {flag.key}
                                                        </a>
                                                    ) : (
                                                        <span key={flag.key} className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                                            missing {flag.key}
                                                        </span>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className="max-w-64 truncate p-2 font-mono" title={resource.originalKey || resource.fileName}>{resource.fileName || resource.originalKey || ""}</td>
                                            <td className="p-2">{resource.sizeBytes ? formatBytes(resource.sizeBytes) : ""}</td>
                                            <td className="p-2 whitespace-nowrap">{resource.updatedAt ? formatDateTime(resource.updatedAt) : ""}</td>
                                            <td className="max-w-sm truncate p-2 font-mono" title={resource.root}>{resource.root}</td>
                                        </tr>
                                    );
                                })}
                                {inventoryRows.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="p-6 text-center text-slate-500">{isInventoryLoading ? "Loading S3 inventory..." : "No S3 upload folders found."}</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

        </div>
    );
};
