import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ResourceViewer } from './ResourceViewer';
import { detectViewerConfig } from './resource/viewerConfig';
import { Resource } from '../aardvark/model';
import React from 'react';

vi.mock('./resource/viewerConfig', () => ({
    detectViewerConfig: vi.fn(),
}));

vi.mock('./viewers/CloverViewer', () => ({
    CloverViewer: ({ iiifManifestUrl }: { iiifManifestUrl: string }) => (
        <div data-testid="clover-viewer" data-url={iiifManifestUrl}>Clover IIIF</div>
    ),
}));

vi.mock('./viewers/MapLibreResourceViewer', () => ({
    MapLibreResourceViewer: ({ protocol, url, layerId }: { protocol: string; url: string; layerId?: string }) => (
        <div data-testid="maplibre-viewer" data-protocol={protocol} data-url={url} data-layer-id={layerId ?? ''}>MapLibre</div>
    ),
}));

describe('ResourceViewer', () => {
    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource',
    } as Resource;

    beforeEach(() => {
        vi.mocked(detectViewerConfig).mockReturnValue(null);
    });

    it('renders nothing if no config found', () => {
        const { container } = render(<ResourceViewer resource={mockResource} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders Clover viewer for IIIF manifest', async () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'iiif_manifest',
            endpoint: 'http://localhost/manifest',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('clover-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-url', 'http://localhost/manifest');
    });

    it('renders MapLibre viewer for WMS', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'wms',
            endpoint: 'http://localhost/wms',
            geometry: '{"type":"Polygon"}',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'wms');
        expect(element).toHaveAttribute('data-url', 'http://localhost/wms');
    });

    it('renders MapLibre viewer for XYZ', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'xyz',
            endpoint: 'http://localhost/xyz',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'xyz');
    });

    it('renders MapLibre viewer for Feature Layer', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'arcgis_feature_layer',
            endpoint: 'http://localhost/feature',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'arcgis_feature_layer');
    });
});
