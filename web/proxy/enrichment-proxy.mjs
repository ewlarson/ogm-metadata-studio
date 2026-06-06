import http from "node:http";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { buildWofConcordanceLayer } from "./wof-concordance.mjs";
import { buildOsmConcordanceLayer } from "./osm-concordance.mjs";
import { buildGeoNamesConcordanceLayer } from "./geonames-concordance.mjs";
import { buildCanonicalConcordanceLayer } from "./canonical-concordance.mjs";
import { refreshWofConcordanceInAiEnrichments } from "./ai-enrichments-wof-refresh.mjs";
import { filterRejectedMapText } from "./map-text-sanity.mjs";
import {
  compactExtractionForVisionAugmentation,
  GOOGLE_VISION_OCR_CALL_ID,
  HYBRID_VISION_OCR_PROVIDER,
  mergeVisionAugmentedExtraction,
  OPENAI_VISION_AUGMENTATION_CALL_ID,
} from "./vision-extraction-augmentation.mjs";
import {
  callGeminiMapLabelExtraction,
  callKimiMapAgentSwarm,
  callOpenAIMapLabelReconciliation,
  GEMINI_LABEL_EXTRACTION_CALL_ID,
  HYBRID_GEMINI_VISION_OCR_PROVIDER,
  HYBRID_KIMI_VISION_OCR_PROVIDER,
  HYBRID_OPENAI_VISION_OCR_PROVIDER,
  KIMI_AGENT_SWARM_CALL_ID,
  OPENAI_LABEL_RECONCILIATION_CALL_ID,
  mergeGoogleVisionWithGeminiExtraction,
  mergeGoogleVisionWithKimiAgentSwarm,
  mergeGoogleVisionWithOpenAIReconciliation,
  redactGeminiRequestForPersistence,
} from "./gemini-text-extraction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFiles(paths) {
  for (const envPath of Array.from(new Set(paths))) {
    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equalsIndex = normalized.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = normalized.slice(0, equalsIndex).trim();
      const value = parseEnvValue(normalized.slice(equalsIndex + 1));
      if (!key || (process.env[key] !== undefined && process.env[key] !== "")) continue;
      process.env[key] = value;
    }
  }
}

loadEnvFiles([
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../.env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
]);

const PORT = Number(process.env.ENRICHMENT_PROXY_PORT || 8787);
const CONFIG_PATH = process.env.ENRICHMENT_PROXY_CONFIG || path.resolve(__dirname, "../local-enrichment.config.json");
const DEFAULT_REGION = "us-east-1";
const ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION = "https://opengeometadata.org/reference/archival-accession-supplement";
const ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION = "https://opengeometadata.org/reference/archival-accession-supplement-json";
const AI_ENRICHMENTS_SCHEMA_VERSION = "0.1.0";
const AI_ENRICHMENTS_SCHEMA_URL = "https://opengeometadata.org/schema/ai-enrichments/schema.json";
const AI_ENRICHMENTS_RELATION = "https://opengeometadata.org/reference/ai-enrichments";
const S3_LIST_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_LIST_TIMEOUT_MS || 30_000);
const S3_OBJECT_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_OBJECT_TIMEOUT_MS || 120_000);
const S3_RETRY_ATTEMPTS = Math.max(1, Number(process.env.ENRICHMENT_PROXY_S3_RETRY_ATTEMPTS || 3));
const S3_RETRY_BASE_DELAY_MS = Math.max(0, Number(process.env.ENRICHMENT_PROXY_S3_RETRY_BASE_DELAY_MS || 750));
const S3_MULTIPART_THRESHOLD_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ENRICHMENT_PROXY_S3_MULTIPART_THRESHOLD_BYTES || 64 * 1024 * 1024));
const S3_MULTIPART_PART_SIZE_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ENRICHMENT_PROXY_S3_MULTIPART_PART_SIZE_BYTES || 32 * 1024 * 1024));
const GEOSPATIAL_DERIVATIVE_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_GEOSPATIAL_DERIVATIVE_TIMEOUT_MS || 60 * 60 * 1000);
const COG_PREVIEW_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_COG_PREVIEW_TIMEOUT_MS || 120_000);
const COG_PREVIEW_MAX_DIMENSION = Number(process.env.ENRICHMENT_PROXY_COG_PREVIEW_MAX_DIMENSION || 1400);
const PMTILES_PREVIEW_MAX_TILE_REQUESTS = Number(process.env.ENRICHMENT_PROXY_PMTILES_PREVIEW_MAX_TILE_REQUESTS || 64);
const PMTILES_PREVIEW_MAX_FEATURES = Number(process.env.ENRICHMENT_PROXY_PMTILES_PREVIEW_MAX_FEATURES || 8000);
const PMTILES_PREVIEW_MAX_COORDINATES = Number(process.env.ENRICHMENT_PROXY_PMTILES_PREVIEW_MAX_COORDINATES || 160000);
const MAX_LIST_PAGES = Number(process.env.ENRICHMENT_PROXY_MAX_LIST_PAGES || 1000);
const EMPTY_HASH = crypto.createHash("sha256").update("").digest("hex");
const VISION_TEST_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const GOOGLE_VISION_JSON_LIMIT_BYTES = Number(process.env.GOOGLE_VISION_JSON_LIMIT_BYTES || 10_000_000);
const GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES = Number(process.env.GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES || 6_500_000);
const GOOGLE_VISION_MAX_DIMENSION = Number(process.env.GOOGLE_VISION_MAX_DIMENSION || 9000);
const GOOGLE_VISION_MIN_DIMENSION = Number(process.env.GOOGLE_VISION_MIN_DIMENSION || 2400);
const GOOGLE_VISION_TILE_OCR_ENABLED = process.env.GOOGLE_VISION_TILE_OCR_ENABLED !== "false";
const GOOGLE_VISION_TILE_MIN_DIMENSION = Number(process.env.GOOGLE_VISION_TILE_MIN_DIMENSION || 5000);
const GOOGLE_VISION_TILE_SIZE = Number(process.env.GOOGLE_VISION_TILE_SIZE || 3000);
const GOOGLE_VISION_TILE_OVERLAP = Number(process.env.GOOGLE_VISION_TILE_OVERLAP || 320);
const GOOGLE_VISION_TILE_MAX_COUNT = Number(process.env.GOOGLE_VISION_TILE_MAX_COUNT || 12);
const GOOGLE_VISION_TILE_JPEG_QUALITY = Number(process.env.GOOGLE_VISION_TILE_JPEG_QUALITY || 88);
const OPENAI_VISION_AUGMENT_OCR_ENABLED = process.env.OPENAI_VISION_AUGMENT_OCR_ENABLED !== "false";
const OPENAI_VISION_AUGMENT_USE_OCR_SOURCES = process.env.OPENAI_VISION_AUGMENT_USE_OCR_SOURCES !== "false";
const OPENAI_VISION_AUGMENT_MAX_DIMENSION = Number(process.env.OPENAI_VISION_AUGMENT_MAX_DIMENSION || 1800);
const OPENAI_VISION_AUGMENT_JPEG_QUALITY = Number(process.env.OPENAI_VISION_AUGMENT_JPEG_QUALITY || 84);
const OPENAI_VISION_AUGMENT_MAX_IMAGES = Math.max(1, Number(process.env.OPENAI_VISION_AUGMENT_MAX_IMAGES || GOOGLE_VISION_TILE_MAX_COUNT + 1));
const GEMINI_TEXT_EXTRACT_USE_SMALL_CROPS = process.env.GEMINI_TEXT_EXTRACT_USE_SMALL_CROPS !== "false";
const GEMINI_TEXT_EXTRACT_CROP_SIZE = Math.max(700, Number(process.env.GEMINI_TEXT_EXTRACT_CROP_SIZE || 1800));
const GEMINI_TEXT_EXTRACT_CROP_OVERLAP = Math.max(0, Number(process.env.GEMINI_TEXT_EXTRACT_CROP_OVERLAP || 320));
const GEMINI_TEXT_EXTRACT_MAX_CROPS = Math.max(1, Number(process.env.GEMINI_TEXT_EXTRACT_MAX_CROPS || 64));
const GEMINI_TEXT_EXTRACT_TARGET_CROPS = Math.max(0, Number(process.env.GEMINI_TEXT_EXTRACT_TARGET_CROPS || 0));
const GEMINI_TEXT_EXTRACT_JPEG_QUALITY = Math.max(50, Math.min(95, Number(process.env.GEMINI_TEXT_EXTRACT_JPEG_QUALITY || 88)));
const AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT = Math.max(0, Number(process.env.AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT || 400));
const METADATA_WRITER_TEXT_LIMIT = Math.max(0, Number(process.env.ENRICHMENT_PROXY_METADATA_WRITER_TEXT_LIMIT || 320));
const METADATA_WRITER_TEXT_GROUP_LIMIT = Math.max(0, Number(process.env.ENRICHMENT_PROXY_METADATA_WRITER_TEXT_GROUP_LIMIT || 180));
const METADATA_WRITER_PLACENAME_LIMIT = Math.max(0, Number(process.env.ENRICHMENT_PROXY_METADATA_WRITER_PLACENAME_LIMIT || 160));

function safeJsonStringify(value, space) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "bigint") return item;
    const asNumber = Number(item);
    return Number.isSafeInteger(asNumber) ? asNumber : item.toString();
  }, space);
}

function cleanMetadataIdPrefix(value) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unr";
}

function effectiveBatchDefaults(batchDefaults = {}, storageProfile = {}) {
  const metadataIdPrefix = cleanMetadataIdPrefix(
    batchDefaults.metadataIdPrefix ||
    storageProfile.metadataIdPrefix ||
    process.env.OGM_METADATA_ID_PREFIX ||
    "unr"
  );
  return {
    ...batchDefaults,
    metadataIdPrefix,
    provider: String(batchDefaults.provider || storageProfile.metadataProvider || storageProfile.name || "").trim(),
  };
}

function generatedAardvarkResourceId(storageProfile = {}, batchDefaults = {}) {
  const prefix = effectiveBatchDefaults(batchDefaults, storageProfile).metadataIdPrefix;
  return `${prefix}-${crypto.randomUUID()}`;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

const uploadJobs = new Map();
const UPLOAD_JOB_TTL_MS = 6 * 60 * 60 * 1000;

function pruneUploadJobs() {
  const cutoff = Date.now() - UPLOAD_JOB_TTL_MS;
  for (const [jobId, job] of uploadJobs.entries()) {
    const updatedAt = Date.parse(job.updatedAt || job.startedAt || "");
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) uploadJobs.delete(jobId);
  }
}

function summarizeUploadJob(job) {
  const milestones = Array.isArray(job?.milestones) ? job.milestones : [];
  const latest = milestones[milestones.length - 1] || null;
  const cropSummary = {
    provider: "",
    phase: "",
    cropCount: 0,
    started: 0,
    completed: 0,
    failed: 0,
    labels: 0,
    claims: 0,
    cacheHits: 0,
  };
  const providers = [
    { prefix: "Kimi map-agent swarm", provider: "Kimi" },
    { prefix: "Gemini map-label extraction", provider: "Gemini" },
    { prefix: "OpenAI map-label reconciliation", provider: "OpenAI" },
  ];
  for (const milestone of milestones) {
    const label = String(milestone?.label || "");
    const detail = milestone?.detail || {};
    const match = providers.find((item) => label.startsWith(item.prefix));
    if (!match || !Number.isFinite(Number(detail.crop))) continue;
    cropSummary.provider = match.provider;
    cropSummary.cropCount = Math.max(cropSummary.cropCount, Number(detail.cropCount || 0));
    if (label.endsWith("crop request started")) cropSummary.started += 1;
    if (label.endsWith("crop response received")) {
      cropSummary.completed += 1;
      cropSummary.labels += Number(detail.labels || 0);
      cropSummary.claims += Number(detail.claims || 0);
      if (detail.cacheHit === true) cropSummary.cacheHits += 1;
    }
    if (label.endsWith("crop failed")) cropSummary.failed += 1;
  }
  if (cropSummary.cropCount > 0) {
    const done = cropSummary.completed + cropSummary.failed;
    cropSummary.phase = `${cropSummary.provider} crop processing`;
    return {
      kind: "crop",
      label: `${cropSummary.provider} crops ${done}/${cropSummary.cropCount} complete (${cropSummary.completed} succeeded, ${cropSummary.failed} failed, ${Math.max(0, cropSummary.cropCount - done)} pending)`,
      percent: Math.round((done / cropSummary.cropCount) * 100),
      ...cropSummary,
    };
  }
  return latest ? {
    kind: "milestone",
    label: latest.label,
    percent: null,
  } : null;
}

function uploadJobSnapshot(jobId) {
  const job = uploadJobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.jobId,
    fileName: job.fileName,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    error: job.error,
    summary: summarizeUploadJob(job),
    milestones: job.milestones,
  };
}

function finishUploadJob(jobId, status, detail = {}) {
  const job = uploadJobs.get(jobId);
  if (!job) return;
  job.status = status;
  job.updatedAt = new Date().toISOString();
  job.completedAt = job.updatedAt;
  if (detail.error) job.error = detail.error;
}

function createUploadLogger(jobId, fileName) {
  pruneUploadJobs();
  const startedAt = Date.now();
  const milestones = [];
  const job = {
    jobId,
    fileName,
    status: "active",
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    milestones,
  };
  uploadJobs.set(jobId, job);
  return {
    milestones,
    log(label, detail = {}) {
      const entry = {
        at: new Date().toISOString(),
        elapsed_ms: Date.now() - startedAt,
        label,
        detail,
      };
      milestones.push(entry);
      job.updatedAt = entry.at;
      console.log(`[upload:${jobId}] ${label}`, safeJsonStringify({ fileName, elapsed_ms: entry.elapsed_ms, ...detail }));
    },
  };
}

const DEFAULT_CONFIG = {
  storageProfiles: [],
  visionProfiles: [],
  modelProfiles: [
    {
      id: "openai-default",
      name: "OpenAI default",
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.5",
      modelParams: {},
    },
    {
      id: "openai-mini-reconciliation",
      name: "OpenAI mini label reconciliation",
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.4-mini",
      modelParams: {},
    },
    {
      id: "gemini-default",
      name: "Gemini label extraction",
      provider: "gemini",
      apiKeyEnv: "GEMINI_API_KEY",
      defaultModel: "gemini-3.5-flash",
      modelParams: {},
    },
    {
      id: "kimi-k2-6-swarm",
      name: "Kimi K2.6 cached map-agent swarm",
      provider: "kimi",
      apiKeyEnv: "MOONSHOT_API_KEY",
      defaultModel: "kimi-k2.6",
      modelParams: {
        thinking: { type: "disabled" },
      },
    },
  ],
};

const geospatialUploadSessions = new Map();
const GEOSPATIAL_UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text);
    const modelProfiles = Array.isArray(parsed.modelProfiles) ? parsed.modelProfiles : DEFAULT_CONFIG.modelProfiles;
    return {
      storageProfiles: normalizeStorageProfiles(parsed.storageProfiles),
      visionProfiles: Array.isArray(parsed.visionProfiles) ? parsed.visionProfiles : [],
      modelProfiles: mergeDefaultModelProfiles(modelProfiles),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function normalizeStorageProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map((profile) => ({
    ...profile,
    metadataIdPrefix: cleanMetadataIdPrefix(profile?.metadataIdPrefix || process.env.OGM_METADATA_ID_PREFIX || "unr"),
    metadataProvider: String(profile?.metadataProvider || "").trim(),
  }));
}

function mergeDefaultModelProfiles(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const ids = new Set(list.map((profile) => profile?.id).filter(Boolean));
  return [
    ...list,
    ...DEFAULT_CONFIG.modelProfiles.filter((profile) => !ids.has(profile.id)),
  ];
}

async function saveConfig(config) {
  const normalized = {
    storageProfiles: normalizeStorageProfiles(config.storageProfiles),
    visionProfiles: Array.isArray(config.visionProfiles) ? config.visionProfiles : [],
    modelProfiles: Array.isArray(config.modelProfiles) ? config.modelProfiles : DEFAULT_CONFIG.modelProfiles,
  };
  validateConfigEnvReferences(normalized);
  await writeFile(CONFIG_PATH, safeJsonStringify(normalized, 2));
  return normalized;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
  });
  res.end(safeJsonStringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function findProfile(config, type, id) {
  const list = type === "storage" ? config.storageProfiles : type === "vision" ? (config.visionProfiles || []) : config.modelProfiles;
  const profile = list.find((item) => item.id === id);
  if (!profile) throw new Error(`${type} profile not found: ${id}`);
  return profile;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AWS_ACCESS_KEY_ID_RE = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;
const OPENAI_API_KEY_RE = /^sk-[A-Za-z0-9_-]{20,}/;
const GOOGLE_API_KEY_RE = /^AIza[A-Za-z0-9_-]{20,}/;
const HIGH_ENTROPY_SECRET_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9/+_=.-]{32,}$/;

function looksLikeCredentialValue(value) {
  const text = String(value || "").trim();
  return AWS_ACCESS_KEY_ID_RE.test(text) || OPENAI_API_KEY_RE.test(text) || GOOGLE_API_KEY_RE.test(text) || HIGH_ENTROPY_SECRET_RE.test(text);
}

function validateEnvReference(name, label) {
  const text = String(name || "").trim();
  if (!text) return "";
  if (looksLikeCredentialValue(text)) {
    throw new Error(`${label} expects an environment variable name such as AWS_ACCESS_KEY_ID or OPENAI_API_KEY, not the credential value itself. Put the value in web/.env and set this field to the env var name.`);
  }
  if (!ENV_VAR_NAME_RE.test(text)) {
    throw new Error(`${label} expects an environment variable name, not a raw secret value. Use a name like AWS_SECRET_ACCESS_KEY in the profile, and put the actual value in web/.env.`);
  }
  return text;
}

function validateConfigEnvReferences(config) {
  for (const profile of config.storageProfiles) {
    validateEnvReference(profile.accessKeyIdEnv, "S3 access key");
    validateEnvReference(profile.secretAccessKeyEnv, "S3 secret key");
    validateEnvReference(profile.sessionTokenEnv, "S3 session token");
  }
  for (const profile of config.modelProfiles) {
    const provider = String(profile.provider || "openai").toLowerCase();
    const label = provider === "gemini" ? "Gemini API key" : provider === "kimi" ? "Kimi API key" : "OpenAI API key";
    validateEnvReference(profile.apiKeyEnv, label);
  }
  for (const profile of config.visionProfiles || []) {
    validateEnvReference(profile.apiKeyEnv, "Google Cloud Vision API key");
  }
}

function resolveEnv(name, label) {
  const envName = validateEnvReference(name, label);
  if (!envName) return "";
  const value = process.env[envName];
  if (!value) throw new Error(`${label} environment variable is not set: ${envName}`);
  return value;
}

function resolveOptionalEnv(name, label) {
  const envName = validateEnvReference(name, label);
  if (!envName) return "";
  return process.env[envName] || "";
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/g, "/");
}

function objectUrl(profile, key, query = undefined) {
  const endpoint = String(profile.endpoint || "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("Storage profile endpoint is required");
  const bucket = profile.bucket;
  if (!bucket) throw new Error("Storage profile bucket is required");
  const forcePathStyle = profile.forcePathStyle !== false;
  let url;
  if (forcePathStyle) {
    url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodePathSegment(key || "")}`);
  } else {
    const base = new URL(endpoint);
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `/${encodePathSegment(key || "")}`;
    url = base;
  }
  if (query) {
    for (const [keyName, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(keyName, String(value));
    }
  }
  return url;
}

function listUrl(profile, prefix, continuationToken) {
  const query = {
    "list-type": "2",
    prefix,
    "max-keys": "1000",
    "continuation-token": continuationToken,
  };
  return objectUrl(profile, "", query);
}

function hmac(key, data, encoding) {
  return crypto.createHmac("sha256", key).update(data).digest(encoding);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function amzDateParts(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signS3Request(method, url, profile, options = {}) {
  const accessKeyId = profile.accessKeyIdEnv ? resolveEnv(profile.accessKeyIdEnv, "S3 access key") : "";
  const secretAccessKey = profile.secretAccessKeyEnv ? resolveEnv(profile.secretAccessKeyEnv, "S3 secret key") : "";
  const sessionToken = resolveOptionalEnv(profile.sessionTokenEnv, "S3 session token");
  if (!accessKeyId || !secretAccessKey) return {};

  const payloadHash = options.payloadHash || EMPTY_HASH;
  const region = profile.region || DEFAULT_REGION;
  const { amzDate, dateStamp } = amzDateParts();
  const canonicalUri = url.pathname.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
  const queryPairs = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const headers = {
    host: url.host,
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    ...(options.extraHeaders || {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalRequest = [method, canonicalUri, queryPairs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");
  return {
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    ...(options.extraHeaders || {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = S3_LIST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`S3 request timed out after ${Math.round(timeoutMs / 1000)} seconds: ${url.origin}${url.pathname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableS3Status(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableS3Error(error) {
  const message = String(error?.message || error || "");
  return /timed out|abort|econnreset|econnrefused|enotfound|etimedout|socket|network|fetch failed/i.test(message);
}

async function signedFetch(profile, url, init = {}) {
  const {
    timeoutMs = S3_LIST_TIMEOUT_MS,
    headers: initHeaders = {},
    payloadHash,
    contentType,
    retryAttempts = S3_RETRY_ATTEMPTS,
    ...rest
  } = init;
  const method = rest.method || "GET";
  const attempts = Math.max(1, Number(retryAttempts || 1));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headers = { ...initHeaders, ...signS3Request(method, url, profile, { payloadHash, contentType }) };
    try {
      const response = await fetchWithTimeout(url, { ...rest, method, headers }, timeoutMs);
      if (!isRetryableS3Status(response.status) || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => null);
      lastError = new Error(`S3 retryable response ${response.status} for ${url.origin}${url.pathname}`);
    } catch (error) {
      lastError = error;
      if (!isRetryableS3Error(error) || attempt === attempts) throw error;
    }
    const delay = S3_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
    if (delay > 0) await sleep(delay);
  }
  throw lastError || new Error(`S3 request failed for ${url.origin}${url.pathname}`);
}

function tagValues(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  return Array.from(xml.matchAll(re)).map((match) => decodeXml(match[1]));
}

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function encodeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function contentTypeForKey(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".jp2") || lower.endsWith(".j2k")) return "image/jp2";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".geojson")) return "application/geo+json";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".parquet")) return "application/vnd.apache.parquet";
  if (lower.endsWith(".pmtiles")) return "application/vnd.pmtiles";
  if (lower.endsWith(".xml")) return "application/xml";
  return "application/octet-stream";
}

function isSupportedRaster(key) {
  return /\.(jpe?g|png|webp|tiff?|jp2|j2k)$/i.test(key);
}

function publicUrlFor(profile, key) {
  if (!profile.publicBaseUrl) return null;
  return `${String(profile.publicBaseUrl).replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function accessUrlFor(profile, key) {
  return publicUrlFor(profile, key) || objectUrl(profile, key).toString();
}

function decodeUrlPathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function keyFromPublicUrl(profile, artifactUrl) {
  if (!profile.publicBaseUrl) return "";
  const publicBase = String(profile.publicBaseUrl).replace(/\/+$/, "");
  if (!artifactUrl.href.startsWith(`${publicBase}/`)) return "";
  return artifactUrl.href
    .slice(publicBase.length + 1)
    .split(/[?#]/, 1)[0]
    .split("/")
    .map(decodeUrlPathSegment)
    .join("/");
}

function keyFromObjectUrl(profile, artifactUrl) {
  const endpoint = new URL(String(profile.endpoint || "").replace(/\/+$/, ""));
  const bucket = String(profile.bucket || "");
  if (!bucket || artifactUrl.protocol !== endpoint.protocol) return "";

  const forcePathStyle = profile.forcePathStyle !== false;
  if (forcePathStyle) {
    if (artifactUrl.host !== endpoint.host) return "";
    const parts = artifactUrl.pathname.replace(/^\/+/, "").split("/");
    if (decodeUrlPathSegment(parts[0] || "") !== bucket) return "";
    return parts.slice(1).map(decodeUrlPathSegment).join("/");
  }

  if (artifactUrl.host !== `${bucket}.${endpoint.host}`) return "";
  return artifactUrl.pathname.replace(/^\/+/, "").split("/").map(decodeUrlPathSegment).join("/");
}

function findArtifactProfileAndKey(config, rawUrl) {
  let artifactUrl;
  try {
    artifactUrl = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Artifact proxy requires a valid url parameter.");
  }
  if (!["http:", "https:"].includes(artifactUrl.protocol)) throw new Error("Artifact proxy only supports HTTP(S) URLs.");

  for (const profile of config.storageProfiles || []) {
    const key = keyFromPublicUrl(profile, artifactUrl) || keyFromObjectUrl(profile, artifactUrl);
    if (!key) continue;
    const uploadRoot = uploadBasePrefix(profile).replace(/\/+$/, "");
    if (!key.startsWith(`${uploadRoot}/`)) throw new Error("Artifact URL is outside the configured upload prefix.");
    return { profile, key };
  }
  throw new Error("Artifact URL does not match a configured storage profile.");
}

async function proxyArtifactObject(config, req, res, rawUrl) {
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    });
    res.end();
    return;
  }

  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await signedFetch(profile, objectUrl(profile, key), {
    method: req.method,
    headers,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });

  const responseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
  };
  for (const name of ["accept-ranges", "cache-control", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  if (!responseHeaders["content-type"]) responseHeaders["content-type"] = contentTypeForKey(key);
  res.writeHead(upstream.status, responseHeaders);
  if (req.method === "HEAD" || upstream.status === 304) {
    res.end();
    return;
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.end(buffer);
}

async function uploadArtifactObject(config, body) {
  const profile = findProfile(config, "storage", body.storageProfileId);
  const key = String(body.key || "").replace(/^\/+/, "");
  if (!key) throw new Error("Artifact upload requires a key.");

  const uploadRoot = uploadBasePrefix(profile).replace(/\/+$/, "");
  if (!key.startsWith(`${uploadRoot}/`)) {
    throw new Error("Artifact upload key is outside the configured upload prefix.");
  }

  let buffer;
  if (typeof body.base64 === "string" && body.base64.trim()) {
    buffer = Buffer.from(body.base64, "base64");
  } else if (typeof body.text === "string") {
    buffer = Buffer.from(body.text, "utf8");
  } else if (body.json && typeof body.json === "object") {
    buffer = Buffer.from(safeJsonStringify(body.json, 2), "utf8");
  } else {
    throw new Error("Artifact upload requires base64, text, or json.");
  }

  const contentType = String(body.contentType || contentTypeForKey(key));
  await putObjectBuffer(profile, key, buffer, contentType);
  return {
    ok: true,
    key,
    url: accessUrlFor(profile, key),
    bytes: buffer.length,
    contentType,
  };
}

function parseCogPreviewDimension(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(16, Math.min(COG_PREVIEW_MAX_DIMENSION, parsed));
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCogPreviewBbox(value) {
  const parts = String(value || "").split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("COG preview requires bbox=west,south,east,north in EPSG:4326.");
  }
  let [west, south, east, north] = parts;
  west = clampNumber(west, -180, 180);
  east = clampNumber(east, -180, 180);
  south = clampNumber(south, -90, 90);
  north = clampNumber(north, -90, 90);
  if (!(east > west && north > south)) {
    throw new Error("COG preview bbox is outside the valid EPSG:4326 range.");
  }
  return { west, south, east, north };
}

function cogPreviewVsicurlCandidates(rawUrl, profile, key) {
  const candidates = [];
  const push = (candidate) => {
    if (!candidate) return;
    if (!/^https?:\/\//i.test(candidate)) return;
    if (candidates.includes(candidate)) return;
    candidates.push(candidate);
  };
  push(String(rawUrl || ""));
  push(publicUrlFor(profile, key));
  push(objectUrl(profile, key).toString());
  return candidates.map((candidate) => `/vsicurl/${candidate}`);
}

function cogPreviewRenderOptions(info) {
  const bands = Array.isArray(info?.bands) ? info.bands : [];
  const nonAlphaBands = bands.filter((band) => String(band?.colorInterpretation || "").toLowerCase() !== "alpha");
  const firstBand = nonAlphaBands[0] || {};
  const interpretations = nonAlphaBands.map((band) => String(band?.colorInterpretation || "").toLowerCase());
  const hasPalette = interpretations.includes("palette") || Boolean(firstBand?.colorTable);
  const hasRgb = interpretations.includes("red") && interpretations.includes("green") && interpretations.includes("blue");
  const hasNonByteBand = nonAlphaBands.some((band) => String(band?.type || "").toLowerCase() !== "byte");
  const layerType = String(firstBand?.metadata?.[""]?.LAYER_TYPE || "").toLowerCase();
  const nbits = Number(firstBand?.metadata?.IMAGE_STRUCTURE?.NBITS || 0);
  const colorTableEntries = Array.isArray(firstBand?.colorTable?.entries) ? firstBand.colorTable.entries.length : 0;
  const histogramBins = Number(firstBand?.metadata?.[""]?.STATISTICS_HISTONUMBINS || 0);
  const isBinaryPalette = hasPalette && (nbits === 1 || colorTableEntries === 2 || histogramBins === 2);
  return {
    expandPalette: hasPalette,
    resampling: hasPalette || layerType === "thematic" ? "near" : "bilinear",
    scaleToByte: !hasPalette && (hasNonByteBand || (!hasRgb && nonAlphaBands.length <= 1)),
    disableOverviews: isBinaryPalette,
  };
}

async function previewRenderOptionsForSource(sourcePath) {
  const result = await inspectCogWithSource(sourcePath);
  if (!result.ok) return cogPreviewRenderOptions(null);
  try {
    return cogPreviewRenderOptions(JSON.parse(result.stdout));
  } catch {
    return cogPreviewRenderOptions(null);
  }
}

async function renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions) {
  const warpedPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.warped.tif`);
  const warpResult = await tryExecFile("gdalwarp", [
    "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR",
    "--config", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.TIFF",
    "-overwrite",
    "-t_srs", "EPSG:4326",
    "-te", String(bbox.west), String(bbox.south), String(bbox.east), String(bbox.north),
    "-ts", String(width), String(height),
    "-r", renderOptions.resampling,
    ...(renderOptions.disableOverviews ? ["-ovr", "NONE"] : []),
    "-dstalpha",
    "-multi",
    "-wo", "NUM_THREADS=ALL_CPUS",
    "-of", "GTiff",
    sourcePath,
    warpedPath,
  ], { timeoutMs: COG_PREVIEW_TIMEOUT_MS });
  if (!warpResult.ok || !existsSync(warpedPath)) return warpResult;

  const translateArgs = ["-of", "PNG"];
  if (renderOptions.expandPalette) translateArgs.push("-expand", "rgba");
  if (renderOptions.scaleToByte) translateArgs.push("-ot", "Byte", "-scale");
  translateArgs.push(warpedPath, outputPath);
  return tryExecFile("gdal_translate", translateArgs, { timeoutMs: COG_PREVIEW_TIMEOUT_MS });
}

async function inspectCogWithSource(sourcePath) {
  return tryExecFileOutput("gdalinfo", [
    "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR",
    "--config", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.TIFF",
    "-json",
    sourcePath,
  ], { timeoutMs: COG_PREVIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 24 });
}

function responseFromCogInfo(info) {
  const bbox = bboxFromGdalInfo(info);
  const size = Array.isArray(info?.size) ? info.size : [];
  if (!bbox) throw new Error("COG metadata did not include a valid WGS84 extent.");
  return {
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    width: Number(size[0] || 0) || null,
    height: Number(size[1] || 0) || null,
    crs: String(info?.stac?.["proj:epsg"] || info?.coordinateSystem?.name || ""),
    layout: String(info?.metadata?.IMAGE_STRUCTURE?.LAYOUT || ""),
  };
}

async function inspectCogArtifact(config, res, rawUrl) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.tiff?$/i.test(key)) throw new HttpError(415, "COG metadata only supports GeoTIFF artifacts.");
  if (!await resolveCommandPath("gdalinfo")) {
    throw new Error("COG metadata requires GDAL gdalinfo to be installed.");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-cog-info-"));
  try {
    let lastError = "";
    for (const sourcePath of cogPreviewVsicurlCandidates(rawUrl, profile, key)) {
      const result = await inspectCogWithSource(sourcePath);
      if (result.ok) {
        return send(res, 200, responseFromCogInfo(JSON.parse(result.stdout)));
      }
      lastError = result.error || lastError;
    }

    const sourcePath = path.join(tempRoot, path.basename(key) || "source.cog.tif");
    await writeFile(sourcePath, await fetchObjectBuffer(profile, key));
    const result = await inspectCogWithSource(sourcePath);
    if (!result.ok) {
      throw new Error(`COG metadata inspection failed: ${result.error || lastError || "GDAL did not return metadata."}`);
    }
    return send(res, 200, responseFromCogInfo(JSON.parse(result.stdout)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function previewCogArtifact(config, res, rawUrl, searchParams) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.tiff?$/i.test(key)) throw new HttpError(415, "COG preview only supports GeoTIFF artifacts.");
  if (!await resolveCommandPath("gdalwarp")) {
    throw new Error("COG preview requires GDAL gdalwarp to be installed.");
  }
  if (!await resolveCommandPath("gdal_translate")) {
    throw new Error("COG preview requires GDAL gdal_translate to be installed.");
  }

  const bbox = parseCogPreviewBbox(searchParams.get("bbox"));
  const width = parseCogPreviewDimension(searchParams.get("width"), 800);
  const height = parseCogPreviewDimension(searchParams.get("height"), 600);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-cog-preview-"));
  try {
    let lastError = "";
    for (const sourcePath of cogPreviewVsicurlCandidates(rawUrl, profile, key)) {
      const outputPath = path.join(tempRoot, `preview-${crypto.randomUUID()}.png`);
      const renderOptions = await previewRenderOptionsForSource(sourcePath);
      const result = await renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions);
      if (result.ok && existsSync(outputPath)) {
        const png = await readFile(outputPath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Range",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
        });
        res.end(png);
        return;
      }
      lastError = result.error || lastError;
    }

    const sourcePath = path.join(tempRoot, path.basename(key) || "source.cog.tif");
    const outputPath = path.join(tempRoot, "preview.png");
    await writeFile(sourcePath, await fetchObjectBuffer(profile, key));
    const renderOptions = await previewRenderOptionsForSource(sourcePath);
    const result = await renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions);
    if (!result.ok || !existsSync(outputPath)) {
      throw new Error(`COG preview render failed: ${result.error || lastError || "GDAL did not create a PNG."}`);
    }
    const png = await readFile(outputPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
    res.end(png);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function isRasterPreviewFileName(name) {
  return /\.(?:tiff?|jp2|j2k|jpe?g|png|webp)$/i.test(String(name || ""));
}

async function rasterPreviewSourceFromArtifact(config, rawUrl) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  const buffer = await fetchObjectBuffer(profile, key);
  if (!/\.zip$/i.test(key)) {
    if (!isRasterPreviewFileName(key)) throw new HttpError(415, "Raster preview only supports image or ZIP package artifacts.");
    return { buffer, name: path.basename(key) || "source.tif" };
  }

  const mod = await import("jszip");
  const JSZip = mod.default || mod;
  const zip = await JSZip.loadAsync(buffer);
  const entry = Object.values(zip.files)
    .filter((file) => !file.dir && isRasterPreviewFileName(file.name))
    .sort((a, b) => {
      const aIsTiff = /\.tiff?$/i.test(a.name) ? 0 : 1;
      const bIsTiff = /\.tiff?$/i.test(b.name) ? 0 : 1;
      return aIsTiff - bIsTiff || a.name.localeCompare(b.name);
    })[0];
  if (!entry) throw new Error("ZIP package did not contain a raster image that can be previewed.");
  return { buffer: Buffer.from(await entry.async("nodebuffer")), name: entry.name };
}

async function previewRasterArtifact(config, res, rawUrl, searchParams) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("Raster preview requires the optional sharp package.");

  const width = parseCogPreviewDimension(searchParams.get("width"), 800);
  const height = parseCogPreviewDimension(searchParams.get("height"), 600);
  const source = await rasterPreviewSourceFromArtifact(config, rawUrl);
  const rendered = await sharp(source.buffer, { limitInputPixels: false })
    .rotate()
    .resize({ width, height, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .png()
    .toBuffer();
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  });
  res.end(rendered);
}

function pmtilesArtifactSource(profile, key) {
  const url = objectUrl(profile, key);
  return {
    getKey() {
      return url.toString();
    },
    async getBytes(offset, length) {
      const end = offset + length - 1;
      const response = await signedFetch(profile, url, {
        headers: { Range: `bytes=${offset}-${end}` },
        timeoutMs: S3_OBJECT_TIMEOUT_MS,
      });
      if (![200, 206].includes(response.status)) {
        const status = response.status === 404 ? 404 : 502;
        throw new HttpError(status, `PMTiles range request failed with status ${response.status}.`);
      }
      const etag = response.headers.get("etag") || undefined;
      return {
        data: await response.arrayBuffer(),
        etag: etag && !etag.startsWith("W/") ? etag : undefined,
        cacheControl: response.headers.get("cache-control") || undefined,
        expires: response.headers.get("expires") || undefined,
      };
    },
  };
}

function validPmtilesPreviewBbox(bbox) {
  if (!bbox) return null;
  const west = Number(bbox.west);
  const south = Number(bbox.south);
  const east = Number(bbox.east);
  const north = Number(bbox.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (!(east > west && north > south)) return null;
  return { west, south, east, north };
}

function pmtilesHeaderBbox(header) {
  return validPmtilesPreviewBbox({
    west: header?.minLon,
    south: header?.minLat,
    east: header?.maxLon,
    north: header?.maxLat,
  });
}

function pmtilesPreviewBbox(searchParams, header) {
  const bboxParam = searchParams.get("bbox");
  if (bboxParam) return parseCogPreviewBbox(bboxParam);
  return pmtilesHeaderBbox(header) || { west: -180, south: -85, east: 180, north: 85 };
}

const WEB_MERCATOR_MAX_LAT = 85.05112878;
const TILE_SIZE = 256;

function lngLatToWorldPixel(lng, lat, zoom) {
  const scale = TILE_SIZE * (2 ** zoom);
  const clampedLat = clampNumber(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function bestPmtilesPreviewZoom(bbox, width, height, minZoom, maxZoom) {
  const padding = 0.82;
  let best = minZoom;
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const nw = lngLatToWorldPixel(bbox.west, bbox.north, zoom);
    const se = lngLatToWorldPixel(bbox.east, bbox.south, zoom);
    const fits = Math.abs(se.x - nw.x) <= width * padding && Math.abs(se.y - nw.y) <= height * padding;
    if (fits) best = zoom;
    else if (zoom > best) break;
  }
  return best;
}

function pmtilesPreviewView(bbox, width, height, zoom) {
  const center = lngLatToWorldPixel((bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2, zoom);
  const worldSize = TILE_SIZE * (2 ** zoom);
  const minX = center.x - width / 2;
  const minY = center.y - height / 2;
  const maxX = center.x + width / 2;
  const maxY = center.y + height / 2;
  const tileLimit = (2 ** zoom) - 1;
  const minTileX = clampNumber(Math.floor(minX / TILE_SIZE), 0, tileLimit);
  const maxTileX = clampNumber(Math.floor((maxX - 1) / TILE_SIZE), 0, tileLimit);
  const minTileY = clampNumber(Math.floor(minY / TILE_SIZE), 0, tileLimit);
  const maxTileY = clampNumber(Math.floor((maxY - 1) / TILE_SIZE), 0, tileLimit);
  return {
    zoom,
    width,
    height,
    minX: clampNumber(minX, 0, worldSize),
    minY: clampNumber(minY, 0, worldSize),
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
  };
}

function pmtilesPreviewTileCount(view) {
  return Math.max(0, view.maxTileX - view.minTileX + 1) * Math.max(0, view.maxTileY - view.minTileY + 1);
}

function pmtilesPreviewViews(bbox, width, height, header) {
  const minZoom = Math.max(0, Math.min(22, Number(header.minZoom || 0)));
  const maxZoom = Math.max(minZoom, Math.min(22, Number(header.maxZoom || minZoom)));
  const preferred = bestPmtilesPreviewZoom(bbox, width, height, minZoom, maxZoom);
  const views = [];
  const seen = new Set();
  const push = (zoom) => {
    if (seen.has(zoom)) return;
    seen.add(zoom);
    const view = pmtilesPreviewView(bbox, width, height, zoom);
    if (pmtilesPreviewTileCount(view) <= PMTILES_PREVIEW_MAX_TILE_REQUESTS) views.push(view);
  };
  for (let zoom = preferred; zoom >= minZoom; zoom -= 1) push(zoom);
  for (let zoom = preferred + 1; zoom <= maxZoom && views.length < 6; zoom += 1) push(zoom);
  return views;
}

function svgNumber(value) {
  return String(Math.round(Number(value) * 10) / 10);
}

function includeSvgStatePoint(state, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  state.bounds.minX = Math.min(state.bounds.minX, x);
  state.bounds.minY = Math.min(state.bounds.minY, y);
  state.bounds.maxX = Math.max(state.bounds.maxX, x);
  state.bounds.maxY = Math.max(state.bounds.maxY, y);
}

function emptyPmtilesSvgState() {
  return {
    polygons: [],
    lines: [],
    points: [],
    featureCount: 0,
    coordinateCount: 0,
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  };
}

function appendVectorFeatureSvg(feature, tileX, tileY, view, state) {
  if (state.featureCount >= PMTILES_PREVIEW_MAX_FEATURES || state.coordinateCount >= PMTILES_PREVIEW_MAX_COORDINATES) return false;
  const geometry = feature.loadGeometry();
  const scale = TILE_SIZE / Number(feature.extent || 4096);
  const project = (point) => {
    const x = tileX * TILE_SIZE + point.x * scale - view.minX;
    const y = tileY * TILE_SIZE + point.y * scale - view.minY;
    includeSvgStatePoint(state, x, y);
    return [x, y];
  };

  state.featureCount += 1;
  if (feature.type === 1) {
    for (const line of geometry) {
      const point = line[0];
      if (!point) continue;
      const [x, y] = project(point);
      state.points.push(`<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="2.4"/>`);
      state.coordinateCount += 1;
    }
    return true;
  }

  for (const line of geometry) {
    if (!Array.isArray(line) || line.length === 0) continue;
    const commands = [];
    for (let index = 0; index < line.length; index += 1) {
      const [x, y] = project(line[index]);
      commands.push(`${index === 0 ? "M" : "L"}${svgNumber(x)} ${svgNumber(y)}`);
      state.coordinateCount += 1;
      if (state.coordinateCount >= PMTILES_PREVIEW_MAX_COORDINATES) break;
    }
    if (commands.length === 0) continue;
    if (feature.type === 3) {
      state.polygons.push(`${commands.join(" ")} Z`);
    } else {
      state.lines.push(commands.join(" "));
    }
    if (state.coordinateCount >= PMTILES_PREVIEW_MAX_COORDINATES) break;
  }
  return true;
}

async function collectPmtilesPreviewSvgState(archive, view, modules) {
  const state = emptyPmtilesSvgState();
  const { VectorTile, Pbf } = modules;
  for (let x = view.minTileX; x <= view.maxTileX; x += 1) {
    for (let y = view.minTileY; y <= view.maxTileY; y += 1) {
      if (state.featureCount >= PMTILES_PREVIEW_MAX_FEATURES || state.coordinateCount >= PMTILES_PREVIEW_MAX_COORDINATES) return state;
      const tile = await archive.getZxy(view.zoom, x, y);
      if (!tile?.data) continue;
      const vectorTile = new VectorTile(new Pbf(new Uint8Array(tile.data)));
      for (const layer of Object.values(vectorTile.layers || {})) {
        for (let index = 0; index < layer.length; index += 1) {
          const keepGoing = appendVectorFeatureSvg(layer.feature(index), x, y, view, state);
          if (!keepGoing) return state;
        }
      }
    }
  }
  return state;
}

function pmtilesSvgContentTransform(width, height, state) {
  const { minX, minY, maxX, maxY } = state.bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return "";
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  if (!(contentWidth > 0) || !(contentHeight > 0)) return "";
  const paddingX = Math.max(18, width * 0.08);
  const paddingY = Math.max(18, height * 0.08);
  const scale = Math.min((width - paddingX * 2) / contentWidth, (height - paddingY * 2) / contentHeight);
  if (!Number.isFinite(scale) || scale <= 0) return "";
  const tx = (width - contentWidth * scale) / 2 - minX * scale;
  const ty = (height - contentHeight * scale) / 2 - minY * scale;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return "";
  return ` transform="translate(${svgNumber(tx)} ${svgNumber(ty)}) scale(${svgNumber(scale)})"`;
}

function pmtilesPreviewSvg(width, height, state) {
  const polygons = state.polygons.length > 0
    ? `<path d="${state.polygons.join(" ")}" fill="#60a5fa" fill-opacity="0.32" fill-rule="evenodd" stroke="#2563eb" stroke-opacity="0.82" stroke-width="1" vector-effect="non-scaling-stroke"/>`
    : "";
  const lines = state.lines.length > 0
    ? `<path d="${state.lines.join(" ")}" fill="none" stroke="#1d4ed8" stroke-opacity="0.95" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
    : "";
  const points = state.points.length > 0
    ? `<g fill="#2563eb" fill-opacity="0.92" stroke="#ffffff" stroke-width="0.9">${state.points.join("")}</g>`
    : "";
  const fallback = !polygons && !lines && !points
    ? `<rect x="${width * 0.22}" y="${height * 0.22}" width="${width * 0.56}" height="${height * 0.56}" rx="2" fill="#60a5fa" fill-opacity="0.2" stroke="#2563eb" stroke-width="2"/>`
    : "";
  const contentTransform = pmtilesSvgContentTransform(width, height, state);
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="#e2e8f0" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${width}" height="${height}" fill="#f8fafc"/>
      <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.75"/>
      ${fallback}
      <g${contentTransform}>
        ${polygons}
        ${lines}
        ${points}
      </g>
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#cbd5e1"/>
    </svg>
  `;
}

async function previewPmtilesArtifact(config, res, rawUrl, searchParams) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("PMTiles preview requires the optional sharp package.");

  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.pmtiles$/i.test(key)) throw new HttpError(415, "PMTiles preview only supports .pmtiles artifacts.");

  const [{ PMTiles, TileType }, vectorTileModule, pbfModule] = await Promise.all([
    import("pmtiles"),
    import("@mapbox/vector-tile"),
    import("pbf"),
  ]);
  const VectorTile = vectorTileModule.VectorTile || vectorTileModule.default?.VectorTile;
  const Pbf = pbfModule.default || pbfModule;
  if (!VectorTile || !Pbf) throw new Error("PMTiles preview could not load vector tile parsers.");

  const width = parseCogPreviewDimension(searchParams.get("width"), 800);
  const height = parseCogPreviewDimension(searchParams.get("height"), 600);
  const archive = new PMTiles(pmtilesArtifactSource(profile, key));
  const header = await archive.getHeader();
  if (header.tileType !== TileType.Mvt) throw new Error("PMTiles preview only supports vector PMTiles archives.");

  const bbox = pmtilesPreviewBbox(searchParams, header);
  const views = pmtilesPreviewViews(bbox, width, height, header);
  let state = emptyPmtilesSvgState();
  for (const view of views) {
    state = await collectPmtilesPreviewSvgState(archive, view, { VectorTile, Pbf });
    if (state.polygons.length > 0 || state.lines.length > 0 || state.points.length > 0) break;
  }

  const rendered = await sharp(Buffer.from(pmtilesPreviewSvg(width, height, state)))
    .png()
    .toBuffer();
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  });
  res.end(rendered);
}

async function vectorPackageGeojsonBuffer(config, rawUrl) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.zip$/i.test(key)) throw new HttpError(415, "Vector package preview only supports zipped shapefile artifacts.");

  const sourceBuffer = await fetchObjectBuffer(profile, key);
  const entries = await zipEntriesFromBuffer(sourceBuffer);
  const shapefile = findShapefileSet(entries);
  if (!shapefile) throw new Error("ZIP package did not contain a shapefile.");

  const analysis = analyzeShapefilePackage(entries, shapefile, path.basename(key));
  const nativeGeojson = geojsonFromShapefile(shapefile.shp.buffer, analysis.dbf, analysis.manifest);
  if (nativeGeojson) return Buffer.from(safeJsonStringify(nativeGeojson), "utf8");

  const ogr2ogrPath = await resolveCommandPath("ogr2ogr");
  if (!ogr2ogrPath) throw new Error("Vector package preview requires ogr2ogr for projected shapefiles.");

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-vector-preview-"));
  try {
    await writeEntriesToDirectory(entries, tempRoot);
    const shpPath = path.join(tempRoot, shapefile.shp.name);
    const geojsonPath = path.join(tempRoot, `${analysis.manifest.dataset.baseName}.geojson`);
    const result = await tryExecFile("ogr2ogr", [
      "-t_srs", "EPSG:4326",
      "-f", "GeoJSON",
      geojsonPath,
      shpPath,
    ], { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS, env: { SHAPE_RESTORE_SHX: "YES" } });
    if (!result.ok || !existsSync(geojsonPath)) {
      throw new Error(result.error || "ogr2ogr did not create a GeoJSON preview.");
    }
    return await readFile(geojsonPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function geoJsonFeatures(value) {
  if (!value || typeof value !== "object") return [];
  if (value.type === "FeatureCollection") return Array.isArray(value.features) ? value.features : [];
  if (value.type === "Feature") return [value];
  if (value.type && value.coordinates) return [{ type: "Feature", geometry: value, properties: {} }];
  return [];
}

function collectGeoJsonBounds(node, bounds) {
  if (!Array.isArray(node)) return;
  if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
    const x = Number(node[0]);
    const y = Number(node[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    return;
  }
  node.forEach((item) => collectGeoJsonBounds(item, bounds));
}

function geoJsonPreviewBounds(geojson) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const feature of geoJsonFeatures(geojson)) collectGeoJsonBounds(feature?.geometry?.coordinates, bounds);
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) ? bounds : null;
}

function geoJsonPathForLine(line, project, close = false) {
  if (!Array.isArray(line)) return "";
  const commands = [];
  for (const coord of line) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const projected = project(coord);
    if (!projected) continue;
    commands.push(`${commands.length === 0 ? "M" : "L"}${svgNumber(projected[0])} ${svgNumber(projected[1])}`);
  }
  if (commands.length < 2) return "";
  return `${commands.join(" ")}${close ? " Z" : ""}`;
}

function appendGeoJsonGeometrySvg(geometry, project, parts) {
  if (!geometry || typeof geometry !== "object") return;
  const { type, coordinates } = geometry;
  if (type === "Polygon") {
    for (const ring of coordinates || []) {
      const pathData = geoJsonPathForLine(ring, project, true);
      if (pathData) parts.polygons.push(pathData);
    }
  } else if (type === "MultiPolygon") {
    for (const polygon of coordinates || []) {
      for (const ring of polygon || []) {
        const pathData = geoJsonPathForLine(ring, project, true);
        if (pathData) parts.polygons.push(pathData);
      }
    }
  } else if (type === "LineString") {
    const pathData = geoJsonPathForLine(coordinates, project);
    if (pathData) parts.lines.push(pathData);
  } else if (type === "MultiLineString") {
    for (const line of coordinates || []) {
      const pathData = geoJsonPathForLine(line, project);
      if (pathData) parts.lines.push(pathData);
    }
  } else if (type === "Point") {
    const point = project(coordinates);
    if (point) parts.points.push(`<circle cx="${svgNumber(point[0])}" cy="${svgNumber(point[1])}" r="2.4"/>`);
  } else if (type === "MultiPoint") {
    for (const coord of coordinates || []) {
      const point = project(coord);
      if (point) parts.points.push(`<circle cx="${svgNumber(point[0])}" cy="${svgNumber(point[1])}" r="2.4"/>`);
    }
  }
}

function geoJsonPreviewSvg(geojson, width, height) {
  const bounds = geoJsonPreviewBounds(geojson);
  const paddingX = Math.max(18, width * 0.08);
  const paddingY = Math.max(18, height * 0.08);
  const parts = { polygons: [], lines: [], points: [] };
  const project = (coord) => {
    if (!bounds || !Array.isArray(coord) || coord.length < 2) return null;
    const x = Number(coord[0]);
    const y = Number(coord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const spanX = bounds.maxX > bounds.minX ? bounds.maxX - bounds.minX : 1;
    const spanY = bounds.maxY > bounds.minY ? bounds.maxY - bounds.minY : 1;
    const contentWidth = Math.max(1, width - paddingX * 2);
    const contentHeight = Math.max(1, height - paddingY * 2);
    const scale = Math.min(contentWidth / spanX, contentHeight / spanY);
    const drawWidth = spanX * scale;
    const drawHeight = spanY * scale;
    const originX = (width - drawWidth) / 2;
    const originY = (height - drawHeight) / 2;
    return [
      originX + (x - bounds.minX) * scale,
      originY + (bounds.maxY - y) * scale,
    ];
  };

  for (const feature of geoJsonFeatures(geojson)) appendGeoJsonGeometrySvg(feature.geometry, project, parts);
  const polygonPath = parts.polygons.length
    ? `<path d="${parts.polygons.join(" ")}" fill="#60a5fa" fill-opacity="0.32" fill-rule="evenodd" stroke="#2563eb" stroke-opacity="0.82" stroke-width="1"/>`
    : "";
  const linePath = parts.lines.length
    ? `<path d="${parts.lines.join(" ")}" fill="none" stroke="#1d4ed8" stroke-opacity="0.95" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : "";
  const pointGroup = parts.points.length
    ? `<g fill="#2563eb" fill-opacity="0.92" stroke="#ffffff" stroke-width="0.9">${parts.points.join("")}</g>`
    : "";
  const fallback = !polygonPath && !linePath && !pointGroup
    ? `<rect x="${width * 0.22}" y="${height * 0.22}" width="${width * 0.56}" height="${height * 0.56}" rx="2" fill="#60a5fa" fill-opacity="0.2" stroke="#2563eb" stroke-width="2"/>`
    : "";
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="#e2e8f0" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${width}" height="${height}" fill="#f8fafc"/>
      <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.75"/>
      ${fallback}
      ${polygonPath}
      ${linePath}
      ${pointGroup}
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#cbd5e1"/>
    </svg>
  `;
}

async function proxyVectorGeoJsonArtifact(config, res, rawUrl) {
  const geojson = await vectorPackageGeojsonBuffer(config, rawUrl);
  res.writeHead(200, {
    "Content-Type": "application/geo+json",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  });
  res.end(geojson);
}

async function previewVectorPackageArtifact(config, res, rawUrl, searchParams) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("Vector package preview requires the optional sharp package.");
  const width = parseCogPreviewDimension(searchParams.get("width"), 800);
  const height = parseCogPreviewDimension(searchParams.get("height"), 600);
  const geojson = JSON.parse((await vectorPackageGeojsonBuffer(config, rawUrl)).toString("utf8"));
  const rendered = await sharp(Buffer.from(geoJsonPreviewSvg(geojson, width, height)))
    .png()
    .toBuffer();
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  });
  res.end(rendered);
}

function sanitizeFileName(name) {
  const cleaned = String(name || "image").replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "image";
}

function uploadBasePrefix(profile) {
  const firstPrefix = Array.isArray(profile.prefixes) ? String(profile.prefixes[0] || "").trim().replace(/^\/+|\/+$/g, "") : "";
  return firstPrefix ? `${firstPrefix}/uploads` : "uploads";
}

function checksumIndexKey(profile, checksum) {
  return `${uploadBasePrefix(profile)}/_checksums/${checksum}.json`;
}

function uploadKeys(profile, resourceId, fileName) {
  const safeName = sanitizeFileName(fileName);
  const baseName = safeName.replace(/\.[^.]+$/, "") || "image";
  const root = `${uploadBasePrefix(profile)}/${resourceId}`;
  return {
    root,
    original: `${root}/original_file/${safeName}`,
    cog: `${root}/derivatives/${baseName}.cog.tif`,
    iiif: `${root}/iiif`,
    thumbnail: `${root}/thumbnail/thumbnail.jpg`,
    metadataSources: `${root}/metadata_sources`,
    extraction: `${root}/enrichment_response.json`,
    archivalSupplement: `${root}/archival_accession_supplement.md`,
    archivalSupplementJson: `${root}/archival_accession_supplement.json`,
    aiEnrichments: `${root}/ai-enrichments.json`,
    aardvark: `${root}/aardvark.json`,
  };
}

function hydrateUploadKeys(profile, keys, resourceId, fileName) {
  const next = { ...uploadKeys(profile, resourceId, fileName), ...(keys || {}) };
  next.root = next.root || `${uploadBasePrefix(profile)}/${resourceId}`;
  next.metadataSources = next.metadataSources || `${next.root}/metadata_sources`;
  next.archivalSupplement = next.archivalSupplement || `${next.root}/archival_accession_supplement.md`;
  next.archivalSupplementJson = next.archivalSupplementJson || `${next.root}/archival_accession_supplement.json`;
  next.aiEnrichments = next.aiEnrichments || `${next.root}/ai-enrichments.json`;
  return next;
}

function geospatialUploadKeys(profile, resourceId, fileName) {
  const safeName = sanitizeFileName(fileName || "geospatial_package.zip");
  const baseName = safeName.replace(/\.[^.]+$/, "") || "dataset";
  const root = `${uploadBasePrefix(profile)}/${resourceId}`;
  return {
    root,
    original: `${root}/original_file/${safeName}`,
    manifest: `${root}/dataset_manifest.json`,
    geojson: `${root}/derivatives/${baseName}.geojson`,
    geoParquet: `${root}/derivatives/${baseName}.parquet`,
    pmtiles: `${root}/derivatives/${baseName}.pmtiles`,
    cog: `${root}/derivatives/${baseName}.cog.tif`,
    thumbnail: `${root}/thumbnail/thumbnail.jpg`,
    archivalSupplement: `${root}/archival_accession_supplement.md`,
    archivalSupplementJson: `${root}/archival_accession_supplement.json`,
    aardvark: `${root}/aardvark.json`,
  };
}

function geospatialUploadKeysFromRoot(root, fileName = "geospatial_package.zip", originalKey = "") {
  const cleanRoot = String(root || "").replace(/\/+$/g, "");
  const safeName = sanitizeFileName(fileName || "geospatial_package.zip");
  const baseName = safeName.replace(/\.[^.]+$/, "") || "dataset";
  return {
    root: cleanRoot,
    original: originalKey || `${cleanRoot}/original_file/${safeName}`,
    manifest: `${cleanRoot}/dataset_manifest.json`,
    geojson: `${cleanRoot}/derivatives/${baseName}.geojson`,
    geoParquet: `${cleanRoot}/derivatives/${baseName}.parquet`,
    pmtiles: `${cleanRoot}/derivatives/${baseName}.pmtiles`,
    cog: `${cleanRoot}/derivatives/${baseName}.cog.tif`,
    iiif: `${cleanRoot}/iiif`,
    thumbnail: `${cleanRoot}/thumbnail/thumbnail.jpg`,
    extraction: `${cleanRoot}/enrichment_response.json`,
    metadataSources: `${cleanRoot}/metadata_sources`,
    archivalSupplement: `${cleanRoot}/archival_accession_supplement.md`,
    archivalSupplementJson: `${cleanRoot}/archival_accession_supplement.json`,
    aiEnrichments: `${cleanRoot}/ai-enrichments.json`,
    aardvark: `${cleanRoot}/aardvark.json`,
  };
}

async function objectExists(profile, key) {
  const response = await signedFetch(profile, objectUrl(profile, key), {
    method: "HEAD",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`S3 object check failed for ${key}: ${response.status} ${await response.text()}`);
  return true;
}

async function createMultipartUpload(profile, key, contentType) {
  const response = await signedFetch(profile, objectUrl(profile, key, { uploads: "" }), {
    method: "POST",
    contentType,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 multipart upload creation failed for ${key}: ${response.status} ${text}`);
  const uploadId = tagValues(text, "UploadId")[0] || "";
  if (!uploadId) throw new Error(`S3 multipart upload creation did not return an UploadId for ${key}.`);
  return uploadId;
}

async function uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer) {
  const payloadHash = sha256(partBuffer);
  const response = await signedFetch(profile, objectUrl(profile, key, { partNumber, uploadId }), {
    method: "PUT",
    body: partBuffer,
    payloadHash,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 multipart part ${partNumber} upload failed for ${key}: ${response.status} ${await response.text()}`);
  const etag = response.headers.get("etag") || response.headers.get("ETag") || "";
  if (!etag) throw new Error(`S3 multipart part ${partNumber} upload for ${key} did not return an ETag.`);
  return etag;
}

async function completeMultipartUpload(profile, key, uploadId, parts) {
  const xml = [
    "<CompleteMultipartUpload>",
    ...parts.map((part) => [
      "<Part>",
      `<PartNumber>${part.partNumber}</PartNumber>`,
      `<ETag>${encodeXmlText(part.etag)}</ETag>`,
      "</Part>",
    ].join("")),
    "</CompleteMultipartUpload>",
  ].join("");
  const body = Buffer.from(xml, "utf8");
  const response = await signedFetch(profile, objectUrl(profile, key, { uploadId }), {
    method: "POST",
    body,
    payloadHash: sha256(body),
    contentType: "application/xml",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 multipart completion failed for ${key}: ${response.status} ${await response.text()}`);
}

async function abortMultipartUpload(profile, key, uploadId) {
  if (!uploadId) return;
  const response = await signedFetch(profile, objectUrl(profile, key, { uploadId }), {
    method: "DELETE",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
    retryAttempts: 1,
  });
  if (!response.ok && response.status !== 404) {
    console.warn(`[S3] Multipart abort failed for ${key}: ${response.status} ${await response.text().catch(() => "")}`);
  }
}

async function putObjectBufferMultipart(profile, key, buffer, contentType) {
  const uploadId = await createMultipartUpload(profile, key, contentType);
  const partCount = Math.ceil(buffer.length / S3_MULTIPART_PART_SIZE_BYTES);
  const parts = [];
  try {
    for (let index = 0; index < partCount; index += 1) {
      const partNumber = index + 1;
      const start = index * S3_MULTIPART_PART_SIZE_BYTES;
      const end = Math.min(start + S3_MULTIPART_PART_SIZE_BYTES, buffer.length);
      const partBuffer = buffer.subarray(start, end);
      console.log(`[S3] Uploading multipart part ${partNumber}/${partCount} for ${key} (${formatBytes(partBuffer.length)})`);
      const etag = await uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer);
      parts.push({ partNumber, etag });
    }
    await completeMultipartUpload(profile, key, uploadId, parts);
  } catch (error) {
    await abortMultipartUpload(profile, key, uploadId);
    throw error;
  }
}

async function putObjectFileMultipart(profile, key, filePath, contentType, fileSize) {
  const uploadId = await createMultipartUpload(profile, key, contentType);
  const partCount = Math.ceil(fileSize / S3_MULTIPART_PART_SIZE_BYTES);
  const parts = [];
  let partNumber = 1;
  try {
    for await (const partBuffer of createReadStream(filePath, { highWaterMark: S3_MULTIPART_PART_SIZE_BYTES })) {
      console.log(`[S3] Uploading multipart file part ${partNumber}/${partCount} for ${key} (${formatBytes(partBuffer.length)})`);
      const etag = await uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer);
      parts.push({ partNumber, etag });
      partNumber += 1;
    }
    await completeMultipartUpload(profile, key, uploadId, parts);
  } catch (error) {
    await abortMultipartUpload(profile, key, uploadId);
    throw error;
  }
}

async function putObjectFile(profile, key, filePath, contentType) {
  const info = await stat(filePath);
  if (info.size >= S3_MULTIPART_THRESHOLD_BYTES) {
    await putObjectFileMultipart(profile, key, filePath, contentType, info.size);
    return;
  }
  await putObjectBuffer(profile, key, await readFile(filePath), contentType);
}

async function putObjectBuffer(profile, key, buffer, contentType) {
  if (buffer.length >= S3_MULTIPART_THRESHOLD_BYTES) {
    await putObjectBufferMultipart(profile, key, buffer, contentType);
    return;
  }
  const payloadHash = sha256(buffer);
  const response = await signedFetch(profile, objectUrl(profile, key), {
    method: "PUT",
    body: buffer,
    payloadHash,
    contentType,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 upload failed for ${key}: ${response.status} ${await response.text()}`);
}

async function fetchJsonObject(profile, key) {
  const response = await signedFetch(profile, objectUrl(profile, key), { timeoutMs: S3_OBJECT_TIMEOUT_MS });
  if (!response.ok) throw new Error(`S3 JSON fetch failed for ${key}: ${response.status} ${await response.text()}`);
  return JSON.parse(await response.text());
}

async function listRawObjects(profile, prefixes) {
  const normalizedPrefixes = Array.isArray(prefixes)
    ? Array.from(new Set(prefixes.map((prefix) => String(prefix ?? "").trim())))
    : [""];
  const objects = [];
  for (const prefix of normalizedPrefixes.length > 0 ? normalizedPrefixes : [""]) {
    let token = undefined;
    let pageCount = 0;
    const seenTokens = new Set();
    do {
      pageCount += 1;
      if (pageCount > MAX_LIST_PAGES) {
        throw new Error(`S3 list exceeded ${MAX_LIST_PAGES} page(s) for prefix "${prefix}". Check the prefix or increase ENRICHMENT_PROXY_MAX_LIST_PAGES.`);
      }
      const url = listUrl(profile, prefix, token);
      const response = await signedFetch(profile, url, { timeoutMs: S3_LIST_TIMEOUT_MS });
      if (!response.ok) throw new Error(`S3 list failed for ${profile.name}: ${response.status} ${await response.text()}`);
      const xml = await response.text();
      const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)).map((match) => match[1]);
      for (const item of contents) {
        const key = tagValues(item, "Key")[0];
        if (!key) continue;
        objects.push({
          key,
          size: Number(tagValues(item, "Size")[0] || 0),
          etag: (tagValues(item, "ETag")[0] || "").replace(/^"|"$/g, ""),
          lastModified: tagValues(item, "LastModified")[0] || "",
        });
      }
      const nextToken = tagValues(xml, "NextContinuationToken")[0] || undefined;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`S3 list returned a repeated continuation token for prefix "${prefix}" after ${pageCount} page(s).`);
      }
      if (nextToken) seenTokens.add(nextToken);
      token = nextToken;
    } while (token);
  }
  return objects;
}

async function listObjects(profile) {
  const normalizedPrefixes = Array.isArray(profile.prefixes)
    ? Array.from(new Set(profile.prefixes.map((prefix) => String(prefix ?? "").trim())))
    : [];
  const prefixes = normalizedPrefixes.length > 0 ? normalizedPrefixes : [""];
  const assets = [];
  let skipped = 0;
  for (const prefix of prefixes) {
    let token = undefined;
    let pageCount = 0;
    const seenTokens = new Set();
    do {
      pageCount += 1;
      if (pageCount > MAX_LIST_PAGES) {
        throw new Error(`S3 list exceeded ${MAX_LIST_PAGES} page(s) for prefix "${prefix}". Check the prefix or increase ENRICHMENT_PROXY_MAX_LIST_PAGES.`);
      }
      const url = listUrl(profile, prefix, token);
      const response = await signedFetch(profile, url, { timeoutMs: S3_LIST_TIMEOUT_MS });
      if (!response.ok) throw new Error(`S3 list failed for ${profile.name}: ${response.status} ${await response.text()}`);
      const xml = await response.text();
      const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)).map((match) => match[1]);
      for (const item of contents) {
        const key = tagValues(item, "Key")[0];
        if (!key) continue;
        const size = Number(tagValues(item, "Size")[0] || 0);
        const lastModified = tagValues(item, "LastModified")[0] || "";
        const etag = (tagValues(item, "ETag")[0] || "").replace(/^"|"$/g, "");
        if (!isSupportedRaster(key)) {
          skipped += 1;
          assets.push({
            id: `${profile.id}:${profile.bucket}/${key}`,
            storage_profile_id: profile.id,
            bucket: profile.bucket,
            object_key: key,
            url: publicUrlFor(profile, key),
            size_bytes: size,
            etag,
            last_modified: lastModified,
            content_type: contentTypeForKey(key),
            status: "skipped",
            metadata_json: safeJsonStringify({ reason: "Unsupported raster extension" }),
          });
          continue;
        }
        assets.push({
          id: `${profile.id}:${profile.bucket}/${key}`,
          storage_profile_id: profile.id,
          bucket: profile.bucket,
          object_key: key,
          url: publicUrlFor(profile, key),
          size_bytes: size,
          etag,
          last_modified: lastModified,
          content_type: contentTypeForKey(key),
          status: "ready",
          metadata_json: "{}",
        });
      }
      const nextToken = tagValues(xml, "NextContinuationToken")[0] || undefined;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`S3 list returned a repeated continuation token for prefix "${prefix}" after ${pageCount} page(s).`);
      }
      if (nextToken) seenTokens.add(nextToken);
      token = nextToken;
    } while (token);
  }
  return { assets, skipped };
}

async function fetchObjectBuffer(profile, key) {
  if (profile.publicBaseUrl) {
    const publicUrl = publicUrlFor(profile, key);
    const response = await fetch(publicUrl);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  }
  const url = objectUrl(profile, key);
  const response = await signedFetch(profile, url, { timeoutMs: S3_OBJECT_TIMEOUT_MS });
  if (!response.ok) throw new Error(`S3 object fetch failed: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

function imageExtensionForContentType(contentType) {
  if (/png/i.test(String(contentType))) return ".png";
  if (/webp/i.test(String(contentType))) return ".webp";
  if (/tiff?/i.test(String(contentType))) return ".tif";
  return ".jpg";
}

async function withTempImageFiles(buffer, contentType, callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "ogm-vision-"));
  try {
    const inputPath = path.join(dir, `input${imageExtensionForContentType(contentType)}`);
    const outputPath = path.join(dir, "output.jpg");
    await writeFile(inputPath, buffer);
    return await callback({ inputPath, outputPath, dir });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseSipsDimension(output, key) {
  const match = String(output || "").match(new RegExp(`${key}:\\s*(\\d+)`));
  return match ? Number(match[1]) : 0;
}

async function sipsImageDimensionsFromBuffer(buffer, contentType) {
  return withTempImageFiles(buffer, contentType, async ({ inputPath }) => {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", inputPath]);
    return {
      width: parseSipsDimension(stdout, "pixelWidth"),
      height: parseSipsDimension(stdout, "pixelHeight"),
    };
  });
}

async function createAnalysisDerivativesFromBuffer(buffer, contentType, assetId) {
  const sharp = await loadSharp();
  if (!sharp) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error("The optional sharp package is required to render TIFF/JP2 imagery.");
    }
    return [{
      id: `${assetId}:original`,
      kind: "original",
      dataUri: `data:${contentType};base64,${buffer.toString("base64")}`,
      mimeType: contentType,
      bytes: buffer.length,
      status: "ready",
    }];
  }

  const image = sharp(buffer, { limitInputPixels: false });
  const meta = await image.metadata();
  const derivatives = [];
  const overview = await sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
  derivatives.push({
    id: `${assetId}:overview`,
    kind: "overview",
    dataUri: `data:image/jpeg;base64,${overview.data.toString("base64")}`,
    width: overview.info.width,
    height: overview.info.height,
    mimeType: "image/jpeg",
    bytes: overview.data.length,
    status: "ready",
  });

  if (meta.width && meta.height && Math.max(meta.width, meta.height) > 2200) {
    const cols = 2;
    const rows = 2;
    const tileWidth = Math.floor(meta.width / cols);
    const tileHeight = Math.floor(meta.height / rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const left = x * tileWidth;
        const top = y * tileHeight;
        const width = x === cols - 1 ? meta.width - left : tileWidth;
        const height = y === rows - 1 ? meta.height - top : tileHeight;
        const tile = await sharp(buffer, { limitInputPixels: false })
          .extract({ left, top, width, height })
          .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 86 })
          .toBuffer({ resolveWithObject: true });
        derivatives.push({
          id: `${assetId}:tile-${x}-${y}`,
          kind: `tile-${x}-${y}`,
          dataUri: `data:image/jpeg;base64,${tile.data.toString("base64")}`,
          width: tile.info.width,
          height: tile.info.height,
          mimeType: "image/jpeg",
          bytes: tile.data.length,
          status: "ready",
        });
      }
    }
  }

  return derivatives;
}

async function createVisionAugmentationDerivativeFromOcrSource(source, assetId, sequence) {
  const sharp = await loadSharp();
  let data = source.buffer;
  let width = source.width || 0;
  let height = source.height || 0;
  let mimeType = source.mimeType || "image/jpeg";

  if (sharp && data && Math.max(width, height) > OPENAI_VISION_AUGMENT_MAX_DIMENSION) {
    const rendered = await sharp(data, { limitInputPixels: false })
      .rotate()
      .resize({
        width: OPENAI_VISION_AUGMENT_MAX_DIMENSION,
        height: OPENAI_VISION_AUGMENT_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColorspace("srgb")
      .jpeg({ quality: Math.max(50, Math.min(95, OPENAI_VISION_AUGMENT_JPEG_QUALITY)), mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    data = rendered.data;
    width = rendered.info.width || width;
    height = rendered.info.height || height;
    mimeType = "image/jpeg";
  }

  return withoutUndefined({
    id: `${assetId}:${source.sourceId || `ocr-source-${sequence + 1}`}`,
    kind: source.sourceKind === "tile" ? "ocr_tile" : "ocr_full",
    dataUri: data ? `data:${mimeType};base64,${data.toString("base64")}` : undefined,
    width,
    height,
    mimeType,
    bytes: data?.length || source.normalizedBytes || source.buffer?.length || 0,
    status: "ready",
    sourceImageId: source.sourceId || `ocr-source-${sequence + 1}`,
    sourceImageKind: source.sourceKind || "full",
    region: source.region,
    coordinateWidth: source.coordinateWidth,
    coordinateHeight: source.coordinateHeight,
    notes: source.sourceKind === "tile"
      ? "OpenAI vision augmentation image generated from the same OCR tile region submitted to Google Cloud Vision."
      : "OpenAI vision augmentation image generated from the same normalized full-image source submitted to Google Cloud Vision.",
  });
}

async function createVisionAugmentationDerivatives({ buffer, contentType, assetId, visionSources }) {
  const sources = Array.isArray(visionSources?.sources) ? visionSources.sources : [];
  if (!OPENAI_VISION_AUGMENT_USE_OCR_SOURCES || sources.length === 0) {
    return createAnalysisDerivativesFromBuffer(buffer, contentType, assetId);
  }
  const selectedSources = sources.slice(0, OPENAI_VISION_AUGMENT_MAX_IMAGES);
  return Promise.all(selectedSources.map((source, index) => createVisionAugmentationDerivativeFromOcrSource(source, assetId, index)));
}

function buildGeminiTextExtractionTiles(width, height) {
  if (!GEMINI_TEXT_EXTRACT_USE_SMALL_CROPS || width <= 0 || height <= 0) return [];
  let tileSize = GEMINI_TEXT_EXTRACT_CROP_SIZE;
  const maxCrops = GEMINI_TEXT_EXTRACT_MAX_CROPS;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const overlap = Math.max(0, Math.min(GEMINI_TEXT_EXTRACT_CROP_OVERLAP, tileSize - 1));
    const step = Math.max(1, tileSize - overlap);
    const tiles = [];
    for (let top = 0; top < height;) {
      const bottom = Math.min(height, top + tileSize);
      const actualTop = Math.max(0, bottom - tileSize);
      for (let left = 0; left < width;) {
        const right = Math.min(width, left + tileSize);
        const actualLeft = Math.max(0, right - tileSize);
        const tile = {
          left: Math.round(actualLeft),
          top: Math.round(actualTop),
          width: Math.round(right - actualLeft),
          height: Math.round(bottom - actualTop),
        };
        if (!tiles.some((existing) => existing.left === tile.left && existing.top === tile.top)) tiles.push(tile);
        if (right >= width) break;
        left += step;
      }
      if (bottom >= height) break;
      top += step;
    }
    if (tiles.length <= maxCrops || attempt === 7) return tiles;
    tileSize = Math.ceil(tileSize * 1.18);
  }
  return [];
}

function normalizedBoxFromValue(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const x1 = Math.max(0, Math.min(1, Math.min(numbers[0], numbers[2])));
  const y1 = Math.max(0, Math.min(1, Math.min(numbers[1], numbers[3])));
  const x2 = Math.max(0, Math.min(1, Math.max(numbers[0], numbers[2])));
  const y2 = Math.max(0, Math.min(1, Math.max(numbers[1], numbers[3])));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function normalizedTileBbox(tile, coordinateWidth, coordinateHeight) {
  const width = Number(coordinateWidth || 0);
  const height = Number(coordinateHeight || 0);
  if (width <= 0 || height <= 0) return null;
  return normalizedBoxFromValue([
    Number(tile?.left || 0) / width,
    Number(tile?.top || 0) / height,
    (Number(tile?.left || 0) + Number(tile?.width || 0)) / width,
    (Number(tile?.top || 0) + Number(tile?.height || 0)) / height,
  ]);
}

function normalizedBoxIntersectionArea(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const x1 = Math.max(Number(a[0]), Number(b[0]));
  const y1 = Math.max(Number(a[1]), Number(b[1]));
  const x2 = Math.min(Number(a[2]), Number(b[2]));
  const y2 = Math.min(Number(a[3]), Number(b[3]));
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function normalizedBoxCenterInside(box, container) {
  if (!Array.isArray(box) || !Array.isArray(container) || box.length !== 4 || container.length !== 4) return false;
  const x = (Number(box[0]) + Number(box[2])) / 2;
  const y = (Number(box[1]) + Number(box[3])) / 2;
  return x >= container[0] && x <= container[2] && y >= container[1] && y <= container[3];
}

function textReconciliationTargetCrops(request = {}, provider = "gemini") {
  const providerSpecific = provider === "openai"
    ? request.openaiTextReconciliationTargetCrops ?? request.openaiTextExtractionTargetCrops
    : provider === "kimi"
      ? request.kimiAgentSwarmTargetCrops ?? request.kimiTextExtractionTargetCrops
    : request.geminiTextExtractionTargetCrops;
  const value = Number(
    providerSpecific
    ?? request.textExtractionTargetCrops
    ?? request.mapLabelReconciliationTargetCrops
    ?? GEMINI_TEXT_EXTRACT_TARGET_CROPS,
  );
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function ocrEvidenceForTextReconciliationTiles(ocrExtraction) {
  return [
    ...asArray(ocrExtraction?.text).map((entry, index) => ({ entry, index, kind: "text", weight: 1 })),
    ...asArray(ocrExtraction?.text_groups).map((entry, index) => ({ entry, index, kind: "text_group", weight: 1.35 })),
  ].map(({ entry, index, kind, weight }) => {
    const content = String(entry?.content || "").trim();
    const bbox = normalizedBoxFromValue(entry?.approx_bbox || entry?.approxBbox);
    if (!content || !bbox) return null;
    return {
      content,
      bbox,
      kind,
      index,
      role: String(entry?.role || "other").toLowerCase(),
      confidence: Math.max(0, Math.min(1, Number(entry?.confidence ?? 0.8))),
      weight,
    };
  }).filter(Boolean);
}

function mapTextSelectionBonus(content, role) {
  const normalized = normalizedContentKey(content);
  if (!normalized) return 0;
  let score = 0;
  if (["waterbody", "park", "landmark", "neighborhood", "railroad", "ferry"].includes(role)) score += 1.1;
  if (["street", "route"].includes(role)) score += 0.45;
  if (/\b(?:park|lake|bay|sound|waterway|canal|harbor|harbour|point|beach|cemetery|golf|club|field|terminal|dock|ferry|station|railway|railroad|district)\b/i.test(content)) score += 0.85;
  if (/\b(?:st|street|ave|avenue|blvd|boulevard|way|road|rd|pl|place|ct|court)\b\.?$/i.test(content)) score += 0.25;
  if (/^\d+$/.test(normalized)) score -= 0.25;
  return score;
}

function scoreTextReconciliationTile(tile, { coordinateWidth, coordinateHeight, ocrEvidence }) {
  const tileBbox = normalizedTileBbox(tile, coordinateWidth, coordinateHeight);
  if (!tileBbox) return { score: 0, evidenceCount: 0, lowConfidenceCount: 0, featureHintCount: 0 };

  let score = 0;
  let evidenceCount = 0;
  let lowConfidenceCount = 0;
  let featureHintCount = 0;
  for (const evidence of ocrEvidence) {
    const intersection = normalizedBoxIntersectionArea(evidence.bbox, tileBbox);
    const centerInside = normalizedBoxCenterInside(evidence.bbox, tileBbox);
    if (!centerInside && intersection <= 0) continue;
    const overlapWeight = centerInside
      ? 1
      : Math.min(0.65, intersection / Math.max(normalizedBoxArea(evidence.bbox), 0.000001));
    const lowConfidenceBonus = evidence.confidence < 0.78 ? (0.78 - evidence.confidence) * 3 : 0;
    const featureBonus = mapTextSelectionBonus(evidence.content, evidence.role);
    const lengthBonus = Math.min(0.9, normalizedContentKey(evidence.content).length / 28);
    score += Math.max(0.15, evidence.weight + lowConfidenceBonus + featureBonus + lengthBonus) * overlapWeight;
    evidenceCount += 1;
    if (lowConfidenceBonus > 0) lowConfidenceCount += 1;
    if (featureBonus >= 0.5) featureHintCount += 1;
  }
  return {
    score: Number(score.toFixed(4)),
    evidenceCount,
    lowConfidenceCount,
    featureHintCount,
  };
}

function evenlySelectedTileIndices(totalCount, targetCount) {
  const selected = new Set();
  if (targetCount <= 0 || targetCount >= totalCount) {
    for (let index = 0; index < totalCount; index += 1) selected.add(index);
    return selected;
  }
  const stride = totalCount / targetCount;
  for (let index = 0; index < targetCount; index += 1) {
    selected.add(Math.min(totalCount - 1, Math.floor((index + 0.5) * stride)));
  }
  for (let index = 0; selected.size < targetCount && index < totalCount; index += 1) {
    selected.add(index);
  }
  return selected;
}

function selectTextReconciliationTiles(tiles, { coordinateWidth, coordinateHeight, ocrExtraction, targetCrops } = {}) {
  const tileList = Array.isArray(tiles) ? tiles : [];
  const target = Math.max(0, Math.floor(Number(targetCrops) || 0));
  const ocrEvidence = ocrEvidenceForTextReconciliationTiles(ocrExtraction);
  const scored = tileList.map((tile, originalIndex) => {
    const metrics = scoreTextReconciliationTile(tile, { coordinateWidth, coordinateHeight, ocrEvidence });
    return { tile, originalIndex, ...metrics };
  });

  if (target <= 0 || target >= scored.length) {
    return scored.map((item) => ({
      ...item.tile,
      selection: {
        strategy: "all_crops",
        originalIndex: item.originalIndex,
        selectionCandidateCount: scored.length,
        selectionTargetCount: target,
        selectionScore: item.score,
        ocrEvidenceCount: ocrEvidence.length,
        tileEvidenceCount: item.evidenceCount,
        lowConfidenceCount: item.lowConfidenceCount,
        featureHintCount: item.featureHintCount,
      },
    }));
  }

  const ranked = [...scored].sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  const hasPositiveEvidenceScore = ranked.some((item) => item.score > 0);
  const selectedIndices = hasPositiveEvidenceScore
    ? new Set(ranked.slice(0, target).map((item) => item.originalIndex))
    : evenlySelectedTileIndices(scored.length, target);
  const rankByIndex = new Map(ranked.map((item, index) => [item.originalIndex, index + 1]));
  const strategy = hasPositiveEvidenceScore ? "ocr_evidence_budget_v1" : "even_grid_budget_v1";

  return scored
    .filter((item) => selectedIndices.has(item.originalIndex))
    .map((item) => ({
      ...item.tile,
      selection: {
        strategy,
        originalIndex: item.originalIndex,
        selectionRank: rankByIndex.get(item.originalIndex),
        selectionCandidateCount: scored.length,
        selectionTargetCount: target,
        selectionScore: item.score,
        ocrEvidenceCount: ocrEvidence.length,
        tileEvidenceCount: item.evidenceCount,
        lowConfidenceCount: item.lowConfidenceCount,
        featureHintCount: item.featureHintCount,
      },
    }));
}

async function createTextReconciliationDerivatives({ buffer, contentType, assetId, visionSources, provider = "gemini", ocrExtraction, request = {} }) {
  if (!GEMINI_TEXT_EXTRACT_USE_SMALL_CROPS) {
    return createVisionAugmentationDerivatives({ buffer, contentType, assetId, visionSources });
  }
  const sharp = await loadSharp();
  if (!sharp) {
    return createVisionAugmentationDerivatives({ buffer, contentType, assetId, visionSources });
  }
  const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
  const coordinateWidth = Number(visionSources?.summary?.coordinateWidth || metadata.width || 0);
  const coordinateHeight = Number(visionSources?.summary?.coordinateHeight || metadata.height || 0);
  const tiles = buildGeminiTextExtractionTiles(coordinateWidth, coordinateHeight);
  if (tiles.length === 0) {
    return createVisionAugmentationDerivatives({ buffer, contentType, assetId, visionSources });
  }
  const targetCrops = textReconciliationTargetCrops(request, provider);
  const selectedTiles = selectTextReconciliationTiles(tiles, {
    coordinateWidth,
    coordinateHeight,
    ocrExtraction,
    targetCrops,
  });

  const derivatives = [];
  const isOpenAI = provider === "openai";
  const isKimi = provider === "kimi";
  const cropPrefix = isOpenAI ? "openai-reconcile-crop" : isKimi ? "kimi-swarm-crop" : "gemini-crop";
  const cropKind = isOpenAI ? "openai_text_reconciliation_crop" : isKimi ? "kimi_agent_swarm_crop" : "gemini_text_crop";
  for (const [index, tile] of selectedTiles.entries()) {
    const cropNumber = Number.isInteger(tile.selection?.originalIndex) ? tile.selection.originalIndex + 1 : index + 1;
    const cropId = `${cropPrefix}-${String(cropNumber).padStart(3, "0")}`;
    const tileRegion = {
      left: tile.left,
      top: tile.top,
      width: tile.width,
      height: tile.height,
    };
    const rendered = await sharp(buffer, { limitInputPixels: false })
      .rotate()
      .extract(tileRegion)
      .toColorspace("srgb")
      .jpeg({ quality: GEMINI_TEXT_EXTRACT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    derivatives.push({
      id: `${assetId}:${cropId}`,
      kind: cropKind,
      dataUri: `data:image/jpeg;base64,${rendered.data.toString("base64")}`,
      width: rendered.info.width || tile.width,
      height: rendered.info.height || tile.height,
      mimeType: "image/jpeg",
      bytes: rendered.data.length,
      status: "ready",
      sourceImageId: cropId,
      sourceImageKind: cropKind,
      region: tileRegion,
      coordinateWidth,
      coordinateHeight,
      tileSelection: tile.selection,
      notes: isOpenAI
        ? "OpenAI map-label reconciliation crop rendered from the original image at map-coordinate resolution."
        : isKimi
          ? "Kimi map-agent swarm crop rendered from the original image at map-coordinate resolution."
        : "Gemini exhaustive text extraction crop rendered from the original image at map-coordinate resolution.",
    });
  }
  return derivatives;
}

async function createGeminiTextExtractionDerivatives(args) {
  return createTextReconciliationDerivatives({ ...args, provider: "gemini" });
}

async function createOpenAITextReconciliationDerivatives(args) {
  return createTextReconciliationDerivatives({ ...args, provider: "openai" });
}

async function createKimiAgentSwarmDerivatives(args) {
  return createTextReconciliationDerivatives({ ...args, provider: "kimi" });
}

async function createTextReconciliationDerivativesForProfile(modelProfile, args) {
  if (shouldReconcileLabelsWithOpenAI(modelProfile, args.request)) {
    return createOpenAITextReconciliationDerivatives({
      ...args,
      assetId: `${args.assetId}:openai-label-reconciliation`,
    });
  }
  if (shouldRunKimiAgentSwarm(modelProfile, args.request)) {
    return createKimiAgentSwarmDerivatives({
      ...args,
      assetId: `${args.assetId}:kimi-agent-swarm`,
    });
  }
  return createGeminiTextExtractionDerivatives({
    ...args,
    assetId: `${args.assetId}:gemini-label-extraction`,
  });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

async function renderVisionJpeg(buffer, maxDimension, quality) {
  const sharp = await loadSharp();
  const image = sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColorspace("srgb")
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return image;
}

async function renderVisionJpegWithSips(buffer, contentType, maxDimension, quality) {
  return withTempImageFiles(buffer, contentType, async ({ inputPath, outputPath }) => {
    await execFileAsync("sips", [
      "-Z", String(maxDimension),
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(Math.max(0, Math.min(100, quality))),
      "-o", outputPath,
      inputPath,
    ]);
    const data = await readFile(outputPath);
    const dimensions = await sipsImageDimensionsFromBuffer(data, "image/jpeg");
    return { data, info: { width: dimensions.width, height: dimensions.height } };
  });
}

function buildVisionTiles(width, height) {
  if (!GOOGLE_VISION_TILE_OCR_ENABLED || width <= 0 || height <= 0) return [];
  if (Math.max(width, height) < GOOGLE_VISION_TILE_MIN_DIMENSION) return [];
  const overlap = Math.max(0, Math.min(GOOGLE_VISION_TILE_OVERLAP, GOOGLE_VISION_TILE_SIZE - 1));
  let tileSize = Math.max(1000, GOOGLE_VISION_TILE_SIZE);
  let tiles = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const step = Math.max(1, tileSize - overlap);
    tiles = [];
    for (let top = 0; top < height;) {
      const bottom = Math.min(height, top + tileSize);
      const actualTop = Math.max(0, bottom - tileSize);
      for (let left = 0; left < width;) {
        const right = Math.min(width, left + tileSize);
        const actualLeft = Math.max(0, right - tileSize);
        const tile = {
          left: Math.round(actualLeft),
          top: Math.round(actualTop),
          width: Math.round(right - actualLeft),
          height: Math.round(bottom - actualTop),
        };
        if (!tiles.some((existing) => existing.left === tile.left && existing.top === tile.top)) tiles.push(tile);
        if (right >= width) break;
        left += step;
      }
      if (bottom >= height) break;
      top += step;
    }
    if (tiles.length <= GOOGLE_VISION_TILE_MAX_COUNT) break;
    tileSize = Math.ceil(tileSize * 1.2);
  }
  return tiles.slice(0, Math.max(0, GOOGLE_VISION_TILE_MAX_COUNT));
}

async function renderVisionTileJpeg(buffer, tile) {
  const sharp = await loadSharp();
  let quality = Math.max(50, Math.min(95, GOOGLE_VISION_TILE_JPEG_QUALITY));
  let best = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rendered = await sharp(buffer, { limitInputPixels: false })
      .rotate()
      .extract(tile)
      .toColorspace("srgb")
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (!best || rendered.data.length < best.data.length) best = rendered;
    if (rendered.data.length <= GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) return rendered;
    quality -= 8;
  }
  if (!best || best.data.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
    throw new Error(`Google Cloud Vision tile remains too large after normalization (${formatBytes(best?.data?.length || 0)} at ${tile.width}x${tile.height}).`);
  }
  return best;
}

async function renderVisionTileJpegWithSips(buffer, contentType, tile) {
  let quality = Math.max(50, Math.min(100, GOOGLE_VISION_TILE_JPEG_QUALITY));
  let best = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rendered = await withTempImageFiles(buffer, contentType, async ({ inputPath, outputPath }) => {
      await execFileAsync("sips", [
        "-c", String(tile.height), String(tile.width),
        "--cropOffset", String(tile.top), String(tile.left),
        "-s", "format", "jpeg",
        "-s", "formatOptions", String(quality),
        "-o", outputPath,
        inputPath,
      ]);
      const data = await readFile(outputPath);
      const dimensions = await sipsImageDimensionsFromBuffer(data, "image/jpeg");
      return { data, info: { width: dimensions.width, height: dimensions.height } };
    });
    if (!best || rendered.data.length < best.data.length) best = rendered;
    if (rendered.data.length <= GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) return rendered;
    quality -= 8;
  }
  if (!best || best.data.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
    throw new Error(`Google Cloud Vision sips tile remains too large after normalization (${formatBytes(best?.data?.length || 0)} at ${tile.width}x${tile.height}).`);
  }
  return best;
}

function sipsTileCropOffset(value) {
  const offset = Math.round(Number(value) || 0);
  // sips treats a 0,0 crop offset as an unspecified/default centered crop, so
  // edge tiles need a one-pixel nudge to remain anchored near the image origin.
  return Math.max(1, offset);
}

async function createVisionImageBuffer(buffer, contentType) {
  const sharp = await loadSharp();
  if (!sharp) {
    let maxDimension = GOOGLE_VISION_MAX_DIMENSION;
    let quality = 90;
    let best = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const rendered = await renderVisionJpegWithSips(buffer, contentType, maxDimension, quality);
      if (!best || rendered.data.length < best.data.length) best = rendered;
      if (rendered.data.length <= GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
        return {
          buffer: rendered.data,
          mimeType: "image/jpeg",
          width: rendered.info.width || 0,
          height: rendered.info.height || 0,
          originalBytes: buffer.length,
          normalizedBytes: rendered.data.length,
          maxDimension,
          quality,
          renderer: "sips",
        };
      }
      if (quality > 70) {
        quality -= 10;
      } else if (maxDimension > GOOGLE_VISION_MIN_DIMENSION) {
        maxDimension = Math.max(GOOGLE_VISION_MIN_DIMENSION, Math.floor(maxDimension * 0.75));
        quality = 82;
      } else {
        quality = Math.max(50, quality - 10);
      }
    }
    if (!best || best.data.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
      throw new Error(`Google Cloud Vision inline image remains too large after sips normalization (${formatBytes(best?.data?.length || buffer.length)}). Install sharp or reduce the source image so the JSON OCR request stays under ${formatBytes(GOOGLE_VISION_JSON_LIMIT_BYTES)}.`);
    }
    return {
      buffer: best.data,
      mimeType: "image/jpeg",
      width: best.info.width || 0,
      height: best.info.height || 0,
      originalBytes: buffer.length,
      normalizedBytes: best.data.length,
      maxDimension,
      quality,
      renderer: "sips",
    };
  }

  let maxDimension = GOOGLE_VISION_MAX_DIMENSION;
  let quality = 90;
  let best = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rendered = await renderVisionJpeg(buffer, maxDimension, quality);
    if (!best || rendered.data.length < best.data.length) best = rendered;
    if (rendered.data.length <= GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
      return {
        buffer: rendered.data,
        mimeType: "image/jpeg",
        width: rendered.info.width || 0,
        height: rendered.info.height || 0,
        originalBytes: buffer.length,
        normalizedBytes: rendered.data.length,
        maxDimension,
        quality,
        renderer: "sharp",
      };
    }
    if (quality > 70) {
      quality -= 10;
    } else if (maxDimension > GOOGLE_VISION_MIN_DIMENSION) {
      maxDimension = Math.max(GOOGLE_VISION_MIN_DIMENSION, Math.floor(maxDimension * 0.75));
      quality = 82;
    } else {
      quality = Math.max(50, quality - 10);
    }
  }

  if (!best) throw new Error("Google Cloud Vision image normalization failed.");
  if (best.data.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
    throw new Error(`Google Cloud Vision inline image remains too large after normalization (${formatBytes(best.data.length)} at ${best.info.width || 0}x${best.info.height || 0}). The JSON OCR request must stay under ${formatBytes(GOOGLE_VISION_JSON_LIMIT_BYTES)}.`);
  }
  return {
    buffer: best.data,
    mimeType: "image/jpeg",
    width: best.info.width || 0,
    height: best.info.height || 0,
    originalBytes: buffer.length,
    normalizedBytes: best.data.length,
    maxDimension,
    quality,
    renderer: "sharp",
  };
}

async function createVisionOcrSources(buffer, contentType) {
  const primary = await createVisionImageBuffer(buffer, contentType);
  const sharp = await loadSharp();
  if (!GOOGLE_VISION_TILE_OCR_ENABLED) {
    return {
      primary,
      sources: [{
        ...primary,
        sourceId: "ocr-source-full",
        sourceKind: "full",
        coordinateWidth: primary.width,
        coordinateHeight: primary.height,
        region: { left: 0, top: 0, width: primary.width, height: primary.height },
      }],
      summary: {
        strategy: "single_normalized_image",
        tileCount: 0,
        coordinateWidth: primary.width,
        coordinateHeight: primary.height,
      },
    };
  }

  const metadata = sharp
    ? await sharp(buffer, { limitInputPixels: false }).metadata()
    : await sipsImageDimensionsFromBuffer(buffer, contentType);
  const coordinateWidth = Number(metadata.width || primary.width || 0);
  const coordinateHeight = Number(metadata.height || primary.height || 0);
  const tiles = buildVisionTiles(coordinateWidth, coordinateHeight);
  const sources = [{
    ...primary,
    sourceId: "ocr-source-full",
    sourceKind: "full",
    coordinateWidth,
    coordinateHeight,
    region: { left: 0, top: 0, width: coordinateWidth, height: coordinateHeight },
  }];

  for (const [index, tile] of tiles.entries()) {
    const renderTile = sharp
      ? tile
      : {
        ...tile,
        left: sipsTileCropOffset(tile.left),
        top: sipsTileCropOffset(tile.top),
      };
    const rendered = sharp
      ? await renderVisionTileJpeg(buffer, renderTile)
      : await renderVisionTileJpegWithSips(buffer, contentType, renderTile);
    sources.push({
      buffer: rendered.data,
      mimeType: "image/jpeg",
      width: rendered.info.width || renderTile.width,
      height: rendered.info.height || renderTile.height,
      originalBytes: buffer.length,
      normalizedBytes: rendered.data.length,
      sourceId: `ocr-source-tile-${String(index + 1).padStart(2, "0")}`,
      sourceKind: "tile",
      coordinateWidth,
      coordinateHeight,
      region: renderTile,
      quality: GOOGLE_VISION_TILE_JPEG_QUALITY,
      renderer: sharp ? "sharp" : "sips",
    });
  }

  return {
    primary,
    sources,
    summary: {
      strategy: tiles.length > 0 ? "full_image_plus_overlapping_tiles" : "single_normalized_image",
      tileCount: tiles.length,
      tileSize: GOOGLE_VISION_TILE_SIZE,
      tileOverlap: GOOGLE_VISION_TILE_OVERLAP,
      tileMaxCount: GOOGLE_VISION_TILE_MAX_COUNT,
      coordinateWidth,
      coordinateHeight,
      renderer: sharp ? "sharp" : "sips",
    },
  };
}

function bboxFromBoundingPoly(poly, width, height) {
  const box = pixelBoxFromBoundingPoly(poly, width, height);
  if (!box) return null;
  const x1 = Math.max(0, Math.min(1, box.x1 / width));
  const y1 = Math.max(0, Math.min(1, box.y1 / height));
  const x2 = Math.max(0, Math.min(1, box.x2 / width));
  const y2 = Math.max(0, Math.min(1, box.y2 / height));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function normalizedPolygonFromBoundingPoly(poly, width, height) {
  const vertices = Array.isArray(poly?.vertices) ? poly.vertices : [];
  if (vertices.length === 0 || width <= 0 || height <= 0) return null;
  const points = vertices.map((vertex) => {
    const x = Number(vertex?.x ?? 0);
    const y = Number(vertex?.y ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [
      Math.max(0, Math.min(1, x / width)),
      Math.max(0, Math.min(1, y / height)),
    ];
  }).filter(Boolean);
  return points.length >= 3 ? points : null;
}

function reprojectSourceX(source, value) {
  const region = source?.region;
  const coordinateWidth = Number(source?.coordinateWidth || 0);
  if (!region || coordinateWidth <= 0) return value;
  return Math.max(0, Math.min(1, (region.left + value * region.width) / coordinateWidth));
}

function reprojectSourceY(source, value) {
  const region = source?.region;
  const coordinateHeight = Number(source?.coordinateHeight || 0);
  if (!region || coordinateHeight <= 0) return value;
  return Math.max(0, Math.min(1, (region.top + value * region.height) / coordinateHeight));
}

function reprojectTextEntryToFullImage(entry, source) {
  const region = source?.region;
  if (!region || source?.sourceKind === "full") return entry;
  const bbox = Array.isArray(entry?.approx_bbox) && entry.approx_bbox.length === 4
    ? [
      reprojectSourceX(source, Number(entry.approx_bbox[0])),
      reprojectSourceY(source, Number(entry.approx_bbox[1])),
      reprojectSourceX(source, Number(entry.approx_bbox[2])),
      reprojectSourceY(source, Number(entry.approx_bbox[3])),
    ]
    : entry?.approx_bbox;
  const polygon = Array.isArray(entry?.approx_polygon)
    ? entry.approx_polygon.map((point) => Array.isArray(point) && point.length >= 2
      ? [reprojectSourceX(source, Number(point[0])), reprojectSourceY(source, Number(point[1]))]
      : point)
    : entry?.approx_polygon;
  return {
    ...entry,
    approx_bbox: bbox,
    approx_polygon: polygon,
  };
}

function pixelBoxFromBoundingPoly(poly, width, height) {
  const vertices = Array.isArray(poly?.vertices) ? poly.vertices : [];
  if (vertices.length === 0 || width <= 0 || height <= 0) return null;
  const xs = vertices.map((vertex) => Number(vertex?.x ?? 0)).filter(Number.isFinite);
  const ys = vertices.map((vertex) => Number(vertex?.y ?? 0)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  const x1 = Math.max(0, Math.min(width, Math.min(...xs)));
  const y1 = Math.max(0, Math.min(height, Math.min(...ys)));
  const x2 = Math.max(0, Math.min(width, Math.max(...xs)));
  const y2 = Math.max(0, Math.min(height, Math.max(...ys)));
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1,
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
  };
}

function textFromVisionWord(word) {
  return (word?.symbols || []).map((symbol) => symbol?.text || "").join("");
}

function textRoleForOcrText(text) {
  if (/[°º]\s*\d+|[NSWE]\b/.test(text)) return "coordinate";
  if (/\bscale\b|(?:\d+\s*(?:mile|miles|km|kilometer|kilometers))\b/i.test(text)) return "scale";
  if (/\blegend\b|explanation/i.test(text)) return "legend";
  return "other";
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function normalizedMergedBox(items, pageWidth, pageHeight) {
  const x1 = Math.min(...items.map((item) => item.box.x1));
  const y1 = Math.min(...items.map((item) => item.box.y1));
  const x2 = Math.max(...items.map((item) => item.box.x2));
  const y2 = Math.max(...items.map((item) => item.box.y2));
  return [
    Math.max(0, Math.min(1, x1 / pageWidth)),
    Math.max(0, Math.min(1, y1 / pageHeight)),
    Math.max(0, Math.min(1, x2 / pageWidth)),
    Math.max(0, Math.min(1, y2 / pageHeight)),
  ];
}

const OCR_TEXT_GROUPING_STRATEGY = "deterministic_collinear_bbox_clustering_v2";

function isGroupableOcrText(entry) {
  const content = String(entry?.content || "").trim();
  const role = String(entry?.role || "other").toLowerCase();
  if (!content || content.length < 2 || content.length > 48 || content.includes("\n")) return false;
  if (["coordinate", "scale", "legend"].includes(role)) return false;
  if (!/[A-Za-z]/.test(content)) return false;
  const compact = content.replace(/\s+/g, "");
  if (!compact) return false;
  const alphaCount = (compact.match(/[A-Za-z]/g) || []).length;
  if (alphaCount / compact.length < 0.5) return false;
  if (/^[ivxlcdm]+$/i.test(compact) && compact.length <= 4) return false;
  return true;
}

function mapLabelTokens(content) {
  return String(content || "")
    .replace(/[^\p{L}\p{N}'&.-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
}

function normalizeMapLabel(content) {
  const tokens = mapLabelTokens(content)
    .map((token) => token.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"))
    .filter((token) => /[A-Za-z]/.test(token));
  if (tokens.length === 0) return "";
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

function titleizeMapLabel(label) {
  return String(label || "")
    .split(/\s+/)
    .map((token) => {
      if (/^(?:[A-Z]{1,2}|[A-Z]&[A-Z])$/.test(token)) return token;
      if (/^[A-Z][a-z]+$/.test(token)) return token;
      if (/^[A-Za-z][A-Za-z'.-]*$/.test(token)) return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      return token;
    })
    .join(" ");
}

const MAP_LABEL_STOPWORDS = new Set([
  "and",
  "ave",
  "avenue",
  "blvd",
  "boulevard",
  "bus",
  "by",
  "car",
  "copyright",
  "country",
  "dr",
  "drive",
  "feet",
  "ferry",
  "golf",
  "guide",
  "house",
  "legend",
  "line",
  "lines",
  "main",
  "map",
  "mile",
  "miles",
  "no",
  "note",
  "numbers",
  "of",
  "park",
  "parks",
  "published",
  "railroad",
  "railroads",
  "rd",
  "road",
  "scale",
  "st",
  "street",
  "thoroughfares",
  "to",
  "way",
]);

const MAP_LABEL_FEATURE_SUFFIXES = {
  park: new Set(["park", "parks"]),
  waterbody: new Set(["bay", "canal", "channel", "creek", "harbor", "lake", "river", "sound", "waterway"]),
  landmark: new Set(["airport", "cem", "cemetery", "club", "college", "dock", "field", "fort", "hospital", "island", "point", "university"]),
  region: new Set(["addition", "district", "heights", "hill", "hills", "junction", "valley"]),
};

const MAP_LABEL_FEATURE_WORDS = new Set(Object.values(MAP_LABEL_FEATURE_SUFFIXES).flatMap((values) => [...values]));

function mapLabelFeatureType(label) {
  const tokens = mapLabelTokens(label).map((token) => token.toLowerCase().replace(/\.$/, ""));
  if (tokens.length === 0) return "other";
  if (tokens.includes("county")) return "county";
  if (tokens.includes("state")) return "state_province";
  const suffix = tokens[tokens.length - 1];
  for (const [type, suffixes] of Object.entries(MAP_LABEL_FEATURE_SUFFIXES)) {
    if (suffixes.has(suffix)) return type;
  }
  if (tokens.some((token) => MAP_LABEL_FEATURE_SUFFIXES.waterbody.has(token))) return "waterbody";
  if (tokens.some((token) => MAP_LABEL_FEATURE_SUFFIXES.landmark.has(token))) return "landmark";
  if (tokens.some((token) => MAP_LABEL_FEATURE_SUFFIXES.region.has(token))) return "region";
  return "other";
}

function looksLikeStreetGridLabel(label) {
  const normalized = normalizeMapLabel(label).toLowerCase();
  if (!normalized) return true;
  const tokens = mapLabelTokens(normalized);
  if (tokens.length === 0) return true;
  const digitCount = (normalized.match(/\d/g) || []).length;
  const alphaCount = (normalized.match(/[a-z]/g) || []).length;
  if (digitCount > 0 && digitCount >= alphaCount) return true;
  if (/^\d+(?:st|nd|rd|th)?$/.test(tokens[0])) return true;
  if (/\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|way|pl|place|dr|drive|ct|court|ter|terrace)\b\.?$/i.test(normalized)) return true;
  if (/^[nswe]\s+\d+(?:st|nd|rd|th)?\s+(?:st|street|ave|avenue)\b/i.test(normalized)) return true;
  return false;
}

function looksLikeMapPlacename(label) {
  const normalized = normalizeMapLabel(label);
  if (!normalized || normalized.length < 4 || normalized.length > 64) return false;
  if (/\b(?:co|company|copyright|legend|lighting|map\s+co|mills?|miles?|published|president|scale|shipbuilding|warehouse|worl)\b/i.test(normalized)) return false;
  if (looksLikeStreetGridLabel(normalized)) return false;
  const tokens = mapLabelTokens(normalized);
  const lowerTokens = tokens.map((token) => token.toLowerCase().replace(/\.$/, ""));
  if (lowerTokens.every((token) => MAP_LABEL_STOPWORDS.has(token))) return false;
  if (tokens.length > 6) return false;
  const compact = normalized.replace(/[^A-Za-z]/g, "");
  if (compact.length < 4) return false;
  const featureType = mapLabelFeatureType(normalized);
  const stopwordRatio = lowerTokens.filter((token) => MAP_LABEL_STOPWORDS.has(token)).length / lowerTokens.length;
  if (stopwordRatio > 0.5 && featureType === "other") return false;
  if (featureType !== "other" && lowerTokens.some((token) => !MAP_LABEL_STOPWORDS.has(token))) return true;
  if (tokens.length >= 2 && lowerTokens.some((token) => !MAP_LABEL_STOPWORDS.has(token) && token.length >= 3)) return true;
  return tokens.length === 1 && compact.length >= 5 && !MAP_LABEL_STOPWORDS.has(lowerTokens[0]);
}

function placenameConfidence(baseConfidence, label, sourceKind) {
  const tokens = mapLabelTokens(label);
  const featureType = mapLabelFeatureType(label);
  let confidence = Math.max(0, Math.min(1, Number(baseConfidence) || 0.6));
  if (sourceKind === "text_group") confidence += 0.08;
  if (tokens.length >= 2) confidence += 0.06;
  if (featureType !== "other") confidence += 0.08;
  if (looksLikeStreetGridLabel(label)) confidence -= 0.35;
  return Math.max(0.35, Math.min(0.98, confidence));
}

function hasSpecificMapNameToken(label) {
  return mapLabelTokens(label)
    .map((token) => token.toLowerCase().replace(/\.$/, ""))
    .some((token) => token.length >= 3 && !MAP_LABEL_STOPWORDS.has(token) && !MAP_LABEL_FEATURE_WORDS.has(token));
}

function featurePhraseForMapLabel(label) {
  const tokens = mapLabelTokens(label);
  const lowerTokens = tokens.map((token) => token.toLowerCase().replace(/\.$/, ""));
  const featureIndices = lowerTokens
    .map((token, index) => MAP_LABEL_FEATURE_WORDS.has(token) ? index : -1)
    .filter((index) => index >= 0);
  if (featureIndices.length === 0) return normalizeMapLabel(label);
  const lastIndex = tokens.length - 1;
  const featureIndex = featureIndices.includes(lastIndex) ? lastIndex : featureIndices[0];
  const start = featureIndex === lastIndex
    ? Math.max(0, featureIndex - 4)
    : Math.max(0, featureIndex - 1);
  const end = featureIndex === lastIndex
    ? featureIndex + 1
    : Math.min(tokens.length, featureIndex === 0 ? featureIndex + 2 : featureIndex + 1);
  return normalizeMapLabel(tokens.slice(start, end).join(" "));
}

function shouldEmitPlacenameCandidate(label) {
  const normalized = normalizeMapLabel(label);
  if (!looksLikeMapPlacename(normalized)) return false;
  const tokens = mapLabelTokens(normalized);
  const lowerTokens = tokens.map((token) => token.toLowerCase().replace(/\.$/, ""));
  if (lowerTokens.some((token) => /^(?:aves?|sts?|rds?)$/.test(token))) return false;
  if (/^(?:ave|avenue|blvd|boulevard|dr|drive|rd|road|st|street)$/.test(lowerTokens[0])) return false;
  const featureType = mapLabelFeatureType(normalized);
  if (featureType !== "other") return tokens.length >= 2 && hasSpecificMapNameToken(normalized);
  return false;
}

function pixelItemFromTextEntry(entry, index, pageWidth, pageHeight) {
  if (!isGroupableOcrText(entry)) return null;
  const box = Array.isArray(entry?.approx_bbox) ? entry.approx_bbox.map(Number) : [];
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
  const [rawX1, rawY1, rawX2, rawY2] = box;
  const x1 = Math.max(0, Math.min(pageWidth, Math.min(rawX1, rawX2) * pageWidth));
  const y1 = Math.max(0, Math.min(pageHeight, Math.min(rawY1, rawY2) * pageHeight));
  const x2 = Math.max(0, Math.min(pageWidth, Math.max(rawX1, rawX2) * pageWidth));
  const y2 = Math.max(0, Math.min(pageHeight, Math.max(rawY1, rawY2) * pageHeight));
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    index,
    content: String(entry.content).trim(),
    role: String(entry.role || "other"),
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
    box: {
      x1,
      y1,
      x2,
      y2,
      width: x2 - x1,
      height: y2 - y1,
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
    },
  };
}

function textItemsCompatible(a, b, medianHeight) {
  const scale = Math.max(medianHeight, a.box.height, b.box.height, 1);
  const distance = Math.hypot(b.box.cx - a.box.cx, b.box.cy - a.box.cy);
  if (distance < scale * 0.45 || distance > scale * 2.85) return false;
  const heightRatio = Math.max(a.box.height, b.box.height) / Math.max(1, Math.min(a.box.height, b.box.height));
  if (heightRatio > 2.4) return false;
  const widthRatio = Math.max(a.box.width, b.box.width) / Math.max(1, Math.min(a.box.width, b.box.width));
  if (widthRatio > 5.5) return false;
  return true;
}

function textItemsSimilarScale(a, b) {
  const heightRatio = Math.max(a.box.height, b.box.height) / Math.max(1, Math.min(a.box.height, b.box.height));
  const widthRatio = Math.max(a.box.width, b.box.width) / Math.max(1, Math.min(a.box.width, b.box.width));
  return heightRatio <= 2.4 && widthRatio <= 5.5;
}

function textLineProposal(seed, second, items, medianHeight) {
  if (!textItemsCompatible(seed, second, medianHeight)) return null;
  const dx = second.box.cx - seed.box.cx;
  const dy = second.box.cy - seed.box.cy;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  const scale = Math.max(medianHeight, seed.box.height, second.box.height, 1);
  const candidates = items.map((item) => {
    const itemDx = item.box.cx - seed.box.cx;
    const itemDy = item.box.cy - seed.box.cy;
    const projection = itemDx * ux + itemDy * uy;
    const perpendicular = Math.abs(itemDx * uy - itemDy * ux);
    return { item, projection, perpendicular };
  })
    .filter(({ item, projection, perpendicular }) => {
      if (projection < -scale * 0.25 || projection > scale * 24) return false;
      if (perpendicular > Math.max(scale * 0.9, item.box.height * 0.95)) return false;
      return item.index === seed.index || textItemsSimilarScale(seed, item);
    })
    .sort((a, b) => a.projection - b.projection);

  const chain = [];
  for (const candidate of candidates) {
    const previous = chain[chain.length - 1]?.item;
    if (!previous) {
      chain.push(candidate);
      continue;
    }
    if (candidate.item.index === previous.index) continue;
    const gap = candidate.projection - chain[chain.length - 1].projection;
    if (gap > Math.max(scale * 3, previous.box.width * 1.2)) break;
    if (!textItemsCompatible(previous, candidate.item, medianHeight)) continue;
    const stepX = candidate.item.box.cx - previous.box.cx;
    const stepY = candidate.item.box.cy - previous.box.cy;
    const stepDistance = Math.hypot(stepX, stepY);
    if (stepDistance <= 0) continue;
    const directionAgreement = (stepX * ux + stepY * uy) / stepDistance;
    if (directionAgreement < Math.cos(Math.PI / 6)) continue;
    chain.push(candidate);
  }

  const uniqueItems = Array.from(new Map(chain.map(({ item }) => [item.index, item])).values());
  if (!uniqueItems.some((item) => item.index === seed.index) || !uniqueItems.some((item) => item.index === second.index)) return null;
  if (uniqueItems.length < 3) return null;
  return uniqueItems;
}

function orderTextGroupItems(items) {
  const minX = Math.min(...items.map((item) => item.box.cx));
  const maxX = Math.max(...items.map((item) => item.box.cx));
  const minY = Math.min(...items.map((item) => item.box.cy));
  const maxY = Math.max(...items.map((item) => item.box.cy));
  const xSpan = maxX - minX;
  const ySpan = maxY - minY;
  return [...items].sort((a, b) => {
    if (xSpan >= ySpan * 0.35) return a.box.cx - b.box.cx;
    return a.box.cy - b.box.cy;
  });
}

function normalizedBoxFromTextItems(items, pageWidth, pageHeight) {
  const x1 = Math.min(...items.map((item) => item.box.x1));
  const y1 = Math.min(...items.map((item) => item.box.y1));
  const x2 = Math.max(...items.map((item) => item.box.x2));
  const y2 = Math.max(...items.map((item) => item.box.y2));
  return [
    Math.max(0, Math.min(1, x1 / pageWidth)),
    Math.max(0, Math.min(1, y1 / pageHeight)),
    Math.max(0, Math.min(1, x2 / pageWidth)),
    Math.max(0, Math.min(1, y2 / pageHeight)),
  ];
}

function roleForTextGroup(items) {
  const roles = items.map((item) => String(item.role || "other").toLowerCase());
  if (roles.includes("title")) return "title";
  if (roles.includes("label")) return "label";
  return "label";
}

function textGroupScore(items, medianHeight) {
  const ordered = orderTextGroupItems(items);
  const gaps = ordered.slice(1).map((item, index) => {
    const previous = ordered[index];
    return Math.hypot(item.box.cx - previous.box.cx, item.box.cy - previous.box.cy) / Math.max(medianHeight, item.box.height, previous.box.height, 1);
  });
  const averageGap = gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const charCount = ordered.reduce((sum, item) => sum + item.content.length, 0);
  return ordered.length * 100 + charCount - averageGap * 8;
}

function textGroupLooksUseful(content) {
  const tokens = String(content || "")
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
  if (tokens.length === 2 && looksLikeMapPlacename(content)) return true;
  if (tokens.length === 2) {
    const lowerTokens = tokens.map((token) => token.toLowerCase().replace(/\.$/, ""));
    const alphaTokens = lowerTokens.filter((token) => /[a-z]/.test(token));
    if (alphaTokens.length === 0) return false;
    if (lowerTokens.every((token) => MAP_LABEL_STOPWORDS.has(token))) return false;
    if (tokens.every((token) => token.length <= 2)) return false;
    return alphaTokens.some((token) => token.length >= 3);
  }
  if (tokens.length < 3) return false;
  const shortTokenRatio = tokens.filter((token) => token.length <= 2).length / tokens.length;
  if (shortTokenRatio > 0.5) return false;
  const uniqueTokenRatio = new Set(tokens.map((token) => token.toLowerCase())).size / tokens.length;
  if (uniqueTokenRatio < 0.6) return false;
  return true;
}

function normalizedMapLabelToken(token) {
  return String(token || "").toLowerCase().replace(/\.$/, "");
}

function specificNameTokensForFeatureGroup(item) {
  return mapLabelTokens(item?.content)
    .filter((token) => /[A-Za-z]/.test(token))
    .filter((token) => {
      const normalized = normalizedMapLabelToken(token);
      return normalized.length >= 3
        && !MAP_LABEL_STOPWORDS.has(normalized)
        && !MAP_LABEL_FEATURE_WORDS.has(normalized);
    })
    .slice(0, 4);
}

function featureSuffixTokenForGroup(item) {
  const tokens = mapLabelTokens(item?.content);
  const lowerTokens = tokens.map(normalizedMapLabelToken);
  const alphaTokens = lowerTokens.filter((token) => /[a-z]/.test(token));
  if (alphaTokens.length === 0 || alphaTokens.length > 2) return "";
  if (alphaTokens.some((token) => !MAP_LABEL_FEATURE_WORDS.has(token) && !MAP_LABEL_STOPWORDS.has(token))) return "";
  return alphaTokens.find((token) => MAP_LABEL_FEATURE_WORDS.has(token)) || "";
}

function textBoxOverlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.box.x2, b.box.x2) - Math.max(a.box.x1, b.box.x1));
  return overlap / Math.max(1, Math.min(a.box.width, b.box.width));
}

function featureLabelItemsLookAdjacent(nameItem, suffixItem, medianHeight) {
  const indexGap = Math.abs(Number(nameItem.index) - Number(suffixItem.index));
  if (!Number.isFinite(indexGap) || indexGap > 10) return false;
  const scale = Math.max(medianHeight, nameItem.box.height, suffixItem.box.height, 1);
  const verticalGap = suffixItem.box.cy - nameItem.box.cy;
  const leftAligned = Math.abs(nameItem.box.x1 - suffixItem.box.x1) <= scale * 1.6;
  const centerAligned = Math.abs(nameItem.box.cx - suffixItem.box.cx) <= scale * 2.2;
  const overlaps = textBoxOverlapRatio(nameItem, suffixItem) >= 0.2;
  const stacked = verticalGap >= -scale * 0.2
    && verticalGap <= scale * 3.2
    && (leftAligned || centerAligned || overlaps);
  const inlineGap = suffixItem.box.x1 - nameItem.box.x2;
  const inline = Math.abs(suffixItem.box.cy - nameItem.box.cy) <= scale * 0.8
    && inlineGap >= -scale * 0.35
    && inlineGap <= scale * 3;
  return stacked || inline;
}

function featureLabelGroupContent(nameItem, suffixItem) {
  const nameTokens = specificNameTokensForFeatureGroup(nameItem);
  const suffixToken = featureSuffixTokenForGroup(suffixItem);
  if (nameTokens.length === 0 || !suffixToken) return "";
  const normalized = normalizeMapLabel([...nameTokens, suffixToken].join(" "));
  if (!shouldEmitPlacenameCandidate(normalized)) return "";
  return titleizeMapLabel(normalized);
}

function adjacentTextLabelGroupContent(firstItem, secondItem) {
  const tokens = [
    ...mapLabelTokens(firstItem?.content),
    ...mapLabelTokens(secondItem?.content),
  ].filter((token) => /[A-Za-z0-9]/.test(token));
  if (tokens.length < 2 || tokens.length > 5) return "";
  if (!tokens.some((token) => /[A-Za-z]/.test(token))) return "";
  const content = tokens.join(" ").replace(/\s+/g, " ").trim();
  if (!textGroupLooksUseful(content)) return "";
  return titleizeMapLabel(content);
}

function supplementalFeatureLabelGroups(items, used, pageWidth, pageHeight, medianHeight, existingGroups) {
  const existingKeys = new Set((existingGroups || []).map((group) => normalizeMapLabel(group.content).toLowerCase()).filter(Boolean));
  const byKey = new Map();

  for (const nameItem of items) {
    if (used.has(nameItem.index)) continue;
    for (const suffixItem of items) {
      if (nameItem.index === suffixItem.index || used.has(suffixItem.index)) continue;
      if (!featureLabelItemsLookAdjacent(nameItem, suffixItem, medianHeight)) continue;
      const featureContent = featureLabelGroupContent(nameItem, suffixItem);
      const content = featureContent || adjacentTextLabelGroupContent(nameItem, suffixItem);
      const key = normalizeMapLabel(content).toLowerCase();
      if (!key || existingKeys.has(key) || !textGroupLooksUseful(content)) continue;
      const ordered = [nameItem, suffixItem];
      const confidence = ordered.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / ordered.length;
      const scale = Math.max(medianHeight, nameItem.box.height, suffixItem.box.height, 1);
      const distance = Math.hypot(nameItem.box.cx - suffixItem.box.cx, nameItem.box.cy - suffixItem.box.cy) / scale;
      const score = confidence * 100 - distance;
      const sourceIndices = ordered.map((item) => item.index);
      const first = ordered[0].box;
      const last = ordered[ordered.length - 1].box;
      const angle = Math.atan2(last.cy - first.cy, last.cx - first.cx) * 180 / Math.PI;
      const candidate = {
        content,
        source_text_indices: sourceIndices,
        source_text_count: ordered.length,
        approx_bbox: normalizedBoxFromTextItems(ordered, pageWidth, pageHeight),
        confidence: Math.max(0.35, Math.min(0.95, confidence * 0.96)),
        role: "label",
        orientation_degrees: Math.round(angle * 10) / 10,
        reasoning: featureContent
          ? "Supplemental OCR grouping paired nearby specific-name text with a feature suffix label while ignoring numeric-only clutter."
          : "Supplemental OCR grouping paired nearby text fragments as a map label before any gazetteer lookup.",
      };
      const existing = byKey.get(key);
      if (!existing || score > existing.score) byKey.set(key, { group: candidate, score });
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.group);
}

function consolidateOcrTextEntries(entries, pageWidth, pageHeight) {
  if (!Array.isArray(entries) || pageWidth <= 0 || pageHeight <= 0) {
    return { groups: [], summary: { strategy: OCR_TEXT_GROUPING_STRATEGY, input_text_count: Array.isArray(entries) ? entries.length : 0, group_count: 0, grouped_text_count: 0 } };
  }

  const items = entries
    .map((entry, index) => pixelItemFromTextEntry(entry, index, pageWidth, pageHeight))
    .filter(Boolean);
  if (items.length === 0) {
    return { groups: [], summary: { strategy: OCR_TEXT_GROUPING_STRATEGY, input_text_count: entries.length, group_count: 0, grouped_text_count: 0 } };
  }

  const medianHeight = Math.max(1, median(items.map((item) => item.box.height)));
  const proposalsByKey = new Map();
  if (items.length >= 3) {
    for (const seed of items) {
      const nearby = items
        .filter((item) => item.index !== seed.index && textItemsCompatible(seed, item, medianHeight))
        .sort((a, b) => Math.hypot(a.box.cx - seed.box.cx, a.box.cy - seed.box.cy) - Math.hypot(b.box.cx - seed.box.cx, b.box.cy - seed.box.cy))
        .slice(0, 10);
      for (const second of nearby) {
        const proposal = textLineProposal(seed, second, items, medianHeight);
        if (!proposal) continue;
        const key = proposal.map((item) => item.index).sort((a, b) => a - b).join(",");
        const score = textGroupScore(proposal, medianHeight);
        const existing = proposalsByKey.get(key);
        if (!existing || score > existing.score) proposalsByKey.set(key, { items: proposal, score });
      }
    }
  }

  const used = new Set();
  const proposals = Array.from(proposalsByKey.values())
    .sort((a, b) => b.items.length - a.items.length || b.score - a.score || Math.min(...a.items.map((item) => item.index)) - Math.min(...b.items.map((item) => item.index)));
  const groups = [];
  for (const proposal of proposals) {
    if (proposal.items.some((item) => used.has(item.index))) continue;
    const ordered = orderTextGroupItems(proposal.items);
    const content = ordered.map((item) => item.content).join(" ").replace(/\s+/g, " ").trim();
    if (!content || content.length < 4) continue;
    if (!textGroupLooksUseful(content)) continue;
    const sourceIndices = ordered.map((item) => item.index);
    const sourceSpan = Math.max(...sourceIndices) - Math.min(...sourceIndices) + 1;
    if (sourceSpan > sourceIndices.length && !looksLikeMapPlacename(content)) continue;
    for (const item of ordered) used.add(item.index);
    const first = ordered[0].box;
    const last = ordered[ordered.length - 1].box;
    const angle = Math.atan2(last.cy - first.cy, last.cx - first.cx) * 180 / Math.PI;
    groups.push({
      content,
      source_text_indices: sourceIndices,
      source_text_count: ordered.length,
      approx_bbox: normalizedBoxFromTextItems(ordered, pageWidth, pageHeight),
      confidence: ordered.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / ordered.length,
      role: roleForTextGroup(ordered),
      orientation_degrees: Math.round(angle * 10) / 10,
      reasoning: "Deterministic secondary OCR pass grouped adjacent boxes with similar size along a shared text baseline.",
    });
  }
  const supplementalGroups = supplementalFeatureLabelGroups(items, used, pageWidth, pageHeight, medianHeight, groups);
  let supplementalAddedCount = 0;
  for (const group of supplementalGroups) {
    if (group.source_text_indices.some((index) => used.has(index))) continue;
    for (const index of group.source_text_indices) used.add(index);
    groups.push(group);
    supplementalAddedCount += 1;
  }

  groups.sort((a, b) => Math.min(...a.source_text_indices) - Math.min(...b.source_text_indices));
  return {
    groups,
    summary: {
      strategy: OCR_TEXT_GROUPING_STRATEGY,
      input_text_count: entries.length,
      candidate_text_count: items.length,
      group_count: groups.length,
      grouped_text_count: used.size,
      supplemental_map_label_group_count: supplementalAddedCount,
      supplemental_feature_label_group_count: supplementalAddedCount,
    },
  };
}

function deriveMapLabelPlacenames(entries, groups) {
  const candidatesByKey = new Map();
  const addCandidate = ({ content, confidence, sourceKind, sourceIndices, bbox }) => {
    const normalized = featurePhraseForMapLabel(content);
    if (!shouldEmitPlacenameCandidate(normalized)) return;
    const name = titleizeMapLabel(normalized);
    const sourceTextIndices = Array.from(new Set((sourceIndices || [])
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0)))
      .sort((a, b) => a - b);
    if (sourceTextIndices.length === 0) return;
    const candidateConfidence = placenameConfidence(confidence, name, sourceKind);
    const key = name.toLowerCase();
    const candidate = withoutUndefined({
      name,
      type: mapLabelFeatureType(name),
      source_text_index: sourceTextIndices[0],
      source_text_indices: sourceTextIndices,
      approx_bbox: bbox,
      confidence: candidateConfidence,
      reasoning: sourceKind === "text_group"
        ? "MapKurator-inspired lexical cleanup selected this consolidated OCR label as a likely map placename."
        : "MapKurator-inspired lexical cleanup selected this OCR label as a likely map placename.",
    });
    const existing = candidatesByKey.get(key);
    if (!existing || candidateConfidence > existing.confidence || (sourceKind === "text_group" && existing.sourceKind !== "text_group")) {
      candidatesByKey.set(key, { ...candidate, sourceKind });
    }
  };

  for (const group of Array.isArray(groups) ? groups : []) {
    addCandidate({
      content: group?.content,
      confidence: group?.confidence,
      sourceKind: "text_group",
      sourceIndices: Array.isArray(group?.source_text_indices) ? group.source_text_indices : [],
      bbox: group?.approx_bbox,
    });
  }

  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const confidence = Number(entry?.confidence);
    if (Number.isFinite(confidence) && confidence < 0.72) continue;
    addCandidate({
      content: entry?.content,
      confidence: entry?.confidence,
      sourceKind: "text",
      sourceIndices: [index],
      bbox: entry?.approx_bbox,
    });
  }

  return Array.from(candidatesByKey.values())
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, 80)
    .map(({ sourceKind, ...candidate }) => candidate);
}

function normalizedContentKey(content) {
  return String(content || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedBoxArea(box) {
  if (!Array.isArray(box) || box.length !== 4) return 0;
  const width = Math.max(0, Number(box[2]) - Number(box[0]));
  const height = Math.max(0, Number(box[3]) - Number(box[1]));
  return width * height;
}

function normalizedBoxIou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const x1 = Math.max(Number(a[0]), Number(b[0]));
  const y1 = Math.max(Number(a[1]), Number(b[1]));
  const x2 = Math.min(Number(a[2]), Number(b[2]));
  const y2 = Math.min(Number(a[3]), Number(b[3]));
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = normalizedBoxArea(a) + normalizedBoxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizedBoxCenterDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return Infinity;
  const ax = (Number(a[0]) + Number(a[2])) / 2;
  const ay = (Number(a[1]) + Number(a[3])) / 2;
  const bx = (Number(b[0]) + Number(b[2])) / 2;
  const by = (Number(b[1]) + Number(b[3])) / 2;
  return Math.hypot(ax - bx, ay - by);
}

function textEntryRank(entry) {
  const confidence = Math.max(0, Math.min(1, Number(entry?.confidence) || 0));
  const sourceBonus = entry?.source_image_kind === "tile" ? 0.08 : 0;
  const contentBonus = Math.min(0.08, String(entry?.content || "").length / 400);
  return confidence + sourceBonus + contentBonus;
}

function dedupeOcrEntries(entries) {
  const kept = [];
  const duplicates = [];
  for (const entry of [...entries].sort((a, b) => textEntryRank(b) - textEntryRank(a))) {
    const key = normalizedContentKey(entry?.content);
    if (!key) continue;
    const duplicateIndex = kept.findIndex((existing) => {
      if (normalizedContentKey(existing?.content) !== key) return false;
      const iou = normalizedBoxIou(existing?.approx_bbox, entry?.approx_bbox);
      if (iou >= 0.35) return true;
      const distance = normalizedBoxCenterDistance(existing?.approx_bbox, entry?.approx_bbox);
      const scale = Math.max(
        Math.sqrt(normalizedBoxArea(existing?.approx_bbox)),
        Math.sqrt(normalizedBoxArea(entry?.approx_bbox)),
        0.004,
      );
      return distance <= scale * 0.75;
    });
    if (duplicateIndex >= 0) {
      duplicates.push({ kept: duplicateIndex, duplicate: entry?.source_image_id || "unknown", content: entry?.content });
      continue;
    }
    kept.push(entry);
  }
  kept.sort((a, b) => {
    const boxA = Array.isArray(a?.approx_bbox) ? a.approx_bbox : [0, 0, 0, 0];
    const boxB = Array.isArray(b?.approx_bbox) ? b.approx_bbox : [0, 0, 0, 0];
    return Number(boxA[1]) - Number(boxB[1]) || Number(boxA[0]) - Number(boxB[0]);
  });
  return { entries: kept, duplicatesRemoved: duplicates.length };
}

function lineEntriesFromVisionWords(words, pageWidth, pageHeight) {
  const items = words.map((word) => {
    const content = textFromVisionWord(word).trim();
    const box = pixelBoxFromBoundingPoly(word?.boundingBox, pageWidth, pageHeight);
    if (!content || !box) return null;
    return {
      content,
      box,
      polygon: normalizedPolygonFromBoundingPoly(word?.boundingBox, pageWidth, pageHeight),
      confidence: Number.isFinite(Number(word?.confidence)) ? Number(word.confidence) : 0.8,
    };
  }).filter(Boolean);
  if (items.length === 0) return [];

  const lineThreshold = Math.max(6, median(items.map((item) => item.box.height)) * 0.75);
  const lines = [];
  let current = [];
  for (const item of items) {
    if (current.length === 0) {
      current = [item];
      continue;
    }
    const currentCenter = current.reduce((sum, word) => sum + word.box.cy, 0) / current.length;
    if (Math.abs(item.box.cy - currentCenter) <= lineThreshold) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.box.x1 - b.box.x1);
    const content = ordered.map((item) => item.content).join(" ").trim();
    const first = ordered[0]?.box;
    const last = ordered[ordered.length - 1]?.box;
    const orientation = first && last ? Math.atan2(last.cy - first.cy, last.cx - first.cx) * 180 / Math.PI : 0;
    return {
      content,
      approx_bbox: normalizedMergedBox(ordered, pageWidth, pageHeight),
      ...(ordered.length === 1 && ordered[0].polygon ? { approx_polygon: ordered[0].polygon } : {}),
      source_word_count: ordered.length,
      orientation_degrees: Math.round(orientation * 10) / 10,
      confidence: ordered.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / ordered.length,
      role: textRoleForOcrText(content),
      reasoning: "Google Cloud Vision OCR line bounding polygon grouped from word boxes.",
    };
  }).filter((entry) => entry.content && entry.approx_bbox[2] > entry.approx_bbox[0] && entry.approx_bbox[3] > entry.approx_bbox[1]);
}

function textEntriesFromFullTextAnnotation(annotation) {
  const entries = [];
  const pages = Array.isArray(annotation?.pages) ? annotation.pages : [];
  for (const page of pages) {
    const pageWidth = Number(page?.width || 0);
    const pageHeight = Number(page?.height || 0);
    for (const block of page?.blocks || []) {
      for (const paragraph of block?.paragraphs || []) {
        const words = Array.isArray(paragraph.words) ? paragraph.words : [];
        const lineEntries = lineEntriesFromVisionWords(words, pageWidth, pageHeight);
        if (lineEntries.length > 0) {
          entries.push(...lineEntries);
          continue;
        }
        const content = words.map(textFromVisionWord).filter(Boolean).join(" ").trim();
        const bbox = bboxFromBoundingPoly(paragraph.boundingBox || block.boundingBox, pageWidth, pageHeight);
        if (!content || !bbox) continue;
        const confidences = [
          Number(paragraph.confidence),
          ...words.map((word) => Number(word?.confidence)).filter(Number.isFinite),
        ].filter(Number.isFinite);
        const confidence = confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : 0.8;
        entries.push({
          content,
          approx_bbox: bbox,
          confidence: Math.max(0, Math.min(1, confidence)),
          role: textRoleForOcrText(content),
          reasoning: "Google Cloud Vision OCR paragraph bounding polygon.",
        });
      }
    }
  }
  return entries;
}

function textEntriesFromTextAnnotations(annotations, width, height) {
  return (annotations || []).slice(1).map((annotation) => {
    const content = String(annotation?.description || "").trim();
    const bbox = bboxFromBoundingPoly(annotation?.boundingPoly, width, height);
    if (!content || !bbox) return null;
    return {
      content,
      approx_bbox: bbox,
      approx_polygon: normalizedPolygonFromBoundingPoly(annotation?.boundingPoly, width, height),
      confidence: 0.8,
      role: textRoleForOcrText(content),
      reasoning: "Google Cloud Vision OCR text annotation bounding polygon.",
    };
  }).filter(Boolean);
}

function googleVisionSourceSummary(source, requestBytes) {
  const dimensions = source.width && source.height ? `${source.width}x${source.height}` : "unknown dimensions";
  const normalized = formatBytes(source.normalizedBytes || source.buffer?.length || 0);
  const original = source.originalBytes ? `, original ${formatBytes(source.originalBytes)}` : "";
  const request = requestBytes ? `, JSON request ${formatBytes(requestBytes)}` : "";
  return `${dimensions}, normalized ${normalized}${original}${request}`;
}

function googleVisionErrorMessage(message, source, requestBytes) {
  const detail = googleVisionSourceSummary(source, requestBytes);
  if (/bad image data/i.test(String(message || ""))) {
    return `Google Cloud Vision rejected the normalized OCR image as "Bad image data" (${detail}). This usually means the image payload is too large for inline OCR JSON or Google could not decode the submitted image bytes.`;
  }
  return `Google Cloud Vision OCR failed: ${message || "unknown error"} (${detail}).`;
}

function googleVisionSourceRequestSummary(source, endpoint, featureType, languageHints) {
  return {
    sourceId: source.sourceId || "ocr-source-full",
    sourceKind: source.sourceKind || "full",
    endpoint,
    image: {
      content: "[redacted base64 image bytes]",
      width: source.width,
      height: source.height,
      mimeType: source.mimeType || "image/jpeg",
      originalBytes: source.originalBytes || null,
      normalizedBytes: source.normalizedBytes || source.buffer?.length || null,
      coordinateWidth: source.coordinateWidth || source.width || null,
      coordinateHeight: source.coordinateHeight || source.height || null,
      region: source.region || null,
      renderer: source.renderer || null,
    },
    features: [{ type: featureType }],
    ...(languageHints.length > 0 ? { imageContext: { languageHints } } : {}),
  };
}

function googleVisionRequestBodyForSource(source, featureType, languageHints) {
  return safeJsonStringify({
    requests: [{
      image: { content: source.buffer.toString("base64") },
      features: [{ type: featureType }],
      ...(languageHints.length > 0 ? { imageContext: { languageHints } } : {}),
    }],
  });
}

function parseGoogleVisionOcrSource({ body, source }) {
  const result = body?.responses?.[0] || {};
  if (result.error) throw new Error(googleVisionErrorMessage(result.error.message || "provider returned an OCR error", source, 0));
  const fullText = result.fullTextAnnotation?.text || result.textAnnotations?.[0]?.description || "";
  const entriesFromFullText = textEntriesFromFullTextAnnotation(result.fullTextAnnotation);
  const rawEntries = entriesFromFullText.length > 0
    ? entriesFromFullText
    : textEntriesFromTextAnnotations(result.textAnnotations, source.width, source.height);
  const entries = rawEntries.map((entry, index) => reprojectTextEntryToFullImage({
    ...entry,
    source_image_id: source.sourceId || "ocr-source-full",
    source_image_kind: source.sourceKind || "full",
    source_region: source.region,
    source_response_path: `/${source.sourceId || "ocr-source-full"}/text/${index}`,
  }, source));
  return { fullText, entries };
}

async function callGoogleVisionOcrSource({ visionProfile, source, endpoint, featureType, languageHints }) {
  const apiKey = resolveEnv(visionProfile.apiKeyEnv, "Google Cloud Vision API key");
  const url = new URL(endpoint);
  url.searchParams.set("key", apiKey);
  const requestBody = googleVisionRequestBodyForSource(source, featureType, languageHints);
  const requestBytes = Buffer.byteLength(requestBody, "utf8");
  if (requestBytes > GOOGLE_VISION_JSON_LIMIT_BYTES) {
    throw new Error(`Google Cloud Vision JSON OCR request is too large (${googleVisionSourceSummary(source, requestBytes)}). Reduce GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES or use a smaller source image.`);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(googleVisionErrorMessage(body?.error?.message || `request failed: ${response.status}`, source, requestBytes));
  }
  return {
    source,
    body,
    requestBytes,
    requestSummary: googleVisionSourceRequestSummary(source, endpoint, featureType, languageHints),
    ...parseGoogleVisionOcrSource({ body, source }),
  };
}

async function callGoogleVisionOcr(visionProfile, sourceOrSources) {
  const endpoint = visionProfile.endpoint || "https://vision.googleapis.com/v1/images:annotate";
  const featureType = visionProfile.featureType || "DOCUMENT_TEXT_DETECTION";
  const languageHints = Array.isArray(visionProfile.languageHints)
    ? visionProfile.languageHints.map(String).filter(Boolean)
    : [];
  const sources = Array.isArray(sourceOrSources?.sources)
    ? sourceOrSources.sources
    : [sourceOrSources].filter(Boolean);
  const sourceSummary = sourceOrSources?.summary || {
    strategy: "single_normalized_image",
    tileCount: Math.max(0, sources.length - 1),
    coordinateWidth: sources[0]?.coordinateWidth || sources[0]?.width || 0,
    coordinateHeight: sources[0]?.coordinateHeight || sources[0]?.height || 0,
  };
  if (sources.length === 0) throw new Error("Google Cloud Vision OCR has no image sources to process.");

  const sourceResults = [];
  const sourceErrors = [];
  for (const [index, source] of sources.entries()) {
    try {
      sourceResults.push(await callGoogleVisionOcrSource({ visionProfile, source, endpoint, featureType, languageHints }));
    } catch (error) {
      if (index === 0) throw error;
      sourceErrors.push({
        sourceId: source.sourceId || `ocr-source-${index}`,
        sourceKind: source.sourceKind || "tile",
        message: error.message || String(error),
      });
    }
  }

  const allEntries = sourceResults.flatMap((result) => result.entries);
  const deduped = dedupeOcrEntries(allEntries);
  const sanity = filterRejectedMapText(deduped.entries);
  const coordinateWidth = sourceSummary.coordinateWidth || sources[0]?.coordinateWidth || sources[0]?.width || 0;
  const coordinateHeight = sourceSummary.coordinateHeight || sources[0]?.coordinateHeight || sources[0]?.height || 0;
  const consolidated = consolidateOcrTextEntries(sanity.accepted, coordinateWidth, coordinateHeight);
  const placenames = deriveMapLabelPlacenames(sanity.accepted, consolidated.groups);
  const fullText = sourceResults.map((result) => result.fullText).filter(Boolean).join("\n\n");
  const rawResponse = sourceResults.length === 1
    ? sourceResults[0].body
    : {
      sourceResponses: sourceResults.map((result) => ({
        sourceId: result.source.sourceId,
        sourceKind: result.source.sourceKind,
        region: result.source.region,
        response: result.body,
      })),
      sourceErrors,
    };
  return {
    parsedResponse: {
      text: sanity.accepted,
      text_groups: consolidated.groups,
      text_grouping_summary: {
        ...consolidated.summary,
        source_strategy: sourceSummary.strategy,
        source_count: sources.length,
        successful_source_count: sourceResults.length,
        failed_source_count: sourceErrors.length,
        pre_dedupe_text_count: allEntries.length,
        duplicate_text_count: deduped.duplicatesRemoved,
        rejected_symbol_text_count: sanity.rejected.length,
        tile_count: sourceSummary.tileCount || 0,
      },
      rejected_text: sanity.rejected,
      placenames,
      map_bbox_estimate: {
        west: 0,
        south: 0,
        east: 0,
        north: 0,
        confidence: 0,
        method: "not_inferred",
        reasoning: "Google Cloud Vision provides OCR text and image-space boxes only; geographic map extent is left for metadata writing or human review.",
      },
      description: fullText
        ? `Google Cloud Vision OCR extracted ${deduped.entries.length} text segment(s) from ${sourceResults.length} source image(s); a deterministic secondary pass consolidated ${consolidated.groups.length} text group(s) and proposed ${placenames.length} placename candidate(s).`
        : "Google Cloud Vision OCR did not return text.",
      debug: {
        ocr_strategy: sourceSummary.tileCount > 0 ? `google_cloud_vision:${featureType}:full_plus_tiles` : `google_cloud_vision:${featureType}`,
        text_grouping_strategy: OCR_TEXT_GROUPING_STRATEGY,
        placename_extraction_strategy: "mapkurator_inspired_deterministic_label_cleanup_v1",
        bbox_inference_strategy: "not_inferred_from_ocr",
        ocr_source_strategy: sourceSummary,
        ocr_source_errors: sourceErrors,
        text_sanity_strategy: "reject_repeated_building_placeholder_glyphs_v1",
        rejected_symbol_text_count: sanity.rejected.length,
        limitations: "OCR boxes are generated by Google Cloud Vision. Large maps may be OCRed with a MapKurator-inspired tile/stitch pass. Placename candidates use deterministic map-label cleanup inspired by MapKurator post-OCR/entity-linking stages, but no external gazetteer is queried.",
      },
    },
    rawResponse,
    provider: "google_cloud_vision",
    requestBody: {
      endpoint,
      requests: sourceResults.map((result) => result.requestSummary),
      tiling: sourceSummary,
      sourceErrors,
    },
    usage: { provider: "google_cloud_vision", featureType, sourceCount: sourceResults.length, tileCount: sourceSummary.tileCount || 0 },
    confidence: deduped.entries.length > 0
      ? deduped.entries.reduce((sum, entry) => sum + Number(entry.confidence || 0), 0) / deduped.entries.length
      : 0,
  };
}

function isGoogleVisionExtraction(extraction) {
  return String(extraction?.debug?.ocr_strategy || "").startsWith("google_cloud_vision");
}

async function createDerivatives(profile, asset) {
  const buffer = await fetchObjectBuffer(profile, asset.object_key);
  return createAnalysisDerivativesFromBuffer(
    buffer,
    asset.content_type || contentTypeForKey(asset.object_key),
    asset.id,
  );
}

async function createIiifLevel0Package(profile, keys, buffer, log = () => undefined) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("The sharp package is required to generate IIIF Level 0 pyramids.");

  log("IIIF normalization started");
  const normalized = await sharp(buffer, { limitInputPixels: false }).rotate().toBuffer();
  const meta = await sharp(normalized, { limitInputPixels: false }).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error("Could not read image dimensions for IIIF generation.");
  log("IIIF dimensions read", { width, height });

  const tileSize = 1024;
  const maxDim = Math.max(width, height);
  const scaleFactors = [];
  for (let factor = 1; factor < maxDim; factor *= 2) {
    scaleFactors.push(factor);
    if (Math.ceil(maxDim / factor) <= tileSize) break;
  }

  let tileCount = 0;
  const sizeEntries = [];

  log("IIIF tile planning started", { tileSize, scaleFactors });
  for (const scaleFactor of scaleFactors) {
    const scaledWidth = Math.max(1, Math.ceil(width / scaleFactor));
    const scaledHeight = Math.max(1, Math.ceil(height / scaleFactor));
    sizeEntries.push({ width: scaledWidth, height: scaledHeight });
    const fullKey = `${keys.iiif}/full/${scaledWidth},/0/default.jpg`;
    const full = await sharp(normalized, { limitInputPixels: false })
      .resize({ width: scaledWidth, withoutEnlargement: scaleFactor === 1 })
      .jpeg({ quality: 88 })
      .toBuffer();
    await putObjectBuffer(profile, fullKey, full, "image/jpeg");

    const regionSize = tileSize * scaleFactor;
    for (let top = 0; top < height; top += regionSize) {
      for (let left = 0; left < width; left += regionSize) {
        const regionWidth = Math.min(regionSize, width - left);
        const regionHeight = Math.min(regionSize, height - top);
        const outputWidth = Math.max(1, Math.ceil(regionWidth / scaleFactor));
        const outputHeight = Math.max(1, Math.ceil(regionHeight / scaleFactor));
        const tileKey = `${keys.iiif}/${left},${top},${regionWidth},${regionHeight}/${outputWidth},/0/default.jpg`;
        tileCount += 1;
        const tile = await sharp(normalized, { limitInputPixels: false })
          .extract({ left, top, width: regionWidth, height: regionHeight })
          .resize({ width: outputWidth, height: outputHeight, fit: "fill" })
          .jpeg({ quality: 88 })
          .toBuffer();
        await putObjectBuffer(profile, tileKey, tile, "image/jpeg");
        if (tileCount === 1 || tileCount % 10 === 0) {
          log("IIIF tile uploaded", { tileCount, scaleFactor, left, top });
        }
      }
    }
  }

  const thumbnail = await sharp(normalized, { limitInputPixels: false })
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
  await putObjectBuffer(profile, keys.thumbnail, thumbnail, "image/jpeg");
  log("IIIF S3 uploads complete", { tileCount, sizeCount: sizeEntries.length });

  const serviceUrl = accessUrlFor(profile, keys.iiif);
  const info = {
    "@context": "http://iiif.io/api/image/2/context.json",
    "@id": serviceUrl,
    protocol: "http://iiif.io/api/image",
    width,
    height,
    profile: ["http://iiif.io/api/image/2/level0.json"],
    tiles: [{ width: tileSize, height: tileSize, scaleFactors }],
    sizes: sizeEntries,
  };
  await putObjectBuffer(profile, `${keys.iiif}/info.json`, Buffer.from(safeJsonStringify(info, 2), "utf8"), "application/json");
  log("IIIF info.json uploaded", { infoUrl: `${serviceUrl}/info.json` });

  return {
    serviceUrl,
    infoUrl: `${serviceUrl}/info.json`,
    thumbnailUrl: accessUrlFor(profile, keys.thumbnail),
    width,
    height,
    tileCount,
    scaleFactors,
  };
}

function formatDecimalCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * 1_000_000_000) / 1_000_000_000);
}

function normalizedBboxObject(value) {
  if (!value) return null;
  const west = Number(value.west);
  const east = Number(value.east);
  const north = Number(value.north);
  const south = Number(value.south);
  if (![west, east, north, south].every(Number.isFinite)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) return null;
  return { west, east, north, south };
}

function bboxToAardvarkEnvelope(bbox) {
  const normalized = normalizedBboxObject(bbox);
  if (!normalized) return "";
  return `ENVELOPE(${formatDecimalCoordinate(normalized.west)},${formatDecimalCoordinate(normalized.east)},${formatDecimalCoordinate(normalized.north)},${formatDecimalCoordinate(normalized.south)})`;
}

function bboxToAardvarkPolygonWkt(bbox) {
  const normalized = normalizedBboxObject(bbox);
  if (!normalized) return "";
  const west = formatDecimalCoordinate(normalized.west);
  const east = formatDecimalCoordinate(normalized.east);
  const north = formatDecimalCoordinate(normalized.north);
  const south = formatDecimalCoordinate(normalized.south);
  return `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;
}

function bboxToAardvarkCentroid(bbox) {
  const normalized = normalizedBboxObject(bbox);
  if (!normalized) return "";
  const lon = (normalized.west + normalized.east) / 2;
  const lat = (normalized.north + normalized.south) / 2;
  return `${formatDecimalCoordinate(lat)},${formatDecimalCoordinate(lon)}`;
}

function bboxFromEnvelopeText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^ENVELOPE\s*\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(",").map((item) => Number(item.trim()));
  if (parts.length < 4) return null;
  const [west, east, north, south] = parts;
  return normalizedBboxObject({ west, east, north, south });
}

function collectCoordinatePairs(value, output = []) {
  if (!Array.isArray(value)) return output;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    output.push([value[0], value[1]]);
    return output;
  }
  for (const child of value) collectCoordinatePairs(child, output);
  return output;
}

function bboxFromCoordinatePairs(coordinates) {
  const valid = coordinates
    .map(([lon, lat]) => [Number(lon), Number(lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (valid.length === 0) return null;
  return normalizedBboxObject({
    west: Math.min(...valid.map(([lon]) => lon)),
    east: Math.max(...valid.map(([lon]) => lon)),
    south: Math.min(...valid.map(([, lat]) => lat)),
    north: Math.max(...valid.map(([, lat]) => lat)),
  });
}

function bboxFromGeoJsonText(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    const direct = Array.isArray(parsed?.bbox) && parsed.bbox.length >= 4
      ? normalizedBboxObject({ west: parsed.bbox[0], south: parsed.bbox[1], east: parsed.bbox[2], north: parsed.bbox[3] })
      : null;
    if (direct) return direct;
    return bboxFromCoordinatePairs(collectCoordinatePairs(parsed?.coordinates));
  } catch {
    return null;
  }
}

function bboxFromWktText(value) {
  const text = String(value || "").trim();
  if (!/^(?:MULTI)?POLYGON\s*\(/i.test(text)) return null;
  const numberMatches = text.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const coordinates = [];
  for (let index = 0; index + 1 < numberMatches.length; index += 2) {
    coordinates.push([Number(numberMatches[index]), Number(numberMatches[index + 1])]);
  }
  return bboxFromCoordinatePairs(coordinates);
}

function bboxFromAardvarkGeometryText(value) {
  return bboxFromEnvelopeText(value) || bboxFromGeoJsonText(value) || bboxFromWktText(value);
}

function normalizeAardvarkSpatialFields(resource) {
  const bbox = bboxFromEnvelopeText(resource?.dcat_bbox) || bboxFromAardvarkGeometryText(resource?.locn_geometry);
  if (!bbox) return resource;
  return {
    ...resource,
    dcat_bbox: bboxToAardvarkEnvelope(bbox),
    locn_geometry: bboxToAardvarkPolygonWkt(bbox),
    dcat_centroid: bboxToAardvarkCentroid(bbox),
    gbl_georeferenced_b: true,
  };
}

function bboxFields(extraction) {
  const bbox = extraction?.map_bbox_estimate;
  if (!bbox || Number(bbox.confidence || 0) <= 0 || !normalizedBboxObject(bbox)) {
    return { bboxString: "", locnGeometry: "", centroid: "" };
  }
  return {
    bboxString: bboxToAardvarkEnvelope(bbox),
    locnGeometry: bboxToAardvarkPolygonWkt(bbox),
    centroid: bboxToAardvarkCentroid(bbox),
  };
}

const stringArraySchema = { type: "array", items: { type: "string" } };
const aardvarkResourceSchemaProperties = {
  id: { type: "string" },
  dct_title_s: { type: "string" },
  dct_alternative_sm: stringArraySchema,
  dct_description_sm: stringArraySchema,
  dct_language_sm: stringArraySchema,
  gbl_displayNote_sm: stringArraySchema,
  dct_creator_sm: stringArraySchema,
  dct_publisher_sm: stringArraySchema,
  schema_provider_s: { type: "string" },
  gbl_resourceClass_sm: stringArraySchema,
  gbl_resourceType_sm: stringArraySchema,
  dct_subject_sm: stringArraySchema,
  dcat_theme_sm: stringArraySchema,
  dcat_keyword_sm: stringArraySchema,
  dct_temporal_sm: stringArraySchema,
  dct_issued_s: { type: "string" },
  gbl_indexYear_im: { type: ["integer", "null"] },
  gbl_dateRange_drsim: { type: "string" },
  dct_spatial_sm: stringArraySchema,
  locn_geometry: { type: "string" },
  dcat_bbox: { type: "string" },
  dcat_centroid: { type: "string" },
  gbl_georeferenced_b: { type: "boolean" },
  dct_identifier_sm: stringArraySchema,
  gbl_wxsIdentifier_s: { type: "string" },
  dct_rights_sm: stringArraySchema,
  dct_rightsHolder_sm: stringArraySchema,
  dct_license_sm: stringArraySchema,
  dct_accessRights_s: { type: "string" },
  dct_format_s: { type: "string" },
  gbl_fileSize_s: { type: "string" },
  pcdm_memberOf_sm: stringArraySchema,
  dct_isPartOf_sm: stringArraySchema,
  dct_source_sm: stringArraySchema,
  dct_isVersionOf_sm: stringArraySchema,
  dct_replaces_sm: stringArraySchema,
  dct_isReplacedBy_sm: stringArraySchema,
  dct_relation_sm: stringArraySchema,
  dct_references_s: { type: "string" },
  gbl_mdVersion_s: { type: "string" },
  gbl_suppressed_b: { type: "boolean" },
  gbl_mdModified_dt: { type: "string" },
};

const AARDVARK_METADATA_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resource: {
      type: "object",
      additionalProperties: false,
      properties: aardvarkResourceSchemaProperties,
      required: Object.keys(aardvarkResourceSchemaProperties),
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: { type: "string" },
          value: { type: "string" },
          source: { type: "string" },
          confidence: { type: "number" },
          reasoning: { type: "string" },
        },
        required: ["field", "value", "source", "confidence", "reasoning"],
      },
    },
  },
  required: ["resource", "evidence"],
};

const AARDVARK_ARRAY_FIELDS = [
  "dct_alternative_sm",
  "dct_description_sm",
  "dct_language_sm",
  "gbl_displayNote_sm",
  "dct_creator_sm",
  "dct_publisher_sm",
  "gbl_resourceClass_sm",
  "gbl_resourceType_sm",
  "dct_subject_sm",
  "dcat_theme_sm",
  "dcat_keyword_sm",
  "dct_temporal_sm",
  "dct_spatial_sm",
  "dct_identifier_sm",
  "dct_rights_sm",
  "dct_rightsHolder_sm",
  "dct_license_sm",
  "pcdm_memberOf_sm",
  "dct_isPartOf_sm",
  "dct_source_sm",
  "dct_isVersionOf_sm",
  "dct_replaces_sm",
  "dct_isReplacedBy_sm",
  "dct_relation_sm",
];

const AARDVARK_STRING_FIELDS = [
  "dct_title_s",
  "schema_provider_s",
  "dct_issued_s",
  "gbl_dateRange_drsim",
  "locn_geometry",
  "dcat_bbox",
  "dcat_centroid",
  "gbl_wxsIdentifier_s",
  "dct_accessRights_s",
  "dct_format_s",
  "gbl_fileSize_s",
  "dct_references_s",
  "gbl_mdVersion_s",
  "gbl_mdModified_dt",
];

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (value === undefined || value === null || value === "") return [];
  return uniqueStrings([value]);
}

function asNumberArray(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  return Array.from(new Set(values
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0)));
}

const AARDVARK_RESOURCE_CLASS_VALUES = ["Collections", "Datasets", "Imagery", "Maps", "Web services", "Websites", "Other"];
const AARDVARK_THEME_VALUES = [
  "Agriculture",
  "Biology",
  "Boundaries",
  "Climate",
  "Economy",
  "Elevation",
  "Environment",
  "Events",
  "Geology",
  "Health",
  "Imagery",
  "Inland Waters",
  "Land Cover",
  "Location",
  "Military",
  "Oceans",
  "Property",
  "Society",
  "Structure",
  "Transportation",
  "Utilities",
];
const AARDVARK_FORMAT_VALUES = [
  "ArcGRID",
  "CD-ROM",
  "DEM",
  "DVD-ROM",
  "Feature Class",
  "Geodatabase",
  "GeoJPEG",
  "GeoJSON",
  "GeoPackage",
  "GeoPDF",
  "GeoTIFF",
  "JPEG",
  "JPEG2000",
  "KML",
  "KMZ",
  "LAS",
  "LAZ",
  "Mixed",
  "MrSID",
  "PDF",
  "PNG",
  "Pulsewaves",
  "Raster Dataset",
  "Shapefile",
  "SQLite Database",
  "Tabular Data",
  "TIFF",
];

function normalizeControlledValues(values, allowedValues, fallback = []) {
  const allowedByLower = new Map(allowedValues.map((value) => [value.toLowerCase(), value]));
  const normalized = asStringArray(values)
    .map((value) => allowedByLower.get(value.toLowerCase()))
    .filter(Boolean);
  return normalized.length > 0 ? uniqueStrings(normalized) : fallback;
}

function normalizeAccessRights(value, fallback = "Public") {
  const text = String(value || "").trim();
  return text === "Public" || text === "Restricted" ? text : fallback;
}

function normalizeLanguageValues(values) {
  return asStringArray(values)
    .map((value) => {
      const text = String(value || "").trim();
      const lower = text.toLowerCase();
      const aliases = {
        english: "eng",
        french: "fre",
        spanish: "spa",
        german: "ger",
        italian: "ita",
        latin: "lat",
        multiple: "mul",
      };
      return aliases[lower] || lower;
    })
    .filter((value) => /^[a-z]{3}$/.test(value));
}

function normalizeFormatFromText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const exact = AARDVARK_FORMAT_VALUES.find((item) => item.toLowerCase() === lower);
  if (exact) return exact;
  if (/image\/jpe?g|\.jpe?g$/i.test(raw)) return "JPEG";
  if (/image\/png|\.png$/i.test(raw)) return "PNG";
  if (/image\/tiff?|\.tiff?$/i.test(raw)) return "TIFF";
  if (/image\/(?:jp2|j2k|jpeg2000)|\.j(?:p2|2k)$/i.test(raw)) return "JPEG2000";
  if (/application\/pdf|\.pdf$/i.test(raw)) return "PDF";
  if (/geo\s*tiff|cog|cloud optimized geotiff|\.cog\.tiff?$/i.test(raw)) return "GeoTIFF";
  if (/geo\s*json|application\/(?:geo\+)?json|\.geojson$/i.test(raw)) return "GeoJSON";
  if (/geo\s*package|geopackage|\.gpkg$/i.test(raw)) return "GeoPackage";
  if (/shape\s*file|esri shapefile|\.shp(?:\.zip)?$/i.test(raw)) return "Shapefile";
  if (/mr\s*sid|\.sid$/i.test(raw)) return "MrSID";
  if (/sqlite|spatialite|\.sqlite$/i.test(raw)) return "SQLite Database";
  if (/csv|tsv|tabular|spreadsheet|\.csv$/i.test(raw)) return "Tabular Data";
  if (/raster|erdas|\.img$/i.test(raw)) return "Raster Dataset";
  if (/mixed|zip|package|archive/i.test(raw)) return "Mixed";
  return raw;
}

function formatLabelFromFileName(fileName, georeferenced = false) {
  const lower = String(fileName || "").toLowerCase();
  if (/\.cog\.tiff?$/.test(lower)) return "GeoTIFF";
  if (/\.tiff?$/.test(lower)) return georeferenced ? "GeoTIFF" : "TIFF";
  if (/\.jpe?g$/.test(lower)) return "JPEG";
  if (/\.png$/.test(lower)) return "PNG";
  if (/\.(jp2|j2k)$/.test(lower)) return "JPEG2000";
  if (/\.pdf$/.test(lower)) return "PDF";
  if (/\.geojson$/.test(lower)) return "GeoJSON";
  if (/\.gpkg$/.test(lower)) return "GeoPackage";
  if (/\.sid$/.test(lower)) return "MrSID";
  if (/\.csv$/.test(lower)) return "Tabular Data";
  if (/\.shp$/.test(lower) || /\.zip$/.test(lower)) return "Shapefile";
  return "";
}

function normalizeAardvarkFormat(value, { fileName = "", contentType = "", georeferenced = false } = {}) {
  const fromValue = normalizeFormatFromText(value);
  if (fromValue && fromValue !== "Mixed") return fromValue === "TIFF" && georeferenced ? "GeoTIFF" : fromValue;
  const fromContentType = normalizeFormatFromText(contentType);
  if (fromContentType) {
    if (fromContentType === "TIFF" && georeferenced) return "GeoTIFF";
    return fromContentType;
  }
  const fromFileName = formatLabelFromFileName(fileName, georeferenced);
  return fromFileName || fromValue || "Mixed";
}

function datasetResourceType(manifest) {
  const geometryType = String(manifest?.dataset?.geometryType || "").trim().toLowerCase();
  if (String(manifest?.dataset?.kind || "").toLowerCase() === "raster") return "Raster data";
  if (geometryType.includes("point")) return "Point data";
  if (geometryType.includes("line") || geometryType.includes("polyline")) return "Line data";
  if (geometryType.includes("polygon")) return "Polygon data";
  if (geometryType.includes("table")) return "Table data";
  return "Table data";
}

function extractionEvidenceText(extraction) {
  const text = Array.isArray(extraction?.text)
    ? extraction.text.map((entry) => entry?.content).filter(Boolean).join("\n")
    : "";
  return [extraction?.description || "", text].filter(Boolean).join("\n");
}

function cleanTitle(title) {
  return String(title || "").replace(/\s+/g, " ").replace(/^["“”]+|["“”]+$/g, "").trim();
}

function inferBibliographicMetadata(extraction) {
  const text = extractionEvidenceText(extraction);
  const title =
    text.match(/titled\s+["“]([^"”]+)["”]/i)?.[1] ||
    text.match(/title(?:d|:)?\s+["“]([^"”]+)["”]/i)?.[1] ||
    "";
  const publishedBy =
    text.match(/published\s+(?:in\s+)?((?:1[5-9]\d{2}|20\d{2})(?:-\d{2})?(?:-\d{2})?)\s+by\s+([^.;,\n]+)/i) ||
    text.match(/published\s+by\s+([^.;,\n]+).*?\b((?:1[5-9]\d{2}|20\d{2})(?:-\d{2})?(?:-\d{2})?)\b/i);
  const issued = publishedBy
    ? (publishedBy[1].match(/^\d/) ? publishedBy[1] : publishedBy[2])
    : text.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1] || "";
  const publisher = publishedBy
    ? (publishedBy[1].match(/^\d/) ? publishedBy[2] : publishedBy[1])
    : "";
  const creator =
    text.match(/(?:drawn|engraved|compiled|surveyed|prepared)\s+by\s+([^.;,\n]+)/i)?.[1] ||
    "";
  return {
    title: cleanTitle(title),
    issued: String(issued || "").trim(),
    publisher: String(publisher || "").replace(/\s+of\s+.*$/i, "").trim(),
    creator: String(creator || "").trim(),
  };
}

function isWeakGeneratedTitle(title, fileName) {
  const cleaned = cleanTitle(title);
  const fromFile = cleanTitle(fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  if (!cleaned) return true;
  if (fromFile && cleaned.toLowerCase() === fromFile.toLowerCase()) return true;
  return cleaned.length < 28 && cleaned === cleaned.toUpperCase();
}

function normalizeIndexYear(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const year = Number.parseInt(String(candidate ?? ""), 10);
  return Number.isFinite(year) && year >= 1000 ? year : null;
}

function distributionsFromResource(resource) {
  const refs = typeof resource.dct_references_s === "string" ? JSON.parse(resource.dct_references_s || "{}") : {};
  const distributions = [];
  for (const [relation_key, value] of Object.entries(refs)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      let url = "";
      let label = undefined;
      if (typeof item === "string") {
        url = item;
      } else if (item && typeof item === "object") {
        url = item.url || item["@id"] || item.id || "";
        label = item.label;
      }
      if (!String(url || "").trim()) continue;
      distributions.push({
        resource_id: resource.id,
        relation_key,
        url: String(url),
        label: label ? String(label) : relation_key.includes("thumbnail") ? "Thumbnail" : relation_key.includes("iiif") ? "IIIF Image API Level 0" : relation_key.includes("enrichment") ? "Extracted placename response" : relation_key.includes("aardvark") ? "Aardvark JSON" : "Original image",
      });
    }
  }
  return distributions;
}

function normalizeAardvarkResource(candidate, fallback, context) {
  const next = { ...fallback, ...(candidate || {}) };
  for (const field of AARDVARK_ARRAY_FIELDS) {
    const candidateValues = asStringArray(candidate?.[field]);
    next[field] = candidateValues.length > 0 ? candidateValues : asStringArray(fallback[field]);
  }
  for (const field of AARDVARK_STRING_FIELDS) {
    const value = String(candidate?.[field] ?? "").trim();
    next[field] = value || String(fallback[field] ?? "");
  }

  const inferred = inferBibliographicMetadata(context.extraction);
  if (inferred.title && isWeakGeneratedTitle(next.dct_title_s, context.fileName)) {
    next.dct_title_s = inferred.title;
  }
  if (!next.dct_issued_s && inferred.issued) next.dct_issued_s = inferred.issued;
  if ((next.dct_publisher_sm || []).length === 0 && inferred.publisher) next.dct_publisher_sm = [inferred.publisher];
  if ((next.dct_creator_sm || []).length === 0 && inferred.creator) next.dct_creator_sm = [inferred.creator];
  if (!String(next.schema_provider_s || "").trim()) {
    next.schema_provider_s = String(fallback.schema_provider_s || context.batchDefaults?.provider || "OpenGeoMetadata Studio").trim();
  }
  if ((next.dct_description_sm || []).length === 0) {
    next.dct_description_sm = [next.dct_title_s].filter(Boolean);
  }

  const issuedYear = normalizeIndexYear(next.gbl_indexYear_im) || normalizeIndexYear(next.dct_issued_s);
  next.gbl_indexYear_im = issuedYear;
  if (issuedYear && (next.dct_temporal_sm || []).length === 0) next.dct_temporal_sm = [String(issuedYear)];
  if (issuedYear && !String(next.gbl_dateRange_drsim || "").trim()) next.gbl_dateRange_drsim = `[${issuedYear} TO ${issuedYear}]`;

  next.gbl_resourceClass_sm = normalizeControlledValues(next.gbl_resourceClass_sm, AARDVARK_RESOURCE_CLASS_VALUES, fallback.gbl_resourceClass_sm || ["Maps"]);
  if ((next.gbl_resourceType_sm || []).length === 0) next.gbl_resourceType_sm = fallback.gbl_resourceType_sm || ["Topographic maps"];
  next.dcat_theme_sm = normalizeControlledValues(next.dcat_theme_sm, AARDVARK_THEME_VALUES, fallback.dcat_theme_sm || ["Location"]);
  next.dct_language_sm = normalizeLanguageValues(next.dct_language_sm);
  next.dct_accessRights_s = normalizeAccessRights(next.dct_accessRights_s, normalizeAccessRights(fallback.dct_accessRights_s, "Public"));
  next.dct_format_s = normalizeAardvarkFormat(next.dct_format_s || fallback.dct_format_s, {
    fileName: context.fileName,
    contentType: context.contentType,
    georeferenced: Boolean(next.gbl_georeferenced_b),
  });

  next.id = context.resourceId;
  next.gbl_mdVersion_s = "Aardvark";
  next.gbl_mdModified_dt = new Date().toISOString();
  next.dct_references_s = fallback.dct_references_s;
  next.dct_identifier_sm = uniqueStrings([context.resourceId, context.checksum, ...(next.dct_identifier_sm || [])]);
  next.dct_source_sm = uniqueStrings([context.artifacts.originalUrl, ...(context.metadataSourceUrls || []), ...(next.dct_source_sm || [])]);
  next.dcat_bbox = fallback.dcat_bbox || next.dcat_bbox || "";
  next.locn_geometry = fallback.locn_geometry || next.locn_geometry || "";
  next.dcat_centroid = fallback.dcat_centroid || next.dcat_centroid || "";
  next.gbl_georeferenced_b = Boolean(next.dcat_bbox || next.locn_geometry);
  next.gbl_suppressed_b = Boolean(next.gbl_suppressed_b);
  delete next.extra;
  return normalizeAardvarkSpatialFields(next);
}

function normalizeMetadataDocuments(documents) {
  return (Array.isArray(documents) ? documents : [])
    .map((document, index) => ({
      name: sanitizeFileName(document?.name || `metadata-${index + 1}.txt`),
      type: String(document?.type || "text/plain"),
      size: Number(document?.size || 0),
      text: String(document?.text || "").slice(0, 200_000),
    }))
    .filter((document) => document.text.trim());
}

async function uploadMetadataDocuments(profile, keys, documents, log = () => undefined) {
  const urls = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const key = `${keys.metadataSources}/${String(index + 1).padStart(2, "0")}-${document.name}`;
    log("Uploading companion metadata", { key, type: document.type, bytes: Buffer.byteLength(document.text, "utf8") });
    await putObjectBuffer(profile, key, Buffer.from(document.text, "utf8"), document.type || "text/plain");
    urls.push(accessUrlFor(profile, key));
  }
  return urls;
}

function contentTypeForMetadataKey(key) {
  const lower = String(key || "").toLowerCase();
  if (lower.endsWith(".xml") || lower.endsWith(".fgdc") || lower.endsWith(".iso")) return "application/xml";
  if (lower.endsWith(".json")) return "application/json";
  return "text/plain";
}

function referencesFromResource(resource) {
  if (!resource || typeof resource.dct_references_s !== "string") return {};
  try {
    const parsed = JSON.parse(resource.dct_references_s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function referenceItems(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => {
      if (typeof item === "string") return { url: item, label: "" };
      if (item && typeof item === "object") {
        return {
          url: String(item.url || item["@id"] || item.id || ""),
          label: String(item.label || ""),
        };
      }
      return { url: "", label: "" };
    })
    .filter((item) => item.url.trim());
}

function firstReferenceUrl(value) {
  return referenceItems(value)[0]?.url || "";
}

function downloadUrlMatching(refs, pattern) {
  return referenceItems(refs["http://schema.org/downloadUrl"])
    .find((item) => pattern.test(`${item.label} ${item.url}`))?.url || "";
}

function geospatialArtifactUrlsForResource(profile, keys, resource, fallback = {}) {
  const refs = referencesFromResource(resource);
  const iiifReference = refs["http://iiif.io/api/image"] ? String(refs["http://iiif.io/api/image"]) : "";
  const schemaUrl = firstReferenceUrl(refs["http://schema.org/url"]);
  const originalPackageUrl = downloadUrlMatching(refs, /original|package|zip/i);
  return {
    ...fallback,
    originalUrl: iiifReference
      ? schemaUrl || fallback.originalUrl || accessUrlFor(profile, keys.original)
      : originalPackageUrl || schemaUrl || fallback.originalUrl || accessUrlFor(profile, keys.original),
    originalPackageUrl: originalPackageUrl || fallback.originalPackageUrl,
    manifestUrl: firstReferenceUrl(refs["https://opengeometadata.org/reference/dataset-manifest"]) || fallback.manifestUrl || accessUrlFor(profile, keys.manifest),
    aardvarkUrl: firstReferenceUrl(refs["https://opengeometadata.org/reference/aardvark-json"]) || fallback.aardvarkUrl || accessUrlFor(profile, keys.aardvark),
    iiifInfoUrl: iiifReference ? (iiifReference.endsWith("/info.json") ? iiifReference : `${iiifReference.replace(/\/+$/, "")}/info.json`) : fallback.iiifInfoUrl,
    extractionUrl: refs["https://opengeometadata.org/reference/enrichment-response"] || fallback.extractionUrl,
    aiEnrichmentsUrl: firstReferenceUrl(refs[AI_ENRICHMENTS_RELATION]) || refs[AI_ENRICHMENTS_RELATION] || fallback.aiEnrichmentsUrl,
    geojsonUrl: firstReferenceUrl(refs.geojson) || downloadUrlMatching(refs, /geojson/i) || fallback.geojsonUrl,
    geoParquetUrl: downloadUrlMatching(refs, /geoparquet|parquet/i) || fallback.geoParquetUrl,
    pmtilesUrl: firstReferenceUrl(refs.pmtiles) || downloadUrlMatching(refs, /pmtiles/i) || fallback.pmtilesUrl,
    cogUrl: firstReferenceUrl(refs["https://www.cogeo.org/"]) || downloadUrlMatching(refs, /cloud optimized geotiff|cog|\.tiff?$/i) || fallback.cogUrl,
    thumbnailUrl: firstReferenceUrl(refs["http://schema.org/thumbnailUrl"]) || fallback.thumbnailUrl,
    archivalSupplementUrl: firstReferenceUrl(refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]) || fallback.archivalSupplementUrl || accessUrlFor(profile, keys.archivalSupplement),
    archivalSupplementJsonUrl: firstReferenceUrl(refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]) || fallback.archivalSupplementJsonUrl || accessUrlFor(profile, keys.archivalSupplementJson),
  };
}

function isLikelyGeospatialResource(fileName, resource) {
  const lowerName = String(fileName || "").toLowerCase();
  const format = String(resource?.dct_format_s || "").toLowerCase();
  const refs = referencesFromResource(resource);
  return lowerName.endsWith(".zip") ||
    format.includes("geotiff") ||
    format.includes("shapefile") ||
    Boolean(refs["https://opengeometadata.org/reference/dataset-manifest"]) ||
    Boolean(refs.geojson) ||
    Boolean(refs.pmtiles) ||
    Boolean(refs["https://www.cogeo.org/"]);
}

function resourceHasGeometry(resource) {
  return Boolean(
    String(resource?.dcat_bbox || "").trim() ||
    String(resource?.locn_geometry || "").trim() ||
    String(resource?.dcat_centroid || "").trim()
  );
}

function applyManifestGeometry(resource, manifest) {
  const bbox = manifest?.dataset?.bbox;
  if (!bbox) return resource;
  return normalizeAardvarkSpatialFields({
    ...resource,
    dcat_bbox: resource.dcat_bbox || bboxToAardvarkEnvelope(bbox),
    locn_geometry: resource.locn_geometry || bboxToAardvarkPolygonWkt(bbox),
    dcat_centroid: resource.dcat_centroid || bboxToAardvarkCentroid(bbox),
    gbl_georeferenced_b: true,
  });
}

function applyExtractionGeometry(resource, extraction) {
  const { bboxString, locnGeometry, centroid } = bboxFields(extraction);
  if (!bboxString && !locnGeometry && !centroid) return resource;
  return {
    ...resource,
    dcat_bbox: resource.dcat_bbox || bboxString,
    locn_geometry: resource.locn_geometry || locnGeometry,
    dcat_centroid: resource.dcat_centroid || centroid,
    gbl_georeferenced_b: true,
  };
}

function checksumFromResource(resource) {
  const identifiers = Array.isArray(resource?.dct_identifier_sm) ? resource.dct_identifier_sm : [];
  return identifiers.map(String).find((value) => /^[a-f0-9]{64}$/i.test(value)) || "";
}

function uploadKeysFromRoot(root, fileName = "original", originalKey = "") {
  const cleanRoot = String(root || "").replace(/\/+$/g, "");
  const safeName = sanitizeFileName(fileName || "original");
  return {
    root: cleanRoot,
    original: originalKey || `${cleanRoot}/original_file/${safeName}`,
    cog: `${cleanRoot}/derivatives/${safeName.replace(/\.[^.]+$/, "") || "image"}.cog.tif`,
    iiif: `${cleanRoot}/iiif`,
    thumbnail: `${cleanRoot}/thumbnail/thumbnail.jpg`,
    metadataSources: `${cleanRoot}/metadata_sources`,
    extraction: `${cleanRoot}/enrichment_response.json`,
    archivalSupplement: `${cleanRoot}/archival_accession_supplement.md`,
    archivalSupplementJson: `${cleanRoot}/archival_accession_supplement.json`,
    aiEnrichments: `${cleanRoot}/ai-enrichments.json`,
    aardvark: `${cleanRoot}/aardvark.json`,
  };
}

function artifactUrlsForResource(profile, keys, resource) {
  const refs = referencesFromResource(resource);
  const iiifReference = refs["http://iiif.io/api/image"] ? String(refs["http://iiif.io/api/image"]) : "";
  const cogReference = refs["https://www.cogeo.org/"];
  const cogUrl = typeof cogReference === "string"
    ? cogReference
    : cogReference && typeof cogReference === "object"
      ? String(cogReference.url || cogReference["@id"] || cogReference.id || "")
      : "";
  return {
    originalUrl: refs["http://schema.org/url"] || accessUrlFor(profile, keys.original),
    thumbnailUrl: refs["http://schema.org/thumbnailUrl"] || accessUrlFor(profile, keys.thumbnail),
    iiifInfoUrl: iiifReference ? (iiifReference.endsWith("/info.json") ? iiifReference : `${iiifReference.replace(/\/+$/, "")}/info.json`) : `${accessUrlFor(profile, keys.iiif)}/info.json`,
    extractionUrl: refs["https://opengeometadata.org/reference/enrichment-response"] || accessUrlFor(profile, keys.extraction),
    aiEnrichmentsUrl: firstReferenceUrl(refs[AI_ENRICHMENTS_RELATION]) || refs[AI_ENRICHMENTS_RELATION] || accessUrlFor(profile, keys.aiEnrichments),
    aardvarkUrl: refs["https://opengeometadata.org/reference/aardvark-json"] || accessUrlFor(profile, keys.aardvark),
    archivalSupplementUrl: refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]?.url || refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION] || accessUrlFor(profile, keys.archivalSupplement),
    archivalSupplementJsonUrl: refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]?.url || refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION] || accessUrlFor(profile, keys.archivalSupplementJson),
    cogUrl,
  };
}

function ensureReferenceJson(resource, artifacts) {
  const refs = referencesFromResource(resource);
  const downloadRefs = Array.isArray(refs["http://schema.org/downloadUrl"])
    ? refs["http://schema.org/downloadUrl"]
    : refs["http://schema.org/downloadUrl"] ? [refs["http://schema.org/downloadUrl"]] : [];
  const mergedDownloadRefs = [];
  const seenDownloadUrls = new Set();
  const addDownloadRef = (entry, fallbackLabel = "") => {
    const item = typeof entry === "string"
      ? { url: entry, label: fallbackLabel }
      : entry && typeof entry === "object"
        ? { ...entry, url: String(entry.url || entry["@id"] || entry.id || ""), label: String(entry.label || fallbackLabel) }
        : { url: "", label: "" };
    if (!item.url || seenDownloadUrls.has(item.url)) return;
    seenDownloadUrls.add(item.url);
    mergedDownloadRefs.push(item.label ? item : { url: item.url });
  };
  downloadRefs.forEach((entry) => addDownloadRef(entry));
  addDownloadRef(artifacts.geoParquetUrl, "GeoParquet derivative");
  addDownloadRef(artifacts.pmtilesUrl, "PMTiles vector tile derivative");
  addDownloadRef(artifacts.geojsonUrl, "GeoJSON viewer derivative");
  addDownloadRef(artifacts.cogUrl, "Cloud Optimized GeoTIFF derivative");
  const nextRefs = {
    ...refs,
    "http://schema.org/url": artifacts.originalUrl,
    ...(artifacts.thumbnailUrl ? { "http://schema.org/thumbnailUrl": artifacts.thumbnailUrl } : {}),
    ...(artifacts.iiifInfoUrl ? { "http://iiif.io/api/image": String(artifacts.iiifInfoUrl || "").replace(/\/info\.json$/i, "") } : {}),
    ...(mergedDownloadRefs.length > 0 ? { "http://schema.org/downloadUrl": mergedDownloadRefs } : {}),
    ...(artifacts.cogUrl ? {
      "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" },
    } : {}),
    ...(artifacts.geojsonUrl ? { geojson: { url: artifacts.geojsonUrl, label: "GeoJSON viewer derivative" } } : {}),
    ...(artifacts.pmtilesUrl ? { pmtiles: { url: artifacts.pmtilesUrl, label: "PMTiles vector tiles" } } : {}),
    ...(artifacts.manifestUrl ? { "https://opengeometadata.org/reference/dataset-manifest": { url: artifacts.manifestUrl, label: "Dataset manifest" } } : {}),
    ...(artifacts.archivalSupplementUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" },
    } : {}),
    ...(artifacts.extractionUrl ? { "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl } : {}),
    ...(artifacts.aiEnrichmentsUrl ? {
      [AI_ENRICHMENTS_RELATION]: { url: artifacts.aiEnrichmentsUrl, label: "OpenGeoMetadata AI Enrichments JSON" },
    } : {}),
    "https://opengeometadata.org/reference/aardvark-json": artifacts.aardvarkUrl,
  };
  if (!artifacts.thumbnailUrl) delete nextRefs["http://schema.org/thumbnailUrl"];
  if (!artifacts.iiifInfoUrl) delete nextRefs["http://iiif.io/api/image"];
  return {
    ...resource,
    dct_references_s: safeJsonStringify(nextRefs),
  };
}

function ensureArchivalSupplementReferences(resource, artifacts) {
  if (!artifacts.archivalSupplementUrl && !artifacts.archivalSupplementJsonUrl) return resource;
  const refs = referencesFromResource(resource);
  const downloadRefs = Array.isArray(refs["http://schema.org/downloadUrl"])
    ? refs["http://schema.org/downloadUrl"]
    : refs["http://schema.org/downloadUrl"] ? [refs["http://schema.org/downloadUrl"]] : [];
  const hasSupplementDownload = downloadRefs.some((item) => {
    const value = typeof item === "string" ? item : item?.url || item?.["@id"] || item?.id || "";
    return value && value === artifacts.archivalSupplementUrl;
  });
  const nextRefs = {
    ...refs,
    ...(artifacts.archivalSupplementUrl ? {
      "http://schema.org/downloadUrl": hasSupplementDownload
        ? downloadRefs
        : [...downloadRefs, { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" }],
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" },
    } : {}),
  };
  return {
    ...resource,
    dct_references_s: safeJsonStringify(nextRefs),
  };
}

async function listProcessedUploadResources(profile, { includeIncomplete = false } = {}) {
  const uploadPrefix = `${uploadBasePrefix(profile)}/`;
  const objects = await listRawObjects(profile, [uploadPrefix]);
  const byRoot = new Map();
  const touch = (root) => {
    const cleanRoot = String(root || "").replace(/\/+$/g, "");
    if (!byRoot.has(cleanRoot)) {
      byRoot.set(cleanRoot, {
        resourceId: cleanRoot.split("/").pop() || cleanRoot,
        root: cleanRoot,
        fileName: "",
        originalKey: "",
        hasAardvark: false,
        hasExtraction: false,
        hasAiEnrichments: false,
        hasThumbnail: false,
        hasIiif: false,
        hasManifest: false,
        hasGeojson: false,
        hasGeoParquet: false,
        hasPmtiles: false,
        hasCog: false,
        hasArchivalSupplement: false,
        metadataSourceCount: 0,
        updatedAt: "",
        sizeBytes: 0,
      });
    }
    return byRoot.get(cleanRoot);
  };

  for (const object of objects) {
    const key = object.key;
    if (key.includes("/_checksums/")) continue;

    let match = key.match(/^(.*)\/original_file\/([^/]+)$/);
    if (match) {
      const item = touch(match[1]);
      item.originalKey = key;
      item.fileName = match[2];
      item.sizeBytes = Number(object.size || item.sizeBytes || 0);
    }

    match = key.match(/^(.*)\/aardvark\.json$/);
    if (match) touch(match[1]).hasAardvark = true;

    match = key.match(/^(.*)\/enrichment_response\.json$/);
    if (match) touch(match[1]).hasExtraction = true;

    match = key.match(/^(.*)\/ai-enrichments\.json$/);
    if (match) touch(match[1]).hasAiEnrichments = true;

    match = key.match(/^(.*)\/thumbnail\/thumbnail\.jpg$/);
    if (match) touch(match[1]).hasThumbnail = true;

    match = key.match(/^(.*)\/iiif\/info\.json$/);
    if (match) touch(match[1]).hasIiif = true;

    match = key.match(/^(.*)\/dataset_manifest\.json$/);
    if (match) touch(match[1]).hasManifest = true;

    match = key.match(/^(.*)\/derivatives\/[^/]+\.geojson$/);
    if (match) touch(match[1]).hasGeojson = true;

    match = key.match(/^(.*)\/derivatives\/[^/]+\.parquet$/);
    if (match) touch(match[1]).hasGeoParquet = true;

    match = key.match(/^(.*)\/derivatives\/[^/]+\.pmtiles$/);
    if (match) touch(match[1]).hasPmtiles = true;

    match = key.match(/^(.*)\/derivatives\/[^/]+\.cog\.tiff?$/);
    if (match) touch(match[1]).hasCog = true;

    match = key.match(/^(.*)\/archival_accession_supplement\.md$/);
    if (match) touch(match[1]).hasArchivalSupplement = true;

    match = key.match(/^(.*)\/metadata_sources\/[^/]+$/);
    if (match) touch(match[1]).metadataSourceCount += 1;

    const root = Array.from(byRoot.keys()).find((candidate) => key.startsWith(`${candidate}/`));
    if (root) {
      const item = byRoot.get(root);
      if (object.lastModified && (!item.updatedAt || object.lastModified > item.updatedAt)) item.updatedAt = object.lastModified;
    }
  }

  return Array.from(byRoot.values())
    .filter((item) => includeIncomplete || (item.hasAardvark && (item.hasExtraction || item.hasManifest)))
    .map((item) => {
      const isGeospatial = item.hasManifest || item.hasGeojson || item.hasGeoParquet || item.hasPmtiles || item.hasCog || /\.zip$/i.test(item.fileName || "");
      const keys = isGeospatial
        ? geospatialUploadKeysFromRoot(item.root, item.fileName || "geospatial_package.zip", item.originalKey)
        : uploadKeysFromRoot(item.root, item.fileName || "original", item.originalKey);
      return {
        ...item,
        fileName: item.fileName || item.resourceId,
        keys,
        artifacts: {
          originalUrl: accessUrlFor(profile, keys.original),
          thumbnailUrl: accessUrlFor(profile, keys.thumbnail),
          ...(keys.iiif ? { iiifInfoUrl: `${accessUrlFor(profile, keys.iiif)}/info.json` } : {}),
          ...(keys.extraction ? { extractionUrl: accessUrlFor(profile, keys.extraction) } : {}),
          aiEnrichmentsUrl: accessUrlFor(profile, keys.aiEnrichments),
          ...(keys.manifest ? { manifestUrl: accessUrlFor(profile, keys.manifest) } : {}),
          ...(keys.geojson ? { geojsonUrl: accessUrlFor(profile, keys.geojson) } : {}),
          ...(keys.geoParquet ? { geoParquetUrl: accessUrlFor(profile, keys.geoParquet) } : {}),
          ...(keys.pmtiles ? { pmtilesUrl: accessUrlFor(profile, keys.pmtiles) } : {}),
          ...(keys.cog ? { cogUrl: accessUrlFor(profile, keys.cog) } : {}),
          archivalSupplementUrl: accessUrlFor(profile, keys.archivalSupplement),
          archivalSupplementJsonUrl: accessUrlFor(profile, keys.archivalSupplementJson),
          aardvarkUrl: accessUrlFor(profile, keys.aardvark),
        },
      };
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function readMetadataDocumentsFromS3(profile, keys, log = () => undefined) {
  const objects = await listRawObjects(profile, [`${keys.metadataSources}/`]);
  const documents = [];
  for (const object of objects.filter((item) => item.size > 0)) {
    const name = object.key.split("/").pop() || "metadata.txt";
    log("Reading companion metadata from S3", { key: object.key, bytes: object.size });
    const buffer = await fetchObjectBuffer(profile, object.key);
    documents.push({
      name,
      type: contentTypeForMetadataKey(object.key),
      size: Number(object.size || buffer.length),
      text: buffer.toString("utf8"),
      url: accessUrlFor(profile, object.key),
    });
  }
  return documents;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeDateTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value === undefined ? undefined : value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

function optionalExtensions(value) {
  const cleaned = withoutUndefined(value);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length > 0
    ? cleaned
    : undefined;
}

function redactOpenAIRequestForPersistence(value) {
  if (Array.isArray(value)) return value.map(redactOpenAIRequestForPersistence);
  if (typeof value === "string" && value.startsWith("data:") && value.includes(";base64,")) {
    const mediaType = value.match(/^data:([^;]+);base64,/)?.[1] || "application/octet-stream";
    return `data:${mediaType};base64,[redacted bytes]`;
  }
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "image_url" && typeof item === "string" && item.startsWith("data:")) {
      const mediaType = item.match(/^data:([^;]+);base64,/)?.[1] || "image";
      next[key] = `data:${mediaType};base64,[redacted image bytes]`;
      continue;
    }
    next[key] = redactOpenAIRequestForPersistence(item);
  }
  return next;
}

function textRoleForAiEnrichments(entry) {
  const content = normalizedText(entry?.content);
  const role = String(entry?.role || "other").toLowerCase();
  if (/\b(?:st|street|ave|avenue|blvd|boulevard|way|road|rd|place|pl)\b\.?$/i.test(content)) return "street";
  if (/\b(?:1[5-9]\d{2}|20\d{2})\b/.test(content)) return "date";
  return [
    "title",
    "publication",
    "publisher",
    "date",
    "coordinate",
    "label",
    "street",
    "route",
    "waterbody",
    "landform",
    "elevation",
    "park",
    "landmark",
    "neighborhood",
    "railroad",
    "ferry",
    "scale",
    "legend",
    "grid",
    "marginalia",
    "other",
  ].includes(role) ? role : "other";
}

function textSegmentId(index) {
  return `text-${String(index + 1).padStart(4, "0")}`;
}

function extractionTextSegments(extraction, sourceCallId) {
  return (Array.isArray(extraction?.text) ? extraction.text : [])
    .map((entry, index) => withoutUndefined({
      id: textSegmentId(index),
      content: String(entry?.content || ""),
      normalizedContent: normalizedText(entry?.content),
      role: textRoleForAiEnrichments(entry),
      approxBbox: entry?.approx_bbox,
      confidence: typeof entry?.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : undefined,
      sourceCallId: entry?.source_call_id || entry?.sourceCallId || sourceCallId,
      sourceResponsePath: `/text/${index}`,
      sourceAssetIds: ["source-original-image"],
      legacyIndex: index,
      readingOrder: index,
      reasoning: entry?.reasoning,
      raw: entry,
      extensions: optionalExtensions({
        approxPolygon: entry?.approx_polygon,
        sourceWordCount: entry?.source_word_count,
        orientationDegrees: entry?.orientation_degrees,
      }),
    }))
    .filter((entry) => entry.content.trim());
}

function extractionTextGroups(extraction, textSegments, sourceCallId) {
  return (Array.isArray(extraction?.text_groups) ? extraction.text_groups : [])
    .map((entry, index) => withoutUndefined({
      id: `text-group-${String(index + 1).padStart(4, "0")}`,
      content: String(entry?.content || ""),
      normalizedContent: normalizedText(entry?.content),
      role: textRoleForAiEnrichments(entry),
      approxBbox: entry?.approx_bbox,
      confidence: typeof entry?.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : undefined,
      sourceTextIds: (Array.isArray(entry?.source_text_indices) ? entry.source_text_indices : [])
        .map((sourceIndex) => textSegments[sourceIndex]?.id)
        .filter(Boolean),
      sourceTextIndices: Array.isArray(entry?.source_text_indices) ? entry.source_text_indices : undefined,
      sourceCallId: entry?.source_call_id || entry?.sourceCallId || sourceCallId,
      reasoning: entry?.reasoning || "Deterministically consolidated from adjacent OCR text segments.",
      extensions: optionalExtensions({
        sourceTextCount: entry?.source_text_count,
        orientationDegrees: entry?.orientation_degrees,
      }),
    }))
    .filter((entry) => entry.content.trim());
}

function sourceTextIdsForIndex(indices, textSegments) {
  return (Array.isArray(indices) ? indices : [indices])
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .map((index) => textSegments[index]?.id)
    .filter(Boolean);
}

function placenameIdentityKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:wash|washington|wa|minn|minnesota|mn|wis|wisconsin|wi|ill|illinois|il|mich|michigan|mi|ind|indiana|in|iowa|ia|ohio|oh|us|usa|united states)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resourceSpatialPlacenameType(name) {
  const normalized = normalizedText(name).toLowerCase();
  if (/\bcounty\b/.test(normalized)) return "county";
  if (/\b(?:bay|canal|channel|creek|harbor|inlet|lake|river|sound|waterway)\b/.test(normalized)) return "waterbody";
  if (/\b(?:park|playfield|reservation|reserve)\b/.test(normalized)) return "park";
  if (/\([^)]*(?:wash|washington|wa|minn|minnesota|mn|wis|wisconsin|wi|ill|illinois|il|mich|michigan|mi|ind|indiana|in|iowa|ia|ohio|oh)[^)]*\)/i.test(String(name || ""))) return "locality";
  return "other";
}

function mergeAiEnrichmentPlacename(existing, candidate) {
  const sourceTextIds = Array.from(new Set([
    ...asStringArray(existing?.sourceTextIds),
    ...asStringArray(candidate?.sourceTextIds),
  ]));
  const sourceTextIndices = Array.from(new Set([
    ...(Array.isArray(existing?.sourceTextIndices) ? existing.sourceTextIndices : []),
    ...(Array.isArray(candidate?.sourceTextIndices) ? candidate.sourceTextIndices : []),
  ].map(Number).filter((index) => Number.isInteger(index) && index >= 0))).sort((a, b) => a - b);
  const sourceCallIds = Array.from(new Set([
    existing?.sourceCallId,
    candidate?.sourceCallId,
    ...asStringArray(existing?.extensions?.sourceCallIds),
    ...asStringArray(candidate?.extensions?.sourceCallIds),
  ].map((item) => String(item || "").trim()).filter(Boolean)));
  const existingType = String(existing?.type || "other").toLowerCase();
  const candidateType = String(candidate?.type || "other").toLowerCase();
  const preferCandidateType = existingType === "other" && candidateType !== "other";
  return withoutUndefined({
    ...existing,
    type: preferCandidateType ? candidate.type : existing.type,
    sourceTextIds,
    sourceTextIndices: sourceTextIndices.length > 0 ? sourceTextIndices : undefined,
    approxBbox: existing?.approxBbox || candidate?.approxBbox,
    confidence: Math.max(Number(existing?.confidence || 0), Number(candidate?.confidence || 0)) || existing?.confidence || candidate?.confidence,
    status: existing?.status === "confirmed" ? existing.status : candidate?.status || existing?.status,
    sourceCallId: existing?.sourceCallId || candidate?.sourceCallId,
    reasoning: existing?.reasoning || candidate?.reasoning,
    extensions: optionalExtensions({
      ...(existing?.extensions || {}),
      sourceCallIds: sourceCallIds.length > 1 ? sourceCallIds : existing?.extensions?.sourceCallIds || candidate?.extensions?.sourceCallIds,
    }),
  });
}

function pushAiEnrichmentPlacename(places, byIdentity, candidate) {
  const key = placenameIdentityKey(candidate?.name);
  if (!key) return;
  const existingIndex = byIdentity.get(key);
  if (existingIndex === undefined) {
    byIdentity.set(key, places.length);
    places.push(candidate);
    return;
  }
  places[existingIndex] = mergeAiEnrichmentPlacename(places[existingIndex], candidate);
}

function derivedPlacenamesForAiEnrichments(extraction, resource, textSegments, extractionCallId, metadataCallId) {
  const places = [];
  const byIdentity = new Map();
  for (const name of asStringArray(resource?.dct_spatial_sm)) {
    pushAiEnrichmentPlacename(places, byIdentity, withoutUndefined({
      id: `place-${String(places.length + 1).padStart(4, "0")}`,
      name,
      normalizedName: name,
      type: resourceSpatialPlacenameType(name),
      sourceTextIds: [],
      confidence: 0.82,
      status: "confirmed",
      sourceCallId: metadataCallId,
      reasoning: "Pinned from the Aardvark metadata writer's spatial coverage output before visual placenames so gazetteer matching keeps catalog-level map context.",
    }));
  }

  for (const [index, place] of (Array.isArray(extraction?.placenames) ? extraction.placenames : []).entries()) {
    const name = normalizedText(place?.name);
    if (!name) continue;
    const sourceIndices = Array.isArray(place?.source_text_indices)
      ? place.source_text_indices
      : Number.isInteger(Number(place?.source_text_index)) ? [Number(place.source_text_index)] : [];
    const placeSourceCallId = place?.source_call_id || place?.sourceCallId || extractionCallId;
    const placeSourceCallIds = asStringArray(place?.source_call_ids);
    pushAiEnrichmentPlacename(places, byIdentity, withoutUndefined({
      id: `place-${String(index + 1).padStart(4, "0")}`,
      name,
      normalizedName: name,
      type: place?.type || "other",
      sourceTextIds: sourceTextIdsForIndex(sourceIndices, textSegments),
      sourceTextIndices: sourceIndices.length > 0 ? sourceIndices : undefined,
      approxBbox: Array.isArray(place?.approx_bbox) ? place.approx_bbox : undefined,
      confidence: typeof place?.confidence === "number" ? Math.max(0, Math.min(1, place.confidence)) : undefined,
      status: "candidate",
      sourceCallId: placeSourceCallId,
      reasoning: place?.reasoning,
      extensions: optionalExtensions({
        sourceCallIds: placeSourceCallIds.length > 0 ? placeSourceCallIds : undefined,
      }),
    }));
  }

  return places.map((place, index) => ({ ...place, id: `place-${String(index + 1).padStart(4, "0")}` }));
}

function aiEnrichmentLink(url, label, mediaType) {
  return withoutUndefined({ url, label, mediaType });
}

function promptChecksum(systemPrompt, userPrompt) {
  return sha256Text([systemPrompt || "", userPrompt || ""].join("\n"));
}

function openAiPromptRecord({ id, label, purpose, call }) {
  if (!call?.systemPrompt && !call?.userPrompt) return null;
  return withoutUndefined({
    id,
    label,
    purpose,
    provider: "openai",
    model: call.model,
    renderedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    systemPrompt: call.systemPrompt,
    userPrompt: call.userPrompt,
    messages: [
      call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
      call.userPrompt ? { role: "user", content: call.userPrompt } : null,
    ].filter(Boolean),
    outputSchema: call.requestBody?.text?.format?.schema,
    variables: call.variables,
    sourceCallId: call.id,
    checksum: {
      algorithm: "SHA-256",
      value: promptChecksum(call.systemPrompt, call.userPrompt),
      purpose: "Checksum of the exact rendered prompt text persisted in this AI Enrichments record.",
    },
  });
}

function openAiModelParamsForCall(call) {
  const body = call?.requestBody;
  if (!body) return undefined;
  if (Array.isArray(body.cropRequests)) {
    return withoutUndefined({
      strategy: body.strategy,
      ...(body.modelParams || {}),
    });
  }
  return Object.fromEntries(Object.entries(body).filter(([key]) => !["model", "input", "text"].includes(key)));
}

function openAiApiCallRecord({ id, sequence, purpose, call, parsedResponse, sourceAssetIds = [] }) {
  if (!call?.requestBody && !call?.rawResponse) return null;
  return withoutUndefined({
    id,
    sequence,
    provider: "openai",
    service: "responses",
    endpoint: "https://api.openai.com/v1/responses",
    method: "POST",
    purpose,
    model: call.model || call.requestBody?.model,
    modelParams: openAiModelParamsForCall(call),
    promptIds: call.promptId ? [call.promptId] : undefined,
    sourceAssetIds,
    completedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    status: call.error ? "failed" : "completed",
    request: {
      promptIds: call.promptId ? [call.promptId] : undefined,
      systemPrompt: call.systemPrompt,
      userPrompt: call.userPrompt,
      messages: [
        call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
        call.userPrompt ? { role: "user", content: call.userPrompt } : null,
      ].filter(Boolean),
      outputSchema: call.requestBody?.text?.format?.schema,
      payload: {
        rawJson: redactOpenAIRequestForPersistence(call.requestBody),
        redacted: true,
        redactionNotes: "Image bytes and credentials are not persisted; rendered text prompts are preserved exactly.",
      },
      redactions: ["api_key", "input_image_bytes"],
    },
    response: {
      raw: call.rawResponse ? { rawJson: call.rawResponse, redacted: false } : undefined,
      parsed: parsedResponse ? { rawJson: parsedResponse, redacted: false } : undefined,
      usage: call.usage,
      error: call.error,
    },
    error: call.error,
  });
}

function geminiPromptRecord({ id, label, purpose, call }) {
  if (!call?.systemPrompt && !call?.userPrompt) return null;
  return withoutUndefined({
    id,
    label,
    purpose,
    provider: "gemini",
    model: call.model,
    renderedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    systemPrompt: call.systemPrompt,
    userPrompt: call.userPrompt,
    messages: [
      call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
      call.userPrompt ? { role: "user", content: call.userPrompt } : null,
    ].filter(Boolean),
    outputSchema: call.requestBody?.generationConfig?.responseSchema,
    variables: call.variables,
    sourceCallId: call.id,
    checksum: {
      algorithm: "SHA-256",
      value: promptChecksum(call.systemPrompt, call.userPrompt),
      purpose: "Checksum of the exact rendered Gemini prompt text persisted in this AI Enrichments record.",
    },
  });
}

function geminiApiCallRecord({ id, sequence, purpose, call, parsedResponse, sourceAssetIds = [] }) {
  if (!call?.requestBody && !call?.rawResponse) return null;
  return withoutUndefined({
    id,
    sequence,
    provider: "gemini",
    service: "generateContent",
    endpoint: call.model ? `https://generativelanguage.googleapis.com/v1beta/models/${call.model}:generateContent` : undefined,
    method: "POST",
    purpose,
    model: call.model,
    modelParams: call.requestBody?.generationConfig
      ? Object.fromEntries(Object.entries(call.requestBody.generationConfig)
        .filter(([key]) => !["responseMimeType", "responseSchema"].includes(key)))
      : undefined,
    promptIds: call.promptId ? [call.promptId] : undefined,
    sourceAssetIds,
    completedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    status: call.error ? "failed" : "completed",
    request: {
      promptIds: call.promptId ? [call.promptId] : undefined,
      systemPrompt: call.systemPrompt,
      userPrompt: call.userPrompt,
      outputSchema: call.requestBody?.generationConfig?.responseSchema,
      payload: {
        rawJson: call.requestBody ? redactGeminiRequestForPersistence(call.requestBody) : undefined,
        redacted: true,
        redactionNotes: "Inline image bytes and credentials are not persisted; rendered text prompts are preserved exactly.",
      },
      redactions: ["api_key", "inline_image_bytes"],
    },
    response: {
      raw: call.rawResponse ? { rawJson: call.rawResponse, redacted: false } : undefined,
      parsed: parsedResponse ? { rawJson: parsedResponse, redacted: false } : undefined,
      usage: call.usage,
      error: call.error,
    },
    error: call.error,
  });
}

function kimiPromptRecord({ id, label, purpose, call }) {
  if (!call?.systemPrompt && !call?.userPrompt) return null;
  return withoutUndefined({
    id,
    label,
    purpose,
    provider: "kimi",
    model: call.model,
    renderedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    systemPrompt: call.systemPrompt,
    userPrompt: call.userPrompt,
    messages: [
      call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
      call.userPrompt ? { role: "user", content: call.userPrompt } : null,
    ].filter(Boolean),
    outputSchema: call.requestBody?.response_format?.json_schema?.schema,
    variables: call.variables,
    sourceCallId: call.id,
    checksum: {
      algorithm: "SHA-256",
      value: promptChecksum(call.systemPrompt, call.userPrompt),
      purpose: "Checksum of the exact rendered Kimi prompt text persisted in this AI Enrichments record.",
    },
    extensions: optionalExtensions({
      promptCacheKeys: call.parsedResponse?.cropStatuses?.map((status) => status?.promptCacheKey).filter(Boolean),
      responseCacheHitCount: call.parsedResponse?.extractionStatus?.responseCacheHitCount,
    }),
  });
}

function kimiModelParamsForCall(call) {
  const body = call?.requestBody;
  if (!body) return undefined;
  if (Array.isArray(body.cropRequests)) {
    return withoutUndefined({
      strategy: body.strategy,
      ...(body.modelParams || {}),
    });
  }
  return Object.fromEntries(Object.entries(body).filter(([key]) => !["model", "messages", "response_format"].includes(key)));
}

function kimiApiCallRecord({ id, sequence, purpose, call, parsedResponse, sourceAssetIds = [] }) {
  if (!call?.requestBody && !call?.rawResponse) return null;
  return withoutUndefined({
    id,
    sequence,
    provider: "kimi",
    service: "chat/completions",
    endpoint: "https://api.moonshot.ai/v1/chat/completions",
    method: "POST",
    purpose,
    model: call.model || call.requestBody?.model,
    modelParams: kimiModelParamsForCall(call),
    promptIds: call.promptId ? [call.promptId] : undefined,
    sourceAssetIds,
    completedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    status: call.error ? "failed" : "completed",
    request: {
      promptIds: call.promptId ? [call.promptId] : undefined,
      systemPrompt: call.systemPrompt,
      userPrompt: call.userPrompt,
      messages: [
        call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
        call.userPrompt ? { role: "user", content: call.userPrompt } : null,
      ].filter(Boolean),
      outputSchema: call.requestBody?.response_format?.json_schema?.schema,
      payload: {
        rawJson: redactOpenAIRequestForPersistence(call.requestBody),
        redacted: true,
        redactionNotes: "Inline image bytes and credentials are not persisted; rendered text prompts, cache keys, and response-cache status are preserved.",
      },
      redactions: ["api_key", "image_url_base64"],
    },
    response: {
      raw: call.rawResponse ? { rawJson: call.rawResponse, redacted: false } : undefined,
      parsed: parsedResponse ? { rawJson: parsedResponse, redacted: false } : undefined,
      usage: call.usage,
      error: call.error,
    },
    error: call.error,
    extensions: optionalExtensions({
      responseCacheHitCount: call.parsedResponse?.extractionStatus?.responseCacheHitCount,
      cachedTokens: call.usage?.cached_tokens,
    }),
  });
}

function ocrApiCallRecord({ result, completedAt }) {
  return withoutUndefined({
    id: "call-google-vision-ocr",
    sequence: 1,
    provider: "google_cloud_vision",
    service: "images:annotate",
    endpoint: "https://vision.googleapis.com/v1/images:annotate",
    method: "POST",
    purpose: "ocr",
    sourceAssetIds: ["source-original-image"],
    completedAt: safeDateTime(completedAt) || new Date().toISOString(),
    status: result?.error ? "failed" : "completed",
    request: {
      payload: {
        rawJson: result?.requestBody || { note: "Request body was not persisted by this provider call." },
        redacted: true,
        redactionNotes: "Inline image bytes and API key are not persisted.",
      },
      redactions: ["api_key", "inline_image_bytes"],
    },
    response: {
      raw: result?.rawResponse ? { rawJson: result.rawResponse, redacted: false } : undefined,
      parsed: result?.parsedResponse ? { rawJson: result.parsedResponse, redacted: false } : undefined,
      usage: result?.usage,
      error: result?.error,
    },
    error: result?.error,
  });
}

function mapExtentForAiEnrichments(extraction, sourceCallId) {
  const bbox = extraction?.map_bbox_estimate || {};
  const bboxSourceCallIds = Array.from(new Set([
    ...asStringArray(bbox.source_call_ids),
    bbox.source_call_id,
  ].filter(Boolean)));
  return withoutUndefined({
    west: Number(bbox.west || 0),
    south: Number(bbox.south || 0),
    east: Number(bbox.east || 0),
    north: Number(bbox.north || 0),
    confidence: typeof bbox.confidence === "number" ? Math.max(0, Math.min(1, bbox.confidence)) : 0,
    method: bbox.method || "not_inferred",
    reasoning: bbox.reasoning || "No geographic map extent was inferred.",
    sourceCallIds: bboxSourceCallIds.length > 0 ? bboxSourceCallIds : [sourceCallId].filter(Boolean),
  });
}

function distributionsWithAiEnrichments(resource, aiEnrichmentsUrl) {
  const distributions = distributionsFromResource(resource);
  if (aiEnrichmentsUrl && !distributions.some((item) => item.relation_key === AI_ENRICHMENTS_RELATION && item.url === aiEnrichmentsUrl)) {
    distributions.push({
      resource_id: resource.id,
      relation_key: AI_ENRICHMENTS_RELATION,
      url: aiEnrichmentsUrl,
      label: "OpenGeoMetadata AI Enrichments JSON",
    });
  }
  return distributions.map((item) => withoutUndefined({
    relationKey: item.relation_key,
    url: item.url,
    label: item.label,
  }));
}

function labelCandidatesForAiEnrichments(extraction) {
  return (Array.isArray(extraction?.label_candidates) ? extraction.label_candidates : [])
    .map((entry, index) => withoutUndefined({
      id: entry?.id || `label-candidate-${String(index + 1).padStart(4, "0")}`,
      content: String(entry?.content || ""),
      role: textRoleForAiEnrichments(entry),
      approxBbox: entry?.approx_bbox || entry?.approxBbox,
      approxPolygon: entry?.approx_polygon || entry?.approxPolygon,
      confidence: typeof entry?.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : undefined,
      sourceCallId: entry?.source_call_id || entry?.sourceCallId,
      sourceTextIndices: asNumberArray(entry?.source_text_indices || entry?.sourceTextIndices),
      geometryStatus: entry?.geometry_status || entry?.geometryStatus,
      candidateStatus: entry?.candidate_status || entry?.candidateStatus,
      bboxSupport: entry?.bbox_support || entry?.bboxSupport,
      orientationDegrees: entry?.orientation_degrees ?? entry?.orientationDegrees,
      writingMode: entry?.writing_mode || entry?.writingMode,
      geometryKind: entry?.geometry_kind || entry?.geometryKind,
      reasoning: entry?.reasoning,
      raw: entry?.raw,
      extensions: optionalExtensions({
        sourceImageId: entry?.source_image_id,
        sourceImageKind: entry?.source_image_kind,
        sourceRegion: entry?.source_region,
        uncertaintyFlags: entry?.uncertainty_flags,
      }),
    }))
    .filter((entry) => entry.content.trim());
}

function buildAiEnrichmentsForImage(args) {
  const {
    resourceId,
    fileName,
    checksum,
    fileSize,
    contentType,
    modifiedAt,
    artifacts,
    extractionResult,
    metadataWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls = [],
    derivativeSummaries = [],
  } = args;
  const createdAt = safeDateTime(archivalSupplement?.processingDate) || safeDateTime(resource?.gbl_mdModified_dt) || new Date().toISOString();
  const extraction = extractionResult?.parsedResponse || {};
  const isOpenAiExtraction = extractionResult?.provider === "openai";
  const isHybridVisionOcr = extractionResult?.provider === HYBRID_VISION_OCR_PROVIDER;
  const isGeminiHybridVisionOcr = extractionResult?.provider === HYBRID_GEMINI_VISION_OCR_PROVIDER;
  const isOpenAIHybridVisionOcr = extractionResult?.provider === HYBRID_OPENAI_VISION_OCR_PROVIDER;
  const isKimiHybridVisionOcr = extractionResult?.provider === HYBRID_KIMI_VISION_OCR_PROVIDER;
  const ocrExtractionResult = (isHybridVisionOcr || isGeminiHybridVisionOcr || isOpenAIHybridVisionOcr || isKimiHybridVisionOcr) ? extractionResult?.ocrResult : extractionResult?.provider === "google_cloud_vision" ? extractionResult : null;
  const extractionCallId = isOpenAiExtraction
    ? "call-openai-historical-map-extraction"
    : isGeminiHybridVisionOcr
      ? GEMINI_LABEL_EXTRACTION_CALL_ID
      : isOpenAIHybridVisionOcr
        ? OPENAI_LABEL_RECONCILIATION_CALL_ID
        : isKimiHybridVisionOcr
          ? KIMI_AGENT_SWARM_CALL_ID
          : GOOGLE_VISION_OCR_CALL_ID;
  const textSegments = extractionTextSegments(extraction, extractionCallId);
  const textGroups = extractionTextGroups(extraction, textSegments, extractionCallId);
  const metadataCall = metadataWriter ? {
    ...metadataWriter,
    id: "call-openai-aardvark-metadata-writer",
    promptId: "prompt-openai-aardvark-metadata-writer",
    completedAt: resource?.gbl_mdModified_dt || createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      metadataSourceUrls,
    },
  } : null;
  const extractionOpenAiCall = extractionResult?.provider === "openai" ? {
    ...extractionResult,
    id: "call-openai-historical-map-extraction",
    promptId: "prompt-openai-historical-map-extraction",
    completedAt: createdAt,
    variables: { resourceId, fileName, checksum, artifactUrls: artifacts },
  } : null;
  const visionAugmentationCall = extractionResult?.visionAugmentation ? {
    ...extractionResult.visionAugmentation,
    id: OPENAI_VISION_AUGMENTATION_CALL_ID,
    promptId: "prompt-openai-vision-text-augmentation",
    completedAt: createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      ocrTextCount: extractionResult.ocrResult?.parsedResponse?.text?.length || 0,
      ocrTextGroupCount: extractionResult.ocrResult?.parsedResponse?.text_groups?.length || 0,
      ocrPlacenameCount: extractionResult.ocrResult?.parsedResponse?.placenames?.length || 0,
    },
  } : null;
  const geminiLabelExtractionCall = extractionResult?.geminiExtraction ? {
    ...extractionResult.geminiExtraction,
    id: GEMINI_LABEL_EXTRACTION_CALL_ID,
    promptId: "prompt-gemini-map-label-extraction",
    completedAt: createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      ocrTextCount: extractionResult.ocrResult?.parsedResponse?.text?.length || 0,
      ocrTextGroupCount: extractionResult.ocrResult?.parsedResponse?.text_groups?.length || 0,
      ocrPlacenameCount: extractionResult.ocrResult?.parsedResponse?.placenames?.length || 0,
    },
  } : null;
  const openAIReconciliationCall = extractionResult?.openAIReconciliation ? {
    ...extractionResult.openAIReconciliation,
    id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
    promptId: "prompt-openai-map-label-reconciliation",
    completedAt: createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      ocrTextCount: extractionResult.ocrResult?.parsedResponse?.text?.length || 0,
      ocrTextGroupCount: extractionResult.ocrResult?.parsedResponse?.text_groups?.length || 0,
      ocrPlacenameCount: extractionResult.ocrResult?.parsedResponse?.placenames?.length || 0,
    },
  } : null;
  const kimiSwarmCall = extractionResult?.kimiSwarm ? {
    ...extractionResult.kimiSwarm,
    id: KIMI_AGENT_SWARM_CALL_ID,
    promptId: "prompt-kimi-map-agent-swarm",
    completedAt: createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      ocrTextCount: extractionResult.ocrResult?.parsedResponse?.text?.length || 0,
      ocrTextGroupCount: extractionResult.ocrResult?.parsedResponse?.text_groups?.length || 0,
      ocrPlacenameCount: extractionResult.ocrResult?.parsedResponse?.placenames?.length || 0,
    },
  } : null;
  const metadataSequence = (visionAugmentationCall || geminiLabelExtractionCall || openAIReconciliationCall || kimiSwarmCall) ? 3 : 2;
  const mapExtent = mapExtentForAiEnrichments(extraction, extractionCallId);
  const basePlacenames = derivedPlacenamesForAiEnrichments(extraction, resource, textSegments, extractionCallId, "call-openai-aardvark-metadata-writer");
  const skipConcordance = AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT > 0
    && basePlacenames.length > AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT;
  const skippedConcordanceExtension = skipConcordance
    ? {
      status: "skipped",
      reason: `Skipped concordance during AI Enrichments assembly because ${basePlacenames.length} placename candidates exceeds AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT=${AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT}. Text extraction should be reviewed before gazetteer matching at this scale.`,
      placenameCount: basePlacenames.length,
      limit: AI_ENRICHMENTS_CONCORDANCE_PLACENAME_LIMIT,
    }
    : null;
  const wofConcordance = skipConcordance
    ? { placenames: basePlacenames, extension: skippedConcordanceExtension }
    : buildWofConcordanceLayer({
      placenames: basePlacenames,
      textGroups,
      textSegments,
      extraction,
      resource,
      mapExtent,
    });
  const osmConcordance = skipConcordance
    ? { placenames: wofConcordance.placenames, extension: skippedConcordanceExtension }
    : buildOsmConcordanceLayer({
      placenames: wofConcordance.placenames,
      textGroups,
      textSegments,
      extraction,
      resource,
      mapExtent,
      boundary: wofConcordance.extension?.boundary,
    });
  const geonamesConcordance = skipConcordance
    ? { placenames: osmConcordance.placenames, extension: skippedConcordanceExtension }
    : buildGeoNamesConcordanceLayer({
      placenames: osmConcordance.placenames,
      textGroups,
      textSegments,
      extraction,
      resource,
      mapExtent,
      boundary: wofConcordance.extension?.boundary,
    });
  const canonicalConcordance = skipConcordance
    ? { placenames: geonamesConcordance.placenames, extension: skippedConcordanceExtension }
    : buildCanonicalConcordanceLayer({
      placenames: geonamesConcordance.placenames,
      textGroups,
      textSegments,
      extraction,
      resource,
      mapExtent,
      boundary: wofConcordance.extension?.boundary,
    });
  const placenames = canonicalConcordance.placenames;
  const apiCalls = [
    ocrExtractionResult ? ocrApiCallRecord({ result: ocrExtractionResult, completedAt: createdAt }) : null,
    extractionOpenAiCall ? openAiApiCallRecord({
      id: "call-openai-historical-map-extraction",
      sequence: 1,
      purpose: "map_text_extraction",
      call: extractionOpenAiCall,
      parsedResponse: extraction,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    visionAugmentationCall ? openAiApiCallRecord({
      id: OPENAI_VISION_AUGMENTATION_CALL_ID,
      sequence: 2,
      purpose: "map_text_extraction",
      call: visionAugmentationCall,
      parsedResponse: visionAugmentationCall.parsedResponse,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    geminiLabelExtractionCall ? geminiApiCallRecord({
      id: GEMINI_LABEL_EXTRACTION_CALL_ID,
      sequence: 2,
      purpose: "map_text_extraction",
      call: geminiLabelExtractionCall,
      parsedResponse: geminiLabelExtractionCall.parsedResponse,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    openAIReconciliationCall ? openAiApiCallRecord({
      id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
      sequence: 2,
      purpose: "map_text_extraction",
      call: openAIReconciliationCall,
      parsedResponse: openAIReconciliationCall.parsedResponse,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    kimiSwarmCall ? kimiApiCallRecord({
      id: KIMI_AGENT_SWARM_CALL_ID,
      sequence: 2,
      purpose: "map_text_extraction",
      call: kimiSwarmCall,
      parsedResponse: kimiSwarmCall.parsedResponse,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    metadataCall ? openAiApiCallRecord({
      id: "call-openai-aardvark-metadata-writer",
      sequence: metadataSequence,
      purpose: "metadata_generation",
      call: metadataCall,
      parsedResponse: { resource: metadataWriter?.resource || resource, evidence: metadataWriter?.evidence || [] },
      sourceAssetIds: ["source-original-image", "artifact-legacy-enrichment-response"],
    }) : null,
  ].filter(Boolean);
  const prompts = [
    extractionOpenAiCall ? openAiPromptRecord({
      id: "prompt-openai-historical-map-extraction",
      label: "Historical map text extraction",
      purpose: "map_text_extraction",
      call: extractionOpenAiCall,
    }) : null,
    visionAugmentationCall ? openAiPromptRecord({
      id: "prompt-openai-vision-text-augmentation",
      label: "OpenAI vision map-text augmentation after OCR",
      purpose: "map_text_extraction",
      call: visionAugmentationCall,
    }) : null,
    geminiLabelExtractionCall ? geminiPromptRecord({
      id: "prompt-gemini-map-label-extraction",
      label: "Gemini map-label extraction after OCR",
      purpose: "map_text_extraction",
      call: geminiLabelExtractionCall,
    }) : null,
    openAIReconciliationCall ? openAiPromptRecord({
      id: "prompt-openai-map-label-reconciliation",
      label: "OpenAI map-label reconciliation after OCR",
      purpose: "map_text_extraction",
      call: openAIReconciliationCall,
    }) : null,
    kimiSwarmCall ? kimiPromptRecord({
      id: "prompt-kimi-map-agent-swarm",
      label: "Kimi K2.6 cached map-agent swarm after OCR",
      purpose: "map_text_extraction",
      call: kimiSwarmCall,
    }) : null,
    metadataCall ? openAiPromptRecord({
      id: "prompt-openai-aardvark-metadata-writer",
      label: "Aardvark metadata writer for scanned historical maps",
      purpose: "metadata_generation",
      call: metadataCall,
    }) : null,
  ].filter(Boolean);
  const mapTextValues = Array.from(new Set([
    ...textSegments.map((item) => item.content),
    ...textGroups.map((item) => item.content),
  ].map(normalizedText).filter(Boolean)));
  return withoutUndefined({
    schemaVersion: AI_ENRICHMENTS_SCHEMA_VERSION,
    standard: "OpenGeoMetadata AI Enrichments",
    resourceId,
    createdAt,
    updatedAt: safeDateTime(resource?.gbl_mdModified_dt) || createdAt,
    generatedBy: {
      name: "Aardvark Metadata Studio enrichment proxy",
      workflow: "image-upload-ocr-openai-aardvark-writer",
      workflowVersion: AI_ENRICHMENTS_SCHEMA_VERSION,
      notes: "Generated at processing time so exact rendered prompts, provider/model choices, and raw responses are preserved.",
    },
    sourceAssets: [
      {
        id: "source-original-image",
        role: "original",
        fileName,
        path: artifacts.originalUrl ? new URL(artifacts.originalUrl).pathname.replace(/^\/[^/]+\//, "") : undefined,
        url: artifacts.originalUrl,
        mediaType: contentType || "application/octet-stream",
        byteSize: Number(fileSize || 0),
        modifiedAt: safeDateTime(modifiedAt),
        checksums: checksum ? [{ algorithm: "SHA-256", value: checksum, purpose: "Submitted image fixity value computed before enrichment." }] : undefined,
      },
      ...derivativeSummaries.map((derivative) => withoutUndefined({
        id: derivative.id,
        role: "analysis_derivative",
        mediaType: derivative.mimeType,
        byteSize: derivative.bytes,
        width: derivative.width,
        height: derivative.height,
        notes: `Vision/text extraction analysis derivative: ${derivative.kind || "image"}.`,
        extensions: optionalExtensions({
          sourceImageId: derivative.sourceImageId,
          sourceImageKind: derivative.sourceImageKind,
          sourceRegion: derivative.region,
          coordinateWidth: derivative.coordinateWidth,
          coordinateHeight: derivative.coordinateHeight,
        }),
      })),
      { id: "derivative-iiif-image-service", role: "iiif_image", url: artifacts.iiifInfoUrl, mediaType: "application/json" },
      { id: "derivative-thumbnail", role: "thumbnail", url: artifacts.thumbnailUrl, mediaType: "image/jpeg" },
      { id: "artifact-legacy-enrichment-response", role: "derived_metadata", url: artifacts.extractionUrl, mediaType: "application/json" },
      { id: "artifact-aardvark-json", role: "derived_metadata", url: artifacts.aardvarkUrl, mediaType: "application/json" },
      { id: "artifact-archival-supplement-json", role: "other", url: artifacts.archivalSupplementJsonUrl, mediaType: "application/json" },
      ...metadataSourceUrls.map((url, index) => ({ id: `metadata-source-${index + 1}`, role: "companion_metadata", url, mediaType: contentTypeForMetadataKey(url) })),
    ],
    artifacts: {
      aardvarkJson: aiEnrichmentLink(artifacts.aardvarkUrl, "Aardvark JSON", "application/json"),
      aiEnrichmentsJson: aiEnrichmentLink(artifacts.aiEnrichmentsUrl, "OpenGeoMetadata AI Enrichments JSON", "application/json"),
      legacyEnrichmentResponse: aiEnrichmentLink(artifacts.extractionUrl, "Legacy enrichment_response.json", "application/json"),
      original: aiEnrichmentLink(artifacts.originalUrl, "Original submitted image", contentType || "application/octet-stream"),
      thumbnail: aiEnrichmentLink(artifacts.thumbnailUrl, "Thumbnail", "image/jpeg"),
      iiifImage: aiEnrichmentLink(artifacts.iiifInfoUrl, "IIIF Image API info.json", "application/json"),
      cloudOptimizedGeoTiff: artifacts.cogUrl ? aiEnrichmentLink(artifacts.cogUrl, "Cloud Optimized GeoTIFF", "image/tiff") : undefined,
      archivalSupplement: aiEnrichmentLink(artifacts.archivalSupplementUrl, "Archival accession processing supplement", "text/markdown"),
      archivalSupplementJson: aiEnrichmentLink(artifacts.archivalSupplementJsonUrl, "Archival accession supplement JSON", "application/json"),
      metadataSources: metadataSourceUrls.map((url) => aiEnrichmentLink(url, "Companion metadata", contentTypeForMetadataKey(url))),
    },
    apiCalls,
    prompts,
    extractedMapText: textSegments,
    textExtractionRuns: extraction?.text_extraction_runs,
    labelCandidates: labelCandidatesForAiEnrichments(extraction),
    textGroups,
    derivedPlacenames: placenames,
    mapExtent,
    description: extraction?.description || asStringArray(resource?.dct_description_sm)[0] || "",
    debug: {
      ...(extraction?.debug || {}),
      schema: AI_ENRICHMENTS_SCHEMA_URL,
    },
    derivedMetadata: {
      standard: "Aardvark",
      standardVersion: "Aardvark",
      recordSchema: "https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json",
      record: resource,
      distributions: distributionsWithAiEnrichments(resource, artifacts.aiEnrichmentsUrl),
      fieldEvidence: [
        { field: "dct_title_s", value: resource?.dct_title_s, sourceCallIds: ["call-openai-aardvark-metadata-writer"], confidence: 0.9, reasoning: "Generated by the Aardvark metadata writer from OCR and source evidence.", reviewStatus: "machine_generated" },
        { field: "dct_spatial_sm", value: resource?.dct_spatial_sm || [], sourcePlacenameIds: placenames.map((place) => place.id), sourceCallIds: ["call-openai-aardvark-metadata-writer"], confidence: 0.8, reasoning: "Spatial coverage derived from OCR and metadata writer evidence.", reviewStatus: "machine_generated" },
      ],
      confidence: metadataWriter ? 0.9 : undefined,
      createdFromCallIds: apiCalls.map((call) => call.id),
      normalizationNotes: ["OpenGeoMetadata AI Enrichments preserves raw prompts and responses; Aardvark remains the reviewed discovery record."],
    },
    indexingHints: {
      fields: [
        {
          field: "ogm_ai_map_text_tsim",
          values: mapTextValues,
          sourceIds: textSegments.map((item) => item.id),
          confidence: textSegments.length > 0 ? textSegments.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / textSegments.length : undefined,
          boost: 2,
          notes: "Indexable text extracted from the map image, including street labels and other fine-grained map text not suitable for Aardvark fields.",
        },
        {
          field: "ogm_ai_placename_sm",
          values: placenames.map((place) => place.name),
          sourceIds: placenames.flatMap((place) => place.sourceTextIds || []),
          confidence: placenames.length > 0 ? placenames.reduce((sum, place) => sum + Number(place.confidence || 0), 0) / placenames.length : undefined,
          boost: 3,
        },
      ],
    },
    review: {
      status: "machine_generated",
      notes: "Review derived metadata, placenames, and OCR before treating candidate values as authoritative.",
    },
    extensions: optionalExtensions({
      wofConcordance: wofConcordance.extension,
      osmConcordance: osmConcordance.extension,
      geonamesConcordance: geonamesConcordance.extension,
      canonicalGazetteer: canonicalConcordance.extension,
      kimiSwarm: extraction?.kimi_swarm,
      textExtractionGraph: (Array.isArray(extraction?.text_extraction_runs) || Array.isArray(extraction?.label_candidates)) ? withoutUndefined({
        textExtractionRuns: extraction?.text_extraction_runs,
        labelCandidates: extraction?.label_candidates,
        kimiSwarmClaims: extraction?.kimi_swarm?.claims,
      }) : undefined,
    }),
  });
}

async function loadJsZip() {
  const mod = await import("jszip");
  return mod.default || mod;
}

function normalizeZipPath(name) {
  return String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isIgnoredZipEntry(name) {
  const normalized = normalizeZipPath(name);
  const parts = normalized.split("/");
  const basename = parts[parts.length - 1] || "";
  return parts.includes("__MACOSX") || basename.startsWith("._") || basename === ".DS_Store";
}

function stripKnownGeoExtension(name) {
  const normalized = normalizeZipPath(name);
  if (/\.shp\.xml$/i.test(normalized)) return normalized.replace(/\.shp\.xml$/i, "");
  return normalized.replace(/\.(shp|shx|dbf|prj|cpg|sbn|sbx|qix)$/i, "");
}

function stripKnownRasterExtension(name) {
  const normalized = normalizeZipPath(name);
  return normalized
    .replace(/\.(tif|tiff|sid|img|jp2|j2k)\.aux\.xml$/i, "")
    .replace(/\.(tif|tiff|sid|img|jp2|j2k|aux)\.xml$/i, "")
    .replace(/\.(tfw|tifw|jgw|j2w|sdw|wld|prj|aux|ovr|rrd|met)$/i, "")
    .replace(/\.(tiff?|sid|img|jp2|j2k)$/i, "");
}

function isRasterSourceEntry(name) {
  return /\.(tiff?|sid|img|jp2|j2k)$/i.test(name);
}

async function zipEntriesFromBuffer(buffer) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(buffer);
  const entries = [];
  for (const [rawName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const name = normalizeZipPath(rawName);
    if (isIgnoredZipEntry(name)) continue;
    const entryBuffer = await entry.async("nodebuffer");
    entries.push({
      name,
      lowerName: name.toLowerCase(),
      size: entryBuffer.length,
      modifiedAt: entry.date instanceof Date && Number.isFinite(entry.date.getTime()) ? entry.date.toISOString() : "",
      sha256: sha256(entryBuffer),
      buffer: entryBuffer,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function findEntry(entries, predicate) {
  return entries.find((entry) => predicate(entry.lowerName));
}

function findShapefileSet(entries) {
  const shp = findEntry(entries, (name) => name.endsWith(".shp") && !name.endsWith(".shp.xml"));
  if (!shp) return null;
  const base = stripKnownGeoExtension(shp.name);
  const lowerBase = base.toLowerCase();
  const byLowerName = new Map(entries.map((entry) => [entry.lowerName, entry]));
  return {
    base,
    shp,
    shx: byLowerName.get(`${lowerBase}.shx`) || null,
    dbf: byLowerName.get(`${lowerBase}.dbf`) || null,
    prj: byLowerName.get(`${lowerBase}.prj`) || null,
    shpXml: byLowerName.get(`${lowerBase}.shp.xml`) || null,
  };
}

function findRasterSet(entries) {
  const source = findEntry(entries, isRasterSourceEntry);
  if (!source) return null;
  const base = stripKnownRasterExtension(source.name);
  const lowerBase = base.toLowerCase();
  return {
    base,
    source,
    sidecars: entries.filter((entry) => entry !== source && stripKnownRasterExtension(entry.name).toLowerCase() === lowerBase),
  };
}

function parseDbf(buffer) {
  if (!buffer || buffer.length < 32) return null;
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  let offset = 32;
  let recordOffset = 1;
  while (offset + 32 <= buffer.length && buffer[offset] !== 0x0d) {
    const descriptor = buffer.subarray(offset, offset + 32);
    const name = descriptor.subarray(0, 11).toString("ascii").replace(/\0.*$/g, "").trim();
    const type = String.fromCharCode(descriptor[11] || 0);
    const length = descriptor[16] || 0;
    const decimals = descriptor[17] || 0;
    if (name && length > 0) {
      fields.push({ name, type, length, decimals, offset: recordOffset });
      recordOffset += length;
    }
    offset += 32;
  }

  const rows = [];
  for (let index = 0; index < recordCount; index += 1) {
    const start = headerLength + index * recordLength;
    const record = buffer.subarray(start, start + recordLength);
    if (record.length < recordLength || record[0] === 0x2a) continue;
    const row = {};
    for (const field of fields) {
      const raw = record.subarray(field.offset, field.offset + field.length).toString("latin1").trim();
      row[field.name] = raw;
    }
    rows.push(row);
  }

  return {
    recordCount,
    headerLength,
    recordLength,
    fields: fields.map(({ offset: _offset, ...field }) => field),
    rows,
  };
}

const SHAPE_TYPE_LABELS = {
  0: "Null",
  1: "Point",
  3: "Polyline",
  5: "Polygon",
  8: "MultiPoint",
  11: "PointZ",
  13: "PolylineZ",
  15: "PolygonZ",
  18: "MultiPointZ",
  21: "PointM",
  23: "PolylineM",
  25: "PolygonM",
  28: "MultiPointM",
  31: "MultiPatch",
};

function parseShpSummary(buffer) {
  if (!buffer || buffer.length < 100) throw new Error("The .shp file is too small to contain a valid shapefile header.");
  const fileCode = buffer.readInt32BE(0);
  const fileLengthWords = buffer.readInt32BE(24);
  const version = buffer.readInt32LE(28);
  const shapeType = buffer.readInt32LE(32);
  const minX = buffer.readDoubleLE(36);
  const minY = buffer.readDoubleLE(44);
  const maxX = buffer.readDoubleLE(52);
  const maxY = buffer.readDoubleLE(60);
  const shapeTypeCounts = {};
  let recordCount = 0;
  let totalParts = 0;
  let totalPoints = 0;
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    const contentOffset = offset + 8;
    const byteLength = contentLengthWords * 2;
    if (contentOffset + byteLength > buffer.length || byteLength < 4) break;
    const recordShapeType = buffer.readInt32LE(contentOffset);
    shapeTypeCounts[recordShapeType] = (shapeTypeCounts[recordShapeType] || 0) + 1;
    if ([3, 5, 13, 15, 23, 25, 31].includes(recordShapeType) && byteLength >= 44) {
      totalParts += buffer.readInt32LE(contentOffset + 36);
      totalPoints += buffer.readInt32LE(contentOffset + 40);
    }
    recordCount += 1;
    offset += 8 + byteLength;
  }
  return {
    fileCode,
    version,
    fileLengthBytes: fileLengthWords * 2,
    shapeType,
    geometryType: SHAPE_TYPE_LABELS[shapeType] || `Shape type ${shapeType}`,
    recordCount,
    totalParts,
    totalPoints,
    bbox: { west: minX, south: minY, east: maxX, north: maxY },
    shapeTypeCounts,
  };
}

function ensureClosedRing(points) {
  if (points.length === 0) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, first];
}

function parseShpPolygonFeatures(buffer, rows) {
  const features = [];
  let recordIndex = 0;
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    const contentOffset = offset + 8;
    const byteLength = contentLengthWords * 2;
    if (contentOffset + byteLength > buffer.length || byteLength < 4) break;
    const shapeType = buffer.readInt32LE(contentOffset);
    if (shapeType === 5 && byteLength >= 44) {
      const numParts = buffer.readInt32LE(contentOffset + 36);
      const numPoints = buffer.readInt32LE(contentOffset + 40);
      const partsOffset = contentOffset + 44;
      const pointsOffset = partsOffset + numParts * 4;
      const partStarts = [];
      for (let part = 0; part < numParts; part += 1) {
        partStarts.push(buffer.readInt32LE(partsOffset + part * 4));
      }
      const rings = [];
      for (let part = 0; part < numParts; part += 1) {
        const startPoint = partStarts[part];
        const endPoint = part + 1 < numParts ? partStarts[part + 1] : numPoints;
        const ring = [];
        for (let point = startPoint; point < endPoint; point += 1) {
          const pointOffset = pointsOffset + point * 16;
          ring.push([buffer.readDoubleLE(pointOffset), buffer.readDoubleLE(pointOffset + 8)]);
        }
        if (ring.length >= 4) rings.push(ensureClosedRing(ring));
      }
      if (rings.length > 0) {
        features.push({
          type: "Feature",
          properties: rows?.[recordIndex] || {},
          geometry: { type: "Polygon", coordinates: rings },
        });
      }
    }
    recordIndex += 1;
    offset += 8 + byteLength;
  }
  return features;
}

function compactCounts(counter, limit = 20) {
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function summarizeAttributes(dbf) {
  if (!dbf) return null;
  const interestingNames = ["ST", "STATE", "Band", "BAND", "UTM", "ZONE", "Res", "RES", "SrcImgDate", "VerDate", "FileName", "QQNAME"];
  const stats = {};
  for (const name of interestingNames) {
    if (!dbf.fields.some((field) => field.name === name)) continue;
    const counter = new Map();
    for (const row of dbf.rows) {
      const value = String(row[name] || "").trim();
      if (!value) continue;
      counter.set(value, (counter.get(value) || 0) + 1);
    }
    stats[name] = {
      uniqueCount: counter.size,
      topValues: compactCounts(counter),
    };
  }
  return {
    recordCount: dbf.recordCount,
    fieldCount: dbf.fields.length,
    fields: dbf.fields,
    stats,
    sampleRows: dbf.rows.slice(0, 8),
  };
}

function yyyymmddToIso(value) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) return "";
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function dateRangeFromRows(rows, field) {
  const values = rows.map((row) => String(row[field] || "").trim()).filter((value) => /^\d{8}$/.test(value)).sort();
  if (values.length === 0) return null;
  return {
    field,
    min: values[0],
    max: values[values.length - 1],
    minIso: yyyymmddToIso(values[0]),
    maxIso: yyyymmddToIso(values[values.length - 1]),
    years: Array.from(new Set(values.map((value) => value.slice(0, 4)))).sort(),
  };
}

function inferTemporal(dbf) {
  if (!dbf) return null;
  return dateRangeFromRows(dbf.rows, "SrcImgDate") || dateRangeFromRows(dbf.rows, "VerDate");
}

const US_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function spatialNamesFromAttributes(dbf) {
  if (!dbf) return [];
  const counter = new Map();
  for (const row of dbf.rows) {
    const code = String(row.ST || row.STATE || "").trim().toUpperCase();
    if (!code) continue;
    const name = US_STATE_NAMES[code] || code;
    counter.set(name, (counter.get(name) || 0) + 1);
  }
  return compactCounts(counter, 12).map((item) => item.value);
}

function humanTitleFromPackage(baseName, manifest) {
  const lower = String(baseName || "").toLowerCase();
  if (/^naip[_-]nv[_-]2010[_-]1m[_-]m4b/.test(lower)) {
    return "NAIP Nevada 2010 1-meter 4-band image tile footprints";
  }
  const cleaned = String(baseName || "Geospatial dataset")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
  const geometry = String(manifest?.dataset?.geometryType || "").toLowerCase();
  return geometry.includes("polygon") ? `${cleaned} polygons` : cleaned;
}

function canUseRawLonLatGeoJson(manifest) {
  const bbox = manifest?.dataset?.bbox || {};
  const finite = [bbox.west, bbox.east, bbox.south, bbox.north].every((value) => Number.isFinite(Number(value)));
  if (!finite) return false;
  const inRange = bbox.west >= -180 && bbox.east <= 180 && bbox.south >= -90 && bbox.north <= 90;
  const prj = String(manifest?.crs?.wkt || "").toLowerCase();
  return inRange && (prj.includes("geogcs") || prj.includes("degree") || !prj.trim());
}

function geojsonFromShapefile(shpBuffer, dbf, manifest) {
  if (!canUseRawLonLatGeoJson(manifest)) return null;
  if (manifest?.dataset?.shapeType !== 5) return null;
  const features = parseShpPolygonFeatures(shpBuffer, dbf?.rows || []);
  return {
    type: "FeatureCollection",
    name: manifest.dataset.baseName,
    features,
  };
}

function metadataXmlSummary(xml) {
  if (!xml) return null;
  const metaId = (xml.match(/<MetaID>([\s\S]*?)<\/MetaID>/i)?.[1] || "").trim();
  const createDate = (xml.match(/<CreaDate>([\s\S]*?)<\/CreaDate>/i)?.[1] || "").trim();
  const processText = (xml.match(/<Process\b[^>]*>([\s\S]*?)<\/Process>/i)?.[1] || "").trim();
  return {
    metaId,
    createDate,
    processText,
    bytes: Buffer.byteLength(xml, "utf8"),
  };
}

function rasterSourceFormat(name) {
  if (/\.tiff?$/i.test(name)) return "GeoTIFF";
  if (/\.sid$/i.test(name)) return "MrSID";
  if (/\.img$/i.test(name)) return "Erdas Imagine";
  if (/\.jp2|\.j2k$/i.test(name)) return "JPEG2000";
  return "Raster";
}

function entryBytes(entry) {
  return Number(entry?.size ?? entry?.buffer?.length ?? 0);
}

function entryChecksum(entry) {
  if (entry?.sha256) return entry.sha256;
  return entry?.buffer ? sha256(entry.buffer) : "";
}

function analyzeShapefilePackage(entries, shapefile, fileName) {
  const shpSummary = parseShpSummary(shapefile.shp.buffer);
  const dbf = shapefile.dbf ? parseDbf(shapefile.dbf.buffer) : null;
  const prjText = shapefile.prj ? shapefile.prj.buffer.toString("utf8").trim() : "";
  const xmlText = shapefile.shpXml ? shapefile.shpXml.buffer.toString("utf8").trim() : "";
  const baseName = path.basename(shapefile.base);
  const temporal = inferTemporal(dbf);
  const manifest = {
    package: {
      fileName,
      format: "ZIP",
      fileCount: entries.length,
      files: entries.map((entry) => ({
        path: entry.name,
        bytes: entryBytes(entry),
        modifiedAt: entry.modifiedAt || "",
        sha256: entryChecksum(entry),
      })),
    },
    dataset: {
      kind: "vector",
      baseName,
      sourceFormat: "ESRI Shapefile",
      shapeType: shpSummary.shapeType,
      geometryType: shpSummary.geometryType,
      featureCount: shpSummary.recordCount,
      totalParts: shpSummary.totalParts,
      totalPoints: shpSummary.totalPoints,
      bbox: shpSummary.bbox,
      centroid: {
        lon: (shpSummary.bbox.west + shpSummary.bbox.east) / 2,
        lat: (shpSummary.bbox.south + shpSummary.bbox.north) / 2,
      },
    },
    crs: {
      wkt: prjText,
      normalized: prjText.includes("North_American_1983") ? "NAD83 geographic coordinates" : "",
    },
    attributes: summarizeAttributes(dbf),
    temporal,
    spatial: {
      names: spatialNamesFromAttributes(dbf),
    },
    sidecarMetadata: metadataXmlSummary(xmlText),
    derivatives: [],
  };
  return { entries, shapefile, dbf, manifest };
}

function analyzeRasterPackage(entries, raster, fileName) {
  const baseName = path.basename(stripKnownRasterExtension(raster.base));
  const xmlEntry = raster.sidecars.find((entry) => /\.xml$/i.test(entry.name));
  const xmlText = xmlEntry ? xmlEntry.buffer.toString("utf8").trim() : "";
  const manifest = {
    package: {
      fileName,
      format: "ZIP",
      fileCount: entries.length,
      files: entries.map((entry) => ({
        path: entry.name,
        bytes: entryBytes(entry),
        modifiedAt: entry.modifiedAt || "",
        sha256: entryChecksum(entry),
      })),
    },
    dataset: {
      kind: "raster",
      baseName,
      sourceFormat: rasterSourceFormat(raster.source.name),
      geometryType: "Raster",
      featureCount: 1,
      sourcePath: raster.source.name,
      sidecarCount: raster.sidecars.length,
      bbox: null,
      centroid: null,
    },
    crs: {
      wkt: "",
      normalized: "",
    },
    attributes: { fieldCount: 0, fields: [], stats: {} },
    temporal: { years: [], minIso: "", maxIso: "" },
    spatial: { names: [] },
    sidecarMetadata: metadataXmlSummary(xmlText),
    derivatives: [],
  };
  return { entries, raster, manifest };
}

async function analyzeGeospatialPackage(buffer, fileName) {
  const entries = await zipEntriesFromBuffer(buffer);
  const shapefile = findShapefileSet(entries);
  if (shapefile) return analyzeShapefilePackage(entries, shapefile, fileName);
  const raster = findRasterSet(entries);
  if (raster) return analyzeRasterPackage(entries, raster, fileName);
  throw new Error("Geospatial package must contain a shapefile or geospatial raster source. Submit a zipped shapefile package, loose shapefile sidecars, or a raster with georeferencing sidecars.");
}

async function writeEntriesToDirectory(entries, directory) {
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const targetDir = path.dirname(target);
    await mkdir(targetDir, { recursive: true });
    if (entry.filePath) {
      await copyFile(entry.filePath, target);
    } else {
      await writeFile(target, entry.buffer);
    }
  }
}

const EXTRA_COMMAND_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

async function resolveCommandPath(command) {
  if (command.includes("/") && existsSync(command)) return command;
  try {
    const { stdout } = await execFileAsync("which", [command], { timeout: 10_000 });
    const found = String(stdout || "").trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // Fall back to common macOS package-manager locations below.
  }
  for (const directory of EXTRA_COMMAND_DIRS) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

async function tryExecFile(command, args, options = {}) {
  try {
    const resolved = await resolveCommandPath(command);
    if (!resolved) return { ok: false, error: `Command not found: ${command}` };
    await execFileAsync(resolved, args, {
      timeout: options.timeoutMs || 180_000,
      maxBuffer: 1024 * 1024 * 8,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

async function tryExecFileOutput(command, args, options = {}) {
  try {
    const resolved = await resolveCommandPath(command);
    if (!resolved) return { ok: false, error: `Command not found: ${command}`, stdout: "", stderr: "" };
    const { stdout, stderr } = await execFileAsync(resolved, args, {
      timeout: options.timeoutMs || 180_000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 16,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return { ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

function bboxFromCoordinateGroups(groups) {
  const points = [];
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const child of value) collect(child);
  };
  collect(groups);
  const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (valid.length === 0) return null;
  return {
    west: Math.min(...valid.map(([lon]) => lon)),
    south: Math.min(...valid.map(([, lat]) => lat)),
    east: Math.max(...valid.map(([lon]) => lon)),
    north: Math.max(...valid.map(([, lat]) => lat)),
  };
}

function rawCornerBboxFromGdalInfo(info) {
  const corners = info?.cornerCoordinates;
  if (!corners) return null;
  const points = [corners.lowerLeft, corners.lowerRight, corners.upperRight, corners.upperLeft]
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length === 0) return null;
  const bbox = bboxFromCoordinateGroups(points);
  const looksLonLat = bbox && bbox.west >= -180 && bbox.east <= 180 && bbox.south >= -90 && bbox.north <= 90;
  return looksLonLat ? bbox : null;
}

function bboxFromGdalInfo(info) {
  return bboxFromCoordinateGroups(info?.wgs84Extent?.coordinates) || rawCornerBboxFromGdalInfo(info);
}

function summarizeGdalInfo(info) {
  return {
    driver: info?.driverShortName || "",
    size: Array.isArray(info?.size) ? info.size : [],
    compression: info?.metadata?.IMAGE_STRUCTURE?.COMPRESSION || "",
    layout: info?.metadata?.IMAGE_STRUCTURE?.LAYOUT || "",
  };
}

function applyGdalInfoToRasterManifest(manifest, info) {
  const bbox = bboxFromGdalInfo(info);
  const size = Array.isArray(info?.size) ? info.size : [];
  manifest.dataset.width = Number(size[0] || 0) || undefined;
  manifest.dataset.height = Number(size[1] || 0) || undefined;
  manifest.dataset.bands = Array.isArray(info?.bands) ? info.bands.length : undefined;
  manifest.dataset.bbox = bbox;
  manifest.dataset.centroid = bbox ? {
    lon: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  } : null;
  manifest.crs.wkt = String(info?.coordinateSystem?.wkt || "");
  manifest.crs.normalized = info?.coordinateSystem?.dataAxisToSRSAxisMapping ? "GDAL-detected coordinate reference system" : "";
  manifest.gdal = summarizeGdalInfo(info);
}

async function inspectRasterWithGdal(rasterPath, manifest, statuses, log) {
  const result = await tryExecFileOutput("gdalinfo", ["-json", rasterPath], { timeoutMs: 120_000 });
  if (!result.ok) {
    statuses.push({ kind: "gdalinfo", status: "missing_dependency", command: "gdalinfo", reason: result.error || "Install GDAL to inspect raster georeferencing." });
    return null;
  }
  try {
    const info = JSON.parse(result.stdout);
    applyGdalInfoToRasterManifest(manifest, info);
    statuses.push({ kind: "gdalinfo", status: "created", bbox: manifest.dataset.bbox, width: manifest.dataset.width, height: manifest.dataset.height });
    log("Raster metadata inspected with GDAL", { bbox: manifest.dataset.bbox, width: manifest.dataset.width, height: manifest.dataset.height });
    return info;
  } catch (error) {
    statuses.push({ kind: "gdalinfo", status: "failed", reason: error.message || String(error) });
    return null;
  }
}

function hasRasterGeoreference(manifest, info) {
  return Boolean(manifest.dataset.bbox || info?.geoTransform || info?.gcps?.gcpList?.length || info?.coordinateSystem?.wkt);
}

function rasterPackageCanBeImageProcessed(analysis) {
  const sourceName = String(analysis?.raster?.source?.name || "");
  return analysis?.manifest?.dataset?.kind === "raster" && /\.(tiff?|jp2|j2k)$/i.test(sourceName);
}

function manifestHasRasterGeoreference(manifest) {
  return Boolean(
    manifest?.dataset?.bbox ||
    String(manifest?.crs?.wkt || "").trim() ||
    String(manifest?.crs?.normalized || "").trim()
  );
}

function shouldPromoteRasterPackageToImageUpload(analysis) {
  return rasterPackageCanBeImageProcessed(analysis) && !manifestHasRasterGeoreference(analysis?.manifest);
}

function rasterBandMetadataValue(band, domain, key) {
  return band?.metadata?.[domain]?.[key] ?? band?.metadata?.[""]?.[key] ?? "";
}

function cogCreationOptionsForRaster(info) {
  const bands = Array.isArray(info?.bands) ? info.bands : [];
  const nonAlphaBands = bands.filter((band) => String(band?.colorInterpretation || "").toLowerCase() !== "alpha");
  const hasPalette = nonAlphaBands.some((band) => String(band?.colorInterpretation || "").toLowerCase() === "palette" || band?.colorTable);
  const hasSubByteSamples = nonAlphaBands.some((band) => {
    const nbits = Number(rasterBandMetadataValue(band, "IMAGE_STRUCTURE", "NBITS"));
    return Number.isFinite(nbits) && nbits > 0 && nbits < 8;
  });
  const options = [
    "COMPRESS=DEFLATE",
    "BLOCKSIZE=512",
    "BIGTIFF=IF_SAFER",
    "NUM_THREADS=ALL_CPUS",
  ];
  if (!hasPalette && !hasSubByteSamples) {
    options.splice(1, 0, "PREDICTOR=YES");
  }
  return options;
}

function cogTranslateArgs(sourcePath, cogPath, creationOptions) {
  return [
    "-of", "COG",
    ...creationOptions.flatMap((option) => ["-co", option]),
    sourcePath,
    cogPath,
  ];
}

function rasterThumbnailOutsizeArgs(info, maxDimension = 512) {
  const size = Array.isArray(info?.size) ? info.size : [];
  const width = Number(size[0] || 0);
  const height = Number(size[1] || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return ["-outsize", String(maxDimension), String(maxDimension)];
  }
  return width >= height
    ? ["-outsize", String(maxDimension), "0"]
    : ["-outsize", "0", String(maxDimension)];
}

async function createRasterThumbnailDerivative({ profile, keys, sourcePath, manifest, info, statuses, uploaded, log }) {
  if (!await resolveCommandPath("gdal_translate")) {
    statuses.push({ kind: "thumbnail", status: "missing_dependency", command: "gdal_translate", reason: "Install GDAL to create raster thumbnails." });
    return;
  }

  const thumbnailPath = path.join(path.dirname(sourcePath), `${manifest.dataset.baseName}.thumbnail.jpg`);
  const result = await tryExecFile("gdal_translate", [
    "-of", "JPEG",
    ...rasterThumbnailOutsizeArgs(info),
    "-r", "average",
    "-co", "QUALITY=86",
    sourcePath,
    thumbnailPath,
  ], { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS });

  if (result.ok && existsSync(thumbnailPath)) {
    const thumbnailInfo = await stat(thumbnailPath);
    await putObjectFile(profile, keys.thumbnail, thumbnailPath, "image/jpeg");
    uploaded.thumbnailUrl = accessUrlFor(profile, keys.thumbnail);
    statuses.push({ kind: "thumbnail", status: "created", key: keys.thumbnail, bytes: thumbnailInfo.size });
    log("Raster thumbnail uploaded", { key: keys.thumbnail, bytes: thumbnailInfo.size });
  } else {
    statuses.push({ kind: "thumbnail", status: "failed", reason: result.error || "gdal_translate did not create a thumbnail image." });
  }
}

async function createCogDerivative({ profile, keys, sourcePath, manifest, info, statuses, uploaded, log }) {
  if (!await resolveCommandPath("gdal_translate")) {
    statuses.push({ kind: "cog", status: "missing_dependency", command: "gdal_translate", reason: "Install GDAL to create Cloud Optimized GeoTIFF derivatives." });
    return;
  }
  const cogPath = path.join(path.dirname(sourcePath), `${manifest.dataset.baseName}.cog.tif`);
  let creationOptions = cogCreationOptionsForRaster(info);
  let result = await tryExecFile("gdal_translate", cogTranslateArgs(sourcePath, cogPath, creationOptions), { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS });
  if (!result.ok && creationOptions.includes("PREDICTOR=YES") && /PREDICTOR/i.test(String(result.error || ""))) {
    await rm(cogPath, { force: true });
    creationOptions = creationOptions.filter((option) => option !== "PREDICTOR=YES");
    result = await tryExecFile("gdal_translate", cogTranslateArgs(sourcePath, cogPath, creationOptions), { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS });
  }
  if (result.ok && existsSync(cogPath)) {
    const cogInfo = await stat(cogPath);
    await putObjectFile(profile, keys.cog, cogPath, "image/tiff");
    uploaded.cogUrl = accessUrlFor(profile, keys.cog);
    statuses.push({ kind: "cog", status: "created", key: keys.cog, bytes: cogInfo.size, creationOptions });
    log("COG derivative uploaded", { key: keys.cog, bytes: cogInfo.size, creationOptions });
  } else {
    statuses.push({ kind: "cog", status: "failed", reason: result.error || "gdal_translate did not create a COG file." });
  }
}

async function createRasterGeospatialDerivatives({ profile, keys, entries, raster, manifest, log }) {
  const uploaded = {};
  const statuses = [];
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-georaster-"));
  try {
    await writeEntriesToDirectory(entries, tempRoot);
    const rasterPath = path.join(tempRoot, raster.source.name);
    const info = await inspectRasterWithGdal(rasterPath, manifest, statuses, log);
    if (info) {
      await createRasterThumbnailDerivative({ profile, keys, sourcePath: rasterPath, manifest, info, statuses, uploaded, log });
    }
    if (hasRasterGeoreference(manifest, info)) {
      await createCogDerivative({ profile, keys, sourcePath: rasterPath, manifest, info, statuses, uploaded, log });
    } else {
      statuses.push({ kind: "cog", status: "skipped", reason: "GDAL did not find raster georeferencing; keeping this out of the COG path." });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return { uploaded, statuses };
}

async function createVectorGeospatialDerivatives({ profile, keys, entries, shapefile, dbf, manifest, log }) {
  const uploaded = {};
  const statuses = [];
  const geojson = geojsonFromShapefile(shapefile.shp.buffer, dbf, manifest);
  let geojsonBuffer = null;

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-geodata-"));
  try {
    await writeEntriesToDirectory(entries, tempRoot);
    const shpPath = path.join(tempRoot, shapefile.shp.name);
    const geojsonPath = path.join(tempRoot, `${manifest.dataset.baseName}.geojson`);
    const ogr2ogrPath = await resolveCommandPath("ogr2ogr");
    if (geojson) {
      geojsonBuffer = Buffer.from(safeJsonStringify(geojson), "utf8");
      await writeFile(geojsonPath, geojsonBuffer);
      await putObjectBuffer(profile, keys.geojson, geojsonBuffer, "application/geo+json");
      uploaded.geojsonUrl = accessUrlFor(profile, keys.geojson);
      statuses.push({ kind: "geojson", status: "created", method: "native-parser", key: keys.geojson, bytes: geojsonBuffer.length });
      log("GeoJSON viewer derivative uploaded", { key: keys.geojson, bytes: geojsonBuffer.length });
    } else if (ogr2ogrPath) {
      const result = await tryExecFile("ogr2ogr", [
        "-t_srs", "EPSG:4326",
        "-f", "GeoJSON",
        geojsonPath,
        shpPath,
      ], { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS, env: { SHAPE_RESTORE_SHX: "YES" } });
      if (result.ok && existsSync(geojsonPath)) {
        geojsonBuffer = await readFile(geojsonPath);
        await putObjectBuffer(profile, keys.geojson, geojsonBuffer, "application/geo+json");
        uploaded.geojsonUrl = accessUrlFor(profile, keys.geojson);
        statuses.push({ kind: "geojson", status: "created", method: "ogr2ogr", key: keys.geojson, bytes: geojsonBuffer.length });
        log("GeoJSON viewer derivative uploaded", { key: keys.geojson, bytes: geojsonBuffer.length, method: "ogr2ogr" });
      } else {
        statuses.push({ kind: "geojson", status: "failed", reason: result.error || "ogr2ogr did not create a GeoJSON file." });
      }
    } else {
      statuses.push({ kind: "geojson", status: "missing_dependency", command: "ogr2ogr", reason: "Install GDAL to create GeoJSON derivatives for projected or non-polygon shapefiles." });
    }

    if (ogr2ogrPath) {
      const parquetPath = path.join(tempRoot, `${manifest.dataset.baseName}.parquet`);
      const result = await tryExecFile("ogr2ogr", [
        "-t_srs", "EPSG:4326",
        "-f", "Parquet",
        parquetPath,
        shpPath,
      ], { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS, env: { SHAPE_RESTORE_SHX: "YES" } });
      if (result.ok && existsSync(parquetPath)) {
        const parquetBuffer = await readFile(parquetPath);
        await putObjectBuffer(profile, keys.geoParquet, parquetBuffer, "application/vnd.apache.parquet");
        uploaded.geoParquetUrl = accessUrlFor(profile, keys.geoParquet);
        statuses.push({ kind: "geoparquet", status: "created", key: keys.geoParquet, bytes: parquetBuffer.length });
        log("GeoParquet derivative uploaded", { key: keys.geoParquet, bytes: parquetBuffer.length });
      } else {
        statuses.push({ kind: "geoparquet", status: "failed", reason: result.error || "ogr2ogr did not create a parquet file." });
      }
    } else {
      statuses.push({ kind: "geoparquet", status: "missing_dependency", command: "ogr2ogr", reason: "Install GDAL to create GeoParquet derivatives." });
    }

    if (geojsonBuffer && await resolveCommandPath("tippecanoe")) {
      const pmtilesPath = path.join(tempRoot, `${manifest.dataset.baseName}.pmtiles`);
      const direct = await tryExecFile("tippecanoe", [
        "-o", pmtilesPath,
        "-f",
        "-zg",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        geojsonPath,
      ]);
      if (direct.ok && existsSync(pmtilesPath)) {
        const pmtilesBuffer = await readFile(pmtilesPath);
        await putObjectBuffer(profile, keys.pmtiles, pmtilesBuffer, "application/vnd.pmtiles");
        uploaded.pmtilesUrl = accessUrlFor(profile, keys.pmtiles);
        statuses.push({ kind: "pmtiles", status: "created", key: keys.pmtiles, bytes: pmtilesBuffer.length });
        log("PMTiles derivative uploaded", { key: keys.pmtiles, bytes: pmtilesBuffer.length });
      } else {
        statuses.push({ kind: "pmtiles", status: "failed", reason: direct.error || "tippecanoe did not create a PMTiles file." });
      }
    } else if (!geojsonBuffer) {
      statuses.push({ kind: "pmtiles", status: "skipped", reason: "A GeoJSON intermediate is required before creating PMTiles." });
    } else {
      statuses.push({ kind: "pmtiles", status: "missing_dependency", command: "tippecanoe", reason: "Install tippecanoe to create PMTiles derivatives." });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return { uploaded, statuses };
}

async function createGeospatialDerivatives(args) {
  if (args.manifest?.dataset?.kind === "raster") return createRasterGeospatialDerivatives(args);
  return createVectorGeospatialDerivatives(args);
}

function metadataDocumentsFromRasterPackage(analysis) {
  return normalizeMetadataDocuments((analysis?.raster?.sidecars || [])
    .filter((entry) => /\.(txt|xml|fgdc|iso|met)$/i.test(entry.name))
    .map((entry) => ({
      name: path.basename(entry.name),
      type: contentTypeForMetadataKey(entry.name),
      size: entryBytes(entry),
      text: entry.buffer ? entry.buffer.toString("utf8") : "",
    })));
}

async function rasterSourceBufferForImagePromotion(source) {
  if (source?.buffer) return source.buffer;
  if (source?.filePath) return readFile(source.filePath);
  throw new Error(`Raster source ${source?.name || "(unknown)"} is not buffered for IIIF/OCR promotion.`);
}

function addRasterPackageReferencesToPromotedImageResource(resource, artifacts, packageFileName) {
  const refs = referencesFromResource(resource);
  const downloadRefs = referenceItems(refs["http://schema.org/downloadUrl"]);
  const seen = new Set(downloadRefs.map((item) => item.url));
  const addDownload = (entry) => {
    if (!entry?.url || seen.has(entry.url)) return;
    seen.add(entry.url);
    downloadRefs.push(entry);
  };
  addDownload({ url: artifacts.originalUrl, label: "Original geospatial raster package" });
  if (artifacts.manifestUrl) addDownload({ url: artifacts.manifestUrl, label: "Dataset manifest" });
  const displayNotes = Array.isArray(resource.gbl_displayNote_sm) ? resource.gbl_displayNote_sm.map(String) : [];
  return {
    ...resource,
    dct_source_sm: uniqueStrings([...(Array.isArray(resource.dct_source_sm) ? resource.dct_source_sm : []), artifacts.originalUrl]),
    gbl_displayNote_sm: uniqueStrings([
      ...displayNotes,
      `${packageFileName} did not expose usable raster georeferencing, so OpenGeoMetadata Studio processed its image source as a scanned map for IIIF and OCR.`,
    ]),
    dct_references_s: safeJsonStringify({
      ...refs,
      "http://schema.org/downloadUrl": downloadRefs,
      ...(artifacts.manifestUrl ? {
        "https://opengeometadata.org/reference/dataset-manifest": { url: artifacts.manifestUrl, label: "Dataset manifest" },
      } : {}),
    }),
  };
}

async function processUnreferencedRasterPackageAsImage({ config, storageProfile, body, resourceId, analysis, packageFileName, packageChecksum, packageArtifacts, keys, log }) {
  const source = analysis.raster?.source;
  if (!source) throw new Error("Raster package promotion requires a raster source file.");
  const sourceBuffer = await rasterSourceBufferForImagePromotion(source);
  const imageFileName = sanitizeFileName(path.basename(source.name) || analysis.manifest.dataset.baseName || "raster.tif");
  const imageChecksum = entryChecksum(source) || sha256(sourceBuffer);
  const metadataDocuments = normalizeMetadataDocuments([
    ...(Array.isArray(body.metadataDocuments) ? body.metadataDocuments : []),
    ...metadataDocumentsFromRasterPackage(analysis),
  ]);

  log("Unreferenced raster package promoted to scanned-map image processing", {
    packageFileName,
    imageFileName,
    imageChecksum,
    bytes: sourceBuffer.length,
  });

  const response = await processUploadedImage(config, {
    ...body,
    resourceId,
    preserveResourceId: true,
    forceReprocess: true,
    file: {
      name: imageFileName,
      type: contentTypeForKey(imageFileName),
      size: sourceBuffer.length,
      checksum: imageChecksum,
      base64: sourceBuffer.toString("base64"),
      modifiedAt: source.modifiedAt || "",
    },
    checksum: imageChecksum,
    metadataDocuments,
  });

  const resource = addRasterPackageReferencesToPromotedImageResource(response.aardvarkJson, packageArtifacts, packageFileName);
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  const distributions = distributionsFromResource(resource);
  return {
    ...response,
    packageChecksum,
    artifacts: {
      ...response.artifacts,
      originalPackageUrl: packageArtifacts.originalUrl,
      manifestUrl: packageArtifacts.manifestUrl,
    },
    manifest: analysis.manifest,
    aardvarkJson: resource,
    distributions,
  };
}

function buildAardvarkForGeospatialPackage({ resourceId, checksum, fileName, fileSize, manifest, batchDefaults = {}, artifacts }) {
  const isRaster = manifest.dataset.kind === "raster";
  const bbox = manifest.dataset.bbox;
  const temporalYears = manifest.temporal?.years || [];
  const firstYear = temporalYears[0] ? Number.parseInt(temporalYears[0], 10) : null;
  const spatialNames = manifest.spatial?.names || [];
  const featureCount = Number(manifest.dataset.featureCount || 0).toLocaleString();
  const datePhrase = manifest.temporal?.minIso && manifest.temporal?.maxIso
    ? ` Source imagery dates range from ${manifest.temporal.minIso} to ${manifest.temporal.maxIso}.`
    : "";
  const rasterDimensions = manifest.dataset.width && manifest.dataset.height
    ? ` with ${Number(manifest.dataset.width).toLocaleString()} x ${Number(manifest.dataset.height).toLocaleString()} pixels`
    : "";
  const description = isRaster
    ? `${manifest.dataset.sourceFormat} raster dataset${rasterDimensions}.${datePhrase}`.trim()
    : `${manifest.dataset.sourceFormat} dataset containing ${featureCount} ${String(manifest.dataset.geometryType || "feature").toLowerCase()} feature(s).${datePhrase}`.trim();
  const title = String(batchDefaults.titlePrefix ? `${batchDefaults.titlePrefix}: ${humanTitleFromPackage(manifest.dataset.baseName, manifest)}` : humanTitleFromPackage(manifest.dataset.baseName, manifest));
  const refs = {
    "http://schema.org/downloadUrl": [
      { url: artifacts.originalUrl, label: isRaster ? "Original geospatial raster package" : "Original zipped shapefile package" },
      ...(artifacts.geoParquetUrl ? [{ url: artifacts.geoParquetUrl, label: "GeoParquet derivative" }] : []),
      ...(artifacts.pmtilesUrl ? [{ url: artifacts.pmtilesUrl, label: "PMTiles vector tile derivative" }] : []),
      ...(artifacts.geojsonUrl ? [{ url: artifacts.geojsonUrl, label: "GeoJSON viewer derivative" }] : []),
      ...(artifacts.cogUrl ? [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }] : []),
      ...(artifacts.archivalSupplementUrl ? [{ url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" }] : []),
    ],
    ...(artifacts.geojsonUrl ? { geojson: { url: artifacts.geojsonUrl, label: "GeoJSON viewer derivative" } } : {}),
    ...(artifacts.pmtilesUrl ? { pmtiles: { url: artifacts.pmtilesUrl, label: "PMTiles vector tiles" } } : {}),
    ...(artifacts.cogUrl ? { "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" } } : {}),
    ...(artifacts.thumbnailUrl ? { "http://schema.org/thumbnailUrl": { url: artifacts.thumbnailUrl, label: "Thumbnail" } } : {}),
    "https://opengeometadata.org/reference/dataset-manifest": { url: artifacts.manifestUrl, label: "Dataset manifest" },
    ...(artifacts.archivalSupplementUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" } } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" } } : {}),
    "https://opengeometadata.org/reference/aardvark-json": { url: artifacts.aardvarkUrl, label: "Aardvark JSON" },
  };
  return {
    id: resourceId,
    dct_title_s: title,
    dct_accessRights_s: normalizeAccessRights(batchDefaults.accessRights, "Public"),
    dct_format_s: normalizeAardvarkFormat(isRaster ? manifest.dataset.sourceFormat : "Shapefile", { fileName, georeferenced: Boolean(bbox) }),
    gbl_mdVersion_s: "Aardvark",
    schema_provider_s: String(batchDefaults.provider || "OpenGeoMetadata Studio"),
    dct_issued_s: manifest.sidecarMetadata?.createDate ? manifest.sidecarMetadata.createDate.slice(0, 4) : "",
    dct_alternative_sm: [],
    dct_description_sm: [description].filter(Boolean),
    dct_language_sm: normalizeLanguageValues(batchDefaults.language ? [String(batchDefaults.language)] : []),
    gbl_displayNote_sm: manifest.derivatives?.some((item) => item.status === "missing_dependency")
      ? ["Some cloud-optimized derivatives were not generated because local geospatial command-line tools are missing."]
      : [],
    dct_creator_sm: batchDefaults.creator ? [String(batchDefaults.creator)] : [],
    dct_publisher_sm: batchDefaults.publisher ? [String(batchDefaults.publisher)] : [],
    gbl_resourceClass_sm: ["Datasets"],
    gbl_resourceType_sm: [datasetResourceType(manifest)],
    dct_subject_sm: Array.isArray(batchDefaults.subjects) ? batchDefaults.subjects.map(String) : [],
    dcat_theme_sm: normalizeControlledValues(
      [
        ...(Array.isArray(batchDefaults.themes) ? batchDefaults.themes.map(String) : []),
        ...(isRaster ? ["Imagery"] : []),
        "Location",
      ],
      AARDVARK_THEME_VALUES,
      ["Location"]
    ),
    dcat_keyword_sm: [
      "automated metadata",
      isRaster ? "geospatial raster" : "geospatial package",
      manifest.dataset.sourceFormat,
      manifest.dataset.geometryType,
      ...Object.keys(manifest.attributes?.stats || {}).slice(0, 8),
    ],
    dct_temporal_sm: temporalYears,
    gbl_dateRange_drsim: firstYear ? `[${Math.min(...temporalYears.map(Number))} TO ${Math.max(...temporalYears.map(Number))}]` : "",
    gbl_indexYear_im: firstYear,
    dct_spatial_sm: spatialNames,
    locn_geometry: bboxToAardvarkPolygonWkt(bbox),
    dcat_bbox: bboxToAardvarkEnvelope(bbox),
    dcat_centroid: bboxToAardvarkCentroid(bbox),
    gbl_georeferenced_b: Boolean(bbox),
    dct_identifier_sm: [resourceId, checksum, fileName],
    gbl_wxsIdentifier_s: "",
    dct_rights_sm: batchDefaults.rights ? [String(batchDefaults.rights)] : [],
    dct_rightsHolder_sm: batchDefaults.rightsHolder ? [String(batchDefaults.rightsHolder)] : [],
    dct_license_sm: batchDefaults.license ? [String(batchDefaults.license)] : [],
    pcdm_memberOf_sm: batchDefaults.memberOf ? [String(batchDefaults.memberOf)] : [],
    dct_isPartOf_sm: batchDefaults.isPartOf ? [String(batchDefaults.isPartOf)] : [],
    dct_source_sm: [artifacts.originalUrl],
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: [],
    gbl_fileSize_s: String(fileSize || ""),
    dct_references_s: safeJsonStringify(refs),
    gbl_suppressed_b: false,
    gbl_mdModified_dt: new Date().toISOString(),
  };
}

const archivalInventoryItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    sizeBytes: { type: "number" },
    modifiedAt: { type: "string" },
    mediaType: { type: "string" },
    fileType: { type: "string" },
    role: { type: "string" },
    sha256: { type: "string" },
    significance: { type: "string" },
  },
  required: ["path", "sizeBytes", "modifiedAt", "mediaType", "fileType", "role", "sha256", "significance"],
};

const archivalDerivativeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    url: { type: "string" },
    status: { type: "string" },
    significance: { type: "string" },
  },
  required: ["type", "url", "status", "significance"],
};

const archivalChecksumSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    algorithm: { type: "string" },
    value: { type: "string" },
    purpose: { type: "string" },
  },
  required: ["path", "algorithm", "value", "purpose"],
};

const archivalProcessingEventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: { type: "string" },
    eventType: { type: "string" },
    outcome: { type: "string" },
    agent: { type: "string" },
    detail: { type: "string" },
  },
  required: ["date", "eventType", "outcome", "agent", "detail"],
};

const ARCHIVAL_ACCESSION_SUPPLEMENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    supplement: {
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string" },
        standardsUsed: { type: "array", items: { type: "string" } },
        resourceId: { type: "string" },
        accessionTitle: { type: "string" },
        processingDate: { type: "string" },
        processingAgent: { type: "string" },
        sourcePackage: {
          type: "object",
          additionalProperties: false,
          properties: {
            fileName: { type: "string" },
            format: { type: "string" },
            sizeBytes: { type: "number" },
            sha256: { type: "string" },
            fileCount: { type: "number" },
          },
          required: ["fileName", "format", "sizeBytes", "sha256", "fileCount"],
        },
        scopeAndContent: { type: "string" },
        appraisalAndSignificance: { type: "string" },
        arrangement: { type: "string" },
        technicalDescription: { type: "string" },
        accessAndUse: { type: "string" },
        inventory: { type: "array", items: archivalInventoryItemSchema },
        checksums: { type: "array", items: archivalChecksumSchema },
        derivatives: { type: "array", items: archivalDerivativeSchema },
        processingEvents: { type: "array", items: archivalProcessingEventSchema },
        processingNotes: { type: "array", items: { type: "string" } },
      },
      required: [
        "schemaVersion",
        "standardsUsed",
        "resourceId",
        "accessionTitle",
        "processingDate",
        "processingAgent",
        "sourcePackage",
        "scopeAndContent",
        "appraisalAndSignificance",
        "arrangement",
        "technicalDescription",
        "accessAndUse",
        "inventory",
        "checksums",
        "derivatives",
        "processingEvents",
        "processingNotes",
      ],
    },
  },
  required: ["supplement"],
};

function archivalFileTypeForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return "ESRI Shapefile geometry";
  if (lower.endsWith(".shx")) return "ESRI Shapefile spatial index";
  if (lower.endsWith(".dbf")) return "dBASE attribute table";
  if (lower.endsWith(".prj")) return "Coordinate reference system definition";
  if (lower.endsWith(".cpg")) return "Character encoding declaration";
  if (lower.endsWith(".shp.xml")) return "FGDC or ArcGIS metadata XML";
  if (lower.endsWith(".sbn") || lower.endsWith(".sbx") || lower.endsWith(".qix")) return "Spatial index sidecar";
  if (/\.(tif|tiff)$/i.test(lower)) return "GeoTIFF raster";
  if (lower.endsWith(".sid")) return "MrSID raster";
  if (lower.endsWith(".img")) return "Erdas Imagine raster";
  if (/\.(jp2|j2k)$/i.test(lower)) return "JPEG2000 raster";
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return "Raster world file";
  if (lower.endsWith(".aux") || lower.endsWith(".aux.xml")) return "Raster auxiliary metadata";
  if (lower.endsWith(".rrd") || lower.endsWith(".ovr")) return "Raster overview pyramid";
  if (lower.endsWith(".xml")) return "Metadata XML";
  if (lower.endsWith(".txt")) return "Text metadata or documentation";
  if (lower.endsWith(".met")) return "Metadata sidecar";
  return "File";
}

function archivalFileRoleForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return "Core vector geometry";
  if (lower.endsWith(".dbf")) return "Feature attribute values";
  if (lower.endsWith(".shx") || lower.endsWith(".sbn") || lower.endsWith(".sbx") || lower.endsWith(".qix")) return "Index supporting GIS access";
  if (lower.endsWith(".prj")) return "Coordinate reference system evidence";
  if (lower.endsWith(".cpg")) return "Text encoding evidence";
  if (/\.(tif|tiff|sid|img|jp2|j2k)$/i.test(lower)) return "Core raster source";
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return "Raster georeferencing sidecar";
  if (lower.endsWith(".aux") || lower.endsWith(".aux.xml") || lower.endsWith(".rrd") || lower.endsWith(".ovr")) return "Raster display and processing support";
  if (lower.endsWith(".xml") || lower.endsWith(".txt") || lower.endsWith(".met")) return "Descriptive or technical metadata";
  return "Package component";
}

function datasetSignificanceSentence(manifest) {
  const title = humanTitleFromPackage(manifest.dataset.baseName, manifest);
  if (manifest.dataset.kind === "raster") {
    return `${title} preserves a georeferenced ${manifest.dataset.sourceFormat || "raster"} source that can support map display, reprojection, and comparison with other spatial evidence.`;
  }
  const geometryType = String(manifest.dataset.geometryType || "feature").toLowerCase();
  if (geometryType.includes("polygon") && /ortho/i.test(String(manifest.dataset.baseName || ""))) {
    return `${title} appears to be an orthophoto or imagery-footprint polygon dataset; polygon footprints are significant because they document coverage, tile boundaries, and the spatial organization of imagery products.`;
  }
  if (geometryType.includes("polygon")) {
    return `${title} preserves polygon features, which are significant for boundaries, footprints, zones, and other areal evidence that can be overlaid with related GIS layers.`;
  }
  return `${title} preserves ${geometryType} geospatial features that can be reused for mapping, spatial analysis, and provenance review.`;
}

function archivalFileSignificance(name, manifest) {
  const role = archivalFileRoleForName(name);
  const datasetSentence = datasetSignificanceSentence(manifest);
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return `${role}. This is the primary geometry file for the source shapefile. ${datasetSentence}`;
  if (lower.endsWith(".dbf")) return `${role}. This table supplies the descriptive fields that make the geometry intelligible and searchable.`;
  if (lower.endsWith(".prj")) return `${role}. This file is important for preserving the coordinate system needed to place the dataset correctly.`;
  if (/\.(tif|tiff|sid|img|jp2|j2k)$/i.test(lower)) return `${role}. This is the primary raster image data. ${datasetSentence}`;
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return `${role}. This sidecar helps place an image in map coordinates when embedded georeferencing is absent or incomplete.`;
  if (lower.endsWith(".xml") || lower.endsWith(".txt") || lower.endsWith(".met")) return `${role}. This documentation may record provenance, lineage, coordinate systems, dates, or processing history.`;
  return `${role}. This file supports faithful preservation and reuse of the source package.`;
}

function buildArchivalInventory(entries, manifest) {
  return entries.map((entry) => ({
    path: entry.name,
    sizeBytes: entry.size,
    modifiedAt: entry.modifiedAt || "",
    mediaType: contentTypeForKey(entry.name),
    fileType: archivalFileTypeForName(entry.name),
    role: archivalFileRoleForName(entry.name),
    sha256: entry.sha256 || sha256(entry.buffer),
    significance: archivalFileSignificance(entry.name, manifest),
  }));
}

function buildArchivalDerivatives(artifacts) {
  return [
    { type: "Original submitted package", url: artifacts.originalUrl || "", status: artifacts.originalUrl ? "preserved" : "missing", significance: "Original package retained as submitted for provenance and fixity review." },
    { type: "Dataset manifest", url: artifacts.manifestUrl || "", status: artifacts.manifestUrl ? "created" : "missing", significance: "Machine-readable processing manifest summarizing detected GIS structure and derivative status." },
    { type: "Aardvark JSON", url: artifacts.aardvarkUrl || "", status: artifacts.aardvarkUrl ? "created" : "missing", significance: "Catalog metadata record used by OpenGeoMetadata-style discovery." },
    { type: "GeoJSON", url: artifacts.geojsonUrl || "", status: artifacts.geojsonUrl ? "created" : "not applicable or not created", significance: "Viewer-friendly vector derivative for preview and inspection." },
    { type: "GeoParquet", url: artifacts.geoParquetUrl || "", status: artifacts.geoParquetUrl ? "created" : "not applicable or not created", significance: "Columnar preservation and analysis derivative for modern geospatial workflows." },
    { type: "PMTiles", url: artifacts.pmtilesUrl || "", status: artifacts.pmtilesUrl ? "created" : "not applicable or not created", significance: "Single-file vector tile derivative for fast web map preview." },
    { type: "Cloud Optimized GeoTIFF", url: artifacts.cogUrl || "", status: artifacts.cogUrl ? "created" : "not applicable or not created", significance: "Cloud-native raster derivative suitable for ranged reads and map preview." },
    { type: "Thumbnail", url: artifacts.thumbnailUrl || "", status: artifacts.thumbnailUrl ? "created" : "not applicable or not created", significance: "Small preview image for discovery interfaces." },
    { type: "Archival supplement JSON", url: artifacts.archivalSupplementJsonUrl || "", status: artifacts.archivalSupplementJsonUrl ? "created" : "missing", significance: "Structured accession supplement used to render this processing note." },
  ];
}

function buildArchivalSupplementFallback({ resourceId, checksum, fileName, fileSize, manifest, artifacts, entries }) {
  const now = new Date().toISOString();
  const inventory = buildArchivalInventory(entries, manifest);
  const title = `${humanTitleFromPackage(manifest.dataset.baseName, manifest)} archival accession supplement`;
  const checksums = [
    { path: fileName, algorithm: "SHA-256", value: checksum, purpose: "Submitted ZIP package fixity value computed in the browser before upload." },
    ...inventory.map((item) => ({
      path: item.path,
      algorithm: "SHA-256",
      value: item.sha256,
      purpose: "Package component fixity value computed after unpacking for electronic processing documentation.",
    })),
  ];
  const derivativeTypes = (manifest.derivatives || [])
    .map((item) => `${item.kind}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`)
    .join("; ");
  return {
    schemaVersion: "OGM Archival Accession Supplement 1.0",
    standardsUsed: [
      "DACS-inspired scope, content, arrangement, and access notes",
      "PREMIS-inspired preservation events and fixity",
      "BagIt-inspired file inventory and checksums",
      "OpenGeoMetadata Aardvark companion record",
    ],
    resourceId,
    accessionTitle: title,
    processingDate: now,
    processingAgent: "Aardvark Metadata Studio enrichment proxy",
    sourcePackage: {
      fileName,
      format: manifest.package?.format || "ZIP",
      sizeBytes: Number(fileSize || 0),
      sha256: checksum,
      fileCount: Number(manifest.package?.fileCount || inventory.length),
    },
    scopeAndContent: `${datasetSignificanceSentence(manifest)} The accession package contains ${inventory.length} file(s) arranged by their source paths inside the submitted ZIP package.`,
    appraisalAndSignificance: `Retained because the package includes geospatial source data plus sidecars needed to preserve context, coordinate reference information, attributes, and derivative reproducibility. ${datasetSignificanceSentence(manifest)}`,
    arrangement: "Original internal package paths were retained. Browser-expanded directories are re-packaged into a single ZIP payload for processing while preserving relative paths and source file dates when available.",
    technicalDescription: `Detected ${manifest.dataset.kind} dataset; source format ${manifest.dataset.sourceFormat || "unknown"}; geometry/type ${manifest.dataset.geometryType || "unknown"}; feature count ${manifest.dataset.featureCount || 0}; CRS ${manifest.crs?.normalized || (manifest.crs?.wkt ? "WKT supplied" : "not detected")}. Derivative outcomes: ${derivativeTypes || "none recorded"}.`,
    accessAndUse: "Access rights default to the accompanying Aardvark record. Review local rights statements before public distribution or derivative reuse.",
    inventory,
    checksums,
    derivatives: buildArchivalDerivatives(artifacts),
    processingEvents: [
      { date: now, eventType: "ingest", outcome: "success", agent: "Aardvark Metadata Studio", detail: `Received ${fileName} and computed source SHA-256 ${checksum}.` },
      { date: now, eventType: "analysis", outcome: "success", agent: "enrichment-proxy geospatial analyzer", detail: `Identified ${manifest.dataset.kind} dataset ${manifest.dataset.baseName}.` },
      { date: now, eventType: "fixity", outcome: "success", agent: "enrichment-proxy SHA-256 inventory", detail: `Computed SHA-256 checksums for ${inventory.length} package component(s).` },
      { date: now, eventType: "derivative_generation", outcome: "recorded", agent: "GDAL/ogr2ogr/tippecanoe where available", detail: derivativeTypes || "No derivative statuses were recorded." },
    ],
    processingNotes: [
      "This supplement is generated in addition to the OpenGeoMetadata Aardvark record.",
      "Narrative description may be enhanced by OpenAI, while file paths, sizes, dates, and checksums are preserved from deterministic processing.",
    ],
  };
}

function normalizeArchivalSupplement(candidate, fallback) {
  const next = { ...fallback, ...(candidate && typeof candidate === "object" ? candidate : {}) };
  const candidateInventory = Array.isArray(candidate?.inventory) ? candidate.inventory : [];
  const candidateByPath = new Map(candidateInventory.map((item) => [String(item?.path || ""), item]));
  next.schemaVersion = fallback.schemaVersion;
  next.resourceId = fallback.resourceId;
  next.processingDate = fallback.processingDate;
  next.processingAgent = fallback.processingAgent;
  next.sourcePackage = fallback.sourcePackage;
  next.inventory = fallback.inventory.map((item) => {
    const candidateItem = candidateByPath.get(item.path);
    return {
      ...item,
      significance: String(candidateItem?.significance || item.significance),
    };
  });
  next.checksums = fallback.checksums;
  next.derivatives = fallback.derivatives;
  next.processingEvents = fallback.processingEvents;
  next.standardsUsed = asStringArray(next.standardsUsed).length > 0 ? asStringArray(next.standardsUsed) : fallback.standardsUsed;
  next.processingNotes = asStringArray(next.processingNotes).length > 0 ? asStringArray(next.processingNotes) : fallback.processingNotes;
  for (const key of ["accessionTitle", "scopeAndContent", "appraisalAndSignificance", "arrangement", "technicalDescription", "accessAndUse"]) {
    next[key] = String(next[key] || fallback[key] || "");
  }
  return next;
}

function archivalSupplementWriterMessages({ fallbackSupplement, manifest, artifacts }) {
  return {
    systemPrompt: [
      "You are an archivist and digital preservation specialist.",
      "Create a concise archival accession processing supplement for a geospatial data package.",
      "Use DACS-style descriptive notes and PREMIS-style preservation event language.",
      "Do not alter file paths, sizes, dates, checksums, derivative URLs, resource identifiers, or processing events.",
      "Improve the narrative significance of the dataset and individual files when the manifest supports it.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Prepare an archival accession supplement for this processed geospatial package.",
      "",
      "Explain what the found resource is, why it is significant, and how its components support preservation and reuse.",
      "For file-level significance, explain specialized GIS components such as .shp, .dbf, .prj, world files, COGs, PMTiles, and imagery footprint polygons when present.",
      "",
      "Deterministic supplement draft:",
      safeJsonStringify(fallbackSupplement, 2),
      "",
      "Geospatial manifest:",
      safeJsonStringify(manifest, 2),
      "",
      "Artifact URLs:",
      safeJsonStringify(artifacts, 2),
    ].join("\n"),
  };
}

async function callArchivalSupplementWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { supplement: context.fallbackSupplement };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = archivalSupplementWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "archival_accession_supplement_writer",
        schema: ARCHIVAL_ACCESSION_SUPPLEMENT_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

function markdownCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function renderArchivalSupplementMarkdown(supplement) {
  const lines = [
    `# ${supplement.accessionTitle}`,
    "",
    `Resource ID: ${supplement.resourceId}`,
    `Processing date: ${supplement.processingDate}`,
    `Processing agent: ${supplement.processingAgent}`,
    `Standards used: ${(supplement.standardsUsed || []).join("; ")}`,
    "",
    "## Source Package",
    "",
    `- File name: ${supplement.sourcePackage.fileName}`,
    `- Format: ${supplement.sourcePackage.format}`,
    `- Size: ${formatBytes(supplement.sourcePackage.sizeBytes)} (${supplement.sourcePackage.sizeBytes} bytes)`,
    `- File count: ${supplement.sourcePackage.fileCount}`,
    `- SHA-256: ${supplement.sourcePackage.sha256}`,
    "",
    "## Scope and Content",
    "",
    supplement.scopeAndContent,
    "",
    "## Appraisal and Significance",
    "",
    supplement.appraisalAndSignificance,
    "",
    "## Arrangement",
    "",
    supplement.arrangement,
    "",
    "## Technical Description",
    "",
    supplement.technicalDescription,
    "",
    "## Inventory",
    "",
    "| Path | File type | Role | Size | Modified | SHA-256 | Significance |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...(supplement.inventory || []).map((item) => [
      markdownCell(item.path),
      markdownCell(item.fileType),
      markdownCell(item.role),
      markdownCell(formatBytes(item.sizeBytes)),
      markdownCell(item.modifiedAt || "unknown"),
      markdownCell(item.sha256),
      markdownCell(item.significance),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Generated Derivatives",
    "",
    "| Type | Status | URL | Significance |",
    "| --- | --- | --- | --- |",
    ...(supplement.derivatives || []).map((item) => [
      markdownCell(item.type),
      markdownCell(item.status),
      markdownCell(item.url),
      markdownCell(item.significance),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Preservation Events",
    "",
    ...(supplement.processingEvents || []).map((event) => `- ${event.date} - ${event.eventType} - ${event.outcome} - ${event.agent}: ${event.detail}`),
    "",
    "## Access and Use",
    "",
    supplement.accessAndUse,
    "",
    "## Processing Notes",
    "",
    ...(supplement.processingNotes || []).map((note) => `- ${note}`),
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function imageInventorySignificance(fileName, contentType) {
  if (/\.(tiff?|jp2|j2k)$/i.test(fileName)) {
    return "Primary high-resolution source image retained for preservation, IIIF tiling, OCR, derivative generation, and future reprocessing.";
  }
  if (/\.(jpe?g|png|webp)$/i.test(fileName)) {
    return "Submitted access image retained as the source supplied to this processing run; compare against higher-fidelity TIFF/JPEG2000 siblings when present.";
  }
  return `Submitted ${contentType || "image"} source retained for preservation and processing provenance.`;
}

function buildImageArchivalSupplement({ resourceId, checksum, fileName, fileSize, contentType, modifiedAt, extraction, artifacts, metadataDocuments = [] }) {
  const now = new Date().toISOString();
  const inventory = [
    {
      path: fileName,
      sizeBytes: Number(fileSize || 0),
      modifiedAt: modifiedAt || "",
      mediaType: contentType || contentTypeForKey(fileName),
      fileType: archivalFileTypeForName(fileName) === "File" ? "Image source" : archivalFileTypeForName(fileName),
      role: "Primary submitted image",
      sha256: checksum,
      significance: imageInventorySignificance(fileName, contentType),
    },
    ...metadataDocuments.map((document, index) => {
      const text = String(document.text || "");
      return {
        path: `metadata_sources/${String(index + 1).padStart(2, "0")}-${document.name}`,
        sizeBytes: Number(document.size || Buffer.byteLength(text, "utf8")),
        modifiedAt: "",
        mediaType: document.type || contentTypeForMetadataKey(document.name),
        fileType: archivalFileTypeForName(document.name),
        role: "Companion descriptive metadata",
        sha256: sha256(Buffer.from(text, "utf8")),
        significance: "Companion documentation that may record title, creator, date, place names, rights, or scanning context used to improve the catalog record.",
      };
    }),
  ];
  const checksums = inventory.map((item) => ({
    path: item.path,
    algorithm: "SHA-256",
    value: item.sha256,
    purpose: item.path === fileName
      ? "Submitted image fixity value computed in the browser before upload and verified by the proxy."
      : "Companion metadata fixity value computed during electronic processing.",
  }));
  const textCount = Array.isArray(extraction?.text) ? extraction.text.length : 0;
  const textGroupCount = Array.isArray(extraction?.text_groups) ? extraction.text_groups.length : 0;
  const placeCount = Array.isArray(extraction?.placenames) ? extraction.placenames.length : 0;
  const description = String(extraction?.description || "").trim();
  return {
    schemaVersion: "OGM Archival Accession Supplement 1.0",
    standardsUsed: [
      "DACS-inspired scope, content, arrangement, and access notes",
      "PREMIS-inspired preservation events and fixity",
      "BagIt-inspired file inventory and checksums",
      "OpenGeoMetadata Aardvark companion record",
    ],
    resourceId,
    accessionTitle: `${fileName.replace(/\.[^.]+$/, "") || resourceId} archival accession supplement`,
    processingDate: now,
    processingAgent: "Aardvark Metadata Studio enrichment proxy",
    sourcePackage: {
      fileName,
      format: contentType || contentTypeForKey(fileName),
      sizeBytes: Number(fileSize || 0),
      sha256: checksum,
      fileCount: inventory.length,
    },
    scopeAndContent: description || `Digitized map or image source ${fileName} processed for discovery, IIIF access, text extraction, and preservation metadata.`,
    appraisalAndSignificance: "Retained because the image is a source or source-like representation used to create access derivatives, OCR/enrichment evidence, and the companion Aardvark record.",
    arrangement: "The submitted image is preserved as the original_file object. Generated derivatives and metadata outputs are arranged under derivative, IIIF, thumbnail, enrichment, and accession supplement paths.",
    technicalDescription: `Detected content type ${contentType || contentTypeForKey(fileName)}. Processing produced IIIF Level 0 access files, a thumbnail, extraction evidence with ${textCount} text segment(s), ${textGroupCount} consolidated text group(s), and ${placeCount} placename candidate(s), and optional COG output when the source was a suitable raster.`,
    accessAndUse: "Access rights default to the accompanying Aardvark record. Review local rights statements before public distribution or derivative reuse.",
    inventory,
    checksums,
    derivatives: [
      { type: "Original submitted image", url: artifacts.originalUrl || "", status: artifacts.originalUrl ? "preserved" : "missing", significance: "Original uploaded image retained for provenance and reprocessing." },
      { type: "IIIF Level 0", url: artifacts.iiifInfoUrl || "", status: artifacts.iiifInfoUrl ? "created" : "missing", significance: "Tile pyramid and info.json used for deep zoom access and text review overlays." },
      { type: "Thumbnail", url: artifacts.thumbnailUrl || "", status: artifacts.thumbnailUrl ? "created" : "missing", significance: "Small preview image for discovery interfaces." },
      { type: "Cloud Optimized GeoTIFF", url: artifacts.cogUrl || "", status: artifacts.cogUrl ? "created" : "not applicable or not created", significance: "Cloud-native raster derivative produced when the image has suitable raster/georeference characteristics." },
      { type: "Enrichment response", url: artifacts.extractionUrl || "", status: artifacts.extractionUrl ? "created" : "missing", significance: "Machine-readable OCR, placename, bounding-box, and descriptive extraction evidence." },
      { type: "AI Enrichments JSON", url: artifacts.aiEnrichmentsUrl || "", status: artifacts.aiEnrichmentsUrl ? "created" : "missing", significance: "Research provenance record preserving provider calls, exact prompts, raw responses, extracted text, and derived metadata evidence." },
      { type: "Aardvark JSON", url: artifacts.aardvarkUrl || "", status: artifacts.aardvarkUrl ? "created" : "missing", significance: "Catalog metadata record used by OpenGeoMetadata-style discovery." },
      { type: "Archival supplement JSON", url: artifacts.archivalSupplementJsonUrl || "", status: artifacts.archivalSupplementJsonUrl ? "created" : "missing", significance: "Structured accession supplement used to render this processing note." },
    ],
    processingEvents: [
      { date: now, eventType: "ingest", outcome: "success", agent: "Aardvark Metadata Studio", detail: `Received ${fileName} and verified SHA-256 ${checksum}.` },
      { date: now, eventType: "derivative_generation", outcome: "recorded", agent: "enrichment-proxy image pipeline", detail: "Generated IIIF/thumbnail outputs and optional COG derivative when appropriate." },
      { date: now, eventType: "metadata_enrichment", outcome: "recorded", agent: "configured OCR/OpenAI enrichment providers", detail: `Recorded ${textCount} text segment(s) and ${placeCount} placename candidate(s).` },
      { date: now, eventType: "fixity", outcome: "success", agent: "enrichment-proxy SHA-256 inventory", detail: `Recorded checksums for ${inventory.length} file/inventory item(s).` },
    ],
    processingNotes: [
      "This supplement is generated in addition to the OpenGeoMetadata Aardvark record.",
      "JPEG access derivatives may be skipped at folder intake when matching TIFF or JPEG2000 source files are present.",
    ],
  };
}

async function writeArchivalSupplementArtifacts(profile, keys, supplement) {
  await putObjectBuffer(profile, keys.archivalSupplementJson, Buffer.from(safeJsonStringify(supplement, 2), "utf8"), "application/json");
  await putObjectBuffer(profile, keys.archivalSupplement, Buffer.from(renderArchivalSupplementMarkdown(supplement), "utf8"), "text/markdown; charset=utf-8");
}

function compactNumber(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Number(number.toFixed(digits));
}

function compactBbox(bbox) {
  if (!Array.isArray(bbox)) return undefined;
  const values = bbox.slice(0, 4).map((value) => compactNumber(value));
  return values.every((value) => value !== undefined) ? values : undefined;
}

function compactOcrEvidenceItem(item, extraKeys = []) {
  if (!item || typeof item !== "object") return null;
  const content = normalizedText(item.content || item.name);
  if (!content) return null;
  const compacted = withoutUndefined({
    content,
    name: item.name && item.name !== content ? normalizedText(item.name) : undefined,
    type: item.type,
    role: item.role,
    confidence: compactNumber(item.confidence, 3),
    approx_bbox: compactBbox(item.approx_bbox),
    orientation_degrees: compactNumber(item.orientation_degrees, 1),
    source_text_count: item.source_text_count,
  });
  for (const key of extraKeys) {
    if (item[key] !== undefined) compacted[key] = item[key];
  }
  return compacted;
}

function textEvidenceScore(item) {
  const content = normalizedText(item?.content);
  if (!content) return -1;
  const confidence = Number(item?.confidence);
  const words = content.split(/\s+/).filter(Boolean);
  const role = String(item?.role || "");
  const usefulWords = words.filter((word) => /[A-Za-z]{3,}/.test(word));
  const hasMapCue = /\b(map|guide|city|county|state|bay|lake|park|river|island|sound|canal|harbor|rail|ferry|boulevard|avenue|street|road|company|co\.)\b/i.test(content);
  const mostlyNumeric = /^[\d\s.,:/-]+$/.test(content);
  let score = Number.isFinite(confidence) ? confidence : 0.5;
  score += Math.min(0.35, usefulWords.length * 0.045);
  score += Math.min(0.2, content.length / 180);
  if (role === "title") score += 0.5;
  if (role === "label" || role === "place") score += 0.18;
  if (hasMapCue) score += 0.18;
  if (mostlyNumeric) score -= 0.45;
  if (content.length <= 2) score -= 0.3;
  return score;
}

function compactExtractionForMetadataWriter(extraction) {
  const text = Array.isArray(extraction?.text) ? extraction.text : [];
  const textGroups = Array.isArray(extraction?.text_groups) ? extraction.text_groups : [];
  const placenames = Array.isArray(extraction?.placenames) ? extraction.placenames : [];
  const seenText = new Set();
  const compactText = text
    .map((item) => ({ item, score: textEvidenceScore(item) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => compactOcrEvidenceItem(item))
    .filter(Boolean)
    .filter((item) => {
      const key = item.content.toLowerCase();
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .slice(0, METADATA_WRITER_TEXT_LIMIT);

  return withoutUndefined({
    description: extraction?.description,
    map_title: extraction?.map_title,
    map_bbox_estimate: extraction?.map_bbox_estimate,
    placenames: placenames
      .map((item) => compactOcrEvidenceItem(item, ["source_text_index"]))
      .filter(Boolean)
      .slice(0, METADATA_WRITER_PLACENAME_LIMIT),
    text_groups: textGroups
      .map((item) => compactOcrEvidenceItem(item))
      .filter(Boolean)
      .slice(0, METADATA_WRITER_TEXT_GROUP_LIMIT),
    text: compactText,
    debug: {
      ocr_strategy: extraction?.debug?.ocr_strategy,
      text_grouping_strategy: extraction?.debug?.text_grouping_strategy,
      placename_extraction_strategy: extraction?.debug?.placename_extraction_strategy,
      ocr_source_strategy: extraction?.debug?.ocr_source_strategy,
      compacted_for_metadata_writer: true,
      original_text_count: text.length,
      original_text_group_count: textGroups.length,
      original_placename_count: placenames.length,
      included_text_count: compactText.length,
      included_text_group_count: Math.min(textGroups.length, METADATA_WRITER_TEXT_GROUP_LIMIT),
      included_placename_count: Math.min(placenames.length, METADATA_WRITER_PLACENAME_LIMIT),
    },
  });
}

const OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE = [
  "OGM Aardvark controlled value guidance:",
  "- dct_format_s: use an OGM format label, not a MIME type. Common scanned image mappings: image/jpeg or .jpg -> JPEG; image/tiff or .tif -> TIFF; image/jp2 or .j2k -> JPEG2000; image/png -> PNG; application/pdf -> PDF. Use GeoTIFF only when the file is a georeferenced TIFF.",
  "- dct_language_sm: use ISO 639-2 three-letter codes such as eng, fre/fra, spa, ger/deu, ita, lat, or mul for multiple languages. Do not spell out language names. Use an empty array when language is unknown.",
  "- gbl_resourceClass_sm: choose only from Collections, Datasets, Imagery, Maps, Web services, Websites, Other. For a scanned or digitized map image, normally use [\"Maps\"]. Use Imagery only for aerial, satellite, or photographic imagery. Use Datasets only for GIS/vector/raster data products.",
  "- gbl_resourceType_sm: for scanned maps, prefer Library of Congress cartographic genre terms. Use Cartographic materials when no more specific term is supported. Common scanned-map terms include World maps, Thematic maps, Nautical charts, Topographic maps, Road maps, Fire insurance maps, Cadastral maps, Geological maps, Pictorial maps, Wall maps, Atlases, Aerial photographs, and Aerial views. Use OpenGeoMetadata data-type terms such as Raster data, Point data, Line data, Polygon data, and Table data only for geospatial datasets, not scanned map images.",
  "- dcat_theme_sm: choose only from Agriculture, Biology, Boundaries, Climate, Economy, Elevation, Environment, Events, Geology, Health, Imagery, Inland Waters, Land Cover, Location, Military, Oceans, Property, Society, Structure, Transportation, Utilities. Pick one to three values supported by the map evidence. For general maps use Location; add Transportation for routes, railroads, roads, shipping, or charts; Oceans for ocean/nautical content; Elevation for relief/topographic content; Boundaries for administrative boundaries; Economy for commerce/trade; Imagery only for imagery; Land Cover only for classified land cover.",
  "- gbl_dateRange_drsim: return a single Solr date range string like \"[1952 TO 1952]\", not an array containing that string.",
  "- locn_geometry: use WKT or ENVELOPE syntax. dcat_centroid: use \"latitude,longitude\". Do not return GeoJSON strings for either field.",
  "- If batch defaults or the base record conflict with the controlled value guidance, replace them with the best OGM-preferred value supported by evidence.",
].join("\n");

function aardvarkWriterMessages({ extraction, baseResource, batchDefaults, artifacts, fileName, checksum, resourceId, metadataDocuments, metadataSourceUrls }) {
  const promptExtraction = compactExtractionForMetadataWriter(extraction);
  const metadataContext = metadataDocuments.length > 0
    ? metadataDocuments.map((document) => `--- ${document.name} (${document.type || "text/plain"}) ---\n${document.text}`).join("\n\n")
    : "No companion metadata document was supplied.";
  return {
    systemPrompt: [
      "You are an expert OpenGeoMetadata Aardvark cataloger for scanned historical maps.",
      "Use the extracted map text, placenames, description, and optional companion metadata to create a high-quality Aardvark resource JSON object.",
      "Prefer explicit bibliographic evidence over filename-like titles or abbreviated map headings.",
      "Do not invent values. Leave unknown optional string fields blank and unknown arrays empty.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Create the best Aardvark metadata record for this uploaded map image.",
      "",
      "Important Aardvark guidance:",
      "- dct_title_s should be the full map title when visible or described, not a cropped heading if a fuller title is available.",
      "- dct_issued_s should be a single publication/issue year when evidence supports it, such as \"1891\".",
      "- dct_temporal_sm is temporal coverage. For a historical map with only one known map/publication year, use that year.",
      "- gbl_indexYear_im should be the integer year used for search/faceting when a year is known.",
      "- gbl_dateRange_drsim should use Solr date range syntax like \"[1891 TO 1891]\" when a single year is known.",
      "- dct_publisher_sm should contain the publisher organization when evidence says \"published by ...\".",
      "- dct_creator_sm should contain cartographers, engravers, surveyors, or agencies that made the map, when evidence supports it.",
      "- Keep id, dct_references_s, dct_source_sm, dcat_bbox, locn_geometry, dcat_centroid, gbl_georeferenced_b, and gbl_mdVersion_s consistent with the supplied base record unless companion metadata clearly improves descriptive fields.",
      "",
      OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE,
      "",
      `Resource id: ${resourceId}`,
      `Image filename: ${fileName}`,
      `Image SHA-256: ${checksum}`,
      `Artifact URLs: ${safeJsonStringify(artifacts, 2)}`,
      `Companion metadata URLs: ${safeJsonStringify(metadataSourceUrls, 2)}`,
      `Batch defaults: ${safeJsonStringify(batchDefaults, 2)}`,
      "",
      "Base Aardvark record to improve:",
      safeJsonStringify(baseResource, 2),
      "",
      "Historical map extraction evidence (compacted for metadata writing; full OCR remains in enrichment_response.json and ai-enrichments.json):",
      safeJsonStringify(promptExtraction, 2),
      "",
      "Optional companion metadata documents (TXT, FGDC XML, ISO XML, or similar):",
      metadataContext,
    ].join("\n"),
  };
}

async function callAardvarkMetadataWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { resource: context.baseResource, evidence: [] };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = aardvarkWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "aardvark_metadata_writer",
        schema: AARDVARK_METADATA_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

function geospatialAardvarkWriterMessages({ manifest, baseResource, batchDefaults, artifacts, fileName, checksum, resourceId }) {
  return {
    systemPrompt: [
      "You are an expert OpenGeoMetadata Aardvark cataloger for geospatial datasets.",
      "Use the deterministic package manifest to improve descriptive metadata for a GIS dataset.",
      "Do not invent values. Preserve machine-derived spatial fields, identifiers, references, and format facts unless the manifest clearly contradicts them.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Create the best Aardvark metadata record for this uploaded geospatial data package.",
      "",
      "Important Aardvark guidance:",
      "- This is data, not a scanned map image. Prefer gbl_resourceClass_sm [\"Datasets\"].",
      "- Use OpenGeoMetadata data-type terms such as Polygon data, Line data, Point data, Raster data, or Table data for gbl_resourceType_sm.",
      "- dct_format_s should be the source package format label, such as Shapefile, GeoPackage, GeoJSON, GeoTIFF, or CSV.",
      "- dct_temporal_sm is temporal coverage. Use dataset dates from attributes or sidecar metadata only when they are evident.",
      "- gbl_indexYear_im should be the integer year used for search/faceting when a temporal year is known.",
      "- Keep id, dct_references_s, dct_source_sm, dcat_bbox, locn_geometry, dcat_centroid, gbl_georeferenced_b, gbl_resourceClass_sm, gbl_resourceType_sm, dct_format_s, and gbl_mdVersion_s consistent with the supplied base record.",
      "",
      OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE,
      "",
      `Resource id: ${resourceId}`,
      `Package filename: ${fileName}`,
      `Package SHA-256: ${checksum}`,
      `Artifact URLs: ${safeJsonStringify(artifacts, 2)}`,
      `Batch defaults: ${safeJsonStringify(batchDefaults, 2)}`,
      "",
      "Base Aardvark record to improve:",
      safeJsonStringify(baseResource, 2),
      "",
      "Deterministic geospatial package manifest:",
      safeJsonStringify(manifest, 2),
    ].join("\n"),
  };
}

async function callGeospatialAardvarkMetadataWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { resource: context.baseResource, evidence: [] };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = geospatialAardvarkWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "aardvark_geospatial_metadata_writer",
        schema: AARDVARK_METADATA_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

async function completeGeospatialProcessing({ config, storageProfile, modelProfile, body, fileName, checksum, fileSize, analysis, uploadOriginal, log, milestones }) {
  const batchDefaults = effectiveBatchDefaults(body.batchDefaults || {}, storageProfile);
  const resourceId = body.resourceId || generatedAardvarkResourceId(storageProfile, batchDefaults);
  const keys = geospatialUploadKeys(storageProfile, resourceId, fileName);
  const artifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    manifestUrl: accessUrlFor(storageProfile, keys.manifest),
    archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
    archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
  };

  const hasCachedGeospatialResource = body.forceReprocess !== true
    && await objectExists(storageProfile, keys.archivalSupplement)
    && await objectExists(storageProfile, keys.aardvark);
  if (hasCachedGeospatialResource) {
    const cachedResource = await fetchJsonObject(storageProfile, keys.aardvark);
    const refs = referencesFromResource(cachedResource);
    const cacheNeedsImagePromotion = rasterPackageCanBeImageProcessed(analysis)
      && !refs["http://iiif.io/api/image"]
      && !refs["https://opengeometadata.org/reference/enrichment-response"];
    if (cacheNeedsImagePromotion) {
      log("Cached raster package lacks IIIF/OCR references; reprocessing to test scanned-map promotion", { resourceId });
    } else {
      log("Geospatial package already has archival accession supplement; returning existing resource", { resourceId });
      const resource = ensureArchivalSupplementReferences(cachedResource, artifacts);
      const existingArtifacts = geospatialArtifactUrlsForResource(storageProfile, keys, resource, artifacts);
      await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
      const manifest = await objectExists(storageProfile, keys.manifest)
        ? await fetchJsonObject(storageProfile, keys.manifest)
        : {};
      const archivalSupplement = await objectExists(storageProfile, keys.archivalSupplementJson)
        ? await fetchJsonObject(storageProfile, keys.archivalSupplementJson)
        : null;
      return {
        cached: true,
        checksum,
        resourceId,
        fileName,
        artifacts: existingArtifacts,
        manifest,
        rawResponse: null,
        usage: null,
        aardvarkJson: resource,
        distributions: distributionsFromResource(resource),
        aardvarkEvidence: [],
        archivalSupplement,
        proxyMilestones: milestones,
      };
    }
  }

  log("Geospatial package manifest created", {
    kind: analysis.manifest.dataset.kind,
    features: analysis.manifest.dataset.featureCount,
    geometryType: analysis.manifest.dataset.geometryType,
    fields: analysis.manifest.attributes?.fieldCount || 0,
  });

  log("Original geospatial package upload started", { key: keys.original, bytes: fileSize });
  await uploadOriginal(keys);
  log("Original geospatial package upload complete", { key: keys.original });

  const derivativeResult = await createGeospatialDerivatives({
    profile: storageProfile,
    keys,
    entries: analysis.entries,
    shapefile: analysis.shapefile,
    raster: analysis.raster,
    dbf: analysis.dbf,
    manifest: analysis.manifest,
    log,
  });
  const finalArtifacts = { ...artifacts, ...derivativeResult.uploaded };
  analysis.manifest.derivatives = derivativeResult.statuses;

  log("Uploading geospatial package manifest", { key: keys.manifest });
  await putObjectBuffer(storageProfile, keys.manifest, Buffer.from(safeJsonStringify(analysis.manifest, 2), "utf8"), "application/json");

  if (shouldPromoteRasterPackageToImageUpload(analysis)) {
    return processUnreferencedRasterPackageAsImage({
      config,
      storageProfile,
      body,
      resourceId,
      analysis,
      packageFileName: fileName,
      packageChecksum: checksum,
      packageArtifacts: finalArtifacts,
      keys,
      log,
    });
  }

  const fallbackSupplement = buildArchivalSupplementFallback({
    resourceId,
    checksum,
    fileName,
    fileSize,
    manifest: analysis.manifest,
    artifacts: finalArtifacts,
    entries: analysis.entries,
  });
  let archivalSupplement = fallbackSupplement;
  let supplementWriter = null;
  try {
    log("Archival accession supplement writer started", { model: body.model || modelProfile.defaultModel });
    supplementWriter = await callArchivalSupplementWriter(modelProfile, body, {
      fallbackSupplement,
      manifest: analysis.manifest,
      artifacts: finalArtifacts,
    });
    archivalSupplement = normalizeArchivalSupplement(supplementWriter.supplement, fallbackSupplement);
    log("Archival accession supplement writer complete", { inventoryFiles: archivalSupplement.inventory.length });
  } catch (error) {
    log("Archival accession supplement writer failed; using deterministic fallback", { error: error.message || String(error) });
    archivalSupplement = fallbackSupplement;
  }

  log("Uploading archival accession supplement", { key: keys.archivalSupplement });
  await putObjectBuffer(storageProfile, keys.archivalSupplementJson, Buffer.from(safeJsonStringify(archivalSupplement, 2), "utf8"), "application/json");
  await putObjectBuffer(storageProfile, keys.archivalSupplement, Buffer.from(renderArchivalSupplementMarkdown(archivalSupplement), "utf8"), "text/markdown; charset=utf-8");

  const baseResource = buildAardvarkForGeospatialPackage({
    resourceId,
    checksum,
    fileName,
    fileSize,
    manifest: analysis.manifest,
    batchDefaults,
    artifacts: finalArtifacts,
  });

  let writer = null;
  let resource = baseResource;
  try {
    log("Geospatial Aardvark metadata writer started", { model: body.model || modelProfile.defaultModel });
    writer = await callGeospatialAardvarkMetadataWriter(modelProfile, body, {
      manifest: analysis.manifest,
      baseResource,
      batchDefaults,
      artifacts: finalArtifacts,
      fileName,
      checksum,
      resourceId,
    });
    resource = normalizeAardvarkResource(writer.resource, baseResource, {
      resourceId,
      checksum,
      artifacts: finalArtifacts,
      fileName,
      fallbackTitle: baseResource.dct_title_s,
      batchDefaults,
    });
    log("Geospatial Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Geospatial Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseResource, {
      resourceId,
      checksum,
      artifacts: finalArtifacts,
      fileName,
      fallbackTitle: baseResource.dct_title_s,
      batchDefaults,
    });
  }

  log("Uploading geospatial Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  const distributions = distributionsFromResource(resource);
  log("Geospatial package processing complete", { resourceId });

  return {
    cached: false,
    checksum,
    resourceId,
    fileName,
    artifacts: finalArtifacts,
    manifest: analysis.manifest,
    rawResponse: writer?.rawResponse,
    usage: { aardvark: writer?.usage, archivalSupplement: supplementWriter?.usage },
    aardvarkJson: resource,
    distributions,
    aardvarkEvidence: writer?.evidence || [],
    archivalSupplement,
    proxyMilestones: milestones,
  };
}

async function processGeospatialPackage(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const fileName = sanitizeFileName(body.file?.name || "geospatial_package.zip");
  const { log, milestones } = createUploadLogger(jobId, fileName);
  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const batchDefaults = effectiveBatchDefaults(body.batchDefaults || {}, storageProfile);
  const checksum = String(body.checksum || body.file?.checksum || "");
  if (!checksum) throw new Error("Geospatial package request is missing a checksum.");
  const buffer = Buffer.from(String(body.file?.base64 || ""), "base64");
  if (buffer.length === 0) throw new Error("Geospatial package request did not include file bytes.");
  if (!/\.zip$/i.test(fileName)) throw new Error("Geospatial packages must be submitted as .zip files. Drop loose shapefile or raster sidecars in the browser so they can be grouped into a ZIP before processing.");

  log("Geospatial package analysis started", { bytes: buffer.length });
  const analysis = await analyzeGeospatialPackage(buffer, fileName);
  return completeGeospatialProcessing({
    config,
    storageProfile,
    modelProfile,
    body,
    fileName,
    checksum,
    fileSize: buffer.length,
    analysis,
    uploadOriginal: (keys) => putObjectBuffer(storageProfile, keys.original, buffer, "application/zip"),
    log,
    milestones,
  });

}

function safeUploadRelativePath(value) {
  const normalized = normalizeZipPath(value || "").replace(/^\/+/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe upload file path: ${value}`);
  }
  return parts.join("/");
}

async function createZipFromDirectory(sourceDirectory, zipPath) {
  const zipCommand = await resolveCommandPath("zip");
  if (!zipCommand) throw new Error("Large expanded geospatial packages require the local zip command so the proxy can package files without browser memory pressure.");
  await execFileAsync(zipCommand, ["-r", "-q", zipPath, "."], {
    cwd: sourceDirectory,
    timeout: 60 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 16,
  });
}

async function createEntriesFromSessionFiles(files) {
  const entries = [];
  for (const file of files) {
    const shouldBuffer = !isRasterSourceEntry(file.relativePath) || file.size <= 64 * 1024 * 1024;
    entries.push({
      name: file.relativePath,
      lowerName: file.relativePath.toLowerCase(),
      size: file.size,
      modifiedAt: file.modifiedAt || "",
      sha256: file.sha256,
      filePath: file.filePath,
      ...(shouldBuffer ? { buffer: await readFile(file.filePath) } : {}),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function cleanupExpiredGeospatialUploadSessions() {
  const now = Date.now();
  for (const [sessionId, session] of geospatialUploadSessions.entries()) {
    if (now - Number(session.createdAt || 0) <= GEOSPATIAL_UPLOAD_SESSION_TTL_MS) continue;
    geospatialUploadSessions.delete(sessionId);
    rm(session.tempRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(`[upload:${sessionId}] Failed to remove expired upload session`, error?.message || String(error));
    });
  }
}

async function createGeospatialUploadSession(_config, body) {
  cleanupExpiredGeospatialUploadSessions();
  const sessionId = `geo-session-${crypto.randomUUID()}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-geospatial-upload-"));
  const session = {
    id: sessionId,
    tempRoot,
    filesRoot: path.join(tempRoot, "files"),
    createdAt: Date.now(),
    request: body || {},
    files: [],
  };
  await mkdir(session.filesRoot, { recursive: true });
  geospatialUploadSessions.set(sessionId, session);
  return { sessionId };
}

async function uploadGeospatialSessionFile(req, url) {
  cleanupExpiredGeospatialUploadSessions();
  const parts = url.pathname.split("/").filter(Boolean);
  const sessionId = parts[parts.length - 2];
  const session = geospatialUploadSessions.get(sessionId);
  if (!session) throw new Error(`Geospatial upload session not found: ${sessionId}`);
  const relativePath = safeUploadRelativePath(url.searchParams.get("path") || "");
  const modifiedAt = url.searchParams.get("modifiedAt") || "";
  const target = path.join(session.filesRoot, relativePath);
  if (!target.startsWith(`${session.filesRoot}${path.sep}`)) throw new Error(`Unsafe upload target path: ${relativePath}`);
  await mkdir(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  let size = 0;
  const writer = createWriteStream(target);
  await pipeline(req, async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }, writer);
  const item = {
    relativePath,
    filePath: target,
    size,
    modifiedAt,
    sha256: hash.digest("hex"),
  };
  session.files = session.files.filter((file) => file.relativePath !== relativePath);
  session.files.push(item);
  return { sessionId, path: relativePath, size, checksum: item.sha256 };
}

async function completeGeospatialUploadSession(config, body) {
  cleanupExpiredGeospatialUploadSessions();
  const sessionId = body.sessionId;
  const session = geospatialUploadSessions.get(sessionId);
  if (!session) throw new Error(`Geospatial upload session not found: ${sessionId}`);
  const request = { ...(session.request || {}), ...(body.request || {}), ...(body || {}) };
  const fileName = sanitizeFileName(request.fileName || request.file?.name || "geospatial_package.zip");
  const { log, milestones } = createUploadLogger(request.jobId || crypto.randomUUID(), fileName);
  const storageProfile = findProfile(config, "storage", request.storageProfileId);
  const modelProfile = findProfile(config, "model", request.modelProfileId);
  if (session.files.length === 0) throw new Error("Geospatial upload session has no files.");
  const zipPath = path.join(session.tempRoot, fileName.endsWith(".zip") ? fileName : `${fileName}.zip`);
  try {
    log("Proxy-side ZIP packaging started", { files: session.files.length });
    await createZipFromDirectory(session.filesRoot, zipPath);
    const zipInfo = await stat(zipPath);
    const checksum = await sha256File(zipPath);
    const entries = await createEntriesFromSessionFiles(session.files);
    const shapefile = findShapefileSet(entries);
    const raster = shapefile ? null : findRasterSet(entries);
    const analysis = shapefile
      ? analyzeShapefilePackage(entries, shapefile, fileName)
      : raster
        ? analyzeRasterPackage(entries, raster, fileName)
        : null;
    if (!analysis) {
      throw new Error("Geospatial package must contain a shapefile or geospatial raster source. Submit shapefile sidecars or a raster with georeferencing sidecars.");
    }
    return await completeGeospatialProcessing({
      config,
      storageProfile,
      modelProfile,
      body: request,
      fileName,
      checksum,
      fileSize: zipInfo.size,
      analysis,
      uploadOriginal: (keys) => putObjectFile(storageProfile, keys.original, zipPath, "application/zip"),
      log,
      milestones,
    });
  } finally {
    geospatialUploadSessions.delete(sessionId);
    await rm(session.tempRoot, { recursive: true, force: true });
  }
}

function buildAardvarkForUpload({ resourceId, checksum, fileName, fileSize, contentType, extraction, batchDefaults = {}, artifacts }) {
  const titleText = Array.isArray(extraction?.text)
    ? extraction.text.find((entry) => entry?.role === "title" && entry?.content)?.content
    : "";
  const fallbackTitle = fileName.replace(/\.[^.]+$/, "") || "Uploaded map";
  const places = Array.isArray(extraction?.placenames)
    ? extraction.placenames
      .filter((place) => place?.name && Number(place.confidence ?? 0) >= 0.75)
      .map((place) => String(place.name))
    : [];
  const uniquePlaces = Array.from(new Set(places)).slice(0, 60);
  const { bboxString, locnGeometry, centroid } = bboxFields(extraction);
  const refs = {
    "http://schema.org/url": artifacts.originalUrl,
    "http://schema.org/thumbnailUrl": artifacts.thumbnailUrl,
    "http://iiif.io/api/image": artifacts.iiifInfoUrl,
    ...(artifacts.cogUrl ? {
      "http://schema.org/downloadUrl": [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }],
      "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" },
    } : {}),
    ...(artifacts.archivalSupplementUrl ? {
      "http://schema.org/downloadUrl": [
        ...(artifacts.cogUrl ? [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }] : []),
        { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
      ],
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" } } : {}),
    "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl,
    ...(artifacts.aiEnrichmentsUrl ? { [AI_ENRICHMENTS_RELATION]: { url: artifacts.aiEnrichmentsUrl, label: "OpenGeoMetadata AI Enrichments JSON" } } : {}),
    "https://opengeometadata.org/reference/aardvark-json": artifacts.aardvarkUrl,
  };
  const resource = {
    id: resourceId,
    dct_title_s: String(batchDefaults.titlePrefix ? `${batchDefaults.titlePrefix}: ${titleText || fallbackTitle}` : titleText || fallbackTitle),
    dct_accessRights_s: normalizeAccessRights(batchDefaults.accessRights, "Public"),
    dct_format_s: normalizeAardvarkFormat("", { fileName, contentType, georeferenced: Boolean(artifacts.cogUrl) }),
    gbl_mdVersion_s: "Aardvark",
    schema_provider_s: String(batchDefaults.provider || "OpenGeoMetadata Studio"),
    dct_issued_s: String(batchDefaults.issued || ""),
    dct_alternative_sm: [],
    dct_description_sm: [extraction?.description || ""].filter(Boolean),
    dct_language_sm: normalizeLanguageValues(batchDefaults.language ? [batchDefaults.language] : []),
    gbl_displayNote_sm: [],
    dct_creator_sm: batchDefaults.creator ? [batchDefaults.creator] : [],
    dct_publisher_sm: batchDefaults.publisher ? [batchDefaults.publisher] : [],
    gbl_resourceClass_sm: normalizeControlledValues(batchDefaults.resourceClass, AARDVARK_RESOURCE_CLASS_VALUES, ["Maps"]),
    gbl_resourceType_sm: Array.isArray(batchDefaults.resourceType) ? batchDefaults.resourceType.map(String) : ["Cartographic materials"],
    dct_subject_sm: Array.isArray(batchDefaults.subjects) ? batchDefaults.subjects.map(String) : [],
    dcat_theme_sm: normalizeControlledValues(batchDefaults.themes, AARDVARK_THEME_VALUES, ["Location"]),
    dcat_keyword_sm: ["AI extracted", "uploaded image", ...uniquePlaces.slice(0, 12)],
    dct_temporal_sm: [],
    gbl_dateRange_drsim: "",
    gbl_indexYear_im: null,
    dct_spatial_sm: uniquePlaces,
    locn_geometry: locnGeometry,
    dcat_bbox: bboxString,
    dcat_centroid: centroid,
    gbl_georeferenced_b: Boolean(bboxString),
    dct_identifier_sm: [resourceId, checksum],
    gbl_wxsIdentifier_s: "",
    dct_rights_sm: batchDefaults.rights ? [batchDefaults.rights] : [],
    dct_rightsHolder_sm: batchDefaults.rightsHolder ? [batchDefaults.rightsHolder] : [],
    dct_license_sm: batchDefaults.license ? [batchDefaults.license] : [],
    pcdm_memberOf_sm: batchDefaults.memberOf ? [batchDefaults.memberOf] : [],
    dct_isPartOf_sm: batchDefaults.isPartOf ? [batchDefaults.isPartOf] : [],
    dct_source_sm: [artifacts.originalUrl],
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: [],
    gbl_fileSize_s: String(fileSize || ""),
    dct_references_s: safeJsonStringify(refs),
    extra: {
      gbl_mdModified_dt: new Date().toISOString(),
      ogm_upload_checksum_s: checksum,
    },
  };
  const distributions = distributionsFromResource(resource);
  return { resource, distributions };
}

async function maybeCreateImageCogDerivative({ profile, keys, buffer, fileName, contentType, log }) {
  const isPotentialGeospatialRaster = /image\/(?:tiff|jp2|j2k)/i.test(contentType || "") || /\.(tiff?|jp2|j2k)$/i.test(fileName);
  if (!isPotentialGeospatialRaster) return { uploaded: {}, statuses: [] };
  const statuses = [];
  const uploaded = {};
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-image-cog-"));
  try {
    const sourcePath = path.join(tempRoot, sanitizeFileName(fileName || "image.tif"));
    await writeFile(sourcePath, buffer);
    const manifest = {
      dataset: {
        kind: "raster",
        baseName: sanitizeFileName(fileName || "image").replace(/\.[^.]+$/, "") || "image",
        bbox: null,
      },
      crs: {
        wkt: "",
        normalized: "",
      },
    };
    const info = await inspectRasterWithGdal(sourcePath, manifest, statuses, log);
    if (!hasRasterGeoreference(manifest, info)) {
      statuses.push({ kind: "cog", status: "skipped", reason: "GDAL did not find georeferencing for this image upload." });
      return { uploaded, statuses };
    }
    await createCogDerivative({ profile, keys, sourcePath, manifest, statuses, uploaded, log });
    return { uploaded, statuses };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function processUploadedImage(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const file = body.file || {};
  const fileName = sanitizeFileName(file.name);
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("Upload request received", { size: file.size || 0, type: file.type || "" });
  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const visionProfile = body.visionProfileId ? findProfile(config, "vision", body.visionProfileId) : null;
  const textExtractionModelProfile = body.textExtractionModelProfileId ? findProfile(config, "model", body.textExtractionModelProfileId) : null;
  const batchDefaults = effectiveBatchDefaults(body.batchDefaults || {}, storageProfile);
  const contentType = file.type || contentTypeForKey(fileName);
  const base64 = String(file.base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!base64) throw new Error("Upload request is missing file data.");
  const buffer = Buffer.from(base64, "base64");
  const checksum = sha256(buffer);
  log("Checksum verified", { checksum, bytes: buffer.length });
  if (body.checksum && String(body.checksum).toLowerCase() !== checksum) {
    throw new Error(`Checksum mismatch for ${fileName}. Browser reported ${body.checksum}, proxy calculated ${checksum}.`);
  }
  const metadataDocuments = normalizeMetadataDocuments(body.metadataDocuments);
  const indexKey = checksumIndexKey(storageProfile, checksum);
  const forceReprocess = body.forceReprocess === true;
  const preserveResourceId = Boolean(body.resourceId && body.preserveResourceId);
  log("Checking checksum index", { indexKey });
  let indexedUpload = null;
  if (!preserveResourceId && await objectExists(storageProfile, indexKey)) {
    const index = await fetchJsonObject(storageProfile, indexKey);
    const resourceId = String(index.resourceId || index.resource_id || `uploaded-${checksum.slice(0, 16)}`);
    const keys = hydrateUploadKeys(storageProfile, index.keys, resourceId, fileName);
    const artifacts = {
      originalUrl: accessUrlFor(storageProfile, keys.original),
      thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
      iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
      extractionUrl: accessUrlFor(storageProfile, keys.extraction),
      archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
      archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
      aiEnrichmentsUrl: accessUrlFor(storageProfile, keys.aiEnrichments),
      aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
      ...(index.artifacts?.cogUrl ? { cogUrl: index.artifacts.cogUrl } : {}),
    };
    indexedUpload = { resourceId, keys, artifacts, index };

    if (!forceReprocess && await objectExists(storageProfile, keys.aardvark)) {
      log("Checksum index hit; returning existing upload without reprocessing", { resourceId });
      let extraction = await objectExists(storageProfile, keys.extraction)
        ? await fetchJsonObject(storageProfile, keys.extraction)
        : null;
      if (!await objectExists(storageProfile, keys.aiEnrichments).catch(() => false)) {
        delete artifacts.aiEnrichmentsUrl;
      }
      let finalAardvarkJson = ensureReferenceJson({ ...await fetchJsonObject(storageProfile, keys.aardvark), id: resourceId }, artifacts);
      if (!await objectExists(storageProfile, keys.archivalSupplement)) {
        log("Cached upload is missing archival supplement; creating lightweight accession record", { key: keys.archivalSupplement });
        const supplement = buildImageArchivalSupplement({
          resourceId,
          checksum,
          fileName,
          fileSize: buffer.length,
          contentType,
          modifiedAt: file.modifiedAt || "",
          extraction,
          artifacts,
          metadataDocuments: [],
        });
        await writeArchivalSupplementArtifacts(storageProfile, keys, supplement);
        finalAardvarkJson = ensureReferenceJson(finalAardvarkJson, artifacts);
      }
      await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(finalAardvarkJson, 2), "utf8"), "application/json");
      const distributions = distributionsFromResource(finalAardvarkJson);
      return {
        cached: true,
        checksum,
        resourceId,
        fileName,
        artifacts,
        extraction,
        rawResponse: null,
        usage: null,
        confidence: null,
        aardvarkJson: finalAardvarkJson,
        distributions,
        aardvarkEvidence: [],
        proxyMilestones: milestones,
      };
    }

    if (forceReprocess) {
      log("Checksum index hit; force reprocess requested", { resourceId });
    } else {
      log("Checksum index hit but Aardvark JSON is missing; reprocessing broken upload", { resourceId });
    }
  }

  const resourceId = preserveResourceId ? String(body.resourceId) : indexedUpload?.resourceId || body.resourceId || generatedAardvarkResourceId(storageProfile, batchDefaults);
  const keys = hydrateUploadKeys(storageProfile, preserveResourceId ? null : indexedUpload?.keys, resourceId, fileName);
  log("Resource directory assigned", { resourceId, root: keys.root, forceReprocess });
  const artifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
    iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
    extractionUrl: accessUrlFor(storageProfile, keys.extraction),
    archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
    archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
    aiEnrichmentsUrl: accessUrlFor(storageProfile, keys.aiEnrichments),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
    ...(indexedUpload?.artifacts?.cogUrl ? { cogUrl: indexedUpload.artifacts.cogUrl } : {}),
  };

  log("Original upload started", { key: keys.original });
  const originalUpload = putObjectBuffer(storageProfile, keys.original, buffer, contentType)
    .then(() => log("Original upload complete", { key: keys.original }));
  const cogPromise = maybeCreateImageCogDerivative({ profile: storageProfile, keys, buffer, fileName, contentType, log });
  log("IIIF package generation started", { root: keys.iiif });
  const iiifPromise = createIiifLevel0Package(storageProfile, keys, buffer, log);
  let extractionPromise;
  let derivativeSummaries = [];
  if (visionProfile) {
    log("Google Cloud Vision OCR image normalization started", { profile: visionProfile.name || visionProfile.id });
    const visionSources = await createVisionOcrSources(buffer, contentType);
    const visionImage = visionSources.primary;
    log("Google Cloud Vision OCR request started", { featureType: visionProfile.featureType || "DOCUMENT_TEXT_DETECTION", width: visionImage.width, height: visionImage.height, originalBytes: visionImage.originalBytes, normalizedBytes: visionImage.normalizedBytes, quality: visionImage.quality ?? null, maxDimension: visionImage.maxDimension ?? null, sourceCount: visionSources.sources.length, tileCount: visionSources.summary.tileCount });
    extractionPromise = callGoogleVisionOcr(visionProfile, visionSources)
      .then(async (result) => {
        log("Google Cloud Vision OCR response received", { textSegments: result.parsedResponse?.text?.length || 0, textGroups: result.parsedResponse?.text_groups?.length || 0, placenames: result.parsedResponse?.placenames?.length || 0, sources: result.usage?.sourceCount || 0, tiles: result.usage?.tileCount || 0, confidence: result.confidence ?? null });
        if (shouldRunTextReconciliation(textExtractionModelProfile, body)) {
          const providerLabel = textReconciliationProviderLabel(textExtractionModelProfile);
          log(`${providerLabel} map-label reconciliation crop generation started`);
          const derivatives = await createTextReconciliationDerivativesForProfile(textExtractionModelProfile, {
            buffer,
            contentType,
            assetId: `${storageProfile.id}:${storageProfile.bucket}/${keys.original}`,
            visionSources,
            ocrExtraction: result.parsedResponse,
            request: body,
          });
          log(`${providerLabel} map-label reconciliation derivatives ready`, { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
          const augmented = await maybeAugmentGoogleVisionOcrWithTextReconciliation({ modelProfile: textExtractionModelProfile, request: body, derivatives, ocrResult: result, log });
          if ([HYBRID_GEMINI_VISION_OCR_PROVIDER, HYBRID_OPENAI_VISION_OCR_PROVIDER, HYBRID_KIMI_VISION_OCR_PROVIDER].includes(augmented.provider)) {
            derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
          }
          return augmented;
        }
        if (shouldAugmentOcrWithOpenAIVision(modelProfile, body)) {
          log("OpenAI vision augmentation OCR-source image generation started");
          const derivatives = await createVisionAugmentationDerivatives({
            buffer,
            contentType,
            assetId: `${storageProfile.id}:${storageProfile.bucket}/${keys.original}:vision-augmentation`,
            visionSources,
          });
          log("OpenAI vision augmentation derivatives ready", { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
          const augmented = await maybeAugmentGoogleVisionOcrResult({ modelProfile, request: body, derivatives, ocrResult: result, log });
          if (augmented.provider === HYBRID_VISION_OCR_PROVIDER) {
            derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
          }
          return augmented;
        }
        return result;
      });
  } else {
    log("OpenAI analysis derivative generation started");
    const derivatives = await createAnalysisDerivativesFromBuffer(buffer, contentType, `${storageProfile.id}:${storageProfile.bucket}/${keys.original}`);
    derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
    log("OpenAI analysis derivatives ready", { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
    log("OpenAI extraction request started", { model: body.model || modelProfile.defaultModel });
    extractionPromise = callOpenAI(modelProfile, body, derivatives)
      .then((result) => {
        log("OpenAI extraction response received", { confidence: result.confidence ?? null });
        return result;
      });
  }
  const [iiif, extractionResult, cogResult] = await Promise.all([iiifPromise, extractionPromise, cogPromise, originalUpload.then(() => true).then(() => null)]);
  log("Parallel proxy work complete", { tileCount: iiif.tileCount, scaleFactors: iiif.scaleFactors, cogStatus: cogResult.statuses?.find((status) => status.kind === "cog")?.status || "not_applicable" });

  const finalArtifacts = {
    ...artifacts,
    thumbnailUrl: iiif.thumbnailUrl,
    iiifInfoUrl: iiif.infoUrl,
    ...cogResult.uploaded,
  };
  const metadataSourceUrls = await uploadMetadataDocuments(storageProfile, keys, metadataDocuments, log);
  log("Uploading enrichment response JSON", { key: keys.extraction });
  await putObjectBuffer(storageProfile, keys.extraction, Buffer.from(safeJsonStringify(extractionResult.parsedResponse, 2), "utf8"), "application/json");
  const archivalSupplement = buildImageArchivalSupplement({
    resourceId,
    checksum,
    fileName,
    fileSize: buffer.length,
    contentType,
    modifiedAt: file.modifiedAt || "",
    extraction: extractionResult.parsedResponse,
    artifacts: finalArtifacts,
    metadataDocuments,
  });
  log("Uploading image archival accession supplement", { key: keys.archivalSupplement });
  await writeArchivalSupplementArtifacts(storageProfile, keys, archivalSupplement);
  const baseAardvark = buildAardvarkForUpload({
    resourceId,
    checksum,
    fileName,
    fileSize: buffer.length,
    contentType,
    extraction: extractionResult.parsedResponse,
    batchDefaults,
    artifacts: finalArtifacts,
  });
  let aardvarkWriter = null;
  let resource = baseAardvark.resource;
  try {
    log("Aardvark metadata writer started", { metadataDocuments: metadataDocuments.length });
    aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      baseResource: baseAardvark.resource,
      batchDefaults,
      artifacts: finalArtifacts,
      metadataDocuments,
      metadataSourceUrls,
    });
    resource = normalizeAardvarkResource(aardvarkWriter.resource, baseAardvark.resource, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      artifacts: finalArtifacts,
      metadataSourceUrls,
      batchDefaults,
      contentType,
    });
    log("Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseAardvark.resource, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      artifacts: finalArtifacts,
      metadataSourceUrls,
      batchDefaults,
      contentType,
    });
  }
  const distributions = distributionsFromResource(resource);
  const aiEnrichments = buildAiEnrichmentsForImage({
    resourceId,
    fileName,
    checksum,
    fileSize: buffer.length,
    contentType,
    modifiedAt: file.modifiedAt || "",
    artifacts: finalArtifacts,
    extractionResult,
    metadataWriter: aardvarkWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls,
    derivativeSummaries,
  });
  log("Uploading AI Enrichments JSON", { key: keys.aiEnrichments, prompts: aiEnrichments.prompts.length, apiCalls: aiEnrichments.apiCalls.length });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(aiEnrichments, 2), "utf8"), "application/json");
  log("Uploading Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("Writing checksum index", { indexKey });
  await putObjectBuffer(storageProfile, indexKey, Buffer.from(safeJsonStringify({
    checksum,
    resourceId,
    fileName,
    root: keys.root,
    keys,
    artifacts: finalArtifacts,
    metadataSourceUrls,
    created_at: new Date().toISOString(),
  }, 2), "utf8"), "application/json");
  log("Upload workflow complete", { resourceId });

  return {
    cached: false,
    checksum,
    resourceId,
    fileName,
    artifacts: finalArtifacts,
    aiEnrichmentsUrl: finalArtifacts.aiEnrichmentsUrl,
    iiif,
    extraction: extractionResult.parsedResponse,
    rawResponse: extractionResult.rawResponse,
    usage: extractionResult.usage,
    confidence: extractionResult.confidence,
    aardvarkJson: resource,
    distributions,
    aardvarkEvidence: aardvarkWriter?.evidence || [],
    archivalSupplement,
    derivatives: derivativeSummaries,
    proxyMilestones: milestones,
  };
}

async function regenerateAardvarkForS3Resource(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const requested = body.resource || {};
  const root = String(requested.root || "").replace(/\/+$/g, "");
  if (!root) throw new Error("Regenerate request is missing the S3 resource root.");

  const fileName = sanitizeFileName(requested.fileName || requested.resourceId || root.split("/").pop() || "resource");
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("Aardvark regeneration request received", { root });

  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  log("Fetching existing Aardvark and extraction JSON", { aardvark: keys.aardvark, extraction: keys.extraction });
  const [existingAardvark, extraction] = await Promise.all([
    fetchJsonObject(storageProfile, keys.aardvark),
    fetchJsonObject(storageProfile, keys.extraction),
  ]);
  const resourceId = String(existingAardvark.id || requested.resourceId || root.split("/").pop() || crypto.randomUUID());
  const checksum = String(requested.checksum || checksumFromResource(existingAardvark));
  const artifacts = artifactUrlsForResource(storageProfile, keys, existingAardvark);
  const baseResource = ensureReferenceJson(existingAardvark, artifacts);

  const storedMetadataDocuments = await readMetadataDocumentsFromS3(storageProfile, keys, log);
  const suppliedMetadataDocuments = normalizeMetadataDocuments(body.metadataDocuments);
  const metadataDocuments = normalizeMetadataDocuments([...storedMetadataDocuments, ...suppliedMetadataDocuments]);
  const metadataSourceUrls = uniqueStrings([
    ...storedMetadataDocuments.map((document) => document.url),
    ...(Array.isArray(requested.metadataSourceUrls) ? requested.metadataSourceUrls : []),
  ]);

  let aardvarkWriter = null;
  let resource = baseResource;
  try {
    log("Aardvark metadata writer started", { metadataDocuments: metadataDocuments.length });
    aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
      resourceId,
      checksum,
      fileName,
      extraction,
      baseResource,
      batchDefaults,
      artifacts,
      metadataDocuments,
      metadataSourceUrls,
    });
    resource = normalizeAardvarkResource(aardvarkWriter.resource, baseResource, {
      resourceId,
      checksum,
      fileName,
      extraction,
      artifacts,
      metadataSourceUrls,
      batchDefaults,
      contentType: contentTypeForKey(fileName),
    });
    log("Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseResource, {
      resourceId,
      checksum,
      fileName,
      extraction,
      artifacts,
      metadataSourceUrls,
      batchDefaults,
      contentType: contentTypeForKey(fileName),
    });
  }

  const archivalSupplement = await objectExists(storageProfile, keys.archivalSupplementJson).catch(() => false)
    ? await fetchJsonObject(storageProfile, keys.archivalSupplementJson)
    : null;
  const extractionProvider = String(extraction?.debug?.ocr_strategy || "").startsWith("google_cloud_vision")
    ? "google_cloud_vision"
    : "openai";
  const aiEnrichments = buildAiEnrichmentsForImage({
    resourceId,
    fileName,
    checksum,
    fileSize: Number(resource.gbl_fileSize_s || existingAardvark.gbl_fileSize_s || 0),
    contentType: contentTypeForKey(fileName),
    artifacts,
    extractionResult: {
      provider: extractionProvider,
      parsedResponse: extraction,
      rawResponse: null,
      usage: extractionProvider === "google_cloud_vision"
        ? { provider: "google_cloud_vision", rawResponseNotAvailable: true }
        : { provider: "openai", rawResponseNotAvailable: true },
    },
    metadataWriter: aardvarkWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls,
    derivativeSummaries: [],
  });
  log("Uploading regenerated AI Enrichments JSON", { key: keys.aiEnrichments, prompts: aiEnrichments.prompts.length, apiCalls: aiEnrichments.apiCalls.length });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(aiEnrichments, 2), "utf8"), "application/json");

  log("Uploading regenerated Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("Aardvark regeneration complete", { resourceId });

  return {
    resourceId,
    fileName,
    root,
    artifacts,
    aiEnrichmentsUrl: artifacts.aiEnrichmentsUrl,
    extraction,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
    aardvarkEvidence: aardvarkWriter?.evidence || [],
    proxyMilestones: milestones,
  };
}

async function refreshOcrForS3ImageResource(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const requested = body.resource || {};
  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = body.modelProfileId ? findProfile(config, "model", body.modelProfileId) : null;
  const visionProfile = findProfile(config, "vision", body.visionProfileId);
  const textExtractionModelProfile = body.textExtractionModelProfileId ? findProfile(config, "model", body.textExtractionModelProfileId) : null;
  const batchDefaults = effectiveBatchDefaults(body.batchDefaults || {}, storageProfile);
  const root = String(requested.root || (requested.resourceId ? `${uploadBasePrefix(storageProfile)}/${requested.resourceId}` : "")).replace(/\/+$/g, "");
  if (!root) throw new Error("OCR refresh request is missing the S3 resource root.");
  if (!modelProfile && body.skipMetadataWriter !== true) throw new Error("OCR refresh requires a model profile unless skipMetadataWriter is true.");

  const fileName = sanitizeFileName(requested.fileName || requested.originalKey?.split("/").pop() || requested.resourceId || root.split("/").pop() || "resource");
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("S3 OCR refresh request received", { root });

  const keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  log("Fetching existing Aardvark JSON and original image", { aardvark: keys.aardvark, original: keys.original });
  const [existingAardvark, buffer] = await Promise.all([
    fetchJsonObject(storageProfile, keys.aardvark),
    fetchObjectBuffer(storageProfile, keys.original),
  ]);
  const resourceId = String(existingAardvark.id || requested.resourceId || root.split("/").pop() || crypto.randomUUID());
  const checksum = sha256(buffer);
  const contentType = body.contentType || contentTypeForKey(keys.original || fileName);
  const artifacts = artifactUrlsForResource(storageProfile, keys, existingAardvark);
  const baseResource = ensureReferenceJson(existingAardvark, artifacts);

  log("Google Cloud Vision OCR image normalization started", { profile: visionProfile.name || visionProfile.id });
  const visionSources = await createVisionOcrSources(buffer, contentType);
  const visionImage = visionSources.primary;
  log("Google Cloud Vision OCR request started", {
    featureType: visionProfile.featureType || "DOCUMENT_TEXT_DETECTION",
    width: visionImage.width,
    height: visionImage.height,
    originalBytes: visionImage.originalBytes,
    normalizedBytes: visionImage.normalizedBytes,
    quality: visionImage.quality ?? null,
    maxDimension: visionImage.maxDimension ?? null,
    sourceCount: visionSources.sources.length,
    tileCount: visionSources.summary.tileCount,
  });
  let extractionResult = await callGoogleVisionOcr(visionProfile, visionSources);
  log("Google Cloud Vision OCR response received", {
    textSegments: extractionResult.parsedResponse?.text?.length || 0,
    textGroups: extractionResult.parsedResponse?.text_groups?.length || 0,
    placenames: extractionResult.parsedResponse?.placenames?.length || 0,
    sources: extractionResult.usage?.sourceCount || 0,
    tiles: extractionResult.usage?.tileCount || 0,
    confidence: extractionResult.confidence ?? null,
  });
  let derivativeSummaries = [];
  if (shouldRunTextReconciliation(textExtractionModelProfile, body)) {
    const providerLabel = textReconciliationProviderLabel(textExtractionModelProfile);
    log(`${providerLabel} map-label reconciliation crop generation started`);
    const derivatives = await createTextReconciliationDerivativesForProfile(textExtractionModelProfile, {
      buffer,
      contentType,
      assetId: `${storageProfile.id}:${storageProfile.bucket}/${keys.original}`,
      visionSources,
      ocrExtraction: extractionResult.parsedResponse,
      request: body,
    });
    log(`${providerLabel} map-label reconciliation derivatives ready`, { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
    extractionResult = await maybeAugmentGoogleVisionOcrWithTextReconciliation({ modelProfile: textExtractionModelProfile, request: body, derivatives, ocrResult: extractionResult, log });
    if ([HYBRID_GEMINI_VISION_OCR_PROVIDER, HYBRID_OPENAI_VISION_OCR_PROVIDER, HYBRID_KIMI_VISION_OCR_PROVIDER].includes(extractionResult.provider)) {
      derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
    }
  } else if (shouldAugmentOcrWithOpenAIVision(modelProfile, body)) {
    log("OpenAI vision augmentation OCR-source image generation started");
    const derivatives = await createVisionAugmentationDerivatives({
      buffer,
      contentType,
      assetId: `${storageProfile.id}:${storageProfile.bucket}/${keys.original}:vision-augmentation`,
      visionSources,
    });
    log("OpenAI vision augmentation derivatives ready", { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
    extractionResult = await maybeAugmentGoogleVisionOcrResult({ modelProfile, request: body, derivatives, ocrResult: extractionResult, log });
    if (extractionResult.provider === HYBRID_VISION_OCR_PROVIDER) {
      derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
    }
  }

  const storedMetadataDocuments = await readMetadataDocumentsFromS3(storageProfile, keys, log);
  const suppliedMetadataDocuments = normalizeMetadataDocuments(body.metadataDocuments);
  const metadataDocuments = normalizeMetadataDocuments([...storedMetadataDocuments, ...suppliedMetadataDocuments]);
  const metadataSourceUrls = uniqueStrings([
    ...storedMetadataDocuments.map((document) => document.url),
    ...(Array.isArray(requested.metadataSourceUrls) ? requested.metadataSourceUrls : []),
  ]);

  log("Uploading refreshed enrichment response JSON", { key: keys.extraction });
  await putObjectBuffer(storageProfile, keys.extraction, Buffer.from(safeJsonStringify(extractionResult.parsedResponse, 2), "utf8"), "application/json");

  let aardvarkWriter = null;
  let resource = baseResource;
  let metadataWriterError = "";
  if (body.skipMetadataWriter === true) {
    log("Aardvark metadata writer skipped by request");
  } else {
    try {
      log("Aardvark metadata writer started", { metadataDocuments: metadataDocuments.length });
      aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
        resourceId,
        checksum,
        fileName,
        extraction: extractionResult.parsedResponse,
        baseResource,
        batchDefaults,
        artifacts,
        metadataDocuments,
        metadataSourceUrls,
      });
      resource = normalizeAardvarkResource(aardvarkWriter.resource, baseResource, {
        resourceId,
        checksum,
        fileName,
        extraction: extractionResult.parsedResponse,
        artifacts,
        metadataSourceUrls,
        batchDefaults,
        contentType,
      });
      log("Aardvark metadata writer complete", { title: resource.dct_title_s });
    } catch (error) {
      metadataWriterError = error.message || String(error);
      log("Aardvark metadata writer failed; preserving existing Aardvark record", { error: metadataWriterError });
      if (body.preserveAardvarkOnWriterFailure === false) {
        resource = normalizeAardvarkResource({}, baseResource, {
          resourceId,
          checksum,
          fileName,
          extraction: extractionResult.parsedResponse,
          artifacts,
          metadataSourceUrls,
          batchDefaults,
          contentType,
        });
      }
    }
  }

  const archivalSupplement = buildImageArchivalSupplement({
    resourceId,
    checksum,
    fileName,
    fileSize: buffer.length,
    contentType,
    modifiedAt: requested.updatedAt || requested.lastModified || "",
    extraction: extractionResult.parsedResponse,
    artifacts,
    metadataDocuments,
  });
  log("Uploading refreshed archival accession supplement", { key: keys.archivalSupplement });
  await writeArchivalSupplementArtifacts(storageProfile, keys, archivalSupplement);

  const aiEnrichments = buildAiEnrichmentsForImage({
    resourceId,
    fileName,
    checksum,
    fileSize: buffer.length,
    contentType,
    modifiedAt: requested.updatedAt || requested.lastModified || "",
    artifacts,
    extractionResult,
    metadataWriter: aardvarkWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls,
    derivativeSummaries,
  });
  if (metadataWriterError) {
    aiEnrichments.debug = {
      ...(aiEnrichments.debug || {}),
      metadataWriterError,
    };
  }
  log("Uploading refreshed AI Enrichments JSON", { key: keys.aiEnrichments, prompts: aiEnrichments.prompts.length, apiCalls: aiEnrichments.apiCalls.length });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(aiEnrichments, 2), "utf8"), "application/json");

  log("Uploading refreshed Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("S3 OCR refresh complete", { resourceId });

  return {
    resourceId,
    fileName,
    root,
    checksum,
    artifacts,
    aiEnrichmentsUrl: artifacts.aiEnrichmentsUrl,
    extraction: extractionResult.parsedResponse,
    rawResponse: extractionResult.rawResponse,
    usage: extractionResult.usage,
    confidence: extractionResult.confidence,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
    aardvarkEvidence: aardvarkWriter?.evidence || [],
    archivalSupplement,
    metadataWriterError: metadataWriterError || undefined,
    proxyMilestones: milestones,
  };
}

function extractionProviderFromLegacyResponse(extraction) {
  return String(extraction?.debug?.ocr_strategy || "").startsWith("google_cloud_vision")
    ? "google_cloud_vision"
    : "openai";
}

async function refreshWofConcordanceForS3Resource(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const requested = body.resource || {};
  const root = String(requested.root || "").replace(/\/+$/g, "");
  if (!root) throw new Error("WOF concordance refresh request is missing the S3 resource root.");

  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const fileName = sanitizeFileName(requested.fileName || requested.resourceId || root.split("/").pop() || "resource");
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("WOF concordance refresh request received", { root });

  const keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  log("Fetching existing Aardvark JSON", { aardvark: keys.aardvark });
  const existingAardvark = await fetchJsonObject(storageProfile, keys.aardvark);
  const resourceId = String(existingAardvark.id || requested.resourceId || root.split("/").pop() || crypto.randomUUID());
  const artifacts = artifactUrlsForResource(storageProfile, keys, existingAardvark);
  const resource = ensureReferenceJson({ ...existingAardvark, id: resourceId }, artifacts);

  let aiEnrichments;
  let extraction = {};
  let createdAiEnrichments = false;
  if (await objectExists(storageProfile, keys.aiEnrichments).catch(() => false)) {
    log("Fetching existing AI Enrichments JSON", { aiEnrichments: keys.aiEnrichments });
    aiEnrichments = await fetchJsonObject(storageProfile, keys.aiEnrichments);
  } else {
    createdAiEnrichments = true;
    log("AI Enrichments JSON missing; rebuilding from legacy extraction response", { extraction: keys.extraction });
    extraction = await fetchJsonObject(storageProfile, keys.extraction);
    const extractionProvider = extractionProviderFromLegacyResponse(extraction);
    const archivalSupplement = await objectExists(storageProfile, keys.archivalSupplementJson).catch(() => false)
      ? await fetchJsonObject(storageProfile, keys.archivalSupplementJson)
      : null;
    aiEnrichments = buildAiEnrichmentsForImage({
      resourceId,
      fileName,
      checksum: checksumFromResource(resource),
      fileSize: Number(resource.gbl_fileSize_s || requested.sizeBytes || 0),
      contentType: contentTypeForKey(fileName),
      modifiedAt: requested.updatedAt || requested.lastModified || "",
      artifacts,
      extractionResult: {
        provider: extractionProvider,
        parsedResponse: extraction,
        rawResponse: null,
        usage: extractionProvider === "google_cloud_vision"
          ? { provider: "google_cloud_vision", rawResponseNotAvailable: true }
          : { provider: "openai", rawResponseNotAvailable: true },
      },
      metadataWriter: null,
      resource,
      archivalSupplement,
      metadataSourceUrls: Array.isArray(requested.metadataSourceUrls) ? requested.metadataSourceUrls : [],
      derivativeSummaries: [],
    });
  }

  const distributions = distributionsWithAiEnrichments(resource, artifacts.aiEnrichmentsUrl);
  const refreshed = refreshWofConcordanceInAiEnrichments(aiEnrichments, {
    resource,
    distributions,
    extraction,
  });
  log("Uploading persisted WOF concordance AI Enrichments JSON", {
    key: keys.aiEnrichments,
    matched: refreshed.wofConcordance?.matched || 0,
    supplemental: refreshed.wofConcordance?.supplementalPlacenames || 0,
    osmMatched: refreshed.osmConcordance?.matched || 0,
    osmSupplemental: refreshed.osmConcordance?.supplementalPlacenames || 0,
    geonamesMatched: refreshed.geonamesConcordance?.matched || 0,
    geonamesOverlap: refreshed.geonamesConcordance?.overlapPlacenames || 0,
    removedSupplemental: refreshed.removedSupplementalPlacenameCount,
  });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(refreshed.aiEnrichments, 2), "utf8"), "application/json");

  if (resource.dct_references_s !== existingAardvark.dct_references_s) {
    log("Uploading Aardvark JSON with AI Enrichments reference", { key: keys.aardvark });
    await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  }
  log("WOF concordance refresh complete", { resourceId, createdAiEnrichments });

  return {
    resourceId,
    fileName,
    root,
    artifacts,
    aiEnrichmentsUrl: artifacts.aiEnrichmentsUrl,
    createdAiEnrichments,
    wofConcordance: refreshed.wofConcordance,
    osmConcordance: refreshed.osmConcordance,
    geonamesConcordance: refreshed.geonamesConcordance,
    removedSupplementalPlacenameCount: refreshed.removedSupplementalPlacenameCount,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
    proxyMilestones: milestones,
  };
}

async function fetchAardvarkForS3Resource(config, body) {
  const requested = body.resource || {};
  const root = String(requested.root || "").replace(/\/+$/g, "");
  if (!root) throw new Error("Aardvark refresh request is missing the S3 resource root.");

  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const fileName = sanitizeFileName(requested.fileName || requested.resourceId || root.split("/").pop() || "resource");
  let keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  const aardvarkJson = await fetchJsonObject(storageProfile, keys.aardvark);
  const resourceId = String(aardvarkJson.id || requested.resourceId || root.split("/").pop() || "");
  const isGeospatial = isLikelyGeospatialResource(fileName, aardvarkJson);
  if (isGeospatial) {
    keys = {
      ...geospatialUploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
      ...(requested.keys || {}),
    };
    keys.root = root;
    keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;
  }

  const hasThumbnail = requested.hasThumbnail === true || await objectExists(storageProfile, keys.thumbnail).catch(() => false);
  const hasIiif = requested.hasIiif === true || await objectExists(storageProfile, `${keys.iiif}/info.json`).catch(() => false);
  const hasAiEnrichments = requested.hasAiEnrichments === true || await objectExists(storageProfile, keys.aiEnrichments).catch(() => false);
  const hasArchivalSupplement = requested.hasArchivalSupplement === true || await objectExists(storageProfile, keys.archivalSupplement).catch(() => false);
  const hasArchivalSupplementJson = await objectExists(storageProfile, keys.archivalSupplementJson).catch(() => false);
  const hasExtraction = requested.hasExtraction === true || await objectExists(storageProfile, keys.extraction).catch(() => false);
  const hasCog = isGeospatial && await objectExists(storageProfile, keys.cog).catch(() => false);
  const hasManifest = isGeospatial && await objectExists(storageProfile, keys.manifest).catch(() => false);
  const hasGeojson = isGeospatial && await objectExists(storageProfile, keys.geojson).catch(() => false);
  const hasGeoParquet = isGeospatial && await objectExists(storageProfile, keys.geoParquet).catch(() => false);
  const hasPmtiles = isGeospatial && await objectExists(storageProfile, keys.pmtiles).catch(() => false);

  const fallbackArtifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
    ...(hasThumbnail ? { thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail) } : {}),
    ...(hasIiif ? { iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json` } : {}),
    ...(hasExtraction ? { extractionUrl: accessUrlFor(storageProfile, keys.extraction) } : {}),
    ...(hasAiEnrichments ? { aiEnrichmentsUrl: accessUrlFor(storageProfile, keys.aiEnrichments) } : {}),
    ...(hasArchivalSupplement ? { archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement) } : {}),
    ...(hasArchivalSupplementJson ? { archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson) } : {}),
    ...(hasManifest ? { manifestUrl: accessUrlFor(storageProfile, keys.manifest) } : {}),
    ...(hasGeojson ? { geojsonUrl: accessUrlFor(storageProfile, keys.geojson) } : {}),
    ...(hasGeoParquet ? { geoParquetUrl: accessUrlFor(storageProfile, keys.geoParquet) } : {}),
    ...(hasPmtiles ? { pmtilesUrl: accessUrlFor(storageProfile, keys.pmtiles) } : {}),
    ...(hasCog ? { cogUrl: accessUrlFor(storageProfile, keys.cog) } : {}),
  };

  const artifacts = isGeospatial
    ? geospatialArtifactUrlsForResource(storageProfile, keys, aardvarkJson, fallbackArtifacts)
    : artifactUrlsForResource(storageProfile, keys, aardvarkJson);
  if (!hasThumbnail) delete artifacts.thumbnailUrl;
  if (!hasIiif) delete artifacts.iiifInfoUrl;
  if (!hasExtraction) delete artifacts.extractionUrl;
  if (!hasAiEnrichments) {
    delete artifacts.aiEnrichmentsUrl;
  }
  if (!hasArchivalSupplement) delete artifacts.archivalSupplementUrl;
  if (!hasArchivalSupplementJson) delete artifacts.archivalSupplementJsonUrl;

  let resource = { ...aardvarkJson, id: resourceId };
  if (!resourceHasGeometry(resource) && hasManifest) {
    const manifest = await fetchJsonObject(storageProfile, keys.manifest).catch(() => null);
    resource = applyManifestGeometry(resource, manifest);
  }
  if (!resourceHasGeometry(resource) && hasExtraction) {
    const extraction = await fetchJsonObject(storageProfile, keys.extraction).catch(() => null);
    resource = applyExtractionGeometry(resource, extraction);
  }
  resource = ensureReferenceJson(resource, artifacts);

  return {
    resourceId,
    fileName,
    root,
    artifacts,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
  };
}

function mockExtraction() {
  return {
    text: [],
    placenames: [],
    map_bbox_estimate: {
      west: 0,
      south: 0,
      east: 0,
      north: 0,
      confidence: 0,
      method: "mock",
      reasoning: "Mock response generated because ENRICHMENT_PROXY_MOCK_OPENAI is enabled.",
    },
    description: "Mock historical map extraction response.",
    debug: {
      ocr_strategy: "mock",
      placename_extraction_strategy: "mock",
      bbox_inference_strategy: "mock",
      limitations: "No model call was made.",
    },
  };
}

function extractResponseText(openaiResponse) {
  if (typeof openaiResponse.output_text === "string") return openaiResponse.output_text;
  const parts = [];
  for (const item of openaiResponse.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function normalizeOpenAIModelParams(model, params = {}) {
  const next = { ...(params || {}) };
  // GPT-5 family models reject legacy sampling controls such as temperature.
  if (/^gpt-5/i.test(String(model || ""))) {
    delete next.temperature;
  }
  return next;
}

function unsupportedParameterName(message) {
  const match = String(message || "").match(/Unsupported parameter: '([^']+)'/i);
  return match?.[1] || "";
}

async function postOpenAIResponse(apiKey, body) {
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: safeJsonStringify(currentBody),
    });
    const rawResponse = await response.json().catch(() => ({}));
    if (response.ok) return { rawResponse, requestBody: currentBody };

    const message = rawResponse?.error?.message || `OpenAI request failed: ${response.status}`;
    const unsupported = unsupportedParameterName(message);
    if (unsupported && Object.prototype.hasOwnProperty.call(currentBody, unsupported)) {
      const { [unsupported]: _removed, ...withoutUnsupported } = currentBody;
      currentBody = withoutUnsupported;
      console.warn(`[OpenAI] Retrying without unsupported parameter '${unsupported}'.`);
      continue;
    }
    throw new Error(message);
  }
  throw new Error("OpenAI request failed after removing unsupported parameters.");
}

function hasUsableExtractionSchema(schema) {
  return Boolean(schema && typeof schema === "object" && !Array.isArray(schema) && Object.keys(schema).length > 0);
}

function shouldAugmentOcrWithOpenAIVision(modelProfile, request) {
  return Boolean(
    OPENAI_VISION_AUGMENT_OCR_ENABLED &&
    modelProfile &&
    request?.augmentOcrWithOpenAIVision !== false &&
    request?.openaiVisionAugmentation !== false &&
    hasUsableExtractionSchema(request?.outputSchema),
  );
}

const OPENAI_VISION_AUGMENTATION_SYSTEM_PROMPT = [
  "You are a historical-map vision extraction specialist.",
  "Inspect the map image derivatives directly and return strict JSON matching the provided schema.",
  "Analyze each supplied OCR source image, including individual tiles, as visual evidence paired with the Google Cloud Vision OCR fragments for that source image.",
  "Use OCR evidence as fragments, not final truth. Correct OCR misreadings, merge split labels, ignore numeric or contour/street clutter when it is not part of the label, and add visible text that OCR missed.",
  "Read the map first. Return correct printed map-text labels and groupings even when they are unlikely to appear in a modern gazetteer; gazetteer matching is a later annotation step.",
  "Prioritize curved, rotated, faint, stylized, hydrographic, park, landmark, title, date, publisher, legend, and coordinate labels.",
  "Do not invent text that is not visually supported. Mark uncertain readings with lower confidence and explain the visual evidence in reasoning fields.",
].join(" ");

function openAIVisionAugmentationUserPrompt(request, compactOcr) {
  const originalPrompt = String(request?.userPrompt || "").trim();
  return [
    "Google Cloud Vision OCR has already processed this map. Now inspect the supplied OCR source images as images, not as OCR text, and produce an augmented historical-map extraction.",
    "The image inputs are listed in existing OCR evidence JSON under source_images. Analyze every listed full image and tile. Preserve labels visible in only one tile, and reconcile duplicate tile/full-image readings.",
    "Prefer exact spellings as printed on the map. Include approximate normalized 0-1 full-image boxes when the text is visible. When OCR and image evidence disagree, trust the image and explain the correction.",
    "Do not filter labels because they seem modern-gazetteer-unmatchable. The goal of this pass is faithful map reading and label grouping; authority matching happens after this response.",
    "When two or more OCR fragments form one label, return the consolidated label and preserve the original OCR source_text_index values in source_text_indices when the schema allows it. For example, a specific-name fragment near a feature suffix may become a park, lake, bay, cemetery, or other feature label while nearby numbers are ignored.",
    originalPrompt ? `Original extraction task:\n${originalPrompt}` : "",
    `Existing OCR evidence JSON:\n${safeJsonStringify(compactOcr, 2)}`,
  ].filter(Boolean).join("\n\n");
}

function openAIVisionAugmentationRequest(request, compactOcr) {
  return {
    ...request,
    model: request?.visionAugmentationModel || request?.model,
    systemPrompt: OPENAI_VISION_AUGMENTATION_SYSTEM_PROMPT,
    userPrompt: openAIVisionAugmentationUserPrompt(request, compactOcr),
    outputSchema: request?.outputSchema,
  };
}

async function callOpenAIVisionTextAugmentation(modelProfile, request, derivatives, ocrExtraction) {
  const compactOcr = compactExtractionForVisionAugmentation(ocrExtraction, { imageInputs: derivatives });
  const augmentationRequest = openAIVisionAugmentationRequest(request, compactOcr);
  const result = await callOpenAI(modelProfile, augmentationRequest, derivatives);
  return {
    ...result,
    provider: "openai",
    purpose: "vision_text_augmentation",
    compactOcrContext: compactOcr,
  };
}

function confidenceFromText(extraction) {
  const confidences = (Array.isArray(extraction?.text) ? extraction.text : [])
    .map((entry) => Number(entry?.confidence))
    .filter((value) => Number.isFinite(value));
  return confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : null;
}

function mergeGoogleVisionWithOpenAIAugmentation(ocrResult, visionAugmentation) {
  const parsedResponse = mergeVisionAugmentedExtraction({
    ocrExtraction: ocrResult?.parsedResponse,
    visionExtraction: visionAugmentation?.parsedResponse,
    ocrCallId: GOOGLE_VISION_OCR_CALL_ID,
    visionCallId: OPENAI_VISION_AUGMENTATION_CALL_ID,
  });
  return {
    parsedResponse,
    rawResponse: {
      google_cloud_vision: ocrResult?.rawResponse,
      openai_vision_augmentation: visionAugmentation?.rawResponse,
    },
    requestBody: {
      google_cloud_vision: ocrResult?.requestBody,
      openai_vision_augmentation: visionAugmentation?.requestBody,
    },
    provider: HYBRID_VISION_OCR_PROVIDER,
    usage: {
      provider: HYBRID_VISION_OCR_PROVIDER,
      google_cloud_vision: ocrResult?.usage,
      openai_vision_augmentation: visionAugmentation?.usage,
    },
    confidence: confidenceFromText(parsedResponse) ?? ocrResult?.confidence ?? visionAugmentation?.confidence ?? null,
    ocrResult,
    visionAugmentation,
  };
}

async function maybeAugmentGoogleVisionOcrResult({ modelProfile, request, derivatives, ocrResult, log = () => undefined }) {
  if (!shouldAugmentOcrWithOpenAIVision(modelProfile, request)) return ocrResult;
  try {
    log("OpenAI vision augmentation request started", { model: request?.visionAugmentationModel || request?.model || modelProfile.defaultModel, derivatives: derivatives.length });
    const visionAugmentation = await callOpenAIVisionTextAugmentation(modelProfile, request, derivatives, ocrResult.parsedResponse);
    const hybrid = mergeGoogleVisionWithOpenAIAugmentation(ocrResult, visionAugmentation);
    log("OpenAI vision augmentation response received", {
      addedTextSegments: hybrid.parsedResponse?.text_grouping_summary?.vision_augmented_text_count || 0,
      addedTextGroups: hybrid.parsedResponse?.text_grouping_summary?.vision_augmented_text_group_count || 0,
      addedPlacenames: hybrid.parsedResponse?.text_grouping_summary?.vision_augmented_placename_count || 0,
    });
    return hybrid;
  } catch (error) {
    const message = error.message || String(error);
    log("OpenAI vision augmentation failed; preserving Google Vision OCR", { error: message });
    return {
      ...ocrResult,
      parsedResponse: {
        ...(ocrResult?.parsedResponse || {}),
        debug: {
          ...(ocrResult?.parsedResponse?.debug || {}),
          vision_augmentation_error: message,
        },
      },
    };
  }
}

function shouldExtractLabelsWithGemini(modelProfile, request) {
  return Boolean(
    modelProfile
    && String(modelProfile.provider || "").toLowerCase() === "gemini"
    && request?.geminiTextExtraction !== false
    && request?.textExtractionModelProfileId,
  );
}

function shouldReconcileLabelsWithOpenAI(modelProfile, request) {
  return Boolean(
    modelProfile
    && String(modelProfile.provider || "openai").toLowerCase() === "openai"
    && request?.openaiTextReconciliation !== false
    && request?.textExtractionModelProfileId,
  );
}

function shouldRunKimiAgentSwarm(modelProfile, request) {
  return Boolean(
    modelProfile
    && String(modelProfile.provider || "").toLowerCase() === "kimi"
    && request?.kimiAgentSwarm !== false
    && request?.textExtractionModelProfileId,
  );
}

function shouldRunTextReconciliation(modelProfile, request) {
  return shouldExtractLabelsWithGemini(modelProfile, request)
    || shouldReconcileLabelsWithOpenAI(modelProfile, request)
    || shouldRunKimiAgentSwarm(modelProfile, request);
}

function resolveGeminiApiKey(modelProfile) {
  const primary = resolveOptionalEnv(modelProfile?.apiKeyEnv, "Gemini API key");
  if (primary) return primary;
  for (const fallbackName of ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"]) {
    if (fallbackName === modelProfile?.apiKeyEnv) continue;
    const fallback = resolveOptionalEnv(fallbackName, "Gemini API key");
    if (fallback) return fallback;
  }
  return resolveEnv(modelProfile?.apiKeyEnv || "GEMINI_API_KEY", "Gemini API key");
}

function resolveKimiApiKey(modelProfile) {
  const primary = resolveOptionalEnv(modelProfile?.apiKeyEnv, "Kimi API key");
  if (primary) return primary;
  for (const fallbackName of ["MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_OPEN_PLATFORM_API_KEY"]) {
    if (fallbackName === modelProfile?.apiKeyEnv) continue;
    const fallback = resolveOptionalEnv(fallbackName, "Kimi API key");
    if (fallback) return fallback;
  }
  return resolveEnv(modelProfile?.apiKeyEnv || "MOONSHOT_API_KEY", "Kimi API key");
}

function textReconciliationProviderLabel(modelProfile) {
  const provider = String(modelProfile?.provider || "openai").toLowerCase();
  if (provider === "gemini") return "Gemini";
  if (provider === "kimi") return "Kimi";
  return "OpenAI";
}

async function maybeAugmentGoogleVisionOcrWithGemini({ modelProfile, request, derivatives, ocrResult, log = () => undefined }) {
  if (!shouldExtractLabelsWithGemini(modelProfile, request)) return ocrResult;
  try {
    log("Gemini map-label extraction request started", { model: request?.geminiModel || request?.textExtractionModel || modelProfile.defaultModel, derivatives: derivatives.length });
    const apiKey = resolveGeminiApiKey(modelProfile);
    const geminiExtraction = await callGeminiMapLabelExtraction({
      modelProfile,
      request,
      derivatives,
      ocrExtraction: ocrResult?.parsedResponse,
      apiKey,
      log,
    });
    const hybrid = mergeGoogleVisionWithGeminiExtraction({ ocrResult, geminiExtraction });
    log("Gemini map-label extraction response received", {
      labels: geminiExtraction.parsedResponse?.labels?.length || 0,
      addedTextSegments: hybrid.parsedResponse?.text_grouping_summary?.gemini_added_text_count || 0,
      filteredOvermergedGroups: hybrid.parsedResponse?.text_grouping_summary?.gemini_filtered_overmerged_group_count || 0,
    });
    return hybrid;
  } catch (error) {
    const message = error.message || String(error);
    log("Gemini map-label extraction failed; preserving Google Vision OCR", { error: message });
    return {
      ...ocrResult,
      parsedResponse: {
        ...(ocrResult?.parsedResponse || {}),
        debug: {
          ...(ocrResult?.parsedResponse?.debug || {}),
          gemini_label_extraction_error: message,
        },
      },
    };
  }
}

async function maybeReconcileGoogleVisionOcrWithOpenAI({ modelProfile, request, derivatives, ocrResult, log = () => undefined }) {
  if (!shouldReconcileLabelsWithOpenAI(modelProfile, request)) return ocrResult;
  try {
    log("OpenAI map-label reconciliation request started", { model: request?.openaiTextReconciliationModel || request?.textExtractionModel || modelProfile.defaultModel, derivatives: derivatives.length });
    const apiKey = resolveEnv(modelProfile?.apiKeyEnv || "OPENAI_API_KEY", "OpenAI API key");
    const openAIReconciliation = await callOpenAIMapLabelReconciliation({
      modelProfile,
      request,
      derivatives,
      ocrExtraction: ocrResult?.parsedResponse,
      apiKey,
      log,
    });
    const hybrid = mergeGoogleVisionWithOpenAIReconciliation({ ocrResult, openAIReconciliation });
    log("OpenAI map-label reconciliation response received", {
      labels: openAIReconciliation.parsedResponse?.labels?.length || 0,
      addedTextSegments: hybrid.parsedResponse?.text_grouping_summary?.openai_reconciled_added_text_count || 0,
      filteredOvermergedGroups: hybrid.parsedResponse?.text_grouping_summary?.openai_reconciled_filtered_overmerged_group_count || 0,
    });
    return hybrid;
  } catch (error) {
    const message = error.message || String(error);
    log("OpenAI map-label reconciliation failed; preserving Google Vision OCR", { error: message });
    return {
      ...ocrResult,
      parsedResponse: {
        ...(ocrResult?.parsedResponse || {}),
        debug: {
          ...(ocrResult?.parsedResponse?.debug || {}),
          openai_label_reconciliation_error: message,
        },
      },
    };
  }
}

async function maybeAugmentGoogleVisionOcrWithKimi({ modelProfile, request, derivatives, ocrResult, log = () => undefined }) {
  if (!shouldRunKimiAgentSwarm(modelProfile, request)) return ocrResult;
  try {
    log("Kimi map-agent swarm request started", { model: request?.kimiAgentSwarmModel || request?.textExtractionModel || modelProfile.defaultModel, derivatives: derivatives.length });
    const apiKey = resolveKimiApiKey(modelProfile);
    const kimiSwarm = await callKimiMapAgentSwarm({
      modelProfile,
      request,
      derivatives,
      ocrExtraction: ocrResult?.parsedResponse,
      apiKey,
      log,
    });
    const hybrid = mergeGoogleVisionWithKimiAgentSwarm({ ocrResult, kimiSwarm });
    log("Kimi map-agent swarm response received", {
      labels: kimiSwarm.parsedResponse?.labels?.length || 0,
      claims: kimiSwarm.parsedResponse?.claims?.length || 0,
      agents: kimiSwarm.parsedResponse?.agents?.length || 0,
      addedTextSegments: hybrid.parsedResponse?.text_grouping_summary?.kimi_swarm_added_text_count || 0,
      responseCacheHitCount: kimiSwarm.parsedResponse?.extractionStatus?.responseCacheHitCount || 0,
      cachedTokens: kimiSwarm.usage?.cached_tokens,
    });
    return hybrid;
  } catch (error) {
    const message = error.message || String(error);
    log("Kimi map-agent swarm failed; preserving Google Vision OCR", { error: message });
    return {
      ...ocrResult,
      parsedResponse: {
        ...(ocrResult?.parsedResponse || {}),
        debug: {
          ...(ocrResult?.parsedResponse?.debug || {}),
          kimi_agent_swarm_error: message,
        },
      },
    };
  }
}

async function maybeAugmentGoogleVisionOcrWithTextReconciliation(args) {
  if (shouldExtractLabelsWithGemini(args.modelProfile, args.request)) {
    return maybeAugmentGoogleVisionOcrWithGemini(args);
  }
  if (shouldReconcileLabelsWithOpenAI(args.modelProfile, args.request)) {
    return maybeReconcileGoogleVisionOcrWithOpenAI(args);
  }
  if (shouldRunKimiAgentSwarm(args.modelProfile, args.request)) {
    return maybeAugmentGoogleVisionOcrWithKimi(args);
  }
  return args.ocrResult;
}

async function callOpenAI(modelProfile, request, derivatives) {
  if (String(modelProfile?.provider || "openai").toLowerCase() !== "openai") {
    throw new Error(`OpenAI request requires an OpenAI model profile; '${modelProfile?.name || modelProfile?.id || "selected profile"}' is configured for ${modelProfile?.provider || "unknown"}.`);
  }
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    const parsedResponse = mockExtraction();
    const model = request.model || modelProfile.defaultModel;
    return {
      parsedResponse,
      rawResponse: parsedResponse,
      requestBody: { mock: true },
      provider: "openai",
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      model,
      usage: { mock: true },
      confidence: 0,
    };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const input = [
    { role: "system", content: [{ type: "input_text", text: request.systemPrompt }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: request.userPrompt },
        ...derivatives.filter((d) => d.dataUri).map((d) => ({
          type: "input_image",
          image_url: d.dataUri,
          detail: "high",
        })),
      ],
    },
  ];
  const body = {
    model,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "historical_map_extraction",
        schema: request.outputSchema,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsedResponse = text ? JSON.parse(text) : rawResponse;
  return {
    parsedResponse,
    rawResponse,
    requestBody,
    provider: "openai",
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    model,
    usage: rawResponse.usage,
    confidence: parsedResponse?.map_bbox_estimate?.confidence ?? null,
  };
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const config = await loadConfig();

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/artifacts/proxy") {
    return proxyArtifactObject(config, req, res, url.searchParams.get("url"));
  }
  if (req.method === "POST" && url.pathname === "/api/artifacts/upload") {
    const body = await readJson(req);
    return send(res, 200, await uploadArtifactObject(config, body));
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/cog-info") {
    return inspectCogArtifact(config, res, url.searchParams.get("url"));
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/cog-preview") {
    return previewCogArtifact(config, res, url.searchParams.get("url"), url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/pmtiles-preview") {
    return previewPmtilesArtifact(config, res, url.searchParams.get("url"), url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/raster-preview") {
    return previewRasterArtifact(config, res, url.searchParams.get("url"), url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/vector-geojson") {
    return proxyVectorGeoJsonArtifact(config, res, url.searchParams.get("url"));
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/vector-preview") {
    return previewVectorPackageArtifact(config, res, url.searchParams.get("url"), url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, config);
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    return send(res, 200, await saveConfig(await readJson(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-storage") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.profileId);
    const { assets } = await listObjects({ ...profile, prefixes: [profile.prefixes?.[0] || ""] });
    return send(res, 200, { ok: true, message: `Connected. Read ${assets.length} object(s) from the first prefix.` });
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-model") {
    const body = await readJson(req);
    const profile = findProfile(config, "model", body.profileId);
    const provider = String(profile.provider || "openai").toLowerCase();
    if (provider === "gemini") resolveGeminiApiKey(profile);
    else if (provider === "kimi") resolveKimiApiKey(profile);
    else resolveEnv(profile.apiKeyEnv, "OpenAI API key");
    const label = provider === "gemini" ? "Gemini" : provider === "kimi" ? "Kimi" : "OpenAI";
    return send(res, 200, { ok: true, message: `${label} profile '${profile.name}' can resolve ${provider === "kimi" ? "Kimi API credentials" : provider === "gemini" ? "Gemini API credentials" : profile.apiKeyEnv}.` });
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-vision") {
    const body = await readJson(req);
    const profile = findProfile(config, "vision", body.profileId);
    await callGoogleVisionOcr(profile, { buffer: VISION_TEST_IMAGE, mimeType: "image/png", width: 1, height: 1 });
    return send(res, 200, { ok: true, message: `Google Cloud Vision profile '${profile.name}' connected using ${profile.apiKeyEnv}.` });
  }
  if (req.method === "POST" && url.pathname === "/api/storage/sync") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.profileId);
    const result = await listObjects(profile);
    return send(res, 200, { ...result, message: `Synced ${result.assets.length} object(s).` });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/processed-resources") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.storageProfileId);
    const resources = await listProcessedUploadResources(profile, { includeIncomplete: Boolean(body.includeIncomplete) });
    const label = body.includeIncomplete ? "upload folder" : "processed resource";
    return send(res, 200, { resources, count: resources.length, message: `Found ${resources.length} ${label}(s).` });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/regenerate-aardvark") {
    const body = await readJson(req);
    const result = await regenerateAardvarkForS3Resource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/refresh-s3-ocr") {
    const body = await readJson(req);
    const result = await refreshOcrForS3ImageResource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/refresh-wof-concordance") {
    const body = await readJson(req);
    const result = await refreshWofConcordanceForS3Resource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/aardvark-json") {
    const body = await readJson(req);
    const result = await fetchAardvarkForS3Resource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/enrich/historical-map") {
    const body = await readJson(req);
    const storageProfile = findProfile(config, "storage", body.storageProfileId);
    const modelProfile = findProfile(config, "model", body.modelProfileId);
    const visionProfile = body.visionProfileId ? findProfile(config, "vision", body.visionProfileId) : null;
    const textExtractionModelProfile = body.textExtractionModelProfileId ? findProfile(config, "model", body.textExtractionModelProfileId) : null;
    const objectKey = body.asset?.object_key || body.asset?.id || "selected asset";
    if (visionProfile) {
      let buffer;
      try {
        buffer = await fetchObjectBuffer(storageProfile, body.asset.object_key);
      } catch (error) {
        throw new Error(`Source image fetch failed for ${objectKey}: ${error.message || String(error)}`);
      }
      try {
        const sources = await createVisionOcrSources(buffer, body.asset?.content_type || contentTypeForKey(objectKey));
        const vision = await callGoogleVisionOcr(visionProfile, sources);
        if (shouldRunTextReconciliation(textExtractionModelProfile, body)) {
          const derivatives = await createTextReconciliationDerivativesForProfile(textExtractionModelProfile, {
            buffer,
            contentType: body.asset?.content_type || contentTypeForKey(objectKey),
            assetId: `${storageProfile.id}:${storageProfile.bucket}/${body.asset.object_key}`,
            visionSources: sources,
            ocrExtraction: vision.parsedResponse,
            request: body,
          });
          const augmented = await maybeAugmentGoogleVisionOcrWithTextReconciliation({
            modelProfile: textExtractionModelProfile,
            request: body,
            derivatives,
            ocrResult: vision,
          });
          return send(res, 200, { ...augmented, derivatives });
        }
        if (!shouldAugmentOcrWithOpenAIVision(modelProfile, body)) {
          return send(res, 200, { ...vision, derivatives: [] });
        }
        const derivatives = await createVisionAugmentationDerivatives({
          buffer,
          contentType: body.asset?.content_type || contentTypeForKey(objectKey),
          assetId: `${storageProfile.id}:${storageProfile.bucket}/${body.asset.object_key}:vision-augmentation`,
          visionSources: sources,
        });
        const augmented = await maybeAugmentGoogleVisionOcrResult({
          modelProfile,
          request: body,
          derivatives,
          ocrResult: vision,
        });
        return send(res, 200, { ...augmented, derivatives });
      } catch (error) {
        throw new Error(`Google Cloud Vision/Gemini/OpenAI/Kimi vision extraction failed for ${objectKey}: ${error.message || String(error)}`);
      }
    }
    let derivatives;
    try {
      derivatives = await createDerivatives(storageProfile, body.asset);
    } catch (error) {
      throw new Error(`Derivative generation failed for ${objectKey}: ${error.message || String(error)}`);
    }
    let openai;
    try {
      openai = await callOpenAI(modelProfile, body, derivatives);
    } catch (error) {
      throw new Error(`OpenAI extraction failed for ${objectKey}: ${error.message || String(error)}`);
    }
    return send(res, 200, { ...openai, derivatives });
  }
  const uploadProgressMatch = url.pathname.match(/^\/api\/uploads\/jobs\/([^/]+)\/progress$/);
  if (req.method === "GET" && uploadProgressMatch) {
    const jobId = decodeURIComponent(uploadProgressMatch[1]);
    const snapshot = uploadJobSnapshot(jobId);
    if (!snapshot) return send(res, 404, { error: `Upload job not found: ${jobId}` });
    return send(res, 200, snapshot);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/process-image") {
    const body = await readJson(req);
    try {
      const result = await processUploadedImage(config, body);
      finishUploadJob(body.jobId, "complete", { resourceId: result.resourceId });
      return send(res, 200, result);
    } catch (error) {
      finishUploadJob(body.jobId, "error", { error: error.message || String(error) });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/process-geospatial-package") {
    const body = await readJson(req);
    try {
      const result = await processGeospatialPackage(config, body);
      finishUploadJob(body.jobId, "complete", { resourceId: result.resourceId });
      return send(res, 200, result);
    } catch (error) {
      finishUploadJob(body.jobId, "error", { error: error.message || String(error) });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/geospatial-sessions") {
    const body = await readJson(req);
    const result = await createGeospatialUploadSession(config, body);
    return send(res, 200, result);
  }
  if (req.method === "PUT" && /^\/api\/uploads\/geospatial-sessions\/[^/]+\/files$/.test(url.pathname)) {
    const result = await uploadGeospatialSessionFile(req, url);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/geospatial-sessions/complete") {
    const body = await readJson(req);
    try {
      const result = await completeGeospatialUploadSession(config, body);
      finishUploadJob(body.jobId, "complete", { resourceId: result.resourceId });
      return send(res, 200, result);
    } catch (error) {
      finishUploadJob(body.jobId, "error", { error: error.message || String(error) });
      throw error;
    }
  }

  return send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    const status = Number(error?.status || 500);
    send(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, { error: error.message || String(error) });
  });
});

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Enrichment proxy listening on http://localhost:${PORT}`);
    console.log(`Config: ${CONFIG_PATH}`);
  });
}

export {
  bboxFields,
  bboxToAardvarkCentroid,
  bboxToAardvarkEnvelope,
  bboxToAardvarkPolygonWkt,
  buildAardvarkForGeospatialPackage,
  buildAardvarkForUpload,
  consolidateOcrTextEntries,
  cogPreviewRenderOptions,
  deriveMapLabelPlacenames,
  effectiveBatchDefaults,
  generatedAardvarkResourceId,
  normalizeAardvarkFormat,
  normalizeAardvarkResource,
  rasterThumbnailOutsizeArgs,
  selectTextReconciliationTiles,
  shouldPromoteRasterPackageToImageUpload,
};
