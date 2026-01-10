import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResultsMapView } from './ResultsMapView';

const mockFlyToBounds = vi.fn();

// Mock dependencies
vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
    TileLayer: () => <div data-testid="tile-layer">TileLayer</div>,
    Rectangle: ({ children, eventHandlers }: any) => (
        <div data-testid="rectangle" onClick={eventHandlers?.click}>
            {children}
        </div>
    ),
    Popup: ({ children }: any) => <div data-testid="popup">{children}</div>,
    useMap: () => ({
        flyToBounds: mockFlyToBounds
    })
}));

vi.mock('leaflet', () => ({
    default: {
        featureGroup: (layers: any[]) => ({
            getBounds: () => ({
                isValid: () => layers.length > 0
            })
        }),
        rectangle: () => ({})
    }
}));

describe('ResultsMapView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders empty state if no mappable features', () => {
        const resources = [{ id: '1', dct_title_s: 'No BBox' }]; // missing dcat_bbox
        render(<ResultsMapView resources={resources as any} onEdit={vi.fn()} onSelect={vi.fn()} />);

        expect(screen.getByText('No mappable results found in this page.')).toBeDefined();
    });

    it('renders map with rectangles for valid bboxes', () => {
        const resources = [
            { id: '1', dct_title_s: 'Map 1', dcat_bbox: 'ENVELOPE(-10, 10, 20, -5)' }, // Valid
            { id: '2', dct_title_s: 'Map 2', dcat_bbox: 'invalid' }, // Invalid
            { id: '3', dct_title_s: 'Map 3', dcat_bbox: '-10,-10,10,10' } // CSV format
        ];

        render(<ResultsMapView resources={resources as any} onEdit={vi.fn()} onSelect={vi.fn()} />);

        expect(screen.getByTestId('map-container')).toBeDefined();
        const rects = screen.getAllByTestId('rectangle');
        expect(rects.length).toBe(2); // ID 1 and 3
    });

    it('triggers interactions', () => {
        const resources = [
            { id: '1', dct_title_s: 'Map 1', dcat_bbox: 'ENVELOPE(0,0,0,0)' }
        ];
        const onSelect = vi.fn();
        const onEdit = vi.fn();

        render(<ResultsMapView resources={resources as any} onEdit={onEdit} onSelect={onSelect} />);

        // Click rectangle -> onSelect
        fireEvent.click(screen.getByTestId('rectangle'));
        expect(onSelect).toHaveBeenCalledWith('1');

        // Click edit in popup
        fireEvent.click(screen.getByText('Edit Record'));
        expect(onEdit).toHaveBeenCalledWith('1');
    });

    it('MapController handles effects', () => {
        // Since MapController is rendered inside MapContainer which we mocked to render children,
        // it acts as a functional component calling useMap (mocked).
        // Interactions: if highlightedId provided, calls flyToBounds.

        const resources = [
            { id: '1', dct_title_s: 'Map 1', dcat_bbox: 'ENVELOPE(0,0,0,0)' }
        ];

        const { rerender } = render(
            <ResultsMapView
                resources={resources as any}
                onEdit={vi.fn()}
                onSelect={vi.fn()}
                highlightedResourceId={null}
            />
        );

        // Initial render triggers flyToBounds for "all bounds" logic (reset)
        expect(mockFlyToBounds).toHaveBeenCalled();
        mockFlyToBounds.mockClear();

        // Highlight
        rerender(
            <ResultsMapView
                resources={resources as any}
                onEdit={vi.fn()}
                onSelect={vi.fn()}
                highlightedResourceId="1"
            />
        );
        expect(mockFlyToBounds).toHaveBeenCalled();
    });
});
