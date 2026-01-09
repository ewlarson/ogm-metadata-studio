import React, { useEffect, useRef } from 'react';
import { Resource } from '../aardvark/model';

interface GalleryViewProps {
    resources: Resource[];
    thumbnails: Record<string, string | null>;

    onSelect?: (id: string) => void;
    onLoadMore?: () => void;
    hasMore?: boolean;
}

export const GalleryView: React.FC<GalleryViewProps> = ({ resources, thumbnails, onSelect, onLoadMore, hasMore }) => {
    const observerTarget = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore) {
                    onLoadMore?.();
                }
            },
            { threshold: 0.1, rootMargin: '100px' }
        );

        const currentTarget = observerTarget.current;
        if (currentTarget) {
            observer.observe(currentTarget);
        }

        return () => {
            if (currentTarget) {
                observer.unobserve(currentTarget);
            }
        };
    }, [hasMore, onLoadMore]);

    if (resources.length === 0) {
        return (
            <div className="flex h-64 items-center justify-center text-slate-500">
                No results found.
            </div>
        );
    }

    return (
        <div className="flex flex-col">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4">
                {resources.map(r => (
                    <div
                        key={r.id}
                        className="group relative bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg overflow-hidden hover:shadow-md transition-shadow cursor-pointer flex flex-col"
                        onClick={() => onSelect?.(r.id)}
                    >
                        {/* Thumbnail Aspect Ratio 1:1 or 4:3? Aardvark usually squares. */}
                        <div className="aspect-square bg-gray-100 dark:bg-slate-950 flex items-center justify-center overflow-hidden relative">
                            {thumbnails[r.id] ? (
                                <img src={thumbnails[r.id]!} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-4xl opacity-10 select-none">
                                    {r.gbl_resourceClass_sm?.includes("Maps") ? "🗺️" : "📄"}
                                </span>
                            )}

                            {/* Overlay Gradient for Text Readability? No, text below. */}

                            {/* Hover Overlay Actions? */}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                        </div>

                        <div className="p-2 flex flex-col flex-1">
                            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 line-clamp-2 mb-1 leading-snug" title={r.dct_title_s}>
                                {r.dct_title_s}
                            </h3>
                            <div className="mt-auto flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                                <span>{r.gbl_indexYear_im || "-"}</span>
                                <span className="uppercase tracking-tighter opacity-70 border border-gray-200 dark:border-slate-700 px-1 rounded">
                                    {r.gbl_resourceClass_sm?.[0] || "Item"}
                                </span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            {/* Sentinel for infinite scroll */}
            {hasMore && <div ref={observerTarget} className="h-10 w-full" />}
        </div>
    );
};
