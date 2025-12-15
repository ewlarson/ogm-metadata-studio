import React, { useEffect, useState } from "react";
import { Resource, resourceFromJson, resourceToJson } from "../aardvark/model";
import {
  GithubClient,
  ProjectConfig,
  loadProjectConfig,
  saveProjectConfig,
  upsertJsonFile,
  upsertTextFile,
} from "../github/client";
import { buildResourcesCsv, buildDistributionsCsv } from "../aardvark/tabular";
import { flattenResource, extractDistributionsFromJson } from "../aardvark/mapping";
import { getDuckDbContext, queryResources, queryResourceById, exportDuckDbToBlob } from "../duckdb/duckdbClient";
import { TabularEditor } from "./TabularEditor";

const TOKEN_STORAGE_KEY = "aardvark-github-token"; // Now using localStorage

// Resource list table component that queries DuckDB
const ResourceListTable: React.FC<{
  selectedId: string | null;
  project: ProjectConfig | null;
  isLoadingData: boolean;
  onSelectResource: (resource: Resource) => void;
  onRefresh: () => void;
}> = ({ selectedId, project, isLoadingData, onSelectResource, onRefresh }) => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (project && !isLoadingData) {
      // Reload when project connects and data loading is complete
      // Add a small delay to ensure DuckDB is ready
      const timer = setTimeout(() => {
        loadResources();
      }, 100);
      return () => clearTimeout(timer);
    } else if (!project) {
      // Clear resources when project is disconnected
      setResources([]);
      setIsLoading(false);
    }
  }, [project, isLoadingData, selectedId]); // Refresh when project, loading state, or selection changes

  async function loadResources() {
    if (!project) {
      // In anonymous mode, just query duckdb directly
      // We assume DuckDB is already populated from parquet
      try {
        const res = await queryResources();
        setResources(res);
        onRefresh();
      } catch {
        setResources([]);
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const res = await queryResources();
      if (res.length === 0) {
        // If DuckDB is empty, try loading from localStorage fallback
        const fallback = localStorage.getItem(`aardvark-resources-${project.owner}-${project.repo}`);
        if (fallback) {
          try {
            const parsed = JSON.parse(fallback) as Resource[];
            setResources(parsed);
            onRefresh();
            setIsLoading(false);
            return;
          } catch {
            // Invalid fallback data, continue with empty
          }
        }
      }
      setResources(res);
      onRefresh(); // Update count
    } catch (err) {
      console.error("Failed to load resources from DuckDB", err);
      // Try fallback
      const fallback = localStorage.getItem(`aardvark-resources-${project.owner}-${project.repo}`);
      if (fallback) {
        try {
          const parsed = JSON.parse(fallback) as Resource[];
          setResources(parsed);
          onRefresh();
        } catch {
          setResources([]);
        }
      } else {
        setResources([]);
      }
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="mt-3 text-xs text-slate-400">Loading resources from DuckDB...</div>
    );
  }

  if (resources.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
      <table className="min-w-full divide-y divide-slate-800 text-xs">
        <thead className="bg-slate-900/80">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-slate-400 uppercase tracking-wide text-[10px]">
              ID
            </th>
            <th className="px-3 py-2 text-left font-semibold text-slate-400 uppercase tracking-wide text-[10px]">
              Title
            </th>
            <th className="px-3 py-2 text-left font-semibold text-slate-400 uppercase tracking-wide text-[10px]">
              Access
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800 bg-slate-900/40">
          {resources.map((r) => (
            <tr
              key={r.id}
              className={`hover:bg-slate-800/60 cursor-pointer ${selectedId === r.id ? "bg-slate-800/80" : ""
                }`}
              onClick={() => onSelectResource(r)}
            >
              <td className="px-3 py-2 font-mono text-[11px] text-slate-200">
                {r.id}
              </td>
              <td className="px-3 py-2 text-[12px] text-slate-100">
                {r.dct_title_s}
              </td>
              <td className="px-3 py-2 text-[11px] text-slate-300">
                {r.dct_accessRights_s}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

async function syncDuckDbFromResources(resources: Resource[]): Promise<void> {
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) {
      console.warn("DuckDB not available, skipping sync");
      return;
    }
    const conn: any = await (ctx.db as any).connect();

    // Build flattened rows for resources table
    const rows = resources.map((r) => flattenResource(r));
    if (rows.length === 0) {
      await conn.query("DROP TABLE IF EXISTS resources");
      await conn.query("DROP TABLE IF EXISTS distributions");
      await conn.close?.();
      return;
    }

    const fieldnames = Array.from(
      new Set(rows.flatMap((r) => Object.keys(r)))
    );

    await conn.query("DROP TABLE IF EXISTS resources");
    const columnsSql = fieldnames.map((n) => `"${n}" TEXT`).join(", ");
    await conn.query(`CREATE TABLE resources (${columnsSql});`);

    const placeholders = fieldnames.map(() => "?").join(", ");
    const stmt = await conn.prepare(`INSERT INTO resources VALUES (${placeholders})`);
    try {
      for (const row of rows) {
        const values = fieldnames.map((n) => row[n] ?? null);
        await stmt.query(...values);
      }
    } finally {
      await stmt.close();
    }

    // Build distributions table from dct_references_s
    const distRows: { resource_id: string; relation_key: string; url: string }[] = [];
    for (const res of resources) {
      const json = resourceToJson(res);
      const dists = extractDistributionsFromJson(json);
      for (const d of dists) {
        distRows.push({
          resource_id: d.resource_id,
          relation_key: d.relation_key,
          url: d.url,
        });
      }
    }

    await conn.query("DROP TABLE IF EXISTS distributions");
    await conn.query(
      "CREATE TABLE distributions (resource_id TEXT, relation_key TEXT, url TEXT);"
    );
    if (distRows.length > 0) {
      const distStmt = await conn.prepare("INSERT INTO distributions VALUES (?, ?, ?)");
      try {
        for (const d of distRows) {
          await distStmt.query(d.resource_id, d.relation_key, d.url);
        }
      } finally {
        await distStmt.close();
      }
    }

    await conn.close?.();

    // Persist to IndexedDB after syncing
    const dbCtx = await getDuckDbContext();
    if (dbCtx && dbCtx.db) {
      const { persistDuckDbToIndexedDB } = await import("../duckdb/duckdbClient");
      await persistDuckDbToIndexedDB(dbCtx.db);
    }
  } catch (e) {
    // DuckDB is an internal optimization; don't break the UX if it fails.
    console.error("Failed to sync DuckDB from resources", e);
  }
}

export const App: React.FC = () => {
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [metadataPath, setMetadataPath] = useState("metadata");
  const [status, setStatus] = useState<string>("Not connected");
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [resourceCount, setResourceCount] = useState<number>(0); // Track count for UI
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [classText, setClassText] = useState<string>("");
  const [descText, setDescText] = useState<string>("");
  const [rememberToken, setRememberToken] = useState(false);
  const [showTabularEditor, setShowTabularEditor] = useState(false);
  const [isExportingDuckDb, setIsExportingDuckDb] = useState(false);

  // Refresh resource count from DuckDB
  async function refreshResourceCount() {
    // If project is not set, we might still have loaded parquet data
    try {
      const resources = await queryResources();
      setResourceCount(resources.length);
    } catch (err) {
      console.error("Failed to refresh resource count from DuckDB", err);
      setResourceCount(0);
    }
  }

  // Initial load: try to load Parquet file if available
  useEffect(() => {
    async function init() {
      // Only try loading parquet if we haven't successfully restored state 
      // or if we want to ensure fresh data.
      // For now, let's try importing parquet on every full reload 
      // if the table is empty or missing.

      const ctx = await getDuckDbContext();
      if (!ctx || !ctx.db) return;

      const { importParquetFromUrl } = await import("../duckdb/duckdbClient");
      const resources = await queryResources();

      if (resources.length === 0) {
        console.log("DuckDB empty, attempting to load resources.parquet...");
        try {
          // We use absolute path to ensure worker can find it
          const url = new URL("resources.parquet", window.location.href).href;
          console.log("Attempting to load parquet from", url);
          const success = await importParquetFromUrl(url, "resources");
          if (success) {
            console.log("Successfully loaded resources.parquet");
            await refreshResourceCount();
          } else {
            console.log("resources.parquet not found or failed to load");
            setDataError("Failed to import resources.parquet (check console)");
          }
        } catch (e) {
          console.warn("Failed to load parquet", e);
          setDataError(`Failed to load parquet: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    init();
  }, []);

  useEffect(() => {
    const saved = loadProjectConfig();
    const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);

    if (saved) {
      setOwner(saved.owner);
      setRepo(saved.repo);
      setBranch(saved.branch);
      setMetadataPath(saved.metadataPath);
    }

    if (storedToken) {
      setToken(storedToken);
    }

    // Auto-connect if both token and project config exist
    if (saved && storedToken) {
      // Set the form fields and trigger auto-connect
      setOwner(saved.owner);
      setRepo(saved.repo);
      setBranch(saved.branch);
      setMetadataPath(saved.metadataPath);
      setToken(storedToken);

      // Auto-connect after a brief delay to ensure state is set
      setTimeout(() => {
        handleConnect();
      }, 100);
    } else if (saved) {
      setStatus(
        `Project remembered: ${saved.owner}/${saved.repo} @ ${saved.branch} (paste token to connect)`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Don't auto-refresh from DuckDB on project change - let handleConnect do it

  function parseOwnerRepo(
    ownerInput: string,
    repoInput: string
  ): { owner: string; repo: string } | null {
    const ownerTrimmed = ownerInput.trim();
    const repoTrimmed = repoInput.trim();

    // If repo field is a full URL or SSH, try to parse owner/repo from it.
    const candidate = repoTrimmed || ownerTrimmed;
    if (!candidate) return null;

    // Strip .git suffix to be tolerant of clone URLs.
    const stripped = candidate.replace(/\.git$/i, "");

    // HTTP(S) URL: https://github.com/owner/repo
    if (stripped.includes("github.com")) {
      try {
        const url = stripped.startsWith("http")
          ? new URL(stripped)
          : new URL(stripped.replace("git@github.com:", "https://github.com/").replace("ssh://git@", "https://"));
        const parts = url.pathname.replace(/^\/+/, "").split("/");
        if (parts.length >= 2) {
          return { owner: parts[0], repo: parts[1] };
        }
      } catch {
        // fall through to other heuristics
      }
    }

    // SSH style: git@github.com:owner/repo
    if (stripped.startsWith("git@github.com:")) {
      const rest = stripped.replace("git@github.com:", "");
      const parts = rest.split("/");
      if (parts.length >= 2) {
        return { owner: parts[0], repo: parts[1] };
      }
    }

    // Plain owner/repo pattern in a single field
    if (!ownerTrimmed && stripped.includes("/")) {
      const [o, r] = stripped.split("/");
      if (o && r) return { owner: o, repo: r };
    }

    if (ownerTrimmed && repoTrimmed) {
      return { owner: ownerTrimmed, repo: repoTrimmed };
    }

    return null;
  }

  async function handleConnect(
    e?: React.FormEvent | React.MouseEvent
  ) {
    e?.preventDefault();
    setError(null);

    if (!token.trim()) {
      setError("Please paste a GitHub Personal Access Token.");
      return;
    }
    const parsed = parseOwnerRepo(owner, repo);
    if (!parsed) {
      setError(
        "Please provide at least a GitHub owner/repo or a full repository URL."
      );
      return;
    }
    const normalizedOwner = parsed.owner;
    const normalizedRepo = parsed.repo;

    setIsConnecting(true);
    try {
      const client = new GithubClient({ token: token.trim() });
      const config: ProjectConfig = {
        owner: normalizedOwner,
        repo: normalizedRepo,
        branch: branch.trim() || "main",
        metadataPath: metadataPath.trim() || "metadata",
      };

      await client.verifyRepoAndBranch(config);
      const metaStatus = await client.metadataDirectoryStatus(config);

      // Load existing metadata JSON files from GitHub.
      setIsLoadingData(true);
      setDataError(null);
      try {
        const files = await client.listMetadataJsonFiles(config);
        console.log(`Found ${files.length} JSON files in GitHub`);
        const all: Resource[] = [];
        for (const f of files) {
          try {
            const json = (await client.readJsonFile(config, f.path)) as unknown;
            const res = resourceFromJson(json as any);
            all.push(res);
            console.log(`Loaded resource: ${res.id}`);
          } catch (innerErr) {
            console.error("Failed to parse resource", f.path, innerErr);
          }
        }
        // Populate DuckDB with resources from GitHub (DuckDB is source of truth)
        // Check if DuckDB is available first
        const ctx = await getDuckDbContext();
        if (ctx && ctx.db) {
          try {
            console.log(`Populating DuckDB with ${all.length} resources from GitHub...`);
            await syncDuckDbFromResources(all);

            // Persist DuckDB to IndexedDB
            const { persistDuckDbToIndexedDB } = await import("../duckdb/duckdbClient");
            await persistDuckDbToIndexedDB(ctx.db);
            console.log("Successfully populated and persisted DuckDB");

            // Refresh resource count from DuckDB
            await refreshResourceCount();
          } catch (duckdbErr) {
            console.warn("DuckDB population failed, using localStorage fallback:", duckdbErr);
            // Store in localStorage as fallback
            localStorage.setItem(`aardvark-resources-${config.owner}-${config.repo}`, JSON.stringify(all));
            setResourceCount(all.length);
          }
        } else {
          // DuckDB not available - use localStorage fallback
          console.warn("DuckDB not available (CORS issue in development), using localStorage fallback");
          localStorage.setItem(`aardvark-resources-${config.owner}-${config.repo}`, JSON.stringify(all));
          setResourceCount(all.length);
        }
      } catch (loadErr) {
        console.error(loadErr);
        setDataError(
          loadErr instanceof Error
            ? loadErr.message
            : "Could not load existing metadata files from GitHub."
        );
      } finally {
        setIsLoadingData(false);
      }

      saveProjectConfig(config);
      // Always save token to localStorage for persistence
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
      setProject(config);
      setSelectedId(null);
      setEditing(null);
      setStatus(
        `Connected to ${config.owner}/${config.repo} @ ${config.branch}${metaStatus === "present" ? " (metadata/ found)" : " (metadata/ missing yet)"
        }`
      );
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error
          ? err.message
          : "Could not verify repository. Please check the details and token."
      );
      setStatus("Not connected");
    } finally {
      setIsConnecting(false);
    }
  }

  function handleForget() {
    localStorage.removeItem("aardvark-project-config");
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setProject(null);
    setStatus("Not connected");
    setResourceCount(0);
    setDataError(null);
    setError(null);
    setSelectedId(null);
    setEditing(null);
    setSaveError(null);
  }

  async function handleSignOut() {
    // Clear all stored data
    localStorage.removeItem("aardvark-project-config");
    localStorage.removeItem(TOKEN_STORAGE_KEY);

    // Clear DuckDB from IndexedDB
    const { clearDuckDbFromIndexedDB } = await import("../duckdb/duckdbClient");
    await clearDuckDbFromIndexedDB();

    // Reset all state
    setProject(null);
    setToken("");
    setOwner("");
    setRepo("");
    setBranch("main");
    setMetadataPath("metadata");
    setStatus("Not connected");
    setResourceCount(0);
    setDataError(null);
    setError(null);
    setSelectedId(null);
    setEditing(null);
    setSaveError(null);
  }

  async function handleExportDuckDb() {
    if (!project || !token.trim()) return;
    setIsExportingDuckDb(true);
    try {
      const blob = await exportDuckDbToBlob();
      const client = new GithubClient({ token: token.trim() });

      // The blob is already JSON, so read it as text
      const jsonText = await blob.text();
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);

      await upsertTextFile(
        client,
        project,
        "resources.duckdb.json",
        formatted,
        "Export DuckDB state to GitHub"
      );

      alert("DuckDB state exported to GitHub as resources.duckdb.json");
    } catch (err) {
      console.error("Failed to export DuckDB", err);
      alert(`Failed to export DuckDB: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExportingDuckDb(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-white font-bold text-lg">
            A
          </span>
          <div>
            <h1 className="text-lg font-semibold">Aardvark Metadata Studio</h1>
            <p className="text-xs text-slate-400">
              Browser-based editor for OpenGeoMetadata Aardvark records
            </p>
          </div>
        </div>
        <div className="text-right flex flex-col items-end gap-1">
          <p className="text-[11px] text-slate-400">{status}</p>
          <p className="text-[10px] text-slate-500">
            GitHub-connected · DuckDB-powered · Static-host friendly
          </p>
          {project && (
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={handleForget}
                className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-800/70"
              >
                Change project
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="rounded-md border border-red-700 px-2 py-1 text-[10px] text-red-200 hover:bg-red-900/30"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl mx-auto space-y-4">
        {!project && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-base font-semibold mb-2">Connect to GitHub</h2>
            <p className="text-xs text-slate-400 mb-4">
              This app talks directly to GitHub from your browser. Paste a{" "}
              <span className="font-mono">repo</span>-scoped Personal Access
              Token and repository details. We’ll remember the project
              configuration locally, but not your token (unless you choose to
              reuse it in this session).
            </p>

            <form
              onSubmit={handleConnect}
              className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm"
            >
              <div>
                <label className="block text-xs font-medium text-slate-200 mb-1">
                  Owner (user or org)
                </label>
                <input
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  placeholder="your-university"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-200 mb-1">
                  Repository
                </label>
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  placeholder="opengeometadata-records or full GitHub URL"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-200 mb-1">
                  Branch
                </label>
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  placeholder="main"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-200 mb-1">
                  Metadata folder
                </label>
                <input
                  value={metadataPath}
                  onChange={(e) => setMetadataPath(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  placeholder="metadata"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Where Aardvark JSON files live, e.g.{" "}
                  <span className="font-mono">metadata/*.json</span>.
                </p>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-200 mb-1">
                  GitHub Personal Access Token
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  placeholder="Token with repo contents: read/write"
                />
                <div className="mt-1 flex items-center justify-between gap-3">
                  <p className="text-[10px] text-slate-500">
                    Create at{" "}
                    <span className="font-mono">
                      github.com/settings/tokens
                    </span>{" "}
                    with minimal <span className="font-mono">repo</span> contents
                    permissions.
                  </p>
                  <label className="flex items-center gap-1 text-[10px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={rememberToken}
                      onChange={(e) => setRememberToken(e.target.checked)}
                      className="h-3 w-3 rounded border-slate-600 bg-slate-900"
                    />
                    <span>Remember token on this device</span>
                  </label>
                </div>
              </div>
              <div className="md:col-span-2 flex items-center justify-between mt-2">
                <div className="text-[11px] text-slate-500">
                  We never send credentials anywhere except directly to GitHub.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={isConnecting}
                    className="rounded-md bg-indigo-500 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-400 disabled:opacity-60"
                  >
                    {isConnecting ? "Connecting…" : "Connect to GitHub"}
                  </button>
                </div>
              </div>
            </form>

            {error && (
              <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {error}
              </div>
            )}
          </section>
        )}

        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-base font-semibold mb-2">Resources in GitHub</h2>
          {!project && resourceCount === 0 && (
            <p className="text-xs text-slate-400">
              Connect to GitHub above to load and edit your Aardvark records.
            </p>
          )}
          {(project || resourceCount > 0) && (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="space-y-1">
                  {isLoadingData && (
                    <p className="text-xs text-slate-400">
                      Loading metadata from GitHub…
                    </p>
                  )}
                  {dataError && (
                    <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                      {dataError}
                    </div>
                  )}
                  {!isLoadingData && !dataError && resourceCount === 0 && project && (
                    <p className="text-xs text-slate-400">
                      No Aardvark JSON files found yet in{" "}
                      <span className="font-mono">{metadataPath}</span>. Click "New resource" below to create one.
                    </p>
                  )}
                  {!isLoadingData && !dataError && resourceCount > 0 && (
                    <p className="text-xs text-slate-400">
                      {resourceCount} resource{resourceCount !== 1 ? "s" : ""} in DuckDB
                      {!project && " (Read-Only View)"}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!project) {
                        alert("Please connect to GitHub to create new resources.");
                        return;
                      }
                      setSelectedId(null);
                      setEditing({
                        id: "",
                        dct_title_s: "",
                        dct_accessRights_s: "Public",
                        gbl_resourceClass_sm: ["Datasets"],
                        gbl_mdVersion_s: "Aardvark",
                        schema_provider_s: "",
                        dct_issued_s: "",
                        dct_description_sm: [],
                        dct_creator_sm: [],
                        dct_publisher_sm: [],
                        dct_subject_sm: [],
                        dcat_keyword_sm: [],
                        extra: {},
                      });
                      setClassText("Datasets");
                      setDescText("");
                      setSaveError(null);
                    }}
                    className={`rounded-md px-3 py-2 text-[11px] font-medium text-white shadow-sm ${project ? "bg-emerald-500 hover:bg-emerald-400" : "bg-slate-700 cursor-not-allowed opacity-50"
                      }`}
                  >
                    + New resource
                  </button>
                  {resourceCount > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleExportDuckDb}
                        disabled={isExportingDuckDb || !project}
                        className="rounded-md border border-slate-700 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-800/70 disabled:opacity-60"
                      >
                        {isExportingDuckDb ? "Exporting..." : "Export DuckDB"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTabularEditor(!showTabularEditor)}
                        className="rounded-md border border-slate-700 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-800/70"
                      >
                        {showTabularEditor ? "Hide" : "Show"} Tabular Editor
                      </button>
                    </>
                  )}
                </div>
              </div>
              <ResourceListTable
                selectedId={selectedId}
                project={project}
                isLoadingData={isLoadingData}
                onSelectResource={(resource) => {
                  setSelectedId(resource.id);
                  setEditing({ ...resource });
                  setClassText(resource.gbl_resourceClass_sm.join(" | "));
                  setDescText(resource.dct_description_sm.join(" | "));
                  setSaveError(null);
                }}
                onRefresh={refreshResourceCount}
              />
            </>
          )}
        </section>

        {(project || resourceCount > 0) && showTabularEditor && (
          <TabularEditor
            onSelectResource={(resource) => {
              setSelectedId(resource.id);
              setEditing({ ...resource });
              setClassText(resource.gbl_resourceClass_sm.join(" | "));
              setDescText(resource.dct_description_sm.join(" | "));
              setSaveError(null);
              setShowTabularEditor(false);
            }}
            onRefresh={refreshResourceCount}
          />
        )}

        {project && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-base font-semibold mb-2">
              {editing ? (selectedId ? "Edit resource" : "New resource") : "Resource editor"}
            </h2>
            {!editing && (
              <p className="text-xs text-slate-400">
                Select a resource from the table above, or create a new one to begin editing.
              </p>
            )}
            {editing && (
              <>
                <form
                  className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm"
                  onSubmit={(e) => e.preventDefault()}
                >
                  <div>
                    <label className="block text-xs font-medium text-slate-200 mb-1">
                      ID
                    </label>
                    <input
                      value={editing.id}
                      onChange={(e) =>
                        setEditing((prev) =>
                          prev ? { ...prev, id: e.target.value } : prev
                        )
                      }
                      disabled={!!selectedId}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 disabled:bg-slate-900/60 disabled:text-slate-500"
                      placeholder="unique-id"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-200 mb-1">
                      Title (dct_title_s)
                    </label>
                    <input
                      value={editing.dct_title_s}
                      onChange={(e) =>
                        setEditing((prev) =>
                          prev
                            ? { ...prev, dct_title_s: e.target.value }
                            : prev
                        )
                      }
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                      placeholder="Descriptive title"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-200 mb-1">
                      Access rights (dct_accessRights_s)
                    </label>
                    <input
                      value={editing.dct_accessRights_s}
                      onChange={(e) =>
                        setEditing((prev) =>
                          prev
                            ? { ...prev, dct_accessRights_s: e.target.value }
                            : prev
                        )
                      }
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                      placeholder="Public"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-200 mb-1">
                      Resource class (gbl_resourceClass_sm)
                      <span className="ml-1 text-[10px] text-slate-400">
                        (pipe-delimited)
                      </span>
                    </label>
                    <input
                      value={classText}
                      onChange={(e) => setClassText(e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                      placeholder="Datasets | Maps"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-200 mb-1">
                      Description (dct_description_sm)
                      <span className="ml-1 text-[10px] text-slate-400">
                        (pipe-delimited)
                      </span>
                    </label>
                    <textarea
                      value={descText}
                      onChange={(e) => setDescText(e.target.value)}
                      rows={3}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-2 flex items-center justify-between mt-2">
                    <div className="text-[11px] text-slate-500">
                      Saving will write{" "}
                      <span className="font-mono">
                        {metadataPath}/{editing.id || "new-id"}.json
                      </span>{" "}
                      to GitHub.
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(null);
                          setEditing(null);
                          setSaveError(null);
                        }}
                        className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800/70"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={isSaving || !editing.id || !editing.dct_title_s}
                        onClick={async () => {
                          if (!project || !editing) return;
                          setIsSaving(true);
                          setSaveError(null);
                          try {
                            const client = new GithubClient({ token: token.trim() });
                            const normalizedClass = classText
                              .split("|")
                              .map((v) => v.trim())
                              .filter(Boolean);
                            const normalizedDesc = descText
                              .split("|")
                              .map((v) => v.trim())
                              .filter(Boolean);
                            const toSave: Resource = {
                              ...editing,
                              gbl_resourceClass_sm: normalizedClass,
                              dct_description_sm: normalizedDesc,
                            };
                            const json = resourceToJson(toSave);
                            const path = `${metadataPath}/${toSave.id}.json`;
                            await upsertJsonFile(
                              client,
                              project,
                              path,
                              json,
                              selectedId
                                ? `Update Aardvark resource ${toSave.id}`
                                : `Add Aardvark resource ${toSave.id}`
                            );

                            // Write to DuckDB first (source of truth)
                            const allResources = await queryResources();
                            const updatedResources: Resource[] = (() => {
                              const without = allResources.filter(
                                (r) => r.id !== toSave.id
                              );
                              return [...without, toSave].sort((a, b) =>
                                a.id.localeCompare(b.id)
                              );
                            })();
                            await syncDuckDbFromResources(updatedResources);

                            // Persist DuckDB to IndexedDB
                            const ctx = await getDuckDbContext();
                            if (ctx && ctx.db) {
                              const { persistDuckDbToIndexedDB } = await import("../duckdb/duckdbClient");
                              await persistDuckDbToIndexedDB(ctx.db);
                            }

                            // Refresh count
                            await refreshResourceCount();
                            setSelectedId(toSave.id);

                            // Sync to GitHub FROM DuckDB
                            const duckdbResources = await queryResources();
                            const resourcesCsv = buildResourcesCsv(duckdbResources);
                            const distsCsv = buildDistributionsCsv(duckdbResources);

                            if (resourcesCsv) {
                              await upsertTextFile(
                                client,
                                project,
                                "resources.csv",
                                resourcesCsv,
                                "Rebuild resources.csv from metadata"
                              );
                            }
                            if (distsCsv) {
                              await upsertTextFile(
                                client,
                                project,
                                "distributions.csv",
                                distsCsv,
                                "Rebuild distributions.csv from metadata"
                              );
                            }
                          } catch (err) {
                            console.error(err);
                            setSaveError(
                              err instanceof Error
                                ? err.message
                                : "Failed to save resource to GitHub."
                            );
                          } finally {
                            setIsSaving(false);
                          }
                        }}
                        className="rounded-md bg-emerald-500 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-400 disabled:opacity-60"
                      >
                        {isSaving
                          ? "Saving…"
                          : selectedId
                            ? "Save changes to GitHub"
                            : "Create in GitHub"}
                      </button>
                    </div>
                  </div>
                </form>
                {saveError && (
                  <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    {saveError}
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
};

