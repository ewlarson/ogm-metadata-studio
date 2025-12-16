import React, { useEffect, useState } from "react";
import { Resource, resourceFromJson, resourceToJson, REPEATABLE_STRING_FIELDS } from "../aardvark/model";
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
import { TagInput } from "./TagInput";
import { ResourceList } from "./ResourceList";

const TOKEN_STORAGE_KEY = "aardvark-github-token"; // Now using localStorage


async function syncDuckDbFromResources(resources: Resource[]): Promise<void> {
  try {
    const ctx = await getDuckDbContext();
    if (!ctx || !ctx.db) {
      console.warn("DuckDB not available, skipping sync");
      return;
    }
    const conn: any = await (ctx.db as any).connect();

    // Build flattened rows for resources table using DuckDB-specific flattening 
    // (preserves arrays for repeatable fields)
    const { flattenResourceForDuckDb } = await import("../aardvark/mapping");
    const rows = resources.map((r) => flattenResourceForDuckDb(r));

    if (rows.length === 0) {
      await conn.query("DROP TABLE IF EXISTS resources");
      await conn.query("DROP TABLE IF EXISTS distributions");
      await conn.close?.();
      return;
    }

    // Use correct types for columns: VARCHAR[] for repeatable fields, TEXT for others.
    // We must ensure we don't accidentally send flattened strings if we want arrays.
    // Actually, flattenResource likely keeps them as string[] if we don't join them. 
    // Let's check flattenResource logic in mapping.ts. 
    // Assuming flattenResource returns { key: val | val[] }, we need to handle it.
    // If flattenResource joins them (e.g. "a|b"), we should fix flattenResource OR 
    // here we should just use the raw resource object instead of flattening?
    // The previous implementation used flattenResource. Let's check it.
    // But for now, let's assume we want to preserve arrays.

    const fieldnames = Array.from(
      new Set(rows.flatMap((r) => Object.keys(r)))
    );

    // Helper to check if a field is repeatable
    const isRepeatable = (name: string) => REPEATABLE_STRING_FIELDS.includes(name);

    await conn.query("DROP TABLE IF EXISTS resources");
    const columnsSql = fieldnames.map((n) => {
      // If it's repeatable, use VARCHAR[] (list of strings)
      if (isRepeatable(n)) return `"${n}" VARCHAR[]`;
      return `"${n}" VARCHAR`;
    }).join(", ");

    await conn.query(`CREATE TABLE resources (${columnsSql});`);

    const placeholders = fieldnames.map(() => "?").join(", ");
    const stmt = await conn.prepare(`INSERT INTO resources VALUES (${placeholders})`);
    try {
      for (const row of rows) {
        // Prepare values. If it's an array field, ensure it's passed as array.
        // If generic object row has it as string, we might need to split? 
        // We should probably NOT use flattenResource if it joins strings. 
        // Let's look at how flattenResource works first. 
        // Wait, I can't check it inside this tool replacement. 
        // But if I change the table definition to VARCHAR[], DuckDB expects arrays.
        // If I pass ['a','b'] to query(), it works for VARCHAR[].
        // If `row[n]` is already string[], good.
        // If `row[n]` is undefined, null is good.
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
  const [rememberToken, setRememberToken] = useState(false);
  const [showTabularEditor, setShowTabularEditor] = useState(false);
  const [isExportingDuckDb, setIsExportingDuckDb] = useState(false);
  const [view, setView] = useState<"list" | "edit" | "create">("list");

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

      const ctx = await getDuckDbContext();
      if (!ctx || !ctx.db) return;

      const { importParquetFromUrl } = await import("../duckdb/duckdbClient");
      const resources = await queryResources();

      if (resources.length === 0) {
        console.log("DuckDB empty, attempting to load resources.parquet...");
        try {
          let url = new URL("resources.parquet", window.location.href).href;

          // Check if we have a stored project config to load from remote
          const storedConfig = loadProjectConfig();
          if (storedConfig) {
            // Construct GitHub Pages URL: https://<owner>.github.io/<repo>/resources.parquet
            // distinct from the repo URL (which might be the code repo if not split yet, but user intends to split)
            // If the user follows the "Data Repo" plan, the config will point to the Data Repo.
            url = `https://${storedConfig.owner}.github.io/${storedConfig.repo}/resources.parquet`;
            console.log("Found stored config, attempting to load remote parquet from", url);
          } else {
            console.log("No stored config, attempting to load local parquet from", url);
          }

          const success = await importParquetFromUrl(url, "resources");
          if (success) {
            console.log("Successfully loaded resources.parquet");
            await refreshResourceCount();
          } else {
            console.log("resources.parquet not found or failed to load from", url);
            // If remote failed, maybe try local fallback? 
            // For now, let's keep it simple. If they have config, they expect remote.
            if (storedConfig) {
              console.log("Remote load failed, falling back to local...");
              const localUrl = new URL("resources.parquet", window.location.href).href;
              const localSuccess = await importParquetFromUrl(localUrl, "resources");
              if (localSuccess) {
                console.log("Successfully loaded local resources.parquet fallback");
                await refreshResourceCount();
                return;
              }
            }
            setDataError(`Failed to import resources.parquet from ${url} (check console)`);
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
      setView("list");
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

      <main className="flex-1 p-6 w-full mx-auto">
        <div className="space-y-6">
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
                      type="submit"
                      disabled={isConnecting}
                      className="flex w-full justify-center rounded-md border border-transparent bg-indigo-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
                    >
                      {isConnecting ? "Connecting..." : "Connect"}
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

          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 flex-1 flex flex-col min-h-0">
            {view === "list" && (
              <ResourceList
                project={project}
                resourceCount={resourceCount}
                onEdit={(id) => {
                  if (!project) return;
                  // Start editing
                  // We need to fetch the full resource first or use what we need.
                  // Since we have the ID, let's fetch it from DuckDB or find it.
                  // Async fetch is better.
                  (async () => {
                    const r = await queryResourceById(id);
                    if (r) {
                      setEditing(r);
                      setSelectedId(id);
                      setView("edit");
                      setSaveError(null);
                    }
                  })();
                }}
                onCreate={() => {
                  setSelectedId(null);
                  setEditing({
                    id: "",
                    dct_title_s: "",
                    dct_accessRights_s: "Public",
                    gbl_resourceClass_sm: ["Datasets"],
                    gbl_mdVersion_s: "Aardvark",
                    schema_provider_s: "",
                    dct_issued_s: "",

                    dct_alternative_sm: [],
                    dct_description_sm: [],
                    dct_language_sm: [],
                    gbl_displayNote_sm: [],

                    dct_creator_sm: [],
                    dct_publisher_sm: [],

                    gbl_resourceType_sm: [],
                    dct_subject_sm: [],
                    dcat_theme_sm: [],
                    dcat_keyword_sm: [],

                    dct_temporal_sm: [],
                    gbl_dateRange_drsim: [],

                    dct_spatial_sm: [],

                    dct_identifier_sm: [],
                    dct_rights_sm: [],
                    dct_rightsHolder_sm: [],
                    dct_license_sm: [],

                    pcdm_memberOf_sm: [],
                    dct_isPartOf_sm: [],
                    dct_source_sm: [],
                    dct_isVersionOf_sm: [],
                    dct_replaces_sm: [],
                    dct_relation_sm: [],

                    extra: {},
                  });
                  setView("create");
                  setSaveError(null);
                }}
                onRefreshProject={refreshResourceCount}
              />
            )}

            {(view === "edit" || view === "create") && editing && (
              <div className="flex flex-col lg:flex-row gap-6 items-start h-full">
                {/* Table of Contents Sidebar */}
                <aside className="w-full lg:w-48 flex-shrink-0 lg:sticky lg:top-4">
                  <button
                    onClick={() => {
                      setView("list");
                      setEditing(null);
                      setSelectedId(null);
                    }}
                    className="mb-4 flex items-center gap-2 text-xs text-slate-400 hover:text-white"
                  >
                    ← Back to list
                  </button>
                  <nav className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-1 max-h-[calc(100vh-200px)] overflow-y-auto">
                    <h3 className="mb-3 text-xs font-semibold text-slate-400 uppercase tracking-wider px-2">
                      Sections
                    </h3>
                    {[
                      { id: "section-required", label: "Required" },
                      { id: "section-identification", label: "Identification" },
                      { id: "section-credits", label: "Credits" },
                      { id: "section-categories", label: "Categories" },
                      { id: "section-temporal", label: "Temporal" },
                      { id: "section-spatial", label: "Spatial" },
                      { id: "section-administrative", label: "Administrative" },
                      { id: "section-object", label: "Object" },
                      { id: "section-relations", label: "Relations" },
                    ].map((item) => (
                      <a
                        key={item.id}
                        href={`#${item.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          document.getElementById(item.id)?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          });
                        }}
                        className="block rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                      >
                        {item.label}
                      </a>
                    ))}
                  </nav>
                </aside>

                {/* Main Form Area */}
                <div className="flex-1 min-w-0 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
                  <h2 className="text-base font-semibold mb-2">
                    {view === "edit" ? `Edit: ${editing.dct_title_s || editing.id}` : "Create New Resource"}
                  </h2>

                  <form
                    className="mt-3 text-sm"
                    onSubmit={(e) => e.preventDefault()}
                  >
                    <div className="space-y-8">
                      {/* Required Sections */}
                      <div id="section-required" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Required</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">ID</label>
                            <input
                              value={editing.id}
                              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                              disabled={!!selectedId}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 disabled:bg-slate-900/60"
                            />
                          </div>
                          <div className="lg:col-span-2">
                            <label className="block text-xs font-medium text-slate-200 mb-1">Title</label>
                            <input
                              value={editing.dct_title_s}
                              onChange={(e) => setEditing({ ...editing, dct_title_s: e.target.value })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Resource Class (gbl_resourceClass_sm)</label>
                            <TagInput
                              value={editing.gbl_resourceClass_sm}
                              onChange={(val) => setEditing({ ...editing, gbl_resourceClass_sm: val })}
                              fieldName="gbl_resourceClass_sm"
                              placeholder="Datasets, Maps..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Access Rights</label>
                            <select
                              value={editing.dct_accessRights_s}
                              onChange={(e) => setEditing({ ...editing, dct_accessRights_s: e.target.value })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            >
                              <option value="Public">Public</option>
                              <option value="Restricted">Restricted</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Format</label>
                            <input
                              value={editing.dct_format_s ?? ""}
                              onChange={(e) => setEditing({ ...editing, dct_format_s: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                              placeholder="Shapefile"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Identification */}
                      <div id="section-identification" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Identification</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
                          <div className="md:col-span-2">
                            <label className="block text-xs font-medium text-slate-200 mb-1">Description (dct_description_sm)</label>
                            <TagInput
                              value={editing.dct_description_sm}
                              onChange={(val) => setEditing({ ...editing, dct_description_sm: val })}
                              fieldName="dct_description_sm"
                              placeholder="Add descriptions..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Alt Title (dct_alternative_sm)</label>
                            <TagInput
                              value={editing.dct_alternative_sm}
                              onChange={(val) => setEditing({ ...editing, dct_alternative_sm: val })}
                              fieldName="dct_alternative_sm"
                              placeholder="Add alternative titles..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Display Note (gbl_displayNote_sm)</label>
                            <TagInput
                              value={editing.gbl_displayNote_sm}
                              onChange={(val) => setEditing({ ...editing, gbl_displayNote_sm: val })}
                              fieldName="gbl_displayNote_sm"
                              placeholder="Add display notes..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Language (dct_language_sm)</label>
                            <TagInput
                              value={editing.dct_language_sm}
                              onChange={(val) => setEditing({ ...editing, dct_language_sm: val })}
                              fieldName="dct_language_sm"
                              placeholder="Add languages..."
                            />
                          </div>
                        </div>
                      </div>

                      {/* Credits */}
                      <div id="section-credits" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Credits</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Creator (dct_creator_sm)</label>
                            <TagInput
                              value={editing.dct_creator_sm}
                              onChange={(val) => setEditing({ ...editing, dct_creator_sm: val })}
                              fieldName="dct_creator_sm"
                              placeholder="Add creators..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Publisher (dct_publisher_sm)</label>
                            <TagInput
                              value={editing.dct_publisher_sm}
                              onChange={(val) => setEditing({ ...editing, dct_publisher_sm: val })}
                              fieldName="dct_publisher_sm"
                              placeholder="Add publishers..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Provider</label>
                            <input
                              value={editing.schema_provider_s ?? ""}
                              onChange={(e) => setEditing({ ...editing, schema_provider_s: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Categories */}
                      <div id="section-categories" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Categories</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Resource Type (gbl_resourceType_sm)</label>
                            <TagInput
                              value={editing.gbl_resourceType_sm}
                              onChange={(val) => setEditing({ ...editing, gbl_resourceType_sm: val })}
                              fieldName="gbl_resourceType_sm"
                              placeholder="Add resource types..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Subject (dct_subject_sm)</label>
                            <TagInput
                              value={editing.dct_subject_sm}
                              onChange={(val) => setEditing({ ...editing, dct_subject_sm: val })}
                              fieldName="dct_subject_sm"
                              placeholder="Add subjects..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Theme (dcat_theme_sm)</label>
                            <TagInput
                              value={editing.dcat_theme_sm}
                              onChange={(val) => setEditing({ ...editing, dcat_theme_sm: val })}
                              fieldName="dcat_theme_sm"
                              placeholder="Add themes..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Keyword (dcat_keyword_sm)</label>
                            <TagInput
                              value={editing.dcat_keyword_sm}
                              onChange={(val) => setEditing({ ...editing, dcat_keyword_sm: val })}
                              fieldName="dcat_keyword_sm"
                              placeholder="Add keywords..."
                            />
                          </div>
                        </div>
                      </div>

                      {/* Temporal */}
                      <div id="section-temporal" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Temporal</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Temporal Coverage (dct_temporal_sm)</label>
                            <TagInput
                              value={editing.dct_temporal_sm}
                              onChange={(val) => setEditing({ ...editing, dct_temporal_sm: val })}
                              fieldName="dct_temporal_sm"
                              placeholder="Add temporal coverage..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Date Issued</label>
                            <input
                              value={editing.dct_issued_s ?? ""}
                              onChange={(e) => setEditing({ ...editing, dct_issued_s: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                              placeholder="YYYY-MM-DD"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Date Range (gbl_dateRange_drsim)</label>
                            <TagInput
                              value={editing.gbl_dateRange_drsim}
                              onChange={(val) => setEditing({ ...editing, gbl_dateRange_drsim: val })}
                              fieldName="gbl_dateRange_drsim"
                              placeholder="Add date ranges..."
                            />
                          </div>
                        </div>
                      </div>

                      {/* Spatial */}
                      <div id="section-spatial" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Spatial</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Spatial Coverage (dct_spatial_sm)</label>
                            <TagInput
                              value={editing.dct_spatial_sm}
                              onChange={(val) => setEditing({ ...editing, dct_spatial_sm: val })}
                              fieldName="dct_spatial_sm"
                              placeholder="Add spatial coverage..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Bounding Box (ENVELOPE)</label>
                            <input
                              value={editing.dcat_bbox ?? ""}
                              onChange={(e) => setEditing({ ...editing, dcat_bbox: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                              placeholder="ENVELOPE(-180, 180, 90, -90)"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Geometry</label>
                            <input
                              value={editing.locn_geometry ?? ""}
                              onChange={(e) => setEditing({ ...editing, locn_geometry: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            />
                          </div>
                          <div className="flex items-center mt-6">
                            <input
                              type="checkbox"
                              checked={editing.gbl_georeferenced_b ?? false}
                              onChange={(e) => setEditing({ ...editing, gbl_georeferenced_b: e.target.checked })}
                              className="mr-2 rounded border-slate-700 bg-slate-950"
                            />
                            <label className="block text-xs font-medium text-slate-200">Georeferenced</label>
                          </div>
                        </div>
                      </div>

                      {/* Administrative */}
                      <div id="section-administrative" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Administrative</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Identifier (dct_identifier_sm)</label>
                            <TagInput
                              value={editing.dct_identifier_sm}
                              onChange={(val) => setEditing({ ...editing, dct_identifier_sm: val })}
                              fieldName="dct_identifier_sm"
                              placeholder="Add identifiers..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">WXS Identifier</label>
                            <input
                              value={editing.gbl_wxsIdentifier_s ?? ""}
                              onChange={(e) => setEditing({ ...editing, gbl_wxsIdentifier_s: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Rights (dct_rights_sm)</label>
                            <TagInput
                              value={editing.dct_rights_sm}
                              onChange={(val) => setEditing({ ...editing, dct_rights_sm: val })}
                              fieldName="dct_rights_sm"
                              placeholder="Add rights..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Rights Holder (dct_rightsHolder_sm)</label>
                            <TagInput
                              value={editing.dct_rightsHolder_sm}
                              onChange={(val) => setEditing({ ...editing, dct_rightsHolder_sm: val })}
                              fieldName="dct_rightsHolder_sm"
                              placeholder="Add rights holders..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">License (dct_license_sm)</label>
                            <TagInput
                              value={editing.dct_license_sm}
                              onChange={(val) => setEditing({ ...editing, dct_license_sm: val })}
                              fieldName="dct_license_sm"
                              placeholder="Add licenses..."
                            />
                          </div>
                          <div className="flex items-center mt-6">
                            <input
                              type="checkbox"
                              checked={editing.gbl_suppressed_b ?? false}
                              onChange={(e) => setEditing({ ...editing, gbl_suppressed_b: e.target.checked })}
                              className="mr-2 rounded border-slate-700 bg-slate-950"
                            />
                            <label className="block text-xs font-medium text-slate-200">Suppressed</label>
                          </div>
                        </div>
                      </div>

                      {/* Object */}
                      <div id="section-object" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Object</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">File Size</label>
                            <input
                              value={editing.gbl_fileSize_s ?? ""}
                              onChange={(e) => setEditing({ ...editing, gbl_fileSize_s: e.target.value || null })}
                              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Relations */}
                      <div id="section-relations" className="scroll-mt-6 rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                        <h3 className="mb-4 text-base font-semibold text-slate-200 border-b border-slate-700 pb-2">Relations</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Member Of (pcdm_memberOf_sm)</label>
                            <TagInput
                              value={editing.pcdm_memberOf_sm}
                              onChange={(val) => setEditing({ ...editing, pcdm_memberOf_sm: val })}
                              fieldName="pcdm_memberOf_sm"
                              placeholder="Add member of..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Is Part Of (dct_isPartOf_sm)</label>
                            <TagInput
                              value={editing.dct_isPartOf_sm}
                              onChange={(val) => setEditing({ ...editing, dct_isPartOf_sm: val })}
                              fieldName="dct_isPartOf_sm"
                              placeholder="Add is part of..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Source (dct_source_sm)</label>
                            <TagInput
                              value={editing.dct_source_sm}
                              onChange={(val) => setEditing({ ...editing, dct_source_sm: val })}
                              fieldName="dct_source_sm"
                              placeholder="Add source..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Is Version Of (dct_isVersionOf_sm)</label>
                            <TagInput
                              value={editing.dct_isVersionOf_sm}
                              onChange={(val) => setEditing({ ...editing, dct_isVersionOf_sm: val })}
                              fieldName="dct_isVersionOf_sm"
                              placeholder="Add is version of..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Replaces (dct_replaces_sm)</label>
                            <TagInput
                              value={editing.dct_replaces_sm}
                              onChange={(val) => setEditing({ ...editing, dct_replaces_sm: val })}
                              fieldName="dct_replaces_sm"
                              placeholder="Add replaces..."
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-200 mb-1">Relation (dct_relation_sm)</label>
                            <TagInput
                              value={editing.dct_relation_sm}
                              onChange={(val) => setEditing({ ...editing, dct_relation_sm: val })}
                              fieldName="dct_relation_sm"
                              placeholder="Add relation..."
                            />
                          </div>
                        </div>
                      </div>

                    </div>

                    <div className="flex items-center justify-between mt-6 border-t border-slate-800 pt-4">
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
                            setView("list");
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
                              const toSave: Resource = {
                                ...editing,
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
                              // Simple update logic for DuckDB sync:
                              // Since we don't have update logic, we do full sync for now or optimistic update
                              // Actually, we can just upsert the single resource into DuckDB later if we want optimization.
                              // For now, let's just re-sync everything or use the array logic.

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
                              // Success! return to edit mode or list
                              // Stay in edit mode but maybe give feedback?
                              // Or go back to list?
                              setView("list");
                              setEditing(null); // Clear editing to force list view
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
                </div>
              </div>
            )}

          </section>
        </div>
      </main >
    </div >
  );
};
