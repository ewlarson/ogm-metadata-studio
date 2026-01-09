import React, { useEffect, useState } from 'react';
import L from 'leaflet';
// @ts-ignore
if (!window.L) window.L = L;

import { Resource } from '../aardvark/model';
import { detectViewerConfig, ViewerConfig } from './resource/viewerConfig';


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

export const ResourceViewer: React.FC<ResourceViewerProps> = ({ resource }) => {
    const [config, setConfig] = useState<ViewerConfig | null>(null);

    // 1. Determine Viewer Configuration from Resource
    useEffect(() => {
        setConfig(detectViewerConfig(resource));
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
