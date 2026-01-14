import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ResourceViewer } from './ResourceViewer';
import { detectViewerConfig } from './resource/viewerConfig';
import { Resource } from '../aardvark/model';
import React from 'react';

// Mock detectViewerConfig
vi.mock('./resource/viewerConfig', () => ({
    detectViewerConfig: vi.fn(),
}));

// Mock dynamic imports
vi.mock('@hotwired/stimulus', () => ({
    Application: {
        start: vi.fn()
    }
}));

vi.mock('@geoblacklight/frontend', () => ({
    default: {}
}));

vi.mock('@geoblacklight/frontend/app/javascript/geoblacklight/controllers/clover_viewer_controller.js', () => ({
    default: class MockController {
        connect() { }
        disconnect() { }
        getViewer() { return <div>Mock Viewer</div>; }
    }
}));

// Mock Leaflet
vi.mock('leaflet', () => ({
    default: {
        map: vi.fn(),
        tileLayer: vi.fn(),
        marker: vi.fn(),
    }
}));

describe('ResourceViewer', () => {
    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource'
    } as Resource;

    const mockRegister = vi.fn();
    const mockStimulus = {
        register: mockRegister,
        router: {
            modulesByIdentifier: {
                has: vi.fn().mockReturnValue(false)
            }
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        HTMLCanvasElement.prototype.getContext = vi.fn();
        (window as any).Stimulus = mockStimulus;

        // Mock fetch to avoid "Cross origin" error if something triggers it
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({})
        })) as any;
    });

    it('renders nothing if no config found', () => {
        (detectViewerConfig as any).mockReturnValue(null);
        const { container } = render(<ResourceViewer resource={mockResource} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders Clover viewer logic', async () => {
        (detectViewerConfig as any).mockReturnValue({
            protocol: 'iiif_manifest',
            endpoint: 'http://localhost/manifest'
        });

        render(<ResourceViewer resource={mockResource} />);

        // Wait for registration
        await waitFor(() => {
            expect(mockRegister).toHaveBeenCalledWith('clover-viewer', expect.any(Function));
        });

        // Use findByTestId to verify render
        const element = await screen.findByTestId('clover-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-controller', 'clover-viewer');

        // Manually trigger connect to verify rendering logic
        const ControllerClass = mockRegister.mock.calls.find(c => c[0] === 'clover-viewer')[1];
        const instance = new ControllerClass();
        instance.element = element;
        // Mock properties used by the controller
        Object.defineProperty(instance, 'urlValue', { get: () => element.getAttribute('data-clover-viewer-url-value') });
        Object.defineProperty(instance, 'protocolValue', { get: () => element.getAttribute('data-clover-viewer-protocol-value') });

        // Connect
        instance.connect();
        await waitFor(() => {
            expect(element).toHaveTextContent('Mock Viewer');
        });
    });

    it('renders Leaflet viewer for WMS', async () => {
        (detectViewerConfig as any).mockReturnValue({
            protocol: 'wms',
            endpoint: 'http://localhost/wms',
            geometry: '{"type":"Polygon"}'
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = await screen.findByTestId('leaflet-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-controller', 'leaflet-viewer');
        expect(element).toHaveAttribute('data-leaflet-viewer-protocol-value', 'Wms');
    });

    it('renders Leaflet viewer for XYZ', async () => {
        (detectViewerConfig as any).mockReturnValue({
            protocol: 'xyz',
            endpoint: 'http://localhost/xyz'
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = await screen.findByTestId('leaflet-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-leaflet-viewer-protocol-value', 'Xyz');
    });

    it('renders Leaflet viewer for Feature Layer', async () => {
        (detectViewerConfig as any).mockReturnValue({
            protocol: 'arcgis_feature_layer',
            endpoint: 'http://localhost/feature'
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = await screen.findByTestId('leaflet-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-leaflet-viewer-protocol-value', 'FeatureLayer');
    });
});
