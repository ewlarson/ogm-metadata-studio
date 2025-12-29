import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GithubClient, GithubRepoRef } from './client';

describe('GithubClient', () => {
    let client: GithubClient;
    const mockRepoRef: GithubRepoRef = {
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main'
    };

    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
        client = new GithubClient({ token: 'fake-token' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('adds authorization header', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({})
        });

        // access private method via verifyRepoAndBranch which calls request
        await client.verifyRepoAndBranch(mockRepoRef);

        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('https://api.github.com/repos/test-owner/test-repo'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'token fake-token'
                })
            })
        );
    });

    it('handles rate limits', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 403,
            headers: new Map([
                ['x-ratelimit-limit', '60'],
                ['x-ratelimit-remaining', '0'],
                ['x-ratelimit-reset', '1600000000']
            ]),
            text: async () => 'Rate limit exceeded'
        });

        await expect(client.verifyRepoAndBranch(mockRepoRef))
            .rejects.toThrow(/Rate Limit Exceeded/);
    });

    it('fetches blob and decodes base64', async () => {
        const mockContent = "Hello World";
        const mockBase64 = btoa(mockContent);

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                content: mockBase64,
                encoding: "base64"
            })
        });

        // fetchBlob returns parsed JSON usually? 
        // The implementation tries JSON.parse(utf8Str).
        // So let's make the content valid JSON.
        const jsonContent = JSON.stringify({ foo: "bar" });
        const jsonBase64 = btoa(jsonContent);

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                content: jsonBase64,
                encoding: "base64"
            })
        });

        const result = await client.fetchBlob(mockRepoRef, 'some-sha');
        expect(result).toEqual({ foo: "bar" });
    });

    it('fetches subtree correctly', async () => {
        // 1. fetch branch
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ commit: { sha: 'root-sha' } })
        });

        // 2. fetch root tree
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                tree: [
                    { path: 'metadata', type: 'tree', sha: 'meta-sha' }
                ],
                truncated: false
            })
        });

        // 3. fetch recursive subtree
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                tree: [
                    { path: 'file1.json', type: 'blob', sha: 'blob-sha' }
                ],
                truncated: false
            })
        });

        const result = await client.fetchSubtree(mockRepoRef, 'metadata');
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('file1.json');
    });
});
