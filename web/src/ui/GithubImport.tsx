import React, { useState } from 'react';
import { GithubClient, GithubRepoRef } from '../github/client';
import { importJsonData, saveDb } from '../duckdb/duckdbClient';

export const GithubImport: React.FC = () => {
    // Inputs
    const [repoUrl, setRepoUrl] = useState("https://github.com/OpenGeoMetadata/edu.umn");
    const [branch, setBranch] = useState("main");
    const [token, setToken] = useState("");

    // State
    const [isScanning, setIsScanning] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const [foundFiles, setFoundFiles] = useState<{ path: string; sha: string }[]>([]);

    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState({ current: 0, total: 0, successes: 0, failures: 0 });
    const [errorLogs, setErrorLogs] = useState<{ path: string, error: string }[]>([]);
    const [importError, setImportError] = useState<string | null>(null);

    const parseRepoUrl = (url: string): { owner: string; repo: string } | null => {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        } catch (e) {
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
        setImportError(null);
        setErrorLogs([]);

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) {
            setScanError("Invalid Repository URL. Expected format: https://github.com/owner/repo");
            setIsScanning(false);
            return;
        }

        const client = new GithubClient({ token: token || undefined });

        try {
            // 1. Verify access (and branch somewhat implicitly by fetching tree)
            const files = await client.fetchRecursiveTree({ ...repoRef, branch });

            // 2. Filter for metadata-aardvark json files
            const aardvarkFiles = files.filter(f =>
                f.path.includes("metadata-aardvark") && f.path.endsWith(".json")
            );

            if (aardvarkFiles.length === 0) {
                setScanError("No files found matching 'metadata-aardvark/**/*.json'. check your branch or repo structure.");
            } else {
                setFoundFiles(aardvarkFiles);
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
        setImportError(null);
        setErrorLogs([]);
        setImportProgress({ current: 0, total: foundFiles.length, successes: 0, failures: 0 });

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) return;

        const client = new GithubClient({ token: token || undefined });

        // Optimization: Use Parallel Raw Fetches.
        // Zipball is faster but 'codeload.github.com' has CORS restrictions that block browser access.
        // Raw content (raw.githubusercontent.com) has proper CORS headers.

        const CHUNK_SIZE = 50;
        let successes = 0;
        let failures = 0;

        for (let i = 0; i < foundFiles.length; i += CHUNK_SIZE) {
            const chunk = foundFiles.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (file) => {
                try {
                    const json = await client.fetchPublicJson({ ...repoRef, branch }, file.path);
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
                    <label className="block text-xs font-medium text-slate-400">GitHub Repository URL</label>
                    <input
                        type="text"
                        value={repoUrl}
                        onChange={e => setRepoUrl(e.target.value)}
                        className="w-full rounded bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                        placeholder="e.g. https://github.com/OpenGeoMetadata/edu.umn"
                    />
                </div>
                <div className="space-y-2">
                    <label className="block text-xs font-medium text-slate-400">Branch</label>
                    <input
                        type="text"
                        value={branch}
                        onChange={e => setBranch(e.target.value)}
                        className="w-full rounded bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                        placeholder="main"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-400">
                    Personal Access Token (Optional but Recommended)
                    <span className="ml-2 text-[10px] text-slate-500">Increase rate limit from 60/hr to 5000/hr</span>
                </label>
                <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    className="w-full rounded bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    placeholder="github_pat_..."
                />
            </div>

            {scanError && (
                <div className="p-3 bg-red-900/30 border border-red-800 rounded text-red-200 text-sm">
                    {scanError}
                </div>
            )}

            <div className="flex gap-4">
                <button
                    onClick={handleScan}
                    disabled={isScanning || isImporting}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isScanning ? "Scanning..." : "Scan Repository"}
                </button>
            </div>

            {/* Results Area */}
            {foundFiles.length > 0 && (
                <div className="space-y-4 pt-4 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium text-slate-200">
                            Found {foundFiles.length} Aardvark JSON files
                        </h3>
                        {!isImporting && (
                            <button
                                onClick={handleImport}
                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-sm font-medium"
                            >
                                Start Import
                            </button>
                        )}
                    </div>

                    {isImporting && (
                        <div className="space-y-2">
                            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-emerald-500 transition-all duration-300"
                                    style={{ width: `${(importProgress.current / foundFiles.length) * 100}%` }}
                                />
                            </div>
                            <div className="flex justify-between text-xs text-slate-400">
                                <span>Processing: {importProgress.current} / {foundFiles.length}</span>
                                <span>Success: {importProgress.successes} | Fail: {importProgress.failures}</span>
                            </div>
                        </div>
                    )}

                    {errorLogs.length > 0 && (
                        <div className="max-h-64 overflow-y-auto border border-red-900 rounded bg-red-950/20 p-2 text-xs font-mono text-red-300">
                            <div className="font-bold border-b border-red-900 mb-2 pb-1">Error Log (Last 100)</div>
                            {errorLogs.map((e, i) => (
                                <div key={i} className="mb-1">
                                    <span className="font-semibold">{e.path}:</span> {e.error}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="max-h-64 overflow-y-auto border border-slate-800 rounded bg-slate-900/50 p-2 text-xs font-mono text-slate-400">
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
