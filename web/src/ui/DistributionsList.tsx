import React, { useEffect, useState, useCallback } from "react";
import { queryDistributions, DistributionResult } from "../duckdb/duckdbClient";

interface DistributionsListProps {
    onEditResource: (id: string) => void;
}

export const DistributionsList: React.FC<DistributionsListProps> = ({ onEditResource }) => {
    const [distributions, setDistributions] = useState<any[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [debouncedKeyword, setDebouncedKeyword] = useState("");

    // Debounce keyword
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedKeyword(keyword);
            setPage(1); // Reset to page 1 on search
        }, 300);
        return () => clearTimeout(timer);
    }, [keyword]);

    const pageSize = 20;

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const res: DistributionResult = await queryDistributions(page, pageSize, "resource_id", "asc", debouncedKeyword);
            setDistributions(res.distributions);
            setTotal(res.total);
        } catch (err) {
            console.error("Failed to fetch distributions", err);
        } finally {
            setLoading(false);
        }
    }, [page, debouncedKeyword]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const totalPages = Math.ceil(total / pageSize);

    return (
        <div className="flex h-full flex-col bg-gray-50 dark:bg-slate-900 transition-colors duration-200">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 p-4 backdrop-blur-sm">
                <div className="flex items-center gap-4">
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">All Distributions</h2>
                    <span className="rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-400">
                        {total} total
                    </span>
                </div>
                <div>
                    <input
                        type="text"
                        placeholder="Search ID, Relation, URL, or Resource Title..."
                        className="w-80 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
                <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
                        <thead className="bg-gray-50 dark:bg-slate-950">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">Resource ID</th>
                                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">Resource Title</th>
                                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">Type (Relation)</th>
                                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">Label</th>
                                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">URL</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/50">
                            {loading ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">Loading...</td></tr>
                            ) : distributions.length === 0 ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">No distributions found.</td></tr>
                            ) : (
                                distributions.map((d, i) => (
                                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                        <td className="px-4 py-3 text-xs font-mono text-indigo-600 dark:text-indigo-400 cursor-pointer hover:underline" onClick={() => onEditResource(d.resource_id)}>
                                            {d.resource_id}
                                        </td>
                                        <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300">{d.dct_title_s || "-"}</td>
                                        <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300">{d.relation_key}</td>
                                        <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300 italic">{d.label || ""}</td>
                                        <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs" title={d.url}>
                                            <a href={d.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
                                                {d.url}
                                            </a>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 px-4 py-3">
                <div className="text-sm text-slate-500 dark:text-slate-400">
                    Page {page} of {totalPages || 1}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setPage(Math.max(1, page - 1))}
                        disabled={page === 1}
                        className="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-sm text-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 shadow-sm"
                    >
                        Previous
                    </button>
                    <button
                        onClick={() => setPage(Math.min(totalPages, page + 1))}
                        disabled={page >= totalPages}
                        className="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-sm text-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 shadow-sm"
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
};
