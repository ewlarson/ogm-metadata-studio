import React, { useEffect, useState } from 'react';
import { Resource } from '../aardvark/model';
import { detectViewerConfig, ViewerConfig } from './resource/viewerConfig';
import { MapLibreResourceViewer } from './viewers/MapLibreResourceViewer';
import { CloverViewer } from './viewers/CloverViewer';

interface ResourceViewerProps {
    resource: Resource;
}

export const ResourceViewer: React.FC<ResourceViewerProps> = ({ resource }) => {
    const [config, setConfig] = useState<ViewerConfig | null>(null);

    useEffect(() => {
        setConfig(detectViewerConfig(resource));
    }, [resource]);

    if (!config) return null;

    const { protocol, endpoint, geometry } = config;

    const getViewerType = (proto: string) => {
        if (proto === 'iiif_manifest') return 'clover';
        return 'map';
    };

    const viewerType = getViewerType(protocol);

    if (viewerType === 'clover') {
        return (
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden bg-black">
                <CloverViewer
                    key={endpoint}
                    iiifManifestUrl={endpoint}
                    className="viewer w-full"
                />
            </div>
        );
    }

    if (viewerType === 'map') {
        let mapGeom: string | undefined;
        try {
            mapGeom = geometry ? JSON.stringify(JSON.parse(geometry)) : undefined;
        } catch {
            mapGeom = geometry;
        }

        return (
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden relative z-0">
                <div key={endpoint} className="viewer h-[500px] w-full">
                    <MapLibreResourceViewer
                        protocol={protocol}
                        url={endpoint}
                        layerId={resource.gbl_wxsIdentifier_s ?? ''}
                        mapGeom={mapGeom}
                        options={{ opacity: 0.75 }}
                    />
                </div>
            </div>
        );
    }

    return null;
};
