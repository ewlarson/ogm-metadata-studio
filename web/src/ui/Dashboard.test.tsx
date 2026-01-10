import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Dashboard } from './Dashboard';
import { useResourceSearch } from '../hooks/useResourceSearch';
import { useThumbnailQueue } from '../hooks/useThumbnailQueue';
import { useStaticMapQueue } from '../hooks/useStaticMapQueue';
import { databaseService } from '../services/DatabaseService';

// Mock Hooks
vi.mock('../hooks/useResourceSearch');
vi.mock('../hooks/useThumbnailQueue');
vi.mock('../hooks/useStaticMapQueue');
vi.mock('../services/DatabaseService');

// Mock Child Components
vi.mock('./GalleryView', () => ({
    GalleryView: ({ onSelect }: any) => (
        <div data-testid="gallery-view">
            Gallery View
            <button onClick={() => onSelect('1')}>Select 1</button>
        </div>
    )
}));
vi.mock('./ResultsMapView', () => ({
    ResultsMapView: ({ highlightedResourceId }: any) => (
        <div data-testid="results-map-view">
            Map View {highlightedResourceId && `Highlight: ${highlightedResourceId}`}
        </div>
    )
}));
vi.mock('./DashboardResultsList', () => ({
    DashboardResultsList: ({ onSelect }: any) => (
        <div data-testid="results-list-view">
            List View
            <button onClick={() => onSelect('1')}>Select 1</button>
        </div>
    )
}));
vi.mock('./MapFacet', () => ({
    MapFacet: ({ onChange }: any) => <button onClick={() => onChange({ minX: 0, minY: 0, maxX: 10, maxY: 10 })}>Update Map Facet</button>
}));
vi.mock('./TimelineFacet', () => ({
    TimelineFacet: ({ onChange }: any) => <button onClick={() => onChange([2000, 2020])}>Update Timeline Facet</button>
}));
vi.mock('./ActiveFilterBar', () => ({
    ActiveFilterBar: ({ onRemoveQuery, onRemoveFacet, onClearAll }: any) => (
        <div data-testid="active-filter-bar">
            <button onClick={onRemoveQuery}>Remove Query</button>
            <button onClick={() => onRemoveFacet('f1', 'v1')}>Remove Facet</button>
            <button onClick={onClearAll}>Clear All</button>
        </div>
    )
}));
vi.mock('./FacetModal', () => ({
    FacetModal: ({ isOpen, onClose }: any) => isOpen ? (
        <div data-testid="facet-modal">
            Facet Modal
            <button onClick={onClose}>Close Modal</button>
        </div>
    ) : null
}));
vi.mock('./ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: any) => <div>{children}</div>
}));

