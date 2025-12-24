import React, { useState } from "react";
import { importCsv, saveDb, exportDbBlob, importJsonData, exportAardvarkJsonZip } from "../duckdb/duckdbClient";
import { GithubImport } from "./GithubImport";

export const ImportPage: React.FC = () => {
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<"local" | "github">("local");

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
                } else {
                    const res = await importCsv(file);
                    if (!res.success) {
                        throw new Error(`Failed to import ${file.name}: ${res.message}`);
                    }
                    totalRows += res.count || 0;
                }
            }
            setStatus(`Import complete! Loaded ${totalRows} resources. Data saved to in-memory DB and IndexedDB.`);
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
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "records.duckdb";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setStatus("Database downloaded. Please commit this file to the repository.");
            }
        } catch (err: any) {
            setStatus(`Save failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-8 max-w-4xl mx-auto space-y-8">
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
                    <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-slate-200">1. CSV / JSON Import</h2>
                    <p className="text-slate-500 dark:text-slate-400 mb-4 text-sm">
                        Upload Aardvark-compliant CSV files or OGM Aardvark JSON files.
                        Existing records with matching IDs will be updated.
                    </p>
                    <input
                        type="file"
                        accept=".csv,.json"
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
                    <GithubImport />
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
        </div>
    );
};
