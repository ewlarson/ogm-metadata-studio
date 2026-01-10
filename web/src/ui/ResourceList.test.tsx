import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ResourceList } from './ResourceList';
import * as duckdbClient from '../duckdb/duckdbClient';
import { FIXTURE_POINT } from '../test/fixtures';

// Mock the duckdb client
vi.mock('../duckdb/duckdbClient', () => ({
    searchResources: vi.fn()
}));

describe('ResourceList Component', () => {
    const mockOnEdit = vi.fn();
    const mockOnCreate = vi.fn();

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('renders loading state initially', () => {
        // Mock a promise that doesn't resolve immediately
        vi.mocked(duckdbClient.searchResources).mockReturnValue(new Promise(() => { }));

        render(
            <ResourceList
                project={null}
                resourceCount={0}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        expect(screen.getByText(/Loading.../i)).toBeDefined();
    });

    it('renders resources after fetch', async () => {
        vi.mocked(duckdbClient.searchResources).mockResolvedValue({
            resources: [FIXTURE_POINT],
            total: 1
        });

        render(
            <ResourceList
                project={null}
                resourceCount={1}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        // Wait for loading to finish and data to appear
        await waitFor(() => {
            expect(screen.getByText(FIXTURE_POINT.dct_title_s)).toBeDefined();
        });

        expect(screen.getByText(FIXTURE_POINT.id)).toBeDefined();
        expect(screen.getByText('Datasets')).toBeDefined();
        expect(screen.getByText('Public')).toBeDefined();
    });

    it('calls onEdit when edit button is clicked', async () => {
        vi.mocked(duckdbClient.searchResources).mockResolvedValue({
            resources: [FIXTURE_POINT],
            total: 1
        });

        render(
            <ResourceList
                project={null}
                resourceCount={1}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Edit')).toBeDefined();
        });

        fireEvent.click(screen.getByText('Edit'));
        expect(mockOnEdit).toHaveBeenCalledWith(FIXTURE_POINT.id);
    });

    it('handles search input', async () => {
        vi.mocked(duckdbClient.searchResources).mockResolvedValue({
            resources: [],
            total: 0
        });

        render(
            <ResourceList
                project={null}
                resourceCount={0}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        const input = screen.getByPlaceholderText(/Search resources.../i);
        fireEvent.change(input, { target: { value: 'foobar' } });

        // Debounce wait
        await waitFor(() => {
            expect(duckdbClient.searchResources).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.anything(),
                'foobar'
            );
        }, { timeout: 1000 });
    });
    it('handles sorting', async () => {
        vi.mocked(duckdbClient.searchResources).mockResolvedValue({
            resources: [FIXTURE_POINT],
            total: 1
        });

        render(
            <ResourceList
                project={null}
                resourceCount={1}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        await waitFor(() => expect(screen.getByText('Title')).toBeDefined());

        // Find SortHeader for Title and click it
        // The table column header likely contains the text "Title"
        fireEvent.click(screen.getByText('Title'));

        await waitFor(() => {
            expect(duckdbClient.searchResources).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                'dct_title_s', // Sort field
                'asc', // Direction
                expect.anything()
            );
        });
    });

    it('handles pagination', async () => {
        vi.mocked(duckdbClient.searchResources).mockResolvedValue({
            resources: Array(20).fill(FIXTURE_POINT),
            total: 30
        });

        render(
            <ResourceList
                project={null}
                resourceCount={30}
                onEdit={mockOnEdit}
                onCreate={mockOnCreate}
            />
        );

        await waitFor(() => expect(screen.getByText('Next')).toBeDefined());

        fireEvent.click(screen.getByText('Next'));

        await waitFor(() => {
            expect(duckdbClient.searchResources).toHaveBeenCalledWith(
                2, // page
                20, // limit
                expect.anything(),
                expect.anything(),
                expect.anything()
            );
        });
    });
});
