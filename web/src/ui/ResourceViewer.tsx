import React, { useEffect, useState } from 'react';
import L from 'leaflet';
// @ts-ignore
if (!window.L) window.L = L;

import { Resource } from '../aardvark/model';


// Default Leaflet Options
const DEFAULT_LEAFLET_OPTIONS = {
    MESSAGES: {
        'leaflet-viewer': {
            'error': 'The requested map layer could not be loaded.'
        }
    },
    LAYERS: {
        DETECT_RETINA: true
    }
};

interface ResourceViewerProps {
    resource: Resource;
}

interface ViewerConfig {
    protocol: string;
    endpoint: string;
    geometry?: string; // GeoJSON string
}

export const ResourceViewer: React.FC<ResourceViewerProps> = ({ resource }) => {
    const [config, setConfig] = useState<ViewerConfig | null>(null);

    // 1. Determine Viewer Configuration from Resource
    useEffect(() => {
        const detectConfig = (): ViewerConfig | null => {
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
                    geometry: getGeometry(resource) // WMS often needs bounds/geom to focus
                };
            }
            // XYZ Tiles
            if (refs["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames"] || refs["xyz_tiles"]) {
                return {
                    protocol: "xyz",
                    endpoint: refs["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames"] || refs["xyz_tiles"],
                    geometry: getGeometry(resource)
                };
            }

            // Esri Feature Layer
            if (refs["urn:x-esri:serviceType:ArcGIS#FeatureLayer"] || refs["arcgis_feature_layer"]) {
                return {
                    protocol: "arcgis_feature_layer",
                    endpoint: refs["urn:x-esri:serviceType:ArcGIS#FeatureLayer"] || refs["arcgis_feature_layer"],
                    geometry: getGeometry(resource)
                };
            }

            // Esri Tiled Map Layer
            if (refs["urn:x-esri:serviceType:ArcGIS#TiledMapLayer"] || refs["arcgis_tiled_map_layer"]) {
                return {
                    protocol: "arcgis_tiled_map_layer",
                    endpoint: refs["urn:x-esri:serviceType:ArcGIS#TiledMapLayer"] || refs["arcgis_tiled_map_layer"],
                    geometry: getGeometry(resource)
                };
            }

            // Esri Dynamic Map Layer
            if (refs["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"] || refs["arcgis_dynamic_map_layer"]) {
                return {
                    protocol: "arcgis_dynamic_map_layer",
                    endpoint: refs["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"] || refs["arcgis_dynamic_map_layer"],
                    geometry: getGeometry(resource)
                };
            }

            // Esri Image Map Layer
            if (refs["urn:x-esri:serviceType:ArcGIS#ImageMapLayer"] || refs["arcgis_image_map_layer"]) {
                return {
                    protocol: "arcgis_image_map_layer",
                    endpoint: refs["urn:x-esri:serviceType:ArcGIS#ImageMapLayer"] || refs["arcgis_image_map_layer"],
                    geometry: getGeometry(resource)
                };
            }

            return null;
        };

        setConfig(detectConfig());
    }, [resource]);

    // 2. Load GeoBlacklight Frontend & Register Controllers (Once)
    useEffect(() => {
        const init = async () => {
            // A. Ensure Stimulus is started
            // @ts-ignore
            if (!window.Stimulus) {
                try {
                    const { Application } = await import('@hotwired/stimulus');
                    // @ts-ignore
                    window.Stimulus = Application.start();
                } catch (e) {
                    console.error("ResourceViewer: Failed to init Stimulus", e);
                }
            }

            // B. Register Custom Clover Controller (if not already)
            // @ts-ignore
            if (window.Stimulus && !window.Stimulus.router.modulesByIdentifier.has('clover-viewer')) {
                try {
                    // @ts-ignore
                    const mod = await import('@geoblacklight/frontend/app/javascript/geoblacklight/controllers/clover_viewer_controller.js');
                    const { createRoot } = await import('react-dom/client');

                    // eslint-disable-next-line react-hooks/unsupported-syntax
                    class FixedCloverController extends mod.default {
                        root: any;

                        connect() {
                            console.debug("FixedCloverController: connect", this.urlValue);
                            if (!this.root) {
                                this.root = createRoot(this.element);
                            }
                            this.root.render(this.getViewer(this.protocolValue, this.urlValue));
                        }

                        disconnect() {
                            console.debug("FixedCloverController: disconnect");
                            if (this.root) {
                                this.root.unmount();
                                this.root = null;
                            }
                        }

                        urlValueChanged() {
                            // With key={endpoint}, this might not fire often, but good for safety
                            this.disconnect();
                            this.connect();
                        }
                    }

                    // @ts-ignore
                    window.Stimulus.register('clover-viewer', FixedCloverController);
                } catch (err) {
                    // Ignore re-registration errors or handle strictly
                    console.error("ResourceViewer: Failed to register CloverController", err);
                }
            }

            // C. Load GBL Global (if not already)
            // @ts-ignore
            if (!window.Geoblacklight) {
                import('@geoblacklight/frontend').then((Geoblacklight) => {
                    // @ts-ignore
                    window.Geoblacklight = Geoblacklight;
                }).catch(err => console.error("Failed to load @geoblacklight/frontend", err));
            }
        };

        init();
    }, []); // Empty deps: Run only once on mount


    if (!config) return null;

    // Render Logic based on Protocol
    const { protocol, endpoint, geometry } = config;

    // Helper to get logic similar to GBL
    const getViewerType = (proto: string) => {
        if (['iiif_manifest'].includes(proto)) return 'clover';
        // if (['cog', 'pmtiles'].includes(proto)) return 'openlayers'; // Future support
        return 'leaflet';
    };

    const viewerType = getViewerType(protocol);

    // Map protocol to TitleCase for data attributes (Leaflet Viewer expects this)
    const formatProtocol = (p: string) => {
        if (p === 'wms') return 'Wms';
        if (p === 'xyz') return 'Xyz'; // Or 'XyzTiles'? GBL expects 'Xyz' usually or handled by logic
        if (p === 'arcgis_feature_layer') return 'FeatureLayer';
        if (p === 'arcgis_tiled_map_layer') return 'TiledMapLayer';
        if (p === 'arcgis_dynamic_map_layer') return 'DynamicMapLayer';
        if (p === 'arcgis_image_map_layer') return 'ImageMapLayer';
        return 'Leaflet'; // Fallback
    };


    if (viewerType === 'clover') {
        return (
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden bg-black">
                <div
                    key={endpoint}
                    id="clover-viewer"
                    className="viewer h-[600px]"
                    data-controller="clover-viewer"
                    data-clover-viewer-protocol-value="IiifManifest"
                    data-clover-viewer-url-value={endpoint}
                />
            </div>
        );
    }

    if (viewerType === 'leaflet') {
        const leafletProtocol = formatProtocol(protocol);
        // GeoBlacklight `leaflet-viewer` controller expects specific data attributes

        // We need to pass the geometry if available
        let geomAttr: string | undefined;
        try {
            geomAttr = geometry ? JSON.stringify(JSON.parse(geometry)) : undefined; // Ensure valid JSON string
        } catch (err) {
            console.warn("ResourceViewer: Geometry is not valid JSON", geometry, err);
        }

        return (
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden relative z-0">
                <div
                    key={endpoint}
                    id="leaflet-viewer"
                    className="viewer h-[500px]"
                    data-controller="leaflet-viewer"
                    data-leaflet-viewer-available-value="true" // It is available
                    data-leaflet-viewer-layer-id-value={resource.gbl_wxsIdentifier_s || ''} // WMS identifier usually
                    data-leaflet-viewer-protocol-value={leafletProtocol}
                    data-leaflet-viewer-url-value={endpoint}
                    data-leaflet-viewer-map-geom-value={geomAttr}
                    data-leaflet-viewer-options-value={JSON.stringify(DEFAULT_LEAFLET_OPTIONS)}
                />
            </div>
        );
    }

    return null;
};

// Helper: Extract Geometry (BBox to Polygon or Centroid? GBL usually expects BBox as Polygon)

// Helper: Extract Geometry (BBox to Polygon or Centroid? GBL usually expects BBox as Polygon)
function getGeometry(resource: Resource): string | undefined {
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
