import React, { useEffect, useState, useCallback } from "react";
import { Resource, Distribution } from "../aardvark/model";
// GithubClient imports removed
import { queryResourceById, upsertResource, queryDistributionsForResource, countResources } from "../duckdb/duckdbClient";
import { ResourceList } from "./ResourceList";
import { ImportPage } from "./ImportPage";
import { ResourceEdit } from "./ResourceEdit";
import { DistributionsList } from "./DistributionsList";
import { Dashboard } from "./Dashboard";
import { useUrlState } from "../hooks/useUrlState";
import { AutosuggestInput } from "./AutosuggestInput";
import { ThemeToggle } from "./ThemeToggle";
import { ResourceShow } from "./ResourceShow";
import { ResourceAdmin } from "./ResourceAdmin";
import { ErrorBoundary } from "./shared/ErrorBoundary";



export const App: React.FC = () => {
  // Local state only
  const [resourceCount, setResourceCount] = useState<number>(0);

  // URL State
  type ViewType = "dashboard" | "admin" | "edit" | "create" | "import" | "distributions" | "list" | "gallery" | "map" | "resource" | "resource_admin";
  interface AppState {
    view: ViewType;
    id?: string;
  }

  const [urlState, setUrlState] = useUrlState<AppState>(
    { view: "dashboard" },
    {
      toUrl: (s) => {
        const p = new URLSearchParams();
        if (s.view !== "dashboard" && s.view !== "resource") p.set("view", s.view);
        if (s.id && s.view !== "resource") p.set("id", s.id);
        return p;
      },
      fromUrl: (p, pathname) => {
        // Check for /resources/:id/edit
        const editMatch = pathname.match(/^\/resources\/([^/]+)\/edit$/);
        if (editMatch) {
          return { view: "edit", id: decodeURIComponent(editMatch[1]) };
        }

        // Check for /resources/:id/admin
        const adminMatch = pathname.match(/^\/resources\/([^/]+)\/admin$/);
        if (adminMatch) {
          return { view: "resource_admin", id: decodeURIComponent(adminMatch[1]) };
        }

        // Check for /resources/:id
        const resourceMatch = pathname.match(/^\/resources\/([^/]+)$/);
        if (resourceMatch) {
          return { view: "resource", id: decodeURIComponent(resourceMatch[1]) };
        }

        const view = (p.get("view") as ViewType) || "dashboard";
        const id = p.get("id") || undefined;
        return { view, id };
      },
      cleanup: (p) => {
        p.delete("view");
        p.delete("id");
      },
      path: (s) => {
        if (s.view === "edit" && s.id) {
          return `/resources/${encodeURIComponent(s.id)}/edit`;
        }
        if (s.view === "resource_admin" && s.id) {
          return `/resources/${encodeURIComponent(s.id)}/admin`;
        }
        if (s.view === "resource" && s.id) {
          return `/resources/${encodeURIComponent(s.id)}`;
        }
        return "/";
      }
    }
  );

  const { view, id: selectedId } = urlState;

  const [editing, setEditing] = useState<Resource | null>(null);
  const [editingDistributions, setEditingDistributions] = useState<Distribution[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);



  // Refresh resource count from DuckDB
  async function refreshResourceCount() {
    try {
      const count = await countResources();
      setResourceCount(count);
    } catch (err) {
      console.error("Failed to refresh resource count from DuckDB", err);
      setResourceCount(0);
    }
  }

  // Initial load
  useEffect(() => {
    // Just refresh count, data loading is handled by DuckDB client internals
    refreshResourceCount();
  }, []);

  const handleCreate = useCallback((setView = true) => {
    const empty: Resource = {
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
      gbl_indexYear_im: null,
      dct_spatial_sm: [],
      locn_geometry: "",
      dcat_bbox: "",
      dcat_centroid: "",
      gbl_georeferenced_b: null,
      dct_identifier_sm: [],
      gbl_wxsIdentifier_s: "",
      dct_rights_sm: [],
      dct_rightsHolder_sm: [],
      dct_license_sm: [],
      pcdm_memberOf_sm: [],
      dct_isPartOf_sm: [],
      dct_source_sm: [],
      dct_isVersionOf_sm: [],
      dct_replaces_sm: [],
      dct_isReplacedBy_sm: [],
      dct_relation_sm: [],
      extra: {},
    };
    setEditing(empty);
    setEditingDistributions([]);
    if (setView) setUrlState({ view: "create" });
    setSaveError(null);
  }, [setUrlState]);

  // Load resource if view is edit and we have ID but no data
  useEffect(() => {
    const load = async () => {
      if (view === "edit" && selectedId && (!editing || editing.id !== selectedId)) {
        const r = await queryResourceById(selectedId);
        if (r) {
          const d = await queryDistributionsForResource(selectedId);
          setEditing(r);
          setEditingDistributions(d);
        } else {
          // Not found? go back
          setUrlState(s => ({ ...s, view: "dashboard" }));
        }
      } else if (view === "create" && !editing) {
        // Initialize empty
        handleCreate(false); // don't set view, just data
      }
    };
    load();
  }, [view, selectedId, editing, setUrlState, handleCreate]);




  async function handleSave(resource: Resource, distributions: Distribution[]) {
    setIsSaving(true);
    setSaveError(null);
    try {
      // Verify ID presence
      if (!resource.id) throw new Error("ID is required");

      await upsertResource(resource, distributions);
      await refreshResourceCount();

      setUrlState({ view: "dashboard" }); // Clear ID
      setEditing(null);
      setEditingDistributions([]);

    } catch (e: any) {
      console.error("Save failed", e);
      setSaveError(e.message);
    } finally {
      setIsSaving(false);
    }
  }

  const handleEditResource = async (id: string) => {
    // Just set URL, the effect will load data
    setUrlState({ view: "edit", id });
  };



  const handleReset = () => {
    // Reset to root with no params
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Global Search State
  const [searchValue, setSearchValue] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("q") || "";
  });

  // Sync search value with URL
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setSearchValue(params.get("q") || "");
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleSearch = (val: string) => {
    const params = new URLSearchParams(window.location.search);
    if (val) {
      params.set("q", val);
    } else {
      params.delete("q");
    }
    // Ensure we are on the dashboard
    if (view !== "dashboard") {
      params.delete("view");
    }
    // Reset page to 1 on new search
    params.set("page", "1");

    // Update URL
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.pushState({}, "", newUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col transition-colors duration-200">
      <header className="border-b border-gray-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 px-4 py-3 flex items-center justify-between backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-4 flex-1">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity focus:outline-none flex-shrink-0 w-96 pr-4"
            title="Reset to Dashboard"
          >
            <svg
              className="h-10 w-10 text-indigo-600 dark:text-indigo-400"
              viewBox="0 0 100 100"
              fill="currentColor"
              aria-label="Aardvark Logo"
            >
              {/* Simple stylized Aardvark/Anteater silhouette */}
              <path d="M85.4,36.6c-2.7-5.2-7.5-8.5-12.8-9.4c-2.6-0.4-5.2-0.1-7.7,0.8c-4.4,1.6-8.2,4.8-11,8.9c-0.6,0.9-1.2,1.8-1.7,2.8 c-0.6-0.7-1.3-1.4-2-2.1c-1.6-1.6-3.4-2.9-5.4-3.8c-2-0.9-4.2-1.3-6.4-1.2c-2.2,0.1-4.3,0.7-6.2,1.8c-3.8,2.1-6.7,5.5-8.3,9.5 c-0.4,1-0.7,2-1,3.1c-1.3-0.5-2.6-1-3.9-1.4c-3.9-1.2-8.1-1.3-12-0.3c-1.9,0.5-3.8,1.3-5.5,2.4c-3.4,2.2-6,5.4-7.4,9.1 c-0.7,1.8-1,3.8-1,5.7c0,5.8,2.9,11.2,7.7,14.6c4.8,3.4,10.8,4.5,16.6,3.1c1.4-0.3,2.8-0.8,4.1-1.5c1.3,1.6,2.9,3,4.6,4.1 c3.5,2.2,7.7,3.1,11.8,2.4c4.1-0.7,7.8-3,10.4-6.3c1.3-1.6,2.2-3.4,2.8-5.3c1,0.7,2.1,1.3,3.2,1.8c2.3,1,4.9,1.4,7.4,1.1 c2.5-0.3,4.9-1.3,6.8-2.9c3.9-3.2,6.3-8,6.5-13.1C98.4,45.4,94,39,89,36c-1.1-0.7-2.3-1.2-3.6-1.5L85.4,36.6z M22,65 c-3.3,0.8-6.8,0.2-9.6-1.8c-2.8-2-4.4-5.2-4.4-8.6c0-1.2,0.2-2.3,0.6-3.4c0.8-2.2,2.4-4.1,4.4-5.3c0.9-0.6,2-1,3.1-1.3 c2.2-0.6,4.6-0.5,6.8,0.2c0.8,0.2,1.5,0.5,2.2,0.9L22,65z M65,65c-2.1,2.7-5.3,4.3-8.8,4.3c-1.2,0-2.4-0.2-3.5-0.6 c-2.2-0.8-4-2.5-4.9-4.7c-0.9-2.2-0.8-4.7,0.2-6.8c1-2.1,3-3.7,5.2-4.4c2.2-0.7,4.7-0.5,6.8,0.6c2.1,1,3.7,3,4.4,5.2 C65.2,60.8,65.8,63,65,65z M85,55c0,3.3-1.5,6.4-4,8.5c-1.2,1-2.7,1.7-4.2,1.9c-1.6,0.2-3.1-0.1-4.6-0.7c-2.9-1.2-5-3.9-5.4-7 c-0.2-1.6,0.1-3.1,0.7-4.6c1.2-2.9,3.9-5,7-5.4c1.6-0.2,3.1,0.1,4.6,0.7C82.1,49.6,85,52.1,85,55z" />
            </svg>
            <div className="text-left hidden sm:block">
              <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-tight">Aardvark Metadata Studio</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Local DuckDB Edition
              </p>
            </div>
          </button>

          {/* Global Search */}
          <div className="flex-1 max-w-xl mx-4">
            <AutosuggestInput
              value={searchValue}
              onChange={setSearchValue}
              onSearch={handleSearch}
              placeholder="Search resources..."
              className="w-full"
            />
          </div>
        </div>

        <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">

          <div className="flex gap-2 mt-1 items-center">

            <button
              type="button"
              onClick={() => setUrlState({ view: "admin" })}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${view === "admin"
                ? "bg-slate-100 dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white font-medium"
                : "border-transparent text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"}`}
            >
              Resources
            </button>
            <button
              type="button"
              onClick={() => setUrlState({ view: "distributions" })}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${view === "distributions"
                ? "bg-slate-100 dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white font-medium"
                : "border-transparent text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"}`}
            >
              Distributions
            </button>

            <button
              type="button"
              onClick={() => setUrlState({ view: "import" })}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${view === "import"
                ? "bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-500/50 text-indigo-700 dark:text-indigo-300"
                : "border-transparent text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"}`}
            >
              Import / Export
            </button>
            <div className="w-[1px] h-6 bg-gray-300 dark:bg-slate-800 mx-1"></div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <ErrorBoundary>
        <main className="flex-1 p-6 w-full mx-auto flex flex-col min-h-0">
          <div className="flex-1 flex flex-col min-h-0 space-y-6">

            <section className={`rounded-xl border border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/60 p-6 flex-1 flex flex-col min-h-0 shadow-sm dark:shadow-none backdrop-blur-sm ${view === 'map' ? '' : 'overflow-hidden'}`}>
              {(view === "dashboard" || view === "list" || view === "gallery" || view === "map") && (
                <div className="flex flex-col h-full -m-6">
                  <Dashboard
                    onEdit={handleEditResource}
                    onSelect={(id) => setUrlState({ view: 'resource', id })}
                  />
                </div>
              )}

              {view === "resource" && selectedId && (
                <div className="-m-6 h-[calc(100%+3rem)]">
                  <ResourceShow
                    id={selectedId}
                    onBack={() => setUrlState({ view: 'dashboard' })}
                  />
                </div>
              )}

              {view === "resource_admin" && selectedId && (
                <div className="-m-6 h-[calc(100%+3rem)]">
                  <ResourceAdmin
                    id={selectedId}
                    onBack={() => setUrlState({ view: 'resource', id: selectedId })}
                  />
                </div>
              )}

              {view === "admin" && (
                <ResourceList
                  project={null}
                  resourceCount={resourceCount}
                  onEdit={handleEditResource}
                  onCreate={() => handleCreate(true)}
                />
              )}

              {view === "distributions" && (
                <div className="flex flex-col h-full">
                  <DistributionsList onEditResource={handleEditResource} />
                </div>
              )}

              {(view === "edit" || view === "create") && editing && (
                <ResourceEdit
                  initialResource={editing}
                  initialDistributions={editingDistributions}
                  onSave={handleSave}
                  onCancel={() => {
                    setUrlState({ view: "dashboard" });
                    setEditing(null);
                    setEditingDistributions([]);
                  }}
                  isSaving={isSaving}
                  saveError={saveError}
                />
              )}

              {view === "import" && (
                <div className="flex flex-col h-full">
                  <button
                    onClick={() => {
                      setUrlState({ view: "dashboard" });
                    }}
                    className="mb-4 self-start flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors"
                  >
                    ← Back to Dashboard
                  </button>
                  <ImportPage />
                </div>
              )}

            </section>
          </div>
        </main >
      </ErrorBoundary>
    </div>
  );
};
