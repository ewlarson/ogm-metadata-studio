import React from 'react';

interface ScanFormProps {
    repoUrl: string;
    setRepoUrl: (val: string) => void;
    branch: string;
    setBranch: (val: string) => void;
    token: string;
    setToken: (val: string) => void;
    onScan: () => void;
    isScanning: boolean;
    scanError: string | null;
}

export const ScanForm: React.FC<ScanFormProps> = ({
    repoUrl, setRepoUrl,
    branch, setBranch,
    token, setToken,
    onScan,
    isScanning,
    scanError
}) => {
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
                    onClick={onScan}
                    disabled={isScanning}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                    {isScanning ? "Scanning..." : "Scan Repository"}
                </button>
            </div>
        </div>
    );
};
