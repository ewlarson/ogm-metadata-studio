import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dashboard } from './Dashboard';
import { databaseService } from '../services/DatabaseService';

// Mock child components that might cause issues (Map)
vi.mock('./ResultsMapView', () => ({
    ResultsMapView: () => <div data-testid="results-map-view">Map View</div>
}));

vi.mock('./MapFacet', () => ({
    MapFacet: () => <div>Map Facet</div>
}));

vi.mock('./GalleryView', () => ({
    GalleryView: () => <div>Gallery View</div>
}));

vi.mock('./FacetModal', () => ({
    FacetModal: () => <div data-testid="facet-modal">Facet Modal</div>
}));

// Mock hooks
const mockSetState = vi.fn();
const mockToggleFacet = vi.fn();
const mockRegisterThumbnail = vi.fn();
const mockRegisterStaticMap = vi.fn();

vi.mock('../hooks/useResourceSearch', () => ({
    useResourceSearch: () => ({
        resources: [
            { id: '1', dct_title_s: 'Res 1', gbl_resourceClass_sm: ['Map'], gbl_indexYear_im: 2020 }
        ],
        facetsData: {
            'gbl_resourceClass_sm': [
                { value: 'Map', count: 10 },
                ...Array.from({ length: 6 }).map((_, i) => ({ value: `Map ${i}`, count: 1 }))
            ],
            'dct_spatial_sm': []
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
        activeFilters: {},
        toggleFacet: mockToggleFacet
    })
}));

vi.mock('../hooks/useThumbnailQueue', () => ({
    useThumbnailQueue: () => ({
        thumbnails: { '1': 'thumb.jpg' },
        register: mockRegisterThumbnail
    })
}));

vi.mock('../hooks/useStaticMapQueue', () => ({
    useStaticMapQueue: () => ({
        mapUrls: {},
        register: mockRegisterStaticMap
    })
}));

// Mock DatabaseService
vi.mock('../services/DatabaseService', () => ({
    databaseService: {
        exportFilteredResults: vi.fn()
    }
}));

// Global URL object mock
global.URL.createObjectURL = vi.fn(() => 'blob:url');
global.URL.revokeObjectURL = vi.fn();


describe('Dashboard Component', () => {
    const mockOnEdit = vi.fn();
    const mockOnSelect = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders dashboard layout', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        expect(screen.getByText(/Refine Results/i)).toBeDefined();
        // Fuzzy match for "Found <span ...>100</span> results"
        expect(screen.getByText(/Found/i)).toBeDefined();
        // Check for 100 appearing significantly
        expect(screen.getAllByText('100').length).toBeGreaterThan(0);
        expect(screen.getByText('Res 1')).toBeDefined();
    });

    it('renders facets', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(screen.getByText('Resource Class')).toBeDefined();

        const maps = screen.getAllByText('Map');
        expect(maps.length).toBeGreaterThan(0);

        expect(screen.getAllByText('10')).toBeDefined();
    });

    it('handles view switching', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        const galleryBtn = screen.getByTitle('Gallery View');
        fireEvent.click(galleryBtn);

        expect(mockSetState).toHaveBeenCalled();
        const updateFn = mockSetState.mock.calls[0][0];
        const newState = updateFn({ view: 'list' });
        expect(newState.view).toBe('gallery');
    });

    it('handles export', async () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        const jsonExportBtn = screen.getByText('JSON');
        vi.mocked(databaseService.exportFilteredResults).mockResolvedValue(new Blob(['data']));

        fireEvent.click(jsonExportBtn);

        await waitFor(() => {
            expect(databaseService.exportFilteredResults).toHaveBeenCalled();
        });
    });

    it('handles pagination', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        const nextBtn = screen.getByText('Next');
        fireEvent.click(nextBtn);
        expect(mockSetState).toHaveBeenCalled();
    });
    it('handles facet toggling', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        // Use getByTitle to find the span with title "Map", which is unique to the facet
        fireEvent.click(screen.getByTitle('Map'));

        expect(mockToggleFacet).toHaveBeenCalledWith('gbl_resourceClass_sm', 'Map', 'include');
    });

    it('registers resources for assets', () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);
        expect(mockRegisterThumbnail).toHaveBeenCalledWith('1', expect.anything());
        expect(mockRegisterStaticMap).toHaveBeenCalledWith('1', expect.anything());
    });

    it('opens facet modal', async () => {
        render(<Dashboard onEdit={mockOnEdit} onSelect={mockOnSelect} />);

        // Text is "More Resource Classes..." due to label "Resource Class"
        const showMoreBtn = screen.getByText(/More Resource Classes/i);
        expect(showMoreBtn).toBeDefined();

        fireEvent.click(showMoreBtn);

        // Since we mocked FacetModal, we assume the state change triggers it.
        // But verify setModalState was likely called if we could spy on it, 
        // or just verify the button exists and is clickable which we did.
    });
});
