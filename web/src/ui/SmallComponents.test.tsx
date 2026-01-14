import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ActiveFilterBar } from './ActiveFilterBar';
import { AutosuggestInput } from './AutosuggestInput';
import { TagInput } from './TagInput';
import { Link } from './Link';
import * as duckdb from '../duckdb/duckdbClient';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    getDistinctValues: vi.fn(),
    suggest: vi.fn()
}));

// Mock window.history.pushState
const pushStateSpy = vi.spyOn(window.history, 'pushState');
const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

describe('Small UI Components', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('ActiveFilterBar', () => {
        it('renders nothing if no filters', () => {
            const { container } = render(
                <ActiveFilterBar
                    query=""
                    facets={{}}
                    onRemoveQuery={vi.fn()}
                    onRemoveFacet={vi.fn()}
                    onClearAll={vi.fn()}
                />
            );
            expect(container).toBeEmptyDOMElement();
        });

        it('renders query, facets, and year range', () => {
            const onRemoveQuery = vi.fn();
            const onRemoveFacet = vi.fn();
            const onRemoveYear = vi.fn();

            render(
                <ActiveFilterBar
                    query="maps"
                    facets={{ 'subject': ['History'], '-subject': ['Math'] }}
                    yearRange="1900,2000"
                    onRemoveQuery={onRemoveQuery}
                    onRemoveFacet={onRemoveFacet}
                    onRemoveYearRange={onRemoveYear}
                    onClearAll={vi.fn()}
                />
            );

            expect(screen.getByText('Search: maps')).toBeDefined();
            expect(screen.getByText('Year: 1900 - 2000')).toBeDefined();
            expect(screen.getByText('History')).toBeDefined();
            expect(screen.getByText('Math')).toBeDefined();
            expect(screen.getByText('NOT')).toBeDefined();

            fireEvent.click(screen.getByTitle('Remove search term'));
            expect(onRemoveQuery).toHaveBeenCalled();

            fireEvent.click(screen.getByTitle('Remove year filter'));
            expect(onRemoveYear).toHaveBeenCalled();

            const facetRemoves = screen.getAllByTitle('Remove filter');
            fireEvent.click(facetRemoves[0]);
            expect(onRemoveFacet).toHaveBeenCalled();
        });
    });

    describe('AutosuggestInput', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('renders and handles input', async () => {
            const onChange = vi.fn();
            const onSearch = vi.fn();
            vi.mocked(duckdb.suggest).mockResolvedValue([{ text: 'suggestion', type: 'type', score: 1 }]);

            const { rerender } = render(<AutosuggestInput value="" onChange={onChange} onSearch={onSearch} />);

            const input = screen.getByRole('textbox');
            fireEvent.change(input, { target: { value: 'sug' } });

            expect(onChange).toHaveBeenCalledWith('sug');

            // Re-render
            rerender(<AutosuggestInput value="sug" onChange={onChange} onSearch={onSearch} />);

            // Fast-forward debounce
            React.act(() => {
                vi.advanceTimersByTime(400);
            });

            vi.useRealTimers();

            await waitFor(() => {
                expect(duckdb.suggest).toHaveBeenCalledWith('sug');
                expect(screen.getByText('suggestion')).toBeDefined();
            });

            // Click suggestion
            fireEvent.click(screen.getByText('suggestion'));
            expect(onChange).toHaveBeenCalledWith('suggestion');
            expect(onSearch).toHaveBeenCalledWith('suggestion', expect.anything());
        });

        it('handles enter key', () => {
            const onSearch = vi.fn();
            render(<AutosuggestInput value="term" onChange={vi.fn()} onSearch={onSearch} />);

            const input = screen.getByRole('textbox');
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onSearch).toHaveBeenCalledWith('term');
        });
    });

    describe('TagInput', () => {
        it('loads options and handles change', async () => {
            vi.mocked(duckdb.getDistinctValues).mockResolvedValue(['Option1', 'Option2']);
            const onChange = vi.fn();

            const { container } = render(<TagInput value={[]} onChange={onChange} fieldName="test" />);

            const input = container.querySelector('input');
            expect(input).toBeDefined();

            if (input) {
                // Focus triggers loadOptions? No, react-select needs input change usually
                fireEvent.change(input, { target: { value: 'Opt' } });

                await waitFor(() => {
                    expect(duckdb.getDistinctValues).toHaveBeenCalledWith('test', 'Opt');
                    expect(screen.getByText('Option1')).toBeDefined();
                });

                // Select option
                fireEvent.click(screen.getByText('Option1'));
                expect(onChange).toHaveBeenCalledWith(['Option1']);
            }
        });
    });

    describe('Link', () => {
        it('handles navigation', () => {
            render(<Link href="/test">Test Link</Link>);

            const link = screen.getByText('Test Link');
            fireEvent.click(link);

            expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/test');
            expect(dispatchSpy).toHaveBeenCalled();
        });

        it('ignores modifier clicks', () => {
            pushStateSpy.mockClear();
            render(<Link href="/test">Test Link</Link>);

            const link = screen.getByText('Test Link');
            fireEvent.click(link, { metaKey: true });

            expect(pushStateSpy).not.toHaveBeenCalled();
        });
    });
});
