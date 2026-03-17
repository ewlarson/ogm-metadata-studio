import React, { useState } from "react";
import { importCsv, saveDb, exportDbBlob, importJsonData, exportAardvarkJsonZip } from "../duckdb/duckdbClient";
import { publishCurrentDataToRepoRoot } from "../publish/publishToRepo";
import { GithubImport } from "./GithubImport";

interface ImportPageProps {
    resourceCount?: number;
    onImported?: () => void | Promise<void>;
}

export const ImportPage: React.FC<ImportPageProps> = ({ resourceCount = 0, onImported }) => {
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<"local" | "github">("local");
    const [repoRootHandle, setRepoRootHandle] = useState<any | null>(null);
    const [repoRootName, setRepoRootName] = useState<string>("");

    const handleExportJsonZip = async () => {
        try {
            setLoading(true);
            const blob = await exportAardvarkJsonZip();
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "aardvark-json-export.zip";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setStatus("JSON OGM Export downloaded.");
            }
        } catch (err: any) {
            setStatus(`Export failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setLoading(true);
        setStatus("Importing...");

        try {
            // Process sequentially
            let totalRows = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                setStatus(`Importing ${file.name}...`);

                if (file.name.endsWith(".json")) {
                    const text = await file.text();
                    const json = JSON.parse(text);
                    const count = await importJsonData(json);
                    totalRows += count;
                } else if (file.name.endsWith(".duckdb")) {
                    const { importDuckDbFile } = await import("../duckdb/duckdbClient");
                    const res = await importDuckDbFile(file);
                    if (!res.success) throw new Error(res.message);
                    totalRows += res.count || 0;
                    setStatus(`Database restored. Loaded ${res.count} items.`);
                    await onImported?.();
                    return; // DB Restore is a full replacement, stop processing other files if mixed?
                    // Actually, we can just continue, but usually restore is a standalone op.
                } else {
                    const res = await importCsv(file);
                    if (!res.success) {
                        throw new Error(`Failed to import ${file.name}: ${res.message}`);
                    }
                    totalRows += res.count || 0;
                }
            }
            setStatus(`Import complete! Loaded ${totalRows} resources. Data saved to in-memory DB and IndexedDB.`);
            await onImported?.();
        } catch (err: any) {
            console.error(err);
            setStatus(`Error: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDb = async () => {
        try {
            setLoading(true);
            await saveDb(); // Save to IndexedDB
            const blob = await exportDbBlob();
            if (!blob) {
                setStatus("Browser snapshot saved to IndexedDB. DuckDB file download is not available in this deployment.");
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "records.duckdb";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatus("Database downloaded. Please commit this file to the repository.");
        } catch (err: any) {
            setStatus(`Save failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleChooseRepoRoot = async () => {
        try {
            const picker = (window as any).showDirectoryPicker;
            if (typeof picker !== "function") {
                throw new Error("This browser does not support choosing a local folder. Use a Chromium-based browser.");
            }

            const handle = await picker({
                mode: "readwrite",
            });
            setRepoRootHandle(handle);
            setRepoRootName(handle.name || "");
            setStatus(`Selected repository folder: ${handle.name}.`);
        } catch (err: any) {
            if (err?.name === "AbortError") return;
            setStatus(`Publish setup failed: ${err.message}`);
        }
    };

    const handlePublishToMetadata = async () => {
        if (!repoRootHandle) {
            setStatus("Choose your local repository folder first.");
            return;
        }

        try {
            setLoading(true);
            setStatus("Writing current catalog into web/public/resources.parquet and web/public/resource_distributions.parquet...");
            const result = await publishCurrentDataToRepoRoot(repoRootHandle);
            const readyMessage = `Publish ready. Wrote ${result.resourceCount} records into ${result.publicDirPath}/${result.resourceFileName} and ${result.distributionCount} distributions into ${result.publicDirPath}/${result.distributionsFileName}. Commit and push those files so everyone sees the same dataset on GitHub Pages.`;
            setStatus(readyMessage);
            window.alert(readyMessage);
        } catch (err: any) {
            console.error(err);
            setStatus(`Publish failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-8 max-w-4xl mx-auto space-y-8">
            {resourceCount === 0 && (
                <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl p-8 text-white shadow-lg animate-fade-in-up">
                    <h1 className="text-3xl font-bold mb-4">Welcome to Aardvark Metadata Studio!</h1>
                    <p className="text-lg opacity-90 max-w-2xl">
                        It looks like your database is empty. To get started, please import some data below.
                        You can upload CSV/JSON files or connect a GitHub repository.
                    </p>
                </div>
            )}

            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Import Data</h1>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-slate-800 space-x-6">
                <button
                    onClick={() => setMode("local")}
                    className={`pb-2 text-sm font-medium border-b-2 transition-colors ${mode === "local" ? "border-indigo-500 text-indigo-600 dark:text-white" : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"}`}
                >
                    Local File Upload
                </button>
                <button
                    onClick={() => setMode("github")}
                    className={`pb-2 text-sm font-medium border-b-2 transition-colors ${mode === "github" ? "border-indigo-500 text-indigo-600 dark:text-white" : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"}`}
                >
                    GitHub Import
                </button>
            </div>

            {mode === "local" && (
                <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-6 shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-slate-200">1. CSV / JSON / DuckDB Import</h2>
                    <p className="text-slate-500 dark:text-slate-400 mb-4 text-sm">
                        Upload Aardvark-compliant CSV files, OGM Aardvark JSON files, or a <b>.duckdb</b> backup file.
                        Existing records with matching IDs will be updated (CSV/JSON) or replaced (DB Backup).
                    </p>
                    <input
                        type="file"
                        accept=".csv,.json,.duckdb"
                        multiple
                        onChange={handleFileChange}
                        disabled={loading}
                        className="block w-full text-sm text-slate-500 dark:text-slate-400
                            file:mr-4 file:py-2 file:px-4
                            file:rounded-full file:border-0
                            file:text-sm file:font-semibold
                            file:bg-indigo-600 file:text-white
                            hover:file:bg-indigo-700
                        "
                    />
                    {status && (
                        <div className={`mt-6 p-4 rounded-md ${status.startsWith("Error") ? "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-200 border-red-200 dark:border-red-800" : "bg-gray-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-gray-200 dark:border-slate-700"} border`}>
                            {status}
                        </div>
                    )}
                </div>
            )}

            {mode === "github" && (
                <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-6 shadow-sm">
                    <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-slate-200">GitHub Repository Import</h2>
                    <p className="text-slate-500 dark:text-slate-400 mb-6 text-sm">
                        Scan a GitHub repository for `metadata-aardvark` folders and bulk import JSON records.
                    </p>
                    <GithubImport onImported={onImported} />
                </div>
            )}

            <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-6 shadow-sm">
                <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-slate-200">2. Export Data</h2>
                <p className="text-slate-500 dark:text-slate-400 mb-6 text-sm">
                    Export your data for backup or to commit back to GitHub.
                </p>

                <div className="flex gap-4">
                    <div className="flex-1 p-4 bg-gray-50 dark:bg-slate-800 rounded border border-gray-200 dark:border-slate-700">
                        <h3 className="text-sm font-medium text-slate-900 dark:text-slate-200 mb-2">Download Database (Backup)</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                            Download the full `records.duckdb` file. Commit this to `web/public/` to save changes permanently.
                        </p>
                        <button
                            onClick={handleSaveDb}
                            disabled={loading}
                            className="w-full bg-slate-600 text-white px-4 py-2 rounded-md hover:bg-slate-500 disabled:opacity-50 text-sm font-medium transition-colors"
                        >
                            Download records.duckdb
                        </button>
                    </div>

                    <div className="flex-1 p-4 bg-gray-50 dark:bg-slate-800 rounded border border-gray-200 dark:border-slate-700">
                        <h3 className="text-sm font-medium text-slate-900 dark:text-slate-200 mb-2">Export OGM JSONs (Publish)</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                            Download a ZIP of individual Aardvark JSON files, ready for the GBL workflow.
                        </p>
                        <button
                            onClick={handleExportJsonZip}
                            disabled={loading}
                            className="w-full bg-emerald-600 text-white px-4 py-2 rounded-md hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium transition-colors"
                        >
                            {loading ? "Zipping..." : "Download JSON Zip"}
                        </button>
                    </div>
                </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-6 shadow-sm">
                <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-slate-200">3. Publish Workflow</h2>
                <p className="text-slate-500 dark:text-slate-400 mb-6 text-sm">
                    Choose your local repository root and write the current dataset into <code>web/public/resources.parquet</code>
                    and <code>web/public/resource_distributions.parquet</code>.
                    After that, all you need to do is commit and push those files. GitHub Pages will rebuild
                    the site with those published Parquet artifacts.
                </p>

                <div className="space-y-4">
                    <div className="rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <h3 className="text-sm font-medium text-slate-900 dark:text-slate-200">Target Repository Folder</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                    Pick the local repo root that contains the <code>web/public/</code> folder you want to publish.
                                </p>
                            </div>
                            <button
                                onClick={handleChooseRepoRoot}
                                disabled={loading}
                                className="rounded-md border border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-4 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 disabled:opacity-50"
                            >
                                {repoRootHandle ? "Choose Different Folder" : "Choose Repo Folder"}
                            </button>
                        </div>
                        <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
                            {repoRootHandle
                                ? `Selected: ${repoRootName || "repository root"}`
                                : "No repository folder selected yet."}
                        </p>
                    </div>

                    <div className="rounded border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-4">
                        <h3 className="text-sm font-medium text-slate-900 dark:text-slate-200">Write Publishable Metadata</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
                            This writes the current in-browser dataset to <code>web/public/resources.parquet</code> plus
                            <code>web/public/resource_distributions.parquet</code>.
                            Once complete, commit and push both files so everyone sees the same dataset on GitHub Pages.
                        </p>
                        <button
                            onClick={handlePublishToMetadata}
                            disabled={loading || !repoRootHandle || resourceCount === 0}
                            className="w-full bg-emerald-600 text-white px-4 py-2 rounded-md hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium transition-colors"
                        >
                            {loading ? "Publishing..." : "Prepare Parquet files for commit"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
