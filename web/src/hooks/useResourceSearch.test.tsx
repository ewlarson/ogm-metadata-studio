import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useResourceSearch } from './useResourceSearch';
import * as duckdbClient from '../duckdb/duckdbClient';

// Mock DuckDB Client
vi.mock('../duckdb/duckdbClient', () => ({
    facetedSearch: vi.fn()
}));

// Mock useUrlState to behave like useState but execute config
vi.mock('./useUrlState', () => ({
    useUrlState: (initial: any, config: any) => {
        const [state, setState] = React.useState(() => {
            // Simulate "fromUrl" on mount
            if (config && config.fromUrl && typeof window !== 'undefined') {
                const params = new URLSearchParams(window.location.search);
                const parsed = config.fromUrl(params);
                return { ...initial, ...parsed };
            }
            return initial;
        });

        // Simulate "toUrl" side effect
        React.useEffect(() => {
            if (config && config.toUrl) {
                const params = config.toUrl(state);
                const str = params.toString();
                window.history.replaceState({}, '', str ? '?' + str : '/');
            }
        }, [state]);

        return [state, setState];
    }
}));

import React from 'react'; // ensure React is available for mock

describe('useResourceSearch', () => {
    const stableConfig: any[] = []; // Stable reference

    beforeEach(() => {
        vi.clearAllMocks();
        window.history.replaceState({}, '', '/');
    });

    it('initializes and fetches default data', async () => {
        vi.mocked(duckdbClient.facetedSearch).mockResolvedValue({
            results: [],
            facets: {},
            total: 0
        });

        const { result } = renderHook(() => useResourceSearch(stableConfig));

        expect(result.current.loading).toBe(true);

        await waitFor(() => {
            expect(result.current.loading).toBe(false);
        });

        expect(duckdbClient.facetedSearch).toHaveBeenCalledWith(expect.objectContaining({
            q: "",
            page: { size: 20, from: 0 }
        }));
    });

    it('updates search query and URL', async () => {
        vi.mocked(duckdbClient.facetedSearch).mockResolvedValue({
            results: [],
            facets: {},
            total: 0
        });

        const { result } = renderHook(() => useResourceSearch(stableConfig));

        await waitFor(() => expect(result.current.loading).toBe(false));

        act(() => {
            result.current.setState(prev => ({ ...prev, q: "maps" }));
        });

        await waitFor(() => {
            expect(result.current.state.q).toBe("maps");
            expect(window.location.search).toContain("q=maps");
        });

        expect(duckdbClient.facetedSearch).toHaveBeenCalledWith(expect.objectContaining({
            q: "maps"
        }));
    });

    it('handles facet toggling (include/exclude)', async () => {
        vi.mocked(duckdbClient.facetedSearch).mockResolvedValue({
            results: [],
            facets: {},
            total: 0
        });

        const { result } = renderHook(() => useResourceSearch(stableConfig));
        await waitFor(() => expect(result.current.loading).toBe(false));

        // Toggle Include
        act(() => {
            result.current.toggleFacet("subject", "History", "include");
        });

        await waitFor(() => {
            expect(window.location.search).toContain("include_filters%5Bsubject%5D%5B%5D=History"); // URL encoded
        });

        // Toggle Exclude
        act(() => {
            result.current.toggleFacet("subject", "Math", "exclude");
        });

        await waitFor(() => {
            expect(result.current.state.facets['-subject']).toContain("Math");
        });
    });

    it('parses URL on mount', async () => {
        vi.mocked(duckdbClient.facetedSearch).mockResolvedValue({
            results: [],
            facets: {},
            total: 0
        });

        window.history.replaceState({}, '', '/?q=test&page=2');

        const { result } = renderHook(() => useResourceSearch(stableConfig));

        await waitFor(() => {
            expect(result.current.state.q).toBe("test");
            expect(result.current.state.page).toBe(2);
        });
    });
});
