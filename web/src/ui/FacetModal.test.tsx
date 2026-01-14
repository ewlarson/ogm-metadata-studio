import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FacetModal } from './FacetModal';
import * as duckdbClient from '../duckdb/duckdbClient';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    getFacetValues: vi.fn()
}));

describe('FacetModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render if closed', () => {
        const { container } = render(<FacetModal field="test" label="Test" isOpen={false} onClose={vi.fn()} selectedValues={[]} excludedValues={[]} onToggle={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders and fetches values when open', async () => {
        vi.mocked(duckdbClient.getFacetValues).mockResolvedValue({
            values: [{ value: 'Val1', count: 10 }, { value: 'Val2', count: 5 }],
            total: 2
        });

        render(<FacetModal field="test" label="Test" isOpen={true} onClose={vi.fn()} selectedValues={[]} excludedValues={[]} onToggle={vi.fn()} />);

        expect(screen.getByText('Select Test')).toBeDefined();
        expect(screen.getByText('Loading...')).toBeDefined();

        await waitFor(() => {
            expect(screen.getByText('Val1')).toBeDefined();
            expect(screen.getByText('10')).toBeDefined();
        });
    });

    it('handles search input', async () => {
        vi.mocked(duckdbClient.getFacetValues).mockResolvedValue({ values: [], total: 0 });

        render(<FacetModal field="test" label="Test" isOpen={true} onClose={vi.fn()} selectedValues={[]} excludedValues={[]} onToggle={vi.fn()} />);

        const input = screen.getByPlaceholderText('Search Test...');
        fireEvent.change(input, { target: { value: 'query' } });

        // Search trigger relies on useEffect dependency on `search`.
        // Debounce mechanism? No, it seems direct in the component (useEffect [search]).

        await waitFor(() => {
            expect(duckdbClient.getFacetValues).toHaveBeenCalledWith(expect.objectContaining({ facetQuery: 'query' }));
        });
    });

    it('handles pagination', async () => {
        vi.mocked(duckdbClient.getFacetValues).mockResolvedValue({
            values: [],
            total: 100 // multiple pages
        });

        render(<FacetModal field="test" isOpen={true} onClose={vi.fn()} onToggle={vi.fn()} label="Test" selectedValues={[]} excludedValues={[]} />);

        await waitFor(() => screen.getByText('Page 1 of 5'));

        const next = screen.getByText('Next');
        fireEvent.click(next);

        await waitFor(() => {
            expect(duckdbClient.getFacetValues).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
        });
    });

    it('toggles inclusion and exclusion', async () => {
        vi.mocked(duckdbClient.getFacetValues).mockResolvedValue({
            values: [{ value: 'Val1', count: 10 }],
            total: 1
        });
        const onToggle = vi.fn();

        render(<FacetModal field="test" isOpen={true} onClose={vi.fn()} onToggle={onToggle} label="Test" selectedValues={[]} excludedValues={[]} />);

        await waitFor(() => screen.getByText('Val1'));

        // Include
        fireEvent.click(screen.getByText('Val1'));
        expect(onToggle).toHaveBeenCalledWith('test', 'Val1', 'include');

        // Exclude
        const excludeBtn = screen.getByTitle('Exclude this value');
        fireEvent.click(excludeBtn);
        expect(onToggle).toHaveBeenCalledWith('test', 'Val1', 'exclude');
    });
});
