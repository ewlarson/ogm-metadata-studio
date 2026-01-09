import React from 'react';
import { Resource } from '../aardvark/model';

interface DashboardResultsListProps {
    resources: Resource[];
    thumbnails: Record<string, string | null>;
    mapUrls: Record<string, string | null>;

    onSelect?: (id: string) => void;
    onAddFilter?: (field: string, value: string) => void;
    page: number;
    pageSize?: number;
}

export const DashboardResultsList: React.FC<DashboardResultsListProps> = ({ resources, thumbnails, mapUrls, onSelect, onAddFilter, page = 1, pageSize = 20 }) => {
    return (
        <div className="space-y-4">
            {resources.map((r, index) => (
                <div key={r.id} className="group relative grid grid-cols-[auto_1fr] gap-4 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4 hover:border-gray-300 dark:hover:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-900/60 transition-colors shadow-sm hover:shadow-md">

                    {/* Index Number */}
                    <div className="flex flex-col items-center justify-start pt-1 w-8 flex-shrink-0">
                        <span className="text-xl font-bold text-gray-200 dark:text-slate-800 group-hover:text-indigo-200 dark:group-hover:text-indigo-900 transition-colors">
                            {(page - 1) * pageSize + index + 1}
                        </span>
                    </div>

                    {/* Thumbnail & Content (Nested Grid) */}
                    <div className="col-span-1 grid grid-cols-[1fr] sm:grid-cols-[auto_1fr] gap-4 w-full">

                        {/* Merged Images (Thumbnail + Map) */}
                        <div className="hidden sm:flex flex-row items-stretch select-none">
                            {/* Thumbnail */}
                            <div className="w-40 h-40 bg-gray-100 dark:bg-slate-950 rounded-l-lg border border-gray-200 dark:border-slate-800 border-r-0 items-center justify-center overflow-hidden flex-shrink-0">
                                {thumbnails[r.id] ? (
                                    <img
                                        src={thumbnails[r.id]!}
                                        alt={`Thumbnail for ${r.dct_title_s}`}
                                        className="w-full h-full object-cover"
                                        onError={(e) => (e.currentTarget.style.display = 'none')}
                                        referrerPolicy="no-referrer"
                                        title={`Thumbnail: ${r.dct_title_s}`}
                                    />
                                ) : (
                                    <span className="text-3xl opacity-20 grayscale select-none" title={`No thumbnail for ${r.dct_title_s}`}>
                                        {r.gbl_resourceClass_sm?.includes("Maps") ? "🗺️" : "📄"}
                                    </span>
                                )}
                            </div>

                            {/* Static Map */}
                            <div className="w-40 h-40 bg-gray-100 dark:bg-slate-950 rounded-r-lg border border-gray-200 dark:border-slate-800 overflow-hidden relative flex-shrink-0">
                                {mapUrls[r.id] ? (
                                    <img
                                        src={mapUrls[r.id]!}
                                        alt={`Location map for ${r.dct_title_s}`}
                                        className="w-full h-full object-cover opacity-90 hover:opacity-100 transition-opacity"
                                        referrerPolicy="no-referrer"
                                        title={`Location map: ${r.dct_title_s}`}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                                        No Map
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex flex-col justify-between h-full">
                            <div>
                                <h3 className="text-lg font-medium text-indigo-600 dark:text-indigo-400 group-hover:text-indigo-700 dark:group-hover:text-indigo-300">
                                    <button onClick={() => onSelect?.(r.id)} className="text-left focus:outline-none hover:underline line-clamp-3">
                                        {r.dct_title_s || "Untitled"}
                                    </button>
                                </h3>
                                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 line-clamp-2">
                                    {r.dct_description_sm?.[0] || "No description."}
                                </p>
                            </div>

                            <div className="flex items-center justify-between mt-2 pt-2 border-t border-dashed border-gray-100 dark:border-slate-800">
                                <div className="flex flex-col gap-2 w-full">
                                    <div className="flex flex-wrap gap-2 items-center">
                                        {/* Class */}
                                        {r.gbl_resourceClass_sm?.slice(0, 3).map(c => (
                                            <FacetTag
                                                key={c}
                                                field="gbl_resourceClass_sm"
                                                value={c}
                                                label="Class"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}

                                        {/* Provider */}
                                        {r.schema_provider_s && (
                                            <FacetTag
                                                field="schema_provider_s"
                                                value={r.schema_provider_s}
                                                label="Provider"
                                                onAddFilter={onAddFilter}
                                            />
                                        )}

                                        {/* Subjects */}
                                        {r.dct_subject_sm?.slice(0, 5).map(s => (
                                            <FacetTag
                                                key={s}
                                                field="dct_subject_sm"
                                                value={s}
                                                label="Subject"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}
                                        {r.dct_subject_sm && r.dct_subject_sm.length > 5 && (
                                            <span className="text-xs text-slate-400">+{r.dct_subject_sm.length - 5} subjects</span>
                                        )}

                                        {/* Keywords */}
                                        {r.dcat_keyword_sm?.slice(0, 5).map(k => (
                                            <FacetTag
                                                key={k}
                                                field="dcat_keyword_sm"
                                                value={k}
                                                label="Keyword"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}
                                        {r.dcat_keyword_sm && r.dcat_keyword_sm.length > 5 && (
                                            <span className="text-xs text-slate-400">+{r.dcat_keyword_sm.length - 5} keywords</span>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 font-mono mt-1">
                                        <span title={r.id} className="truncate max-w-[150px]">{r.id}</span>
                                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border ${r.dct_accessRights_s === "Public" ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800" : "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800"}`}>
                                            {r.dct_accessRights_s}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

const FacetTag: React.FC<{
    field: string;
    value: string;
    label: string;
    onAddFilter?: (field: string, value: string) => void;
}> = ({ field, value, label, onAddFilter }) => {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onAddFilter?.(field, value); }}
            className="inline-flex items-center rounded-sm bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
            title={`Filter by ${label}: ${value}`}
        >
            {value}
        </button>
    );
};
