// Minimal GitHub API client for browser use.
// Uses a Personal Access Token (PAT) provided by the user.

export interface GithubClientOptions {
  token: string;
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
  private readonly token: string;

  constructor(options: GithubClientOptions) {
    this.token = options.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${this.token}`,
        ...(init.headers || {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub API error ${res.status}: ${text || res.statusText}`
      );
    }
    return (await res.json()) as T;
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
    } catch (err) {
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

export async function upsertJsonFile(
  client: GithubClient,
  config: ProjectConfig,
  path: string,
  json: unknown,
  message: string
): Promise<void> {
  const owner = config.owner;
  const repo = config.repo;
  const branch = config.branch;

  let existingSha: string | undefined;
  try {
    const existing: any = await (client as any)["request"](
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
        branch
      )}`
    );
    existingSha = existing.sha as string | undefined;
  } catch (err) {
    // 404 means new file; anything else should surface
    if (!(err instanceof Error) || !err.message.includes("404")) {
      throw err;
    }
  }

  const content = toBase64Utf8(JSON.stringify(json, null, 2));
  const body: any = {
    message,
    content,
    branch,
  };
  if (existingSha) {
    body.sha = existingSha;
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

export async function upsertTextFile(
  client: GithubClient,
  config: ProjectConfig,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const owner = config.owner;
  const repo = config.repo;
  const branch = config.branch;

  const encoded = toBase64Utf8(content);

  async function putWithSha(sha: string | undefined): Promise<void> {
    const body: any = {
      message,
      content: encoded,
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

  try {
    await putWithSha(existingSha);
  } catch (err) {
    if (err instanceof Error && err.message.includes("does not match")) {
      // SHA is out of date; fetch latest and retry once.
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


