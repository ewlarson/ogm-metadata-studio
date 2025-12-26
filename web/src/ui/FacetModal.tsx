
import React, { useEffect, useState, useCallback } from 'react';
import { getFacetValues, FacetValueRequest } from '../duckdb/duckdbClient';

interface FacetModalProps {
    field: string;
    label: string;
    isOpen: boolean;
    onClose: () => void;

    // Global Context
    q?: string;
    filters?: Record<string, any>;
    bbox?: string; // "minX,minY,maxX,maxY"
    yearRange?: string; // "min,max"

    // Selection
    selectedValues: string[];
    excludedValues: string[];
    onToggle: (field: string, value: string, mode: 'include' | 'exclude') => void;
}

export const FacetModal: React.FC<FacetModalProps> = ({
    field, label, isOpen, onClose,
    q, filters, bbox, yearRange,
    selectedValues, excludedValues, onToggle
}) => {

    const [loading, setLoading] = useState(false);
    const [values, setValues] = useState<{ value: string; count: number }[]>([]);
    const [total, setTotal] = useState(0);

    // Local Filter State
    const [page, setPage] = useState(1);
    const [pageSize] = useState(20);
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<"count" | "alpha">("count");

    const fetchValues = useCallback(async () => {
        setLoading(true);
        try {
            const bboxObj = bbox ? (() => {
                const p = bbox.split(',').map(Number);
                if (p.length === 4) return { minX: p[0], minY: p[1], maxX: p[2], maxY: p[3] };
                return undefined;
            })() : undefined;

            const res = await getFacetValues({
                field,
                q: q || "",
                filters: filters || {},
                bbox: bboxObj,
                yearRange: yearRange,
                facetQuery: search,
                sort,
                page,
                pageSize
            });
            setValues(res.values);
            setTotal(res.total);
        } catch (e) {
            console.error("Failed to fetch facet values", e);
        } finally {
            setLoading(false);
        }
    }, [field, q, filters, bbox, yearRange, page, pageSize, search, sort]);

    // Reset page when search or sort changes
    useEffect(() => {
        setPage(1);
    }, [search, sort]);

    useEffect(() => {
        if (isOpen) {
            fetchValues();
            // Lock body scroll
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }

        return () => {
            document.body.style.overflow = '';
        };
    }, [isOpen, fetchValues]);

    if (!isOpen) return null;

    const totalPages = Math.ceil(total / pageSize);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            ></div>

            {/* Modal */}
            <div className="relative w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col max-h-[90vh] border border-gray-200 dark:border-slate-800">

                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-800">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                            Select {label}
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {total} values found
                        </p>
                    </div>

                    <button
                        onClick={onClose}
                        className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-slate-500 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                        </svg>
                    </button>
                </div>

                {/* Toolbar */}
                <div className="p-4 border-b border-gray-200 dark:border-slate-800 flex gap-4 bg-gray-50 dark:bg-slate-900/50">
                    <div className="flex-1 relative">
                        <input
                            type="text"
                            placeholder={`Search ${label}...`}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full text-sm rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 py-2.5 pl-10 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 shadow-sm"
                            autoFocus
                        />
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <div className="flex rounded-md shadow-sm">
                        <button
                            onClick={() => setSort("count")}
                            className={`px-3 py-1.5 text-xs font-medium rounded-l-md border ${sort === "count"
                                ? "bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/20 dark:border-indigo-800 dark:text-indigo-300 z-10"
                                : "bg-white border-gray-300 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"}`}
                        >
                            Count
                        </button>
                        <button
                            onClick={() => setSort("alpha")}
                            className={`px-3 py-1.5 text-xs font-medium rounded-r-md border -ml-px ${sort === "alpha"
                                ? "bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/20 dark:border-indigo-800 dark:text-indigo-300 z-10"
                                : "bg-white border-gray-300 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"}`}
                        >
                            A-Z
                        </button>
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
                    {loading ? (
                        <div className="flex items-center justify-center h-32 text-slate-400">Loading...</div>
                    ) : values.length > 0 ? (
                        <div className="flex flex-col space-y-1">
                            {values.map(item => {
                                const isIncluded = selectedValues.includes(item.value);
                                const isExcluded = excludedValues.includes(item.value);

                                return (
                                    <div key={item.value} className="flex items-center justify-between px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-slate-800 group transition-colors">
                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                            <button
                                                onClick={() => onToggle(field, item.value, 'include')}
                                                className={`flex-1 text-left text-base sm:text-sm truncate ${isIncluded
                                                    ? "font-bold text-indigo-600 dark:text-indigo-400"
                                                    : isExcluded
                                                        ? "text-red-500 line-through decoration-red-500 opacity-70"
                                                        : "text-slate-700 dark:text-slate-300"
                                                    }`}
                                                title={item.value}
                                            >
                                                {item.value || "<Empty>"}
                                            </button>
                                        </div>

                                        <div className="flex items-center gap-3 flex-shrink-0">
                                            <span className="text-xs font-mono text-slate-400 dark:text-slate-500 bg-gray-50 dark:bg-slate-800/50 px-2 py-0.5 rounded border border-gray-200 dark:border-slate-700">
                                                {item.count}
                                            </span>

                                            {/* Exclude Button */}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onToggle(field, item.value, 'exclude');
                                                }}
                                                className={`p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600 transition-colors ${isExcluded ? 'text-red-600' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                                                title="Exclude this value"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clipRule="evenodd" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-sm">
                            <p>No values found.</p>
                        </div>
                    )}
                </div>

                {/* Footer / Pagination */}
                {totalPages > 1 && (
                    <div className="p-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex items-center justify-between">
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                            Page {page} of {totalPages}
                        </span>

                        <div className="flex gap-2">
                            <button
                                disabled={page <= 1}
                                onClick={() => setPage(p => p - 1)}
                                className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Previous
                            </button>
                            <button
                                disabled={page >= totalPages}
                                onClick={() => setPage(p => p + 1)}
                                className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