describe('Dashboard Component', () => {
    const mockOnEdit = vi.fn();
    const mockOnSelect = vi.fn();

    // Default hook returns
    const mockSetState = vi.fn();
    const mockToggleFacet = vi.fn();
    const mockRegisterThumb = vi.fn();
    const mockRegisterMap = vi.fn();

    const defaultState = {
        resources: [
            { id: '1', dct_title_s: 'Resource 1', gbl_indexYear_im: 2020 },
            { id: '2', dct_title_s: 'Resource 2', gbl_indexYear_im: 2021 }
        ],
        facetsData: {
            'dct_spatial_sm': [{ value: 'Place 1', count: 10 }]
        },
        total: 100,
        loading: false,
        state: {
            q: '',
            page: 1,
            facets: {},
            view: 'list',
            sort: 'relevance'
        },
        setState: mockSetState,
        activeFilters: [],
        toggleFacet: mockToggleFacet
    };

    beforeEach(() => {
        vi.clearAllMocks();

        (useThumbnailQueue as any).mockReturnValue({
            thumbnails: {},
            register: mockRegisterThumb
        });

        (useStaticMapQueue as any).mockReturnValue({
            mapUrls: {},
            register: mockRegisterMap
        });

        (useResourceSearch as any).mockImplementation(() => defaultState);
    });

    it('renders list view by default (or when configured)', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(screen.getByTestId('results-list-view')).toBeInTheDocument();
        // Use flexible matcher or check parts
        expect(screen.getAllByText(/Found/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText('100').length).toBeGreaterThan(0);
        expect(screen.getAllByText(/results/i).length).toBeGreaterThan(0);
    });

    it('switches to gallery view', () => {
        const current = (useResourceSearch as any).getMockImplementation()();
        (useResourceSearch as any).mockReturnValue({
            ...current,
            state: { ...current.state, view: 'gallery' }
        });
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(screen.getByTestId('gallery-view')).toBeInTheDocument();
    });

    it('switches to map view', () => {
        const current = (useResourceSearch as any).getMockImplementation()();
        (useResourceSearch as any).mockReturnValue({
            ...current,
            state: { ...current.state, view: 'map' }
        });
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(screen.getByTestId('results-map-view')).toBeInTheDocument();
    });

    it('triggers view state change on button click', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        const galleryBtn = screen.getByTitle('Gallery View');
        fireEvent.click(galleryBtn);
        expect(mockSetState).toHaveBeenCalled();
        // Note: checking exact args is hard with setState functional update, but we can verify it was called.
    });

    it('triggers sort change', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'year_desc' } });
        expect(mockSetState).toHaveBeenCalled();
    });

    it('handles pagination', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        const nextBtn = screen.getByText('Next');
        fireEvent.click(nextBtn);
        expect(mockSetState).toHaveBeenCalled();
    });

    it('handles export JSON', async () => {
        const mockBlob = new Blob(['{}'], { type: 'application/zip' });
        (databaseService.exportFilteredResults as any).mockResolvedValue(mockBlob);

        // Mock URL.createObjectURL
        global.URL.createObjectURL = vi.fn(() => 'blob:url');
        global.URL.revokeObjectURL = vi.fn();

        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        const jsonBtn = screen.getByText('JSON');
        fireEvent.click(jsonBtn);

        await waitFor(() => {
            expect(databaseService.exportFilteredResults).toHaveBeenCalledWith(expect.anything(), 'json');
        });
    });

    it('handles export failure', async () => {
        (databaseService.exportFilteredResults as any).mockRejectedValue(new Error('Export Failed'));
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        const csvBtn = screen.getByText('CSV');
        fireEvent.click(csvBtn);

        await waitFor(() => {
            expect(alertSpy).toHaveBeenCalledWith('Export failed. See console.');
        });
    });

    it('interactions with map facet update state', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        fireEvent.click(screen.getByText('Update Map Facet'));
        expect(mockSetState).toHaveBeenCalled();
    });

    it('interactions with timeline facet update state', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        fireEvent.click(screen.getByText('Update Timeline Facet'));
        expect(mockSetState).toHaveBeenCalled();
    });

    describe('Sidebar Facets', () => {
        it('renders facet sections', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            expect(screen.getByText('Place')).toBeInTheDocument();
        });

        it('expands/collapses facet section', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            const btn = screen.getByText('Place');
            // Assuming default open, click to toggle
            fireEvent.click(btn);
            // It's local state, so we expect behavior change. 
            // In the mock data, 'Place' has 1 value 'Place 1'.
            // If closed, the value list won't be visible.
            // If open, it will.
            // Place is index 0, so defaultOpen=true.
            // Click should close it.
            expect(screen.queryByText('Place 1')).not.toBeInTheDocument();

            fireEvent.click(btn);
            expect(screen.getByText('Place 1')).toBeInTheDocument();
        });

        it('toggles facet inclusion', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            fireEvent.click(screen.getByText('Place 1'));
            expect(mockToggleFacet).toHaveBeenCalledWith('dct_spatial_sm', 'Place 1', 'include');
        });

        it('toggles facet exclusion', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            // Hover/Focus needed to see the exclude button? The CSS hides it with opacity-0 group-hover:opacity-100.
            // But in JSDOM, we can click it if it exists in DOM, usually.
            const excludeBtn = screen.getByTitle('Exclude this value');
            fireEvent.click(excludeBtn);
            expect(mockToggleFacet).toHaveBeenCalledWith('dct_spatial_sm', 'Place 1', 'exclude');
        });

        it('opens modal for "More..."', () => {
            (useResourceSearch as any).mockReturnValue({
                ...useResourceSearch({} as any),
                facetsData: {
                    'dct_spatial_sm': [
                        { value: '1', count: 1 }, { value: '2', count: 1 }, { value: '3', count: 1 },
                        { value: '4', count: 1 }, { value: '5', count: 1 }, { value: '6', count: 1 } // > 5 limit
                    ]
                }
            });
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            const moreBtn = screen.getByText(/More Place/);
            fireEvent.click(moreBtn);
            expect(screen.getByTestId('facet-modal')).toBeInTheDocument();

            fireEvent.click(screen.getByText('Close Modal'));
            expect(screen.queryByTestId('facet-modal')).not.toBeInTheDocument();
        });
    });

    describe('Active Filters Interactions', () => {
        it('removes query via ActiveFilterBar', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            fireEvent.click(screen.getByText('Remove Query'));
            expect(mockSetState).toHaveBeenCalled();
        });

        it('removes facet via ActiveFilterBar', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            fireEvent.click(screen.getByText('Remove Facet'));
            expect(mockSetState).toHaveBeenCalled();
        });

        it('clears all via ActiveFilterBar', () => {
            render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
            fireEvent.click(screen.getByText('Clear All'));
            expect(mockSetState).toHaveBeenCalled();
        });
    });

    it('registers resources for thumbnails and maps on mount', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(mockRegisterThumb).toHaveBeenCalledTimes(2); // 2 resources
        expect(mockRegisterMap).toHaveBeenCalledTimes(2);
    });

    it('handles map hover state', async () => {
        const current = (useResourceSearch as any).getMockImplementation()();
        (useResourceSearch as any).mockReturnValue({
            ...current,
            state: { ...current.state, view: 'map' }
        });
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        expect(screen.getByTestId('results-map-view')).toBeInTheDocument();

        const item = screen.getByText('Resource 1').closest('li');
        expect(item).toBeInTheDocument();

        fireEvent.mouseEnter(item!);

        // Wait for the text to appear
        await waitFor(() => {
            expect(screen.getByTestId('results-map-view')).toHaveTextContent(/Highlight: 1/);
        });

        fireEvent.mouseLeave(item!);
        await waitFor(() => {
            expect(screen.getByTestId('results-map-view')).not.toHaveTextContent(/Highlight: 1/);
        });
    });
});
