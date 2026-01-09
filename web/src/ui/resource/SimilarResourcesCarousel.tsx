import React, { useState } from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';

const ITEMS_PER_PAGE = 4;

export const SimilarResourcesCarousel: React.FC<{ items: Resource[] }> = ({ items }) => {
    const [currentPage, setCurrentPage] = useState(0);
    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

    const handlePrev = () => {
        setCurrentPage(p => Math.max(0, p - 1));
    };

    const handleNext = () => {
        setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    };

    const currentItems = items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);

    if (items.length === 0) return null;

    return (
        <div className="mt-12 mb-8 px-6 pb-6">
            <h2 className="text-2xl font-bold mb-6 text-slate-900 dark:text-gray-100">Similar Items</h2>
            <div className="relative group">
                {/* Grid for items */}
                <div className="grid grid-cols-4 gap-6 mb-6">
                    {currentItems.map((item) => (
                        <Link
                            key={item.id}
                            href={`/resources/${item.id}`}
                            className="group/card focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-lg"
                        >
                            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 border border-gray-200 dark:border-slate-700 h-full flex flex-col overflow-hidden">
                                {/* Thumbnail */}
                                <div className="h-40 bg-gray-100 dark:bg-slate-700 overflow-hidden relative">
                                    {item.thumbnail ? (
                                        <img
                                            src={item.thumbnail}
                                            alt=""
                                            className="w-full h-full object-cover transition-transform duration-500 group-hover/card:scale-105"
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-400">
                                            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                            </svg>
                                        </div>
                                    )}
                                </div>

                                {/* Content */}
                                <div className="p-4 flex-1 flex flex-col">
                                    <h3 className="text-sm font-semibold text-slate-900 dark:text-gray-100 line-clamp-2 mb-2 group-hover/card:text-indigo-600 dark:group-hover/card:text-indigo-400">
                                        {item.dct_title_s}
                                    </h3>
                                    <div className="mt-auto text-xs text-slate-500 dark:text-slate-400">
                                        {item.dct_publisher_sm?.[0] || 'Unknown Publisher'}
                                        <span className="mx-1">&middot;</span>
                                        {item.gbl_indexYear_im || 'n.d.'}
                                    </div>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>

                {/* Controls */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-4">
                        <button
                            onClick={handlePrev}
                            disabled={currentPage === 0}
                            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                            aria-label="Previous page"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-600 dark:text-slate-400">
                                <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
                            </svg>
                        </button>

                        <div className="flex gap-2">
                            {Array.from({ length: totalPages }).map((_, i) => (
                                <button
                                    key={i}
                                    onClick={() => setCurrentPage(i)}
                                    className={`w-2 h-2 rounded-full transition-colors ${i === currentPage
                                        ? 'bg-indigo-600 dark:bg-indigo-400'
                                        : 'bg-gray-300 dark:bg-slate-700 hover:bg-gray-400 dark:hover:bg-slate-600'
                                        }`}
                                    aria-label={`Go to page ${i + 1}`}
                                    aria-current={i === currentPage ? 'page' : undefined}
                                />
                            ))}
                        </div>

                        <button
                            onClick={handleNext}
                            disabled={currentPage === totalPages - 1}
                            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                            aria-label="Next page"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-slate-600 dark:text-slate-400">
                                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
