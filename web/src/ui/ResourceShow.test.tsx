import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceShow } from './ResourceShow';
import * as duckdbClient from '../duckdb/duckdbClient';
import { databaseService } from '../services/DatabaseService';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    queryResourceById: vi.fn(),
    querySimilarResources: vi.fn(),
    getSearchNeighbors: vi.fn()
}));

vi.mock('../services/DatabaseService', () => ({
    databaseService: {
        deleteResource: vi.fn()
    }
}));

vi.mock('./shared/ToastContext', () => ({
    useToast: () => ({ addToast: vi.fn() })
}));

// Mock Child Components
vi.mock('./ResourceViewer', () => ({ ResourceViewer: () => <div>Resource Viewer</div> }));
vi.mock('./resource/ResourceSidebar', () => ({ ResourceSidebar: () => <div>Resource Sidebar</div> }));
vi.mock('./resource/ResourceMetadata', () => ({ ResourceMetadata: () => <div>Resource Metadata</div> }));
vi.mock('./resource/SimilarResourcesCarousel', () => ({ SimilarResourcesCarousel: () => <div>Similar Resources</div> }));
vi.mock('./resource/ResourceHeader', () => ({
    ResourceHeader: ({ onDelete }: any) => <button onClick={() => onDelete('1')}>Delete Resource</button>
}));

const mockResource = {
    id: '1',
    dct_title_s: 'Test Resource',
    gbl_resourceClass_sm: ['Map']
};

describe('ResourceShow Component', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('renders loading state initially', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockReturnValue(new Promise(() => { })); // Hang
        render(<ResourceShow id="1" onBack={() => { }} />);
        expect(screen.getByText('Loading resource...')).toBeDefined();
    });

    it('renders resource details when loaded', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(mockResource as any);
        vi.mocked(duckdbClient.querySimilarResources).mockResolvedValue([]);
        vi.mocked(duckdbClient.getSearchNeighbors).mockResolvedValue({ position: 1, total: 10 });

        render(<ResourceShow id="1" onBack={() => { }} />);

        await waitFor(() => {
            expect(screen.getByText('Resource Viewer')).toBeDefined();
        });
        expect(screen.getByText('Resource Metadata')).toBeDefined();
        expect(screen.getByText('Resource Sidebar')).toBeDefined();
    });

    it('renders not found state', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(null);
        render(<ResourceShow id="999" onBack={() => { }} />);
        await waitFor(() => {
            expect(screen.getByText('Resource not found: 999')).toBeDefined();
        });
    });

    it('handles delete action', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(mockResource as any);
        const onBack = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<ResourceShow id="1" onBack={onBack} />);

        await waitFor(() => expect(screen.getByText('Delete Resource')).toBeDefined());

        fireEvent.click(screen.getByText('Delete Resource'));

        await waitFor(() => {
            expect(databaseService.deleteResource).toHaveBeenCalledWith('1');
            expect(onBack).toHaveBeenCalled();
        });
    });
});
