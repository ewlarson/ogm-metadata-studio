import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DistributionsList } from './DistributionsList';
import * as duckdbClient from '../duckdb/duckdbClient';

// Mock dependency
vi.mock('../duckdb/duckdbClient', () => ({
    queryDistributions: vi.fn()
}));

const FIXTURE_DIST = {
    resource_id: 'test-res-1',
    dct_title_s: 'Test Resource',
    relation_key: 'references',
    label: 'Download',
    url: 'http://example.com/data.zip'
};

describe('DistributionsList Component', () => {
    const mockOnEdit = vi.fn();

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('renders loading state initially', async () => {
        vi.mocked(duckdbClient.queryDistributions).mockReturnValue(new Promise(() => { }));
        render(<DistributionsList onEditResource={mockOnEdit} />);
        expect(screen.getByText('Loading...')).toBeDefined();
    });

    it('renders distributions', async () => {
        vi.mocked(duckdbClient.queryDistributions).mockResolvedValue({
            distributions: [FIXTURE_DIST],
            total: 1
        });

        render(<DistributionsList onEditResource={mockOnEdit} />);

        await waitFor(() => {
            expect(screen.getByText('test-res-1')).toBeDefined();
        });
        expect(screen.getByText('Test Resource')).toBeDefined();
        expect(screen.getByText('references')).toBeDefined();
        expect(screen.getByText('Download')).toBeDefined();
        expect(screen.getByText('http://example.com/data.zip')).toBeDefined();
    });

    it('handles edit action', async () => {
        vi.mocked(duckdbClient.queryDistributions).mockResolvedValue({
            distributions: [FIXTURE_DIST],
            total: 1
        });

        render(<DistributionsList onEditResource={mockOnEdit} />);

        await waitFor(() => expect(screen.getByText('Edit')).toBeDefined());
        fireEvent.click(screen.getByText('Edit'));

        expect(mockOnEdit).toHaveBeenCalledWith('test-res-1');
    });

    it('handles search input', async () => {
        vi.mocked(duckdbClient.queryDistributions).mockResolvedValue({ distributions: [], total: 0 });
        render(<DistributionsList onEditResource={mockOnEdit} />);

        const input = screen.getByPlaceholderText(/Search ID/i);
        fireEvent.change(input, { target: { value: 'foobar' } });

        await waitFor(() => {
            expect(duckdbClient.queryDistributions).toHaveBeenCalledWith(
                1, 20, "resource_id", "asc", "foobar"
            );
        });
    });

    it('handles sort', async () => {
        vi.mocked(duckdbClient.queryDistributions).mockResolvedValue({ distributions: [], total: 0 });
        render(<DistributionsList onEditResource={mockOnEdit} />);

        await waitFor(() => expect(screen.getByText('Resource ID')).toBeDefined());

        fireEvent.click(screen.getByText('Resource Title'));

        await waitFor(() => {
            expect(duckdbClient.queryDistributions).toHaveBeenCalledWith(
                1, 20, "dct_title_s", "asc", "" // initial sort is resource_id
            );
        });
    });
});
