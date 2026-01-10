import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGithubScanner } from './useGithubScanner';
import { GithubService } from '../services/GithubService';

// Mock GithubService module
vi.mock('../services/GithubService', () => {
    return {
        GithubService: vi.fn(function () {
            return {
                fetchRepoInfo: vi.fn(),
                fetchSubtree: vi.fn(),
                fetchRecursiveTree: vi.fn()
            };
        })
    };
});

describe('useGithubScanner', () => {
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClient = {
            fetchRepoInfo: vi.fn().mockResolvedValue({}),
            fetchSubtree: vi.fn().mockResolvedValue([]),
            fetchRecursiveTree: vi.fn().mockResolvedValue([])
        };

        (GithubService as any).mockImplementation(function () {
            return mockClient;
        });
    });

    it('scans aardvark folder successfully', async () => {
        mockClient.fetchRepoInfo.mockResolvedValue({ default_branch: 'main' });
        mockClient.fetchSubtree.mockResolvedValue([{ path: 'rec.json', sha: '123' }]);

        const { result } = renderHook(() => useGithubScanner());

        await act(async () => {
            await result.current.scan();
        });

        expect(result.current.foundFiles).toHaveLength(1);
        expect(result.current.foundFiles[0].path).toContain('metadata-aardvark/rec.json');
        expect(result.current.schemaMode).toBe('aardvark');
        expect(result.current.scanError).toBeNull();
    });

    it('switches to auto-detected default branch', async () => {
        mockClient.fetchRepoInfo.mockResolvedValue({ default_branch: 'master' });
        mockClient.fetchSubtree.mockResolvedValue([{ path: 'rec.json', sha: '123' }]);

        const { result } = renderHook(() => useGithubScanner());

        expect(result.current.branch).toBe('main');

        await act(async () => {
            await result.current.scan();
        });

        expect(result.current.branch).toBe('master');
    });

    it('falls back to json folder for legacy', async () => {
        mockClient.fetchRepoInfo.mockResolvedValue({ default_branch: 'main' });
        // First try (aardvark) fails (empty)
        mockClient.fetchSubtree.mockImplementation(async (_: any, path: string) => {
            if (path === 'metadata-aardvark') return []; // Empty -> fallback
            if (path === 'json') return [{ path: 'legacy.json', sha: '999' }];
            return [];
        });

        const { result } = renderHook(() => useGithubScanner());

        await act(async () => {
            await result.current.scan();
        });

        expect(result.current.schemaMode).toBe('gbl1');
        expect(result.current.foundFiles[0].path).toContain('json/legacy.json');
    });

    it('handles errors', async () => {
        // Mock rejection
        mockClient.fetchRepoInfo.mockRejectedValue(new Error('Repo Error'));
        mockClient.fetchSubtree.mockRejectedValue(new Error('Subtree Error'));
        mockClient.fetchRecursiveTree.mockRejectedValue(new Error('Network Error'));

        const { result } = renderHook(() => useGithubScanner());

        await act(async () => {
            await result.current.scan();
        });

        expect(result.current.scanError).toContain('Network Error');
        expect(result.current.isScanning).toBe(false);
    });
});
