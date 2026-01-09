import React, { useEffect, useState } from 'react';
import { Resource } from '../aardvark/model';
import { queryResourceById, querySimilarResources, getSearchNeighbors, FacetedSearchRequest } from '../duckdb/duckdbClient';
import { ResourceViewer } from './ResourceViewer';
import 'leaflet/dist/leaflet.css';
import { SimilarResourcesCarousel } from './resource/SimilarResourcesCarousel';
import { ResourceSidebar } from './resource/ResourceSidebar';
import { ResourceMetadata } from './resource/ResourceMetadata';
import { ResourceHeader } from './resource/ResourceHeader';

interface ResourceShowProps {
    id: string;
    onBack?: () => void;
}

export const ResourceShow: React.FC<ResourceShowProps> = ({ id }) => {
    const [resource, setResource] = useState<Resource | null>(null);
    const [similarResources, setSimilarResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    const [pagination, setPagination] = useState<{ prevId?: string, nextId?: string, position: number, total: number }>({ position: 0, total: 0 });

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const r = await queryResourceById(id);
                setResource(r);

                if (r) {
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
                }
            } catch (e) {
                console.error("Failed to load resource", e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [id]);

    const navigateToId = (targetId: string) => {
        const search = window.location.search;
        const url = `/resources/${encodeURIComponent(targetId)}${search}`;
        window.history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
    };

    if (loading) {
        return <div className="p-8 text-center text-slate-500">Loading resource...</div>;
    }

    if (!resource) {
        return <div className="p-8 text-center text-red-500">Resource not found: {id}</div>;
    }

    return (
        <div className="max-w-7xl mx-auto w-full bg-white dark:bg-slate-900 min-h-full">
            <ResourceHeader
                resource={resource}
                pagination={pagination}
                onNavigate={navigateToId}
            />

            {/* Resource Viewer */}
            <div className="px-6 pt-6">
                <ResourceViewer resource={resource} />
            </div>

            <div className="flex flex-col lg:flex-row">
                <ResourceMetadata resource={resource} />
                <ResourceSidebar resource={resource} />
            </div>

            {similarResources.length > 0 && (
                <SimilarResourcesCarousel items={similarResources} />
            )}
        </div>
    );
};
