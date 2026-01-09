import React from 'react';

interface ImportProgressProps {
    foundFiles: { path: string, sha: string }[];
    schemaMode: 'aardvark' | 'gbl1' | null;
    isImporting: boolean;
    onImport: () => void;
    progress: { current: number, total: number, successes: number, failures: number };
    errorLogs: { path: string, error: string }[];
}

export const ImportProgress: React.FC<ImportProgressProps> = ({
    foundFiles,
    schemaMode,
    isImporting,
    onImport,
    progress,
    errorLogs
}) => {
    if (foundFiles.length === 0) return null;

    return (
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
                        onClick={onImport}
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
                            style={{ width: `${(progress.current / foundFiles.length) * 100}%` }}
                        />
                    </div>
                    <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                        <span>Processing: {progress.current} / {foundFiles.length}</span>
                        <span>Success: {progress.successes} | Fail: {progress.failures}</span>
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
    );
};
