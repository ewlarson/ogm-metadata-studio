import React, { useEffect, useState, useCallback } from "react";
import { queryDistributions, DistributionResult } from "../duckdb/duckdbClient";
import { Pagination, SortHeader, TableContainer } from "./shared/Table";
import { Link } from "./Link";

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

    const [sort, setSort] = useState("resource_id");
    const [dir, setDir] = useState<"asc" | "desc">("asc");

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
            const res: DistributionResult = await queryDistributions(page, pageSize, sort, dir, debouncedKeyword);
            setDistributions(res.distributions);
            setTotal(res.total);
        } catch (err) {
            console.error("Failed to fetch distributions", err);
        } finally {
            setLoading(false);
        }
    }, [page, debouncedKeyword, sort, dir]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSort = (column: string) => {
        if (sort === column) {
            setDir(dir === "asc" ? "desc" : "asc");
        } else {
            setSort(column);
            setDir("asc");
        }
    };

    return (
        <div className="flex h-full flex-col bg-gray-50 dark:bg-slate-900 transition-colors duration-200">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 p-4 backdrop-blur-sm">
                <div className="flex items-center gap-4">
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">All Distributions</h2>
                    <span className="rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-400">
                        {total} total
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search ID, Relation, URL, or Resource Title..."
                        className="w-80 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                    />
                    <button
                        onClick={() => alert("Create Distribution not implemented yet (handled via Resource Edit)")}
                        className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
                    >
                        Create New
                    </button>
                </div>
            </div>

            <TableContainer>
                <thead className="bg-gray-50 dark:bg-slate-950">
                    <tr>
                        <SortHeader label="Resource ID" column="resource_id" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Resource Title" column="dct_title_s" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Type (Relation)" column="relation_key" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Label" column="label" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">URL</th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">Actions</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/50">
                    {loading ? (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">Loading...</td></tr>
                    ) : distributions.length === 0 ? (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">No distributions found.</td></tr>
                    ) : (
                        distributions.map((d, i) => (
                            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                <td className="px-4 py-3 text-xs font-mono text-slate-600 dark:text-slate-400">
                                    <Link href={`/resources/${d.resource_id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
                                        {d.resource_id}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300">{d.dct_title_s || "-"}</td>
                                <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300">{d.relation_key}</td>
                                <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300 italic">{d.label || ""}</td>
                                <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs" title={d.url}>
                                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
                                        {d.url}
                                    </a>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-xs">
                                    <button
                                        onClick={() => onEditResource(d.resource_id)}
                                        className="font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 hover:underline"
                                    >
                                        Edit
                                    </button>
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </TableContainer>

            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onChange={setPage}
            />
        </div>
    );
};
