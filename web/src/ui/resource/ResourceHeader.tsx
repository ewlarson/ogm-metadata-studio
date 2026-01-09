import React from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';

interface PaginationInfo {
    prevId?: string;
    nextId?: string;
    position: number;
    total: number;
}

interface ResourceHeaderProps {
    resource: Resource;
    pagination: PaginationInfo;
    onNavigate: (id: string) => void;
}

export const ResourceHeader: React.FC<ResourceHeaderProps> = ({ resource, pagination, onNavigate }) => {
    const breadcrumbItems = [
        { label: resource.gbl_resourceClass_sm?.[0], field: 'gbl_resourceClass_sm' },
        { label: resource.gbl_resourceType_sm?.[0], field: 'gbl_resourceType_sm' },
        { label: resource.dct_spatial_sm?.[0], field: 'dct_spatial_sm' },
    ].filter(item => item.label);

    return (
        <div className="border-b border-gray-200 dark:border-slate-800 p-6">
            <div className="flex items-center text-sm text-slate-500 dark:text-slate-400 mb-2">
                {/* Left: Breadcrumbs */}
                <div className="flex items-center gap-2 overflow-hidden flex-1">
                    {breadcrumbItems.map((item, idx) => {
                        // Build cumulative filters up to this index
                        const params = new URLSearchParams();
                        for (let i = 0; i <= idx; i++) {
                            const prev = breadcrumbItems[i];
                            params.append(`include_filters[${prev.field}][]`, prev.label!);
                        }
                        const href = `/?${params.toString()}`;

                        return (
                            <React.Fragment key={idx}>
                                {idx > 0 && <span>&rsaquo;</span>}
                                <Link
                                    href={href}
                                    className="hover:text-indigo-600 dark:hover:text-indigo-400 truncate whitespace-nowrap"
                                >
                                    {item.label}
                                </Link>
                            </React.Fragment>
                        );
                    })}
                </div>

                {/* Right: Navigation Controls */}
                <div className="flex items-center gap-4 shrink-0 ml-4">
                    {/* Back to Results */}
                    <Link
                        href={`/?${window.location.search.substring(1)}`}
                        className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                        </svg>
                        Back
                    </Link>

                    {/* Pagination */}
                    {pagination.total > 0 && (
                        <>
                            <div className="h-4 w-px bg-gray-300 dark:bg-slate-700 mx-2"></div>
                            <button
                                onClick={() => pagination.prevId && onNavigate(pagination.prevId)}
                                disabled={!pagination.prevId}
                                className="flex items-center gap-1 disabled:opacity-30 hover:text-indigo-600 disabled:cursor-not-allowed transition-colors"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                    <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                                </svg>
                                Prev
                            </button>
                            <span className="text-slate-900 dark:text-slate-200 font-medium">
                                {pagination.position} of {pagination.total}
                            </span>
                            <button
                                onClick={() => pagination.nextId && onNavigate(pagination.nextId)}
                                disabled={!pagination.nextId}
                                className="flex items-center gap-1 disabled:opacity-30 hover:text-indigo-600 disabled:cursor-not-allowed transition-colors"
                            >
                                Next
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                    <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                                </svg>
                            </button>
                            <div className="h-4 w-px bg-gray-300 dark:bg-slate-700 mx-2"></div>
                        </>
                    )}

                    {/* Clear Search */}
                    <Link
                        href="/"
                        className="flex items-center gap-1 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                    >
                        Clear
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                        </svg>
                    </Link>
                </div>
            </div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{resource.dct_title_s}</h1>
            <div className="flex flex-wrap gap-4 text-sm text-slate-600 dark:text-slate-400 items-center">
                {resource.dct_publisher_sm?.[0] && (
                    <span>{resource.dct_publisher_sm[0]}</span>
                )}
                {resource.gbl_indexYear_im && (
                    <span>&middot; {resource.gbl_indexYear_im}</span>
                )}

                <div className="flex-1"></div>

                <Link
                    href={`/resources/${resource.id}/edit`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
                        <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
                    </svg>
                    Edit Resource
                </Link>
                <Link
                    href={`/resources/${resource.id}/admin`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                    </svg>
                    Admin
                </Link>
            </div>
        </div>
    );
};
