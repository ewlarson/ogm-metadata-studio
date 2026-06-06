import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Distribution, Resource } from '../aardvark/model';
import { queryResourceById, querySimilarResources, getSearchNeighbors, FacetedSearchRequest, queryDistributionsForResource } from '../duckdb/duckdbClient';
import { waitForDuckDbRestore } from '../duckdb/dbInit';
import { ResourceViewer } from './ResourceViewer';
import { SimilarResourcesCarousel } from './resource/SimilarResourcesCarousel';
import { ResourceSidebar } from './resource/ResourceSidebar';
import { ResourceMetadata } from './resource/ResourceMetadata';
import { ResourceHeader } from './resource/ResourceHeader';
import { distributionsFromReferences } from './resource/distributionLinks';
import { detectViewerConfig } from './resource/viewerConfig';

import { databaseService } from '../services/DatabaseService';
import { useToast } from './shared/ToastContext';
import { withBasePath } from '../utils/basePath';
import { recoverProcessedS3ResourceToLocalCatalog } from '../services/processedResourceRecovery';

function referencesFromResource(resource: Resource): Record<string, unknown> {
    if (!resource.dct_references_s) return {};
    try {
        const parsed = JSON.parse(resource.dct_references_s);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function referenceUrl(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return String(record.url || record["@id"] || record.id || "");
    }
    return "";
}

function resourceReferencesProcessedS3Upload(resource: Resource, refs: Record<string, unknown>): boolean {
    const uploadNeedle = `/uploads/${resource.id}/`;
    return Object.values(refs).some((value) => {
        const values = Array.isArray(value) ? value : [value];
        return values.some((item) => referenceUrl(item).includes(uploadNeedle));
    });
}

function shouldRefreshStaleProcessedRaster(resource: Resource): boolean {
    if (!resource.id) return false;
    const refs = referencesFromResource(resource);
    const schemaUrl = referenceUrl(refs["http://schema.org/url"]);
    const hasImageArtifacts = Boolean(
        refs["http://iiif.io/api/image"] ||
        refs["https://opengeometadata.org/reference/enrichment-response"]
    );
    const hasProcessedUpload = resourceReferencesProcessedS3Upload(resource, refs);
    if (hasImageArtifacts) {
        return hasProcessedUpload &&
            (resource.gbl_resourceClass_sm || []).map(String).includes("Maps") &&
            /\.zip(?:$|[?#])/i.test(schemaUrl);
    }
    if (!hasProcessedUpload) return false;

    const classes = (resource.gbl_resourceClass_sm || []).map(String);
    const types = (resource.gbl_resourceType_sm || []).map(String);
    const notes = (resource.gbl_displayNote_sm || []).map(String).join(" ").toLowerCase();
    return classes.includes("Datasets") &&
        types.includes("Raster data") &&
        String(resource.dct_format_s || "").toLowerCase() === "geotiff" &&
        notes.includes("georeferencing");
}

interface ResourceShowProps {
    id: string;
    onBack: () => void;
}
export const ResourceShow: React.FC<ResourceShowProps> = ({ id, onBack }) => {
    const [resource, setResource] = useState<Resource | null>(null);
    const [distributions, setDistributions] = useState<Distribution[]>([]);
    const [similarResources, setSimilarResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
    const [pagination, setPagination] = useState<{ prevId?: string, nextId?: string, position: number, total: number }>({ position: 0, total: 0 });
    const { addToast } = useToast();
    const addToastRef = useRef(addToast);

    useEffect(() => {
        addToastRef.current = addToast;
    }, [addToast]);

    useEffect(() => {
        const controller = new AbortController();
        let canceled = false;
        const load = async () => {
            setLoading(true);
            setRecoveryMessage(null);
            try {
                let r = await queryResourceById(id);
                if (!r) {
                    await waitForDuckDbRestore();
                    r = await queryResourceById(id);
                }
                if (r && shouldRefreshStaleProcessedRaster(r)) {
                    setRecoveryMessage("Checking for an updated processed copy in S3...");
                    try {
                        const recovered = await recoverProcessedS3ResourceToLocalCatalog(id, { signal: controller.signal });
                        if (canceled) return;
                        if (recovered) {
                            r = recovered.resource;
                            addToastRef.current(`Refreshed ${r.dct_title_s || r.id} from processed S3 artifacts.`, "success");
                        }
                    } catch (error) {
                        if (!controller.signal.aborted) {
                            console.info("Processed S3 refresh did not update this resource", error);
                        }
                    } finally {
                        if (!canceled) setRecoveryMessage(null);
                    }
                }
                if (!r) {
                    setRecoveryMessage("Looking for a saved processed copy in S3...");
                    try {
                        const recovered = await recoverProcessedS3ResourceToLocalCatalog(id, { signal: controller.signal });
                        if (canceled) return;
                        if (recovered) {
                            r = recovered.resource;
                            addToastRef.current(`Restored ${r.dct_title_s || r.id} from processed S3 artifacts.`, "success");
                        }
                    } catch (error) {
                        if (!controller.signal.aborted) {
                            console.info("Processed S3 recovery did not restore this resource", error);
                        }
                    } finally {
                        if (!canceled) setRecoveryMessage(null);
                    }
                }
                if (canceled) return;
                setResource(r);

                if (r) {
                    try {
                        const tableDistributions = await queryDistributionsForResource(r.id);
                        setDistributions([...tableDistributions, ...distributionsFromReferences(r)]);
                    } catch (e) {
                        console.warn("Failed to load resource distributions", e);
                        setDistributions(distributionsFromReferences(r));
                    }

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
                } else {
                    setDistributions([]);
                }
            } catch (e) {
                console.error("Failed to load resource", e);
                setDistributions([]);
            } finally {
                if (!canceled) setLoading(false);
            }
        };
        load();
        return () => {
            canceled = true;
            controller.abort();
        };
    }, [id]);

    const navigateToId = (targetId: string) => {
        const search = window.location.search;
        const url = withBasePath(`/resources/${encodeURIComponent(targetId)}${search}`);
        window.history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
    };

    const handleDelete = async (resourceId: string) => {
        if (!window.confirm("Are you sure you want to delete this resource? This action cannot be undone.")) {
            return;
        }

        try {
            await databaseService.deleteResource(resourceId);
            addToast("Resource deleted successfully", "success");
            onBack();
        } catch (e) {
            console.error("Failed to delete resource", e);
            addToast("Failed to delete resource", "error");
        }
    };

    const hasBrowserRenderableViewer = useMemo(() => {
        if (!resource) return false;
        try {
            const config = detectViewerConfig(resource, distributions);
            return Boolean(config && typeof config.endpoint === "string");
        } catch (error) {
            console.warn("ResourceShow: Failed to detect viewer config", error);
            return false;
        }
    }, [distributions, resource]);

    if (loading) {
        return <div className="ogm-page-card m-6 p-8 text-center text-[#5a5547] dark:text-[#ffffff]/80">{recoveryMessage || "Loading resource..."}</div>;
    }

    if (!resource) {
        return <div className="ogm-page-card m-6 p-8 text-center text-[#cf3f32]">Resource not found: {id}</div>;
    }

    return (
        <div className="ogm-resource-page h-full min-h-0 overflow-auto">
            <div className="flex w-full max-w-none flex-col gap-4 p-3 sm:gap-5 sm:p-4 lg:gap-6 lg:p-6">
                <ResourceHeader
                    resource={resource}
                    pagination={pagination}
                    onNavigate={navigateToId}
                    onDelete={handleDelete}
                />

                {hasBrowserRenderableViewer ? (
                    <>
                        <ResourceViewer resource={resource} distributions={distributions} />

                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
                            <ResourceMetadata resource={resource} />
                            <ResourceSidebar resource={resource} distributions={distributions} />
                        </div>
                    </>
                ) : (
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
                        <div className="flex min-w-0 flex-col gap-6">
                            <ResourceViewer resource={resource} distributions={distributions} />
                            <ResourceMetadata resource={resource} />
                        </div>
                        <ResourceSidebar resource={resource} distributions={distributions} />
                    </div>
                )}

                {similarResources.length > 0 && (
                    <SimilarResourcesCarousel items={similarResources} />
                )}
            </div>
        </div>
    );
};
