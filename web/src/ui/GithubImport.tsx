import React, { useState } from 'react';
import { GithubClient } from '../github/client';
import { importJsonData, saveDb } from '../duckdb/duckdbClient';
import { gbl1ToAardvark } from '../aardvark/gbl1_to_aardvark';

export const GithubImport: React.FC = () => {
    // Inputs
    const [repoUrl, setRepoUrl] = useState("https://github.com/OpenGeoMetadata/edu.umn");
    const [branch, setBranch] = useState("main");
    const [token, setToken] = useState("");

    // State
    const [isScanning, setIsScanning] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const [foundFiles, setFoundFiles] = useState<{ path: string; sha: string }[]>([]);
    const [schemaMode, setSchemaMode] = useState<'aardvark' | 'gbl1'>('aardvark');

    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState({ current: 0, total: 0, successes: 0, failures: 0 });
    const [errorLogs, setErrorLogs] = useState<{ path: string, error: string }[]>([]);

    const parseRepoUrl = (url: string): { owner: string; repo: string } | null => {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        } catch {
            // try manual split if not full url
            const parts = url.split('/');
            if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
        }
        return null;
    };

    const handleScan = async () => {
        setIsScanning(true);
        setScanError(null);
        setFoundFiles([]);
        setSchemaMode('aardvark');

        setErrorLogs([]);

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) {
            setScanError("Invalid Repository URL. Expected format: https://github.com/owner/repo");
            setIsScanning(false);
            return;
        }

        const client = new GithubClient({ token: token || undefined });

        try {
            // 0. Auto-detect default branch if possible
            // We want to help the user who leaves "main" but the repo uses "master".
            let effectiveBranch = branch;
            try {
                const repoData = await client.fetchRepoInfo(repoRef.owner, repoRef.repo);
                if (repoData.default_branch && branch === "main" && repoData.default_branch !== "main") {
                    console.log(`[GithubImport] Switch branch 'main' -> '${repoData.default_branch}' (repo default)`);
                    effectiveBranch = repoData.default_branch;
                    setBranch(effectiveBranch); // Update UI
                }
            } catch (e) {
                console.warn("Could not fetch repo info for default branch check", e);
            }

            // 1. Try 'metadata-aardvark' first
            console.log(`[GithubImport] Attempting smart fetch for 'metadata-aardvark' subtree on ${effectiveBranch}...`);
            let files: { path: string; sha: string }[] = [];
            let mode: 'aardvark' | 'gbl1' = 'aardvark';

            try {
                const subtreeFiles = await client.fetchSubtree({ ...repoRef, branch: effectiveBranch }, "metadata-aardvark");
                if (subtreeFiles.length === 0) throw new Error("metadata-aardvark not found or empty");

                files = subtreeFiles.map(f => ({ ...f, path: `metadata-aardvark/${f.path}` }));
                console.log(`[GithubImport] Found metadata-aardvark. Got ${files.length} items.`);
                mode = 'aardvark';
            } catch (e) {
                console.warn("[GithubImport] No metadata-aardvark folder found. Keeping checks open.");

                // 2. Fallback: Check for 'json' folder (common in GBL v1 repos like Harvard)
                try {
                    console.log(`[GithubImport] Checking for legacy 'json' folder...`);
                    const subtreeFiles = await client.fetchSubtree({ ...repoRef, branch: effectiveBranch }, "json");
                    if (subtreeFiles.length === 0) throw new Error("json folder not found or empty");

                    files = subtreeFiles.map(f => ({ ...f, path: `json/${f.path}` }));
                    console.log(`[GithubImport] Found json folder. Got ${files.length} items.`);
                    mode = 'gbl1';
                } catch (e2) {
                    // 3. Fallback: Full Scan
                    console.warn("[GithubImport] No json folder found either. Falling back to full recursive.");
                    files = await client.fetchRecursiveTree({ ...repoRef, branch: effectiveBranch });
                    // We will decide mode based on file contents or paths later, but for now default Aardvark
                    // If we scan recursively and find no folders, it's tough.
                    // But usually OGM repos have structure.
                }
            }

            setSchemaMode(mode);

            // Filter for JSON
            let jsonFiles = files.filter(f => f.path.endsWith(".json"));

            // If we are in recursive fallback mode (mode === 'aardvark' still, but maybe we should re-evaluate)
            // If the fallback scan ran, 'mode' is likely still 'aardvark' from initialization, or whatever the last attempt set?
            // Wait, in my code, if fallback runs, mode is NOT updated.

            // Heuristic detection if we have JSONs but not from known folders
            if (jsonFiles.length > 0) {
                const aardvark = jsonFiles.filter(f => f.path.includes("metadata-aardvark"));
                // Check for "json" folder anywhere in path
                const legacy = jsonFiles.filter(f => f.path.split("/").includes("json"));

                if (aardvark.length > 0) {
                    // Prioritize Aardvark
                    jsonFiles = aardvark;
                    setSchemaMode('aardvark');
                } else if (legacy.length > 0) {
                    // If we found 'json' folders, assume legacy
                    jsonFiles = legacy;
                    setSchemaMode('gbl1');
                } else {
                    // Fallback: If we found JSONs but they are just random?
                    // Let's assume they are GBL1 if we couldn't find metadata-aardvark
                    setSchemaMode('gbl1');
                }
            }

            if (jsonFiles.length === 0) {
                // Construct a better error message with sample paths
                const sample = files.slice(0, 5).map(f => f.path).join(", ");
                setScanError(`Scanned ${files.length} files but found no JSON files. Sample paths: ${sample}`);
            } else {
                setFoundFiles(jsonFiles);
            }

        } catch (err: any) {
            console.error(err);
            setScanError(err.message || "Failed to scan repository.");
        } finally {
            setIsScanning(false);
        }
    };

    const handleImport = async () => {
        if (foundFiles.length === 0) return;

        setIsImporting(true);

        setErrorLogs([]);
        setImportProgress({ current: 0, total: foundFiles.length, successes: 0, failures: 0 });

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) return;

        const client = new GithubClient({ token: token || undefined });

        const CHUNK_SIZE = 50;
        let successes = 0;
        let failures = 0;

        for (let i = 0; i < foundFiles.length; i += CHUNK_SIZE) {
            const chunk = foundFiles.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (file) => {
                try {
                    let json = await client.fetchPublicJson({ ...repoRef, branch }, file.path);

                    // GBL v1 Handling
                    if (schemaMode === 'gbl1') {
                        // Check for double-encoded string (e.g. Harvard)
                        if (typeof json === 'string') {
                            try {
                                json = JSON.parse(json);
                            } catch (e) {
                                // Maybe it was just a string? Unlikely for metadata
                                throw new Error("Failed to parse double-encoded JSON string");
                            }
                        }

                        // Crosswalk
                        json = gbl1ToAardvark(json);
                    }

                    const count = await importJsonData(json, { skipSave: true });

                    if (count > 0) {
                        successes++;
                    } else {
                        failures++;
                        setErrorLogs(prev => [...prev.slice(-99), { path: file.path, error: "No Resource ID found" }]);
                    }
                } catch (e: any) {
                    console.error(`Failed to import ${file.path}`, e);
                    failures++;
                    setErrorLogs(prev => [...prev.slice(-99), { path: file.path, error: e.message || String(e) }]);
                }
            }));

            setImportProgress(prev => ({
                ...prev,
                current: Math.min(i + CHUNK_SIZE, foundFiles.length),
                successes,
                failures
            }));
        }

        // Final Save
        await saveDb();

        setIsImporting(false);
        alert(`Import Complete! Imported ${successes} files. Failed ${failures}.`);
    };

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">GitHub Repository URL</label>
                    <input
                        type="text"
                        value={repoUrl}
                        onChange={e => setRepoUrl(e.target.value)}
                        className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none"
                        placeholder="e.g. https://github.com/OpenGeoMetadata/edu.umn"
                    />
                </div>
                <div className="space-y-2">
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Branch</label>
                    <input
                        type="text"
                        value={branch}
                        onChange={e => setBranch(e.target.value)}
                        className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none"
                        placeholder="main"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                    Personal Access Token (Optional but Recommended)
                    <span className="ml-2 text-[10px] text-slate-400 dark:text-slate-500">Increase rate limit from 60/hr to 5000/hr</span>
                </label>
                <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none"
                    placeholder="github_pat_..."
                />
            </div>

            {scanError && (
                <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-200 text-sm">
                    {scanError}
                </div>
            )}

            <div className="flex gap-4">
                <button
                    onClick={handleScan}
                    disabled={isScanning || isImporting}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                    {isScanning ? "Scanning..." : "Scan Repository"}
                </button>
            </div>

            {/* Results Area */}
            {foundFiles.length > 0 && (
                <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-sm font-medium text-slate-900 dark:text-slate-200">
                                Found {foundFiles.length} files
                            </h3>
                            <p className="text-xs text-slate-500">Detected Schema: <span className="font-semibold uppercase">{schemaMode}</span></p>
                        </div>
                        {!isImporting && (
                            <button
                                onClick={handleImport}
                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-sm font-medium shadow-sm"
                            >
                                Start Import
                            </button>
                        )}
                    </div>

                    {isImporting && (
                        <div className="space-y-2">
                            <div className="h-2 w-full bg-gray-200 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-emerald-500 transition-all duration-300"
                                    style={{ width: `${(importProgress.current / foundFiles.length) * 100}%` }}
                                />
                            </div>
                            <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                                <span>Processing: {importProgress.current} / {foundFiles.length}</span>
                                <span>Success: {importProgress.successes} | Fail: {importProgress.failures}</span>
                            </div>
                        </div>
                    )}

                    {errorLogs.length > 0 && (
                        <div className="max-h-64 overflow-y-auto border border-red-200 dark:border-red-900 rounded bg-red-50 dark:bg-red-950/20 p-2 text-xs font-mono text-red-600 dark:text-red-300">
                            <div className="font-bold border-b border-red-200 dark:border-red-900 mb-2 pb-1">Error Log (Last 100)</div>
                            {errorLogs.map((e, i) => (
                                <div key={i} className="mb-1">
                                    <span className="font-semibold">{e.path}:</span> {e.error}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="max-h-64 overflow-y-auto border border-gray-200 dark:border-slate-800 rounded bg-gray-50 dark:bg-slate-900/50 p-2 text-xs font-mono text-slate-500 dark:text-slate-400">
                        {foundFiles.slice(0, 100).map(f => (
                            <div key={f.sha} className="truncate">{f.path}</div>
                        ))}
                        {foundFiles.length > 100 && <div className="italic pt-2">...and {foundFiles.length - 100} more</div>}
                    </div>
                </div>
            )}
        </div>
    );
};
