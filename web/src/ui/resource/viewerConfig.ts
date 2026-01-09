import { Resource } from '../../aardvark/model';

export interface ViewerConfig {
    protocol: string;
    endpoint: string;
    geometry?: string; // GeoJSON string
}

// Helper: Extract Geometry (BBox to Polygon or Centroid? GBL usually expects BBox as Polygon)
export function getViewerGeometry(resource: Resource): string | undefined {
    const parseEnvelope = (str: string): string | null => {
        const envelopeMatch = str.match(/ENVELOPE\s*\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/i);
        if (envelopeMatch) {
            const w = parseFloat(envelopeMatch[1]);
            const e = parseFloat(envelopeMatch[2]);
            const n = parseFloat(envelopeMatch[3]);
            const s = parseFloat(envelopeMatch[4]);

            // GeoJSON Polygon [ [ [w, n], [e, n], [e, s], [w, s], [w, n] ] ]
            const geojson = {
                type: "Polygon",
                coordinates: [[
                    [w, n],
                    [e, n],
                    [e, s],
                    [w, s],
                    [w, n]
                ]]
            };
            return JSON.stringify(geojson);
        }
        return null;
    };

    // 1. Try locn_geometry
    if (resource.locn_geometry) {
        // Is it JSON?
        try {
            JSON.parse(resource.locn_geometry);
            return resource.locn_geometry;
        } catch (e) {
            // Not native JSON. Is it ENVELOPE?
            const parsed = parseEnvelope(resource.locn_geometry);
            if (parsed) return parsed;
        }
    }

    // 2. Try dcat_bbox (Usually ENVELOPE)
    if (resource.dcat_bbox) {
        const parsed = parseEnvelope(resource.dcat_bbox);
        if (parsed) return parsed;
    }

    return undefined;
}

export function detectViewerConfig(resource: Resource): ViewerConfig | null {
    if (!resource.dct_references_s) return null;

    let refs: Record<string, string> = {};
    try {
        refs = JSON.parse(resource.dct_references_s);
    } catch (e) {
        console.warn("ResourceViewer: Failed to parse dct_references_s", e);
        return null;
    }

    // Priority Logic
    // IIIF Manifest
    if (refs["http://iiif.io/api/presentation#manifest"] || refs["iiif_manifest"]) {
        return {
            protocol: "iiif_manifest",
            endpoint: refs["http://iiif.io/api/presentation#manifest"] || refs["iiif_manifest"]
        };
    }

    // OGC WMS
    if (refs["http://www.opengis.net/def/serviceType/ogc/wms"] || refs["wms"]) {
        return {
            protocol: "wms",
            endpoint: refs["http://www.opengis.net/def/serviceType/ogc/wms"] || refs["wms"],
            geometry: getViewerGeometry(resource) // WMS often needs bounds/geom to focus
        };
    }
    // XYZ Tiles
    if (refs["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames"] || refs["xyz_tiles"]) {
        return {
            protocol: "xyz",
            endpoint: refs["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames"] || refs["xyz_tiles"],
            geometry: getViewerGeometry(resource)
        };
    }

    // Esri Feature Layer
    if (refs["urn:x-esri:serviceType:ArcGIS#FeatureLayer"] || refs["arcgis_feature_layer"]) {
        return {
            protocol: "arcgis_feature_layer",
            endpoint: refs["urn:x-esri:serviceType:ArcGIS#FeatureLayer"] || refs["arcgis_feature_layer"],
            geometry: getViewerGeometry(resource)
        };
    }

    // Esri Tiled Map Layer
    if (refs["urn:x-esri:serviceType:ArcGIS#TiledMapLayer"] || refs["arcgis_tiled_map_layer"]) {
        return {
            protocol: "arcgis_tiled_map_layer",
            endpoint: refs["urn:x-esri:serviceType:ArcGIS#TiledMapLayer"] || refs["arcgis_tiled_map_layer"],
            geometry: getViewerGeometry(resource)
        };
    }

    // Esri Dynamic Map Layer
    if (refs["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"] || refs["arcgis_dynamic_map_layer"]) {
        return {
            protocol: "arcgis_dynamic_map_layer",
            endpoint: refs["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"] || refs["arcgis_dynamic_map_layer"],
            geometry: getViewerGeometry(resource)
        };
    }

    // Esri Image Map Layer
    if (refs["urn:x-esri:serviceType:ArcGIS#ImageMapLayer"] || refs["arcgis_image_map_layer"]) {
        return {
            protocol: "arcgis_image_map_layer",
            endpoint: refs["urn:x-esri:serviceType:ArcGIS#ImageMapLayer"] || refs["arcgis_image_map_layer"],
            geometry: getViewerGeometry(resource)
        };
    }

    return null;
}
