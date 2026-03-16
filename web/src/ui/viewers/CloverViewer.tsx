import React from 'react';
import Viewer from '@samvera/clover-iiif/viewer';

const viewerOptions = {
    showTitle: false,
    showIIIFBadge: false,
    informationPanel: {
        renderToggle: false,
        renderAbout: false,
    },
};

interface CloverViewerProps {
    iiifManifestUrl: string;
    className?: string;
}

export const CloverViewer: React.FC<CloverViewerProps> = ({ iiifManifestUrl, className = '' }) => {
    return (
        <div className={className} style={{ height: 600 }}>
            <Viewer iiifContent={iiifManifestUrl} options={viewerOptions} />
        </div>
    );
};
