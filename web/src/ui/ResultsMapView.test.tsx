import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultsMapView } from './ResultsMapView';

vi.mock('maplibre-gl', () => {
    const LngLatBounds = function (this: any) {
        this.extend = () => this;
        this.getWest = () => 0;
        return this;
    };
    return {
        default: {
            Map: function Map() {
                return {
                    remove: () => {},
                    on: (_event: string, fn: () => void) => { if (_event === 'load') setTimeout(fn, 0); },
                    addSource: () => {},
                    addLayer: () => {},
                    getSource: () => ({}),
                    fitBounds: () => {},
                    setFeatureState: () => {},
                    setPaintProperty: () => {},
                    getBounds: () => ({ getSouthWest: () => ({ lng: 0, lat: 0 }), getNorthEast: () => ({ lng: 1, lat: 1 }) }),
                    getSize: () => ({ width: 400, height: 300 }),
                    isStyleLoaded: () => true,
                    getCanvas: () => ({ style: {} }),
                    addControl: () => {},
                };
            },
            LngLatBounds,
            Popup: function Popup() {
                return {
                    setLngLat: () => this,
                    setHTML: () => this,
                    addTo: () => this,
                    remove: () => {},
                    getElement: () => null,
                };
            },
        },
    };
});

describe('ResultsMapView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders empty state if no mappable features', () => {
        const resources = [{ id: '1', dct_title_s: 'No BBox' }];
        render(<ResultsMapView resources={resources as any} onEdit={vi.fn()} onSelect={vi.fn()} />);

        expect(screen.getByText('No mappable results found in this page.')).toBeInTheDocument();
    });

    it('renders map when resources have bbox', async () => {
        const resources = [
            { id: '1', dct_title_s: 'Map 1', dcat_bbox: 'ENVELOPE(-10, 10, 20, -5)' },
            { id: '2', dct_title_s: 'Map 2', dcat_bbox: '-10,-10,10,10' },
        ];

        render(<ResultsMapView resources={resources as any} onEdit={vi.fn()} onSelect={vi.fn()} />);

        expect(screen.queryByText('No mappable results found in this page.')).not.toBeInTheDocument();
    });
});
