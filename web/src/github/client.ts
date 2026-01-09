// Minimal GitHub API client for browser use.
// Uses a Personal Access Token (PAT) provided by the user.

export interface GithubClientOptions {
  token?: string;
}

export interface GithubRepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export interface ProjectConfig extends GithubRepoRef {
  metadataPath: string;
}

const STORAGE_KEY = "aardvark-project-config";

export class GithubClient {
  private readonly token?: string;

  constructor(options: GithubClientOptions) {
    this.token = options.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      ...(init.headers as Record<string, string> || {}),
    };

    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }

    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers,
    });

    if (!res.ok) {
      // Handle Rate Limit specifically
      if (res.status === 403 || res.status === 429) {
        const limit = res.headers.get("x-ratelimit-limit");
        const remain = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        throw new Error(`GitHub Rate Limit Exceeded. Limit: ${limit}, Remaining: ${remain}. Resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}. Provide a Token!`);
      }

      const text = await res.text();
      throw new Error(
        `GitHub API error ${res.status}: ${text || res.statusText}`
      );
    }
    return (await res.json()) as T;
  }

  async fetchRepoInfo(owner: string, repo: string): Promise<any> {
    return this.request(`/repos/${owner}/${repo}`);
  }



  async fetchTree(): Promise<{ path: string; sha: string; type: string }[]> {
    // This method needs repo context to work, but the current class structure assumes methods work on any repo
    // if passed in via GithubRepoRef. The previous `fetchRecursiveTree` took `repoRef`.
    // The previous edit introduced a broken placeholder. 
    // We will rely on `fetchTreeData` which takes `repoRef`.
    throw new Error("Use fetchTreeData with repoRef instead.");
  }

  private async fetchTreeData(repoRef: GithubRepoRef, sha: string, recursive: boolean): Promise<{ path: string; sha: string; type: string }[]> {
    const { owner, repo } = repoRef;
    const url = `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
    const treeData = await this.request<{ tree: { path: string; mode: string; type: string; sha: string }[], truncated: boolean }>(url);

    if (treeData.truncated) {
      console.warn("GitHub tree response truncated. Some files may be missing.");
    }

    return treeData.tree.map(i => ({
      path: i.path,
      sha: i.sha,
      type: i.type === "blob" ? "blob" : "tree"
    }));
  }

  async fetchRecursiveTree(repoRef: GithubRepoRef): Promise<{ path: string; sha: string; type: string }[]> {
    const { owner, repo, branch } = repoRef;
    const branchData = await this.request<{ commit: { sha: string } }>(
      `/repos/${owner}/${repo}/branches/${branch}`
    );
    return this.fetchTreeData(repoRef, branchData.commit.sha, true);
  }

  // Fetch only the tree for a specific folder path (e.g. metadata-aardvark)
  async fetchSubtree(repoRef: GithubRepoRef, targetPath: string): Promise<{ path: string; sha: string; type: string }[]> {
    try {
      // 1. Get Root Tree (Non-recursive)
      const { owner, repo, branch } = repoRef;
      const branchData = await this.request<{ commit: { sha: string } }>(
        `/repos/${owner}/${repo}/branches/${branch}`
      );
      const rootTree = await this.fetchTreeData(repoRef, branchData.commit.sha, false);

      // 2. Find the target folder
      const target = rootTree.find(i => i.path === targetPath && i.type === "tree");
      if (!target) {
        return [];
      }

      // 3. Fetch that tree recursively
      return await this.fetchTreeData(repoRef, target.sha, true);

    } catch (e) {
      console.error("Subtree fetch failed", e);
      throw e;
    }
  }

  async fetchBlob(repoRef: GithubRepoRef, sha: string): Promise<any> {
    const { owner, repo } = repoRef;
    const data = await this.request<{ content: string; encoding: string }>(
      `/repos/${owner}/${repo}/git/blobs/${sha}`
    );
    if (data.encoding === "base64") {
      const binaryString = atob(data.content.replace(/\s/g, ''));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const utf8Str = new TextDecoder().decode(bytes);
      return JSON.parse(utf8Str);
    } else {
      throw new Error(`Unsupported blob encoding: ${data.encoding}`);
    }
  }

  async fetchPublicJson(repoRef: GithubRepoRef, path: string): Promise<any> {
    const { owner, repo, branch } = repoRef;
    // Encode path segments but preserve slashes
    const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');

    // Cache bust query param? No, we likely want cached for speed.
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodedPath}`;

    const res = await fetch(url);
    if (!res.ok) {
      // Check if it might be an API rate limit response disguised as 403 (sometimes Raw limits too but different)
      throw new Error(`Failed to fetch raw content: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  async verifyRepoAndBranch(ref: GithubRepoRef): Promise<void> {
    // Check repo exists and is accessible.
    await this.request(`/repos/${ref.owner}/${ref.repo}`);
    // Check branch exists.
    await this.request(`/repos/${ref.owner}/${ref.repo}/branches/${ref.branch}`);
  }

  async metadataDirectoryStatus(
    config: ProjectConfig
  ): Promise<"present" | "missing"> {
    try {
      await this.request(
        `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(
          config.metadataPath
        )}?ref=${encodeURIComponent(config.branch)}`
      );
      return "present";
    } catch {
      return "missing";
    }
  }

  async listMetadataJsonFiles(
    config: ProjectConfig
  ): Promise<{ name: string; path: string; sha: string }[]> {
    const res = await this.request<
      Array<{ type: string; name: string; path: string; sha: string }>
    >(
      `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(
        config.metadataPath
      )}?ref=${encodeURIComponent(config.branch)}`
    );

    return res
      .filter((item) => item.type === "file" && item.name.endsWith(".json"))
      .map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
      }));
  }

  async readJsonFile(
    config: ProjectConfig,
    path: string
  ): Promise<unknown> {
    const res = await this.request<{
      content: string;
      encoding: string;
    }>(
      `/repos/${config.owner}/${config.repo}/contents/${path}?ref=${encodeURIComponent(
        config.branch
      )}`
    );
    if (res.encoding !== "base64") {
      throw new Error("Unexpected encoding for GitHub file content.");
    }
    const decoded = atob(res.content.replace(/\n/g, ""));
    return JSON.parse(decoded);
  }
}

function toBase64Utf8(text: string): string {
  // Encode UTF-8 safely for btoa
  return btoa(unescape(encodeURIComponent(text)));
}


async function upsertFile(
  client: GithubClient,
  config: ProjectConfig,
  path: string,
  contentBase64: string,
  message: string
): Promise<void> {
  const { owner, repo, branch } = config;

  async function putWithSha(sha: string | undefined): Promise<void> {
    const body: any = {
      message,
      content: contentBase64,
      branch,
    };
    if (sha) {
      body.sha = sha;
    }
    await (client as any)["request"](
      `/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  // 1. Get existing SHA
  let existingSha: string | undefined;
  try {
    const existing: any = await (client as any)["request"](
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
        branch
      )}`
    );
    existingSha = existing.sha as string | undefined;
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("404")) {
      throw err;
    }
  }

  // 2. Try PUT with SHA
  try {
    await putWithSha(existingSha);
  } catch (err) {
    if (err instanceof Error && err.message.includes("does not match")) {
      // SHA is out of date; fetch latest and retry once.
      console.warn(`SHA mismatch for ${path}, retrying...`);
      const latest: any = await (client as any)["request"](
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
          branch
        )}`
      );
      const latestSha = latest.sha as string | undefined;
      await putWithSha(latestSha);
    } else {
      throw err;
    }
  }
}

export async function upsertJsonFile(
  client: GithubClient,
  config: ProjectConfig,
  path: string,
  json: unknown,
  message: string
): Promise<void> {
  const content = toBase64Utf8(JSON.stringify(json, null, 2));
  await upsertFile(client, config, path, content, message);
}

export async function upsertTextFile(
  client: GithubClient,
  config: ProjectConfig,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const encoded = toBase64Utf8(content);
  await upsertFile(client, config, path, encoded, message);
}

export function saveProjectConfig(config: ProjectConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function loadProjectConfig(): ProjectConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectConfig;
    if (!parsed.owner || !parsed.repo || !parsed.branch) return null;
    if (!parsed.metadataPath) {
      parsed.metadataPath = "metadata";
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearStoredAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("aardvark-github-token");
}


