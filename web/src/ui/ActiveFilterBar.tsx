
import React from "react";


interface ActiveFilterBarProps {
    query: string;
    facets: Record<string, string[]>;
    yearRange?: string; // "min,max"
    fieldLabels?: Record<string, string>;
    onRemoveQuery: () => void;
    onRemoveFacet: (field: string, value: string) => void;
    onRemoveYearRange?: () => void;
    onClearAll: () => void;
}

export const ActiveFilterBar: React.FC<ActiveFilterBarProps> = ({
    query,
    facets,
    yearRange,
    fieldLabels,
    onRemoveQuery,
    onRemoveFacet,
    onRemoveYearRange,
    onClearAll,
}) => {
    const hasQuery = query && query.trim().length > 0;
    const hasFacets = Object.values(facets).some((v) => v.length > 0);
    const hasYearRange = !!yearRange;

    if (!hasQuery && !hasFacets && !hasYearRange) return null;

    const getLabel = (field: string) => {
        if (fieldLabels && fieldLabels[field]) return fieldLabels[field];
        // Fallback: title case the simplified string? or just simplified
        const simple = field.replace(/_s[m]?$/, '').replace('gbl_', '').replace('dct_', '');
        // Capitalize first letter?
        return simple.charAt(0).toUpperCase() + simple.slice(1);
    };

    return (
        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg shadow-sm">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-1">
                Active Filters:
            </span>

            {/* Query Chip */}
            {hasQuery && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-800">
                    <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    Search: {query}
                    <button
                        onClick={onRemoveQuery}
                        className="ml-1 rounded-full hover:bg-indigo-200 dark:hover:bg-indigo-800 p-0.5 text-indigo-600 dark:text-indigo-400 focus:outline-none"
                        title="Remove search term"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </span>
            )}

            {/* Year Range Chip */}
            {hasYearRange && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-900/30 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-800">
                    <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    Year: {yearRange?.replace(',', ' - ')}
                    {onRemoveYearRange && (
                        <button
                            onClick={onRemoveYearRange}
                            className="ml-1 rounded-full hover:bg-emerald-200 dark:hover:bg-emerald-800 p-0.5 text-emerald-600 dark:text-emerald-400 focus:outline-none"
                            title="Remove year filter"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    )}
                </span>
            )}

            {/* Facet Chips */}
            {Object.entries(facets).flatMap(([field, values]) =>
                values.map((val) => (
                    <span
                        key={`${field}-${val}`}
                        className="inline-flex items-center gap-1 rounded-full bg-sky-50 dark:bg-sky-900/30 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300 border border-sky-100 dark:border-sky-800"
                    >
                        <span className="opacity-70">{getLabel(field)}:</span>
                        {val}
                        <button
                            onClick={() => onRemoveFacet(field, val)}
                            className="ml-1 rounded-full hover:bg-sky-200 dark:hover:bg-sky-800 p-0.5 text-sky-600 dark:text-sky-400 focus:outline-none"
                            title="Remove filter"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </span>
                ))
            )}

            {/* Clear All */}
            <button
                onClick={onClearAll}
                className="ml-auto text-xs text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 flex items-center gap-1 transition-colors"
            >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                Clear All
            </button>
        </div>
    );
};
