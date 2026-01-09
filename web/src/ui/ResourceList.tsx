import React, { useEffect, useState, useCallback } from "react";
import { Resource } from "../aardvark/model";
import { searchResources, SearchResult } from "../duckdb/duckdbClient";
import { ProjectConfig } from "../services/GithubService";
import { Pagination, SortHeader, TableContainer } from "./shared/Table";
import { Link } from "./Link";

interface ResourceListProps {
    project: ProjectConfig | null;
    resourceCount: number;
    onEdit: (id: string) => void;
    onCreate: () => void;
}

export const ResourceList: React.FC<ResourceListProps> = ({
    onEdit,
    onCreate,
}) => {
    const [resources, setResources] = useState<Resource[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    // Search/Sort/Page State
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const pageSize = 20;
    const [sortBy, setSortBy] = useState("id");
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

    // Debounce search
    const [debouncedSearch, setDebouncedSearch] = useState(search);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1); // Reset to page 1 on search change
        }, 300);
        return () => clearTimeout(handler);
    }, [search]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // If no project, we might still have data in DuckDB (from parquet load)
            const res: SearchResult = await searchResources(
                page,
                pageSize,
                sortBy,
                sortOrder,
                debouncedSearch
            );
            setResources(res.resources);
            setTotal(res.total);
        } catch (err) {
            console.error("Failed to fetch resources", err);
            setResources([]);
            setTotal(0);
        } finally {
            setLoading(false);
        }
    }, [page, pageSize, sortBy, sortOrder, debouncedSearch]);


    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSort = (column: string) => {
        if (sortBy === column) {
            setSortOrder(sortOrder === "asc" ? "desc" : "asc");
        } else {
            setSortBy(column);
            setSortOrder("asc");
        }
    };

    return (
        <div className="flex h-full flex-col bg-gray-50 dark:bg-slate-900 transition-colors duration-200">
            {/* Header / Toolbar */}
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 p-4 backdrop-blur-sm">
                <div className="flex items-center gap-4">
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Resources</h2>
                    <span className="rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-400">
                        {total} total
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search resources..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-64 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                        onClick={onCreate}
                        className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Create New
                    </button>
                </div>
            </div>

            {/* Table */}
            <TableContainer>
                <thead className="bg-gray-50 dark:bg-slate-950">
                    <tr>
                        <SortHeader
                            label="ID"
                            column="id"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Title"
                            column="dct_title_s"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Class"
                            column="gbl_resourceClass_sm"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Access"
                            column="dct_accessRights_s"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            Actions
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/50">
                    {loading ? (
                        <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                                Loading...
                            </td>
                        </tr>
                    ) : resources.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                                No resources found.
                            </td>
                        </tr>
                    ) : (
                        resources.map((r) => (
                            <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                                <td className="whitespace-nowrap px-4 py-3 font-mono text-sm text-slate-600 dark:text-slate-300">
                                    <Link href={`/resources/${r.id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
                                        {r.id}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-900 dark:text-slate-100 font-medium">
                                    {r.dct_title_s || <span className="text-slate-400 italic">Untitled</span>}
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
                                    {r.gbl_resourceClass_sm.map(c => (
                                        <span key={c} className="mr-1 inline-flex items-center rounded bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700">
                                            {c}
                                        </span>
                                    ))}
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
                                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${r.dct_accessRights_s === "Public"
                                        ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                                        : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
                                        }`}>
                                        {r.dct_accessRights_s}
                                    </span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-sm">
                                    <button
                                        onClick={() => onEdit(r.id)}
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

            {/* Pagination */}
            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onChange={setPage}
            />
        </div>
    );
};
