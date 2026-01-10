import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    GithubService,
    GithubRepoRef,
    ProjectConfig,
    saveProjectConfig,
    loadProjectConfig,
    clearStoredAuth,
    upsertJsonFile,
    upsertTextFile
} from './GithubService';

describe('GithubService', () => {
    let client: GithubService;
    const mockRepoRef: GithubRepoRef = {
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main'
    };

    const mockConfig: ProjectConfig = {
        ...mockRepoRef,
        metadataPath: 'metadata'
    };

    const mockFetch = vi.fn();

    beforeEach(() => {
        mockFetch.mockReset();
        vi.stubGlobal('fetch', mockFetch);
        // Mock localStorage
        const localStorageMock = (function () {
            let store: Record<string, string> = {};
            return {
                getItem: vi.fn((key: string) => store[key] || null),
                setItem: vi.fn((key: string, value: string) => { saveProjectConfig; store[key] = value.toString(); }),
                removeItem: vi.fn((key: string) => { delete store[key]; }),
                clear: vi.fn(() => { store = {}; })
            };
        })();
        vi.stubGlobal('localStorage', localStorageMock);

        client = new GithubService({ token: 'fake-token' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('Core Request Logic', () => {
        it('adds authorization header', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({})
            });

            await client.verifyRepoAndBranch(mockRepoRef);

            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('/repos/test-owner/test-repo'),
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

        it('handles generic API errors', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error'
            });

            await expect(client.fetchRepoInfo('owner', 'repo'))
                .rejects.toThrow(/GitHub API error 500/);
        });
    });

    describe('Fetch Data', () => {
        it('fetchRepoInfo calls correct endpoint', async () => {
            mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) });
            await client.fetchRepoInfo('owner', 'repo');
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('/repos/owner/repo'),
                expect.anything()
            );
        });

        it('fetchPublicJson fetches raw content', async () => {
            mockFetch.mockResolvedValue({ ok: true, json: async () => ({ foo: 'bar' }) });
            const data = await client.fetchPublicJson(mockRepoRef, 'data.json');
            expect(data).toEqual({ foo: 'bar' });
            expect(mockFetch).toHaveBeenCalledWith(
                'https://raw.githubusercontent.com/test-owner/test-repo/main/data.json'
            );
        });

        it('fetchBlob decodes base64', async () => {
            const mockContent = JSON.stringify({ foo: "bar" });
            const mockBase64 = btoa(mockContent);

            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: mockBase64,
                    encoding: "base64"
                })
            });

            const result = await client.fetchBlob(mockRepoRef, 'sha');
            expect(result).toEqual({ foo: "bar" });
        });

        it('fetchBlob throws on unsupported encoding', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: 'xyz',
                    encoding: "none"
                })
            });
            await expect(client.fetchBlob(mockRepoRef, 'sha')).rejects.toThrow(/Unsupported blob encoding/);
        });
    });

    describe('Tree & Subtree', () => {
        it('fetchRecursiveTree calls git/trees with recursive=1', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ commit: { sha: 'root-sha' } })
            }); // branch fetch

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ tree: [], truncated: false })
            }); // tree fetch

            await client.fetchRecursiveTree(mockRepoRef);

            expect(mockFetch).toHaveBeenLastCalledWith(
                expect.stringMatching(/git\/trees\/root-sha\?recursive=1/),
                expect.anything()
            );
        });

        it('fetchSubtree filters correctly', async () => {
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
                    ]
                })
            });

            // 3. fetch recursive subtree
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    tree: [
                        { path: 'file1.json', type: 'blob', sha: 'blob-sha' }
                    ]
                })
            });

            const result = await client.fetchSubtree(mockRepoRef, 'metadata');
            expect(result).toHaveLength(1);
            expect(result[0].path).toBe('file1.json');
        });
    });

    describe('Project Config & Helpers', () => {
        it('metadataDirectoryStatus returns present if exists', async () => {
            mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
            const status = await client.metadataDirectoryStatus(mockConfig);
            expect(status).toBe('present');
        });

        it('metadataDirectoryStatus returns missing if 404', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' });
            const status = await client.metadataDirectoryStatus(mockConfig);
            expect(status).toBe('missing');
        });

        it('listMetadataJsonFiles filters json files', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ([
                    { name: 'a.json', path: 'meta/a.json', sha: '1', type: 'file' },
                    { name: 'b.txt', path: 'meta/b.txt', sha: '2', type: 'file' },
                    { name: 'folder', path: 'meta/folder', sha: '3', type: 'dir' }
                ])
            });

            const files = await client.listMetadataJsonFiles(mockConfig);
            expect(files).toHaveLength(1);
            expect(files[0].name).toBe('a.json');
        });

        it('readJsonFile decodes content', async () => {
            const content = btoa(JSON.stringify({ val: 1 }));
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ content, encoding: 'base64' })
            });

            const data = await client.readJsonFile(mockConfig, 'path.json');
            expect(data).toEqual({ val: 1 });
        });
    });

    describe('Upsert Logic', () => {
        it('upsertFile handles simple put (create)', async () => {
            // 1. Get SHA -> 404 (new file)
            mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });
            // 2. PUT
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

            await client.upsertFile(mockConfig, 'new.json', 'base64', 'msg');

            // Should verify PUT body
            const putCall = mockFetch.mock.calls[1];
            expect(putCall[1].method).toBe('PUT');
            const body = JSON.parse(putCall[1].body);
            expect(body.sha).toBeUndefined();
        });

        it('upsertFile handles update with SHA', async () => {
            // 1. Get SHA -> Found
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sha: 'old-sha' }) });
            // 2. PUT
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

            await client.upsertFile(mockConfig, 'exist.json', 'base64', 'msg');

            const putCall = mockFetch.mock.calls[1];
            const body = JSON.parse(putCall[1].body);
            expect(body.sha).toBe('old-sha');
        });

        it('upsertFile retries on SHA mismatch', async () => {
            // 1. Get SHA -> Found
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sha: 'old-sha' }) });
            // 2. PUT -> Fail (mismatch)
            mockFetch.mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'sha does not match' });
            // 3. Get SHA again (retry)
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sha: 'new-sha' }) });
            // 4. PUT again
            mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

            await client.upsertFile(mockConfig, 'exist.json', 'base64', 'msg');

            expect(mockFetch).toHaveBeenCalledTimes(4);
            const lastPut = mockFetch.mock.calls[3];
            const body = JSON.parse(lastPut[1].body);
            expect(body.sha).toBe('new-sha');
        });
    });

    describe('LocalStorage Config', () => {
        it('saves and loads config', () => {
            saveProjectConfig(mockConfig);
            expect(localStorage.setItem).toHaveBeenCalledWith('aardvark-project-config', JSON.stringify(mockConfig));

            // Manually mock return for load since our stub mimics behavior but let's be explicit
            vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(mockConfig));
            const loaded = loadProjectConfig();
            expect(loaded).toEqual(mockConfig);
        });

        it('clears auth', () => {
            clearStoredAuth();
            expect(localStorage.removeItem).toHaveBeenCalledWith('aardvark-project-config');
            expect(localStorage.removeItem).toHaveBeenCalledWith('aardvark-github-token');
        });

        it('loadProjectConfig handles missing/invalid', () => {
            vi.mocked(localStorage.getItem).mockReturnValue(null);
            expect(loadProjectConfig()).toBeNull();

            vi.mocked(localStorage.getItem).mockReturnValue("invalid json");
            expect(loadProjectConfig()).toBeNull();
        });
    });

    describe('Helpers', () => {
        it('upsertJsonFile calls upsertFile with base64 json', async () => {
            const spy = vi.spyOn(client, 'upsertFile').mockResolvedValue();
            const obj = { x: 1 };
            await upsertJsonFile(client, mockConfig, 'path', obj, 'msg');

            expect(spy).toHaveBeenCalledWith(
                mockConfig,
                'path',
                expect.any(String), // base64 string
                'msg'
            );
        });
    });
});
