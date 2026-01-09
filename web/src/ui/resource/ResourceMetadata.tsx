import React from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';

const FACETABLE_FIELDS = [
    'dct_subject_sm',
    'dct_creator_sm',
    'dcat_theme_sm',
    'dct_spatial_sm',
    'gbl_resourceClass_sm',
    'gbl_resourceType_sm',
    'dct_publisher_sm',
    'dct_language_sm',
    'dct_format_s'
];

interface ResourceMetadataProps {
    resource: Resource;
}

export const ResourceMetadata: React.FC<ResourceMetadataProps> = ({ resource }) => {
    return (
        <div className="flex-1 min-w-0 p-6 border-r border-gray-200 dark:border-slate-800">
            <h2 className="text-lg font-semibold mb-4 text-slate-900 dark:text-white">Full Details</h2>

            <dl className="grid grid-cols-[160px_1fr] gap-y-4 text-sm">
                {Object.entries(resource).map(([key, value]) => {
                    if (!value || (Array.isArray(value) && value.length === 0) || key === 'id' || key === 'dct_references_s' || key.startsWith('_')) return null;
                    // Basic label formatting
                    const label = key.replace(/^[a-z]+_/, '').replace(/_[a-z]+$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());

                    return (
                        <React.Fragment key={key}>
                            <dt className="font-medium text-slate-500 dark:text-slate-400">{label}</dt>
                            <dd className="text-slate-900 dark:text-slate-200 break-all">
                                {(() => {
                                    const isFacetable = FACETABLE_FIELDS.includes(key);
                                    const values = Array.isArray(value) ? value : [String(value)];

                                    return values.map((val, idx) => (
                                        <React.Fragment key={idx}>
                                            {idx > 0 && ", "}
                                            {isFacetable ? (
                                                <Link
                                                    href={`/?include_filters[${key}][]=${encodeURIComponent(val)}`}
                                                    className="text-indigo-600 dark:text-indigo-400 hover:underline"
                                                >
                                                    {val}
                                                </Link>
                                            ) : (
                                                val
                                            )}
                                        </React.Fragment>
                                    ));
                                })()}
                            </dd>
                        </React.Fragment>
                    );
                })}
            </dl>
        </div>
    );
};
