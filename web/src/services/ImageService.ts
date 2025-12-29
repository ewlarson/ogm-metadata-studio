import { Resource, Distribution, REFERENCE_URI_MAPPING } from "../aardvark/model";


/**
 * Service for handling image asset extraction from Aardvark records.
 * Ported from: https://github.com/geobtaa/geospatial-api/blob/develop/app/services/image_service.py
 */
export class ImageService {
    private resource: Resource;
    private distributions: Distribution[];

    constructor(resource: Resource, distributions: Distribution[] = []) {
        this.resource = resource;
        this.distributions = distributions;
    }

    /**
     * Get the thumbnail URL from document metadata.
     * This may require fetching a IIIF manifest, so it returns a Promise.
     */
    async getThumbnailUrl(): Promise<string | null> {
        // 0. Check Cache (already populated in Resource)
        if (this.resource.thumbnail) {
            // console.debug(`[ImageService] Cache Hit for ${this.resource.id}`);
            return this.resource.thumbnail;
        }

        // Check for restricted access rights - actually we might show thumbnails for restricted items if public?
        // Python code skips restricted:
        if (this.resource.dct_accessRights_s?.toLowerCase() === "restricted") {
            console.debug(`[ImageService] Access Restricted for ${this.resource.id}`);
            return null;
        }

        const sourceUrl = this.getThumbnailSourceUrl();
        if (!sourceUrl) return null;

        // Check if it is a IIIF Manifest URL
        if (this.isManifestUrl(sourceUrl)) {
            // Need to fetch manifest
            try {
                const manifest = await this.fetchManifest(sourceUrl);
                if (manifest) {
                    const thumb = this.extractThumbnailFromManifest(manifest);
                    if (thumb) {
                        const final = this.standardizeIiifUrl(thumb);
                        console.log(`[ImageService] ✅ Resolved Thumbnail for ${this.resource.id}:`, final);
                        // Cache handled by queue
                        return final;
                    }
                }
            } catch (e) {
                console.warn(`[ImageService] Failed to fetch/parse manifest for ${this.resource.id}`, e);
            }
            return null;
        }

        // Direct image URL
        const final = this.standardizeIiifUrl(sourceUrl);
        console.log(`[ImageService] ✅ Found Direct Thumbnail for ${this.resource.id}:`, final);
        // Cache handled by queue
        return final;
    }

