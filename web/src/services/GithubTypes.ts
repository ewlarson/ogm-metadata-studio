// GitHub API Type Definitions

export interface GitHubUser {
    login: string;
    id: number;
    avatar_url: string;
    url: string;
    type: string;
    site_admin: boolean;
}

export interface GitHubRepo {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    owner: GitHubUser;
    html_url: string;
    description: string | null;
    fork: boolean;
    url: string;
    created_at: string;
    updated_at: string;
    pushed_at: string;
    git_url: string;
    ssh_url: string;
    clone_url: string;
    svn_url: string;
    homepage: string | null;
    size: number;
    stargazers_count: number;
    watchers_count: number;
    language: string | null;
    has_issues: boolean;
    has_projects: boolean;
    has_downloads: boolean;
    has_wiki: boolean;
    has_pages: boolean;
    forks_count: number;
    mirror_url: string | null;
    archived: boolean;
    disabled: boolean;
    open_issues_count: number;
    license: { key: string; name: string; spdx_id: string; url: string | null } | null;
    allow_forking: boolean;
    is_template: boolean;
    topics: string[];
    visibility: string;
    default_branch: string;
    permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface GitHubBranch {
    name: string;
    commit: {
        sha: string;
        url: string;
    };
    protected: boolean;
}

export interface GitHubTreeItem {
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
    url: string;
}

export interface GitHubTreeResponse {
    sha: string;
    url: string;
    tree: GitHubTreeItem[];
    truncated: boolean;
}

export interface GitHubBlob {
    content: string;
    encoding: "base64" | "utf-8";
    url: string;
    sha: string;
    size: number;
    node_id: string;
}

export interface GitHubContent {
    name: string;
    path: string;
    sha: string;
    size: number;
    url: string;
    html_url: string;
    git_url: string;
    download_url: string | null;
    type: "file" | "dir" | "submodule" | "symlink";
    content?: string;
    encoding?: string;
    _links: {
        self: string;
        git: string;
        html: string;
    };
}
