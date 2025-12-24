import React, { useEffect, useState } from "react";
import { Resource, resourceToJson, REPEATABLE_STRING_FIELDS, Distribution } from "../aardvark/model";
// GithubClient imports removed
import { getDuckDbContext, queryResources, queryResourceById, exportDbBlob, saveDb, upsertResource, queryDistributionsForResource, exportAardvarkJsonZip } from "../duckdb/duckdbClient";
import { TabularEditor } from "./TabularEditor";
import { TagInput } from "./TagInput";
import { ResourceList } from "./ResourceList";
import { ImportPage } from "./ImportPage";
import { ResourceEdit } from "./ResourceEdit";
import { DistributionsList } from "./DistributionsList";
import { Dashboard } from "./Dashboard";
import { useUrlState } from "../hooks/useUrlState";
import { ThemeToggle } from "./ThemeToggle";


export const App: React.FC = () => {
  // Local state only
  const [resourceCount, setResourceCount] = useState<number>(0);

  // URL State
  type ViewType = "dashboard" | "admin" | "edit" | "create" | "import" | "distributions";
  interface AppState {
    view: ViewType;
    id?: string;
  }

  const [urlState, setUrlState] = useUrlState<AppState>(
    { view: "dashboard" },
    {
      toUrl: (s) => {
        const p = new URLSearchParams();
        if (s.view !== "dashboard") p.set("view", s.view);
        if (s.id) p.set("id", s.id);
        return p;
      },
      fromUrl: (p) => {
        const view = (p.get("view") as ViewType) || "dashboard";
        const id = p.get("id") || undefined;
        return { view, id };
      },
      cleanup: (p) => {
        p.delete("view");
        p.delete("id");
      }
    }
  );

  const { view, id: selectedId } = urlState;

  const [editing, setEditing] = useState<Resource | null>(null);
  const [editingDistributions, setEditingDistributions] = useState<Distribution[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isExportingDuckDb, setIsExportingDuckDb] = useState(false);
  const [isExportingJson, setIsExportingJson] = useState(false);
  const [status, setStatus] = useState<string>("Local Mode");

  // Refresh resource count from DuckDB
  async function refreshResourceCount() {
    try {
      const resources = await queryResources();
      setResourceCount(resources.length);
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
  }, [view, selectedId, editing, setUrlState]);


  async function handleExportDuckDb() {
    setIsExportingDuckDb(true);
    try {
      const blob = await exportDbBlob();
      if (!blob) throw new Error("Failed to export DB blob");

      // Download blob as file
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "records.duckdb";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (err) {
      console.error("Failed to export DuckDB", err);
      alert(`Failed to export DuckDB: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExportingDuckDb(false);
    }
  }

  async function handleExportJsonZip() {
    setIsExportingJson(true);
    try {
      const blob = await exportAardvarkJsonZip();
      if (!blob) throw new Error("Failed to export JSON Zip");

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aardvark-json-export.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export JSON Zip", err);
      alert(`Failed to export: ${err}`);
    } finally {
      setIsExportingJson(false);
    }
  }

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

  const handleCreate = (setView = true) => {
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
  };

  const handleReset = () => {
    // Reset to root with no params
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col transition-colors duration-200">
      <header className="border-b border-gray-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 px-4 py-3 flex items-center justify-between backdrop-blur-sm">
        <button
          onClick={handleReset}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity focus:outline-none"
          title="Reset to Dashboard"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 dark:bg-indigo-500 text-white font-bold text-lg shadow-sm">
            A
          </span>
          <div className="text-left">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-tight">Aardvark Metadata Studio</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Local DuckDB Edition
            </p>
          </div>
        </button>
        <div className="text-right flex flex-col items-end gap-1">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{status}</p>
          <div className="flex gap-2 mt-1">
            <ThemeToggle />
            <div className="w-[1px] h-6 bg-gray-300 dark:bg-slate-800 mx-1"></div>
            <button
              type="button"
              onClick={() => setUrlState({ view: "dashboard" })}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${view === "dashboard"
                ? "bg-slate-100 dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white font-medium"
                : "border-transparent text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"}`}
            >
              Dashboard
            </button>
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
            <div className="w-[1px] h-6 bg-gray-300 dark:bg-slate-800 mx-1"></div>
            <button
              type="button"
              onClick={() => setUrlState({ view: "import" })}
              className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${view === "import"
                ? "bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-500/50 text-indigo-700 dark:text-indigo-300"
                : "border-transparent text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"}`}
            >
              Import / Export
            </button>
            <button
              type="button"
              onClick={handleExportJsonZip}
              className="rounded-md border border-emerald-200 dark:border-emerald-900/50 px-2 py-1 text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20"
            >
              {isExportingJson ? "Zipping..." : "Export OGM JSONs"}
            </button>
            <button
              type="button"
              onClick={handleExportDuckDb}
              className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[10px] text-slate-600 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800/70"
            >
              Download DB
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 w-full mx-auto flex flex-col min-h-0">
        <div className="flex-1 flex flex-col min-h-0 space-y-6">

          <section className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/60 p-6 flex-1 flex flex-col min-h-0 overflow-hidden shadow-sm dark:shadow-none backdrop-blur-sm">
            {view === "dashboard" && (
              <div className="flex flex-col h-full -m-6">
                <Dashboard
                  project={null}
                  onEdit={handleEditResource}
                  onCreate={() => handleCreate(true)}
                />
              </div>
            )}

            {view === "admin" && (
              <ResourceList
                project={null}
                resourceCount={resourceCount}
                onEdit={handleEditResource}
                onCreate={() => handleCreate(true)}
                onRefreshProject={refreshResourceCount}
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
    </div>
  );
};