    private getThumbnailSourceUrl(): string | null {
        const refs = this.getReferences();

        // 1. Explicit Thumbnail
        const thumbUrls = this.findUrls(refs, ["http://schema.org/thumbnailUrl", "https://schema.org/thumbnailUrl"]);
        if (thumbUrls.length > 0) return thumbUrls[0];

        // 2. IIIF Image API
        const iiifUrls = this.findUrls(refs, ["http://iiif.io/api/image", "https://iiif.io/api/image"]);
        for (const url of iiifUrls) {
            // ContentDM checks
            if (url.includes("contentdm.oclc.org")) {
                // Pattern: /digital/iiif/collection/id
                const match1 = url.match(/\/digital\/iiif\/([^/]+)\/(\d+)/);
                if (match1) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match1[1]}:${match1[2]}/full/200,/0/default.jpg`;
                }
                const match2 = url.match(/\/iiif\/([^/]+)\//);
                if (match2) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match2[1]}/full/200,/0/default.jpg`;
                }
            }
            if (url.endsWith("/info.json")) {
                return url.replace("/info.json", "/full/200,/0/default.jpg");
            }
            return `${url}/full/200,/0/default.jpg`;
        }

        // 3. IIIF Manifest
        let manifestUrl = this.findUrls(refs, ["http://iiif.io/api/presentation#manifest", "https://iiif.io/api/presentation#manifest"])[0];

        // Heuristic scan if no explicit key
        if (!manifestUrl) {
            const allUrls = this.getAllUrls();
            for (const url of allUrls) {
                if (url.endsWith("/iiif3/manifest") || url.endsWith("/iiif/manifest") || url.endsWith("/manifest") || url.endsWith("manifest.json") || url.includes("/manifest")) {
                    manifestUrl = url;
                    break;
                }
            }
        }

        if (manifestUrl) {
            // Special ContentDM Manifest Optimization
            if (manifestUrl.includes("contentdm.oclc.org") && manifestUrl.includes("/iiif/")) {
                const match = manifestUrl.match(/\/iiif\/([^/]+)\//);
                if (match) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match[1]}/full/200,/0/default.jpg`;
                }
            }
            return manifestUrl; // Return manifest URL to be fetched
        }

        // 4. Esri
        const esriKeys = [
            "urn:x-esri:serviceType:ArcGIS#ImageMapLayer",
            "urn:x-esri:serviceType:ArcGIS#TiledMapLayer",
            "urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"
        ];
        const esriUrl = this.findUrls(refs, esriKeys)[0];
        if (esriUrl) {
            return `${esriUrl}/info/thumbnail/thumbnail.png`;
        }

        // 5. WMS
        const wmsUrl = this.findUrls(refs, ["http://www.opengis.net/def/serviceType/ogc/wms"])[0];
        if (wmsUrl) {
            const layers = this.resource.gbl_wxsIdentifier_s || "";
            return `${wmsUrl}/reflect?FORMAT=image/png&TRANSPARENT=TRUE&WIDTH=200&HEIGHT=200&LAYERS=${layers}`;
        }

        // 6. TMS
        const tmsUrl = this.findUrls(refs, ["http://www.opengis.net/def/serviceType/ogc/tms"])[0];
        if (tmsUrl) {
            return `${tmsUrl}/reflect?format=application/vnd.google-earth.kml+xml`;
        }

        return null;
    }

    private extractThumbnailFromManifest(json: any): string | null {
        try {
            // 1. Manifest-level thumbnail
            if (json.thumbnail) {
                const t = Array.isArray(json.thumbnail) ? json.thumbnail[0] : json.thumbnail;
                const id = typeof t === 'string' ? t : (t['@id'] || t['id']);
                if (id) return id;
            }

            // 2. Sequences (IIIF v2)
            if (json.sequences && json.sequences.length > 0) {
                const canvas = json.sequences[0].canvases?.[0];
                if (canvas) {
                    const img = canvas.images?.[0]?.resource;
                    if (img) {
                        if (img['@id']) return img['@id'];
                        const svcId = img.service?.['@id'];
                        if (svcId) return `${svcId}/full/400,/0/default.jpg`;
                    }
                }
            }

            // 3. Items (IIIF v3)
            if (json.items && json.items.length > 0) {
                const canvas = json.items[0];
                // Canvas thumbnail
                if (canvas.thumbnail) {
                    const t = Array.isArray(canvas.thumbnail) ? canvas.thumbnail[0] : canvas.thumbnail;
                    const id = typeof t === 'string' ? t : (t['id'] || t['@id']);
                    if (id) return id;
                }

                // Content Body
                const body = canvas.items?.[0]?.items?.[0]?.body;
                if (body) {
                    // Try service
                    let service = body.service;
                    if (Array.isArray(service)) service = service[0];
                    if (service) {
                        const svcId = service['id'] || service['@id'] || (typeof service === 'string' ? service : null);
                        if (svcId) return `${svcId}/full/400,/0/default.jpg`;
                    }
                    // Try body ID
                    if (body.id) return body.id;
                }
            }
        } catch (e) {
            console.warn("Error parsing manifest", e);
        }
        return null;
    }

    private standardizeIiifUrl(url: string): string {
        try {
            if (!url.toLowerCase().includes("/iiif/") && !url.toLowerCase().includes("/image/") && !url.includes("info.json")) {
                return url;
            }
            if (url.endsWith("/info.json")) {
                return url.replace("/info.json", "/full/200,/0/default.jpg");
            }
            if (url.includes("stacks.stanford.edu") && (url.includes("/full/!") || url.includes("/full/400,"))) {
                return url;
            }
            if (url.includes("/full/")) {
                const prefix = url.split("/full/")[0];
                // Ensure we use a decent size
                return `${prefix}/full/200,/0/default.jpg`;
            }
            return url;
        } catch {
            return url;
        }
    }

    private isManifestUrl(url: string): boolean {
        const lower = url.toLowerCase();
        return url.endsWith("/iiif3/manifest") ||
            url.endsWith("/iiif/manifest") ||
            url.endsWith("/manifest") ||
            url.endsWith("manifest.json") ||
            url.includes("/manifest") ||
            (url.includes(".json") && (lower.includes("iiif") || url.includes("/object/") || url.includes("/collection/"))) ||
            (url.includes("/api/") && (lower.includes("iiif") || lower.includes("image"))) ||
            lower.includes("/cgi/i/image/api/");
    }

    private async fetchManifest(url: string): Promise<any> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 5000); // 5s timeout
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        } finally {
            clearTimeout(id);
        }
    }

    // --- Helpers for References ---

    private getReferences(): Record<string, string> {
        // Build map from distributions + dct_references_s
        // Usually distributions table is best source if available.
        const refs: Record<string, string> = {};

        // 1. From Table
        for (const dist of this.distributions) {
            const uri = REFERENCE_URI_MAPPING[dist.relation_key?.toLowerCase()] || dist.relation_key;
            if (uri && dist.url) {
                refs[uri] = dist.url;
            }
        }

        // 2. From Resource (if dct_references_s is parsed? It's usually a string in raw JSON)
        // Note: The Resource model might not store parsed references explicitly, 
        // but `extra` might have it if not flattened.
        // However, usually `distributions` passed to constructor should suffice.
        return refs;
    }

    private findUrls(refs: Record<string, string>, keys: string[]): string[] {
        const hits: string[] = [];
        for (const k of keys) {
            if (refs[k]) hits.push(refs[k]); // refs[k] is single URL usually
            // If we support parsed multi-values?
            // The refs map built above flattens. 
            // If multiple dists have same Key, my `refs` map overwrites.
            // I should ideally check all distributions.
        }

        // Better implementation: Check distributions directly
        const rawHits: string[] = [];
        for (const k of keys) {
            // Find distributions matching this URI (mapped or direct)
            const matches = this.distributions.filter(d => {
                const mapped = REFERENCE_URI_MAPPING[d.relation_key?.toLowerCase()] || d.relation_key;
                return mapped === k;
            });
            matches.forEach(m => rawHits.push(m.url));
        }
        return rawHits.length > 0 ? rawHits : hits;
    }

    private getAllUrls(): string[] {
        return this.distributions.map(d => d.url).filter(Boolean);
    }
}
