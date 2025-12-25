import React, { useState } from "react";
import { Resource, REPEATABLE_STRING_FIELDS, SCALAR_FIELDS, Distribution } from "../aardvark/model";
import { TagInput } from "./TagInput";

interface ResourceEditProps {
    initialResource: Resource;
    initialDistributions: Distribution[];
    onSave: (resource: Resource, distributions: Distribution[]) => Promise<void>;
    onCancel: () => void;
    isSaving: boolean;
    saveError: string | null;
}

export const ResourceEdit: React.FC<ResourceEditProps> = ({
    initialResource,
    initialDistributions,
    onSave,
    onCancel,
    isSaving,
    saveError,
}) => {
    const [resource, setResource] = useState<Resource>(initialResource);
    const [distributions, setDistributions] = useState<Distribution[]>(initialDistributions || []);
    const [activeTab, setActiveTab] = useState<"required" | "identification" | "provenance" | "object" | "administrative" | "related">("required");

    const handleChange = (field: keyof Resource, value: any) => {
        setResource((prev) => ({ ...prev, [field]: value }));
    };

    const handleArrayChange = (field: keyof Resource, values: string[]) => {
        setResource((prev) => ({ ...prev, [field]: values }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(resource, distributions);
    };

    // Distribution Handlers
    const addDistribution = () => {
        setDistributions([...distributions, { resource_id: resource.id, relation_key: "", url: "" }]);
    };

    const updateDistribution = (index: number, field: keyof Distribution, val: string) => {
        const newDists = [...distributions];
        newDists[index] = { ...newDists[index], [field]: val };
        setDistributions(newDists);
    };

    const removeDistribution = (index: number) => {
        const newDists = [...distributions];
        newDists.splice(index, 1);
        setDistributions(newDists);
    };

    const renderTextField = (label: string, field: keyof Resource, required = false) => (
        <div className="mb-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {label} {required && <span className="text-red-500 dark:text-red-400">*</span>}
            </label>
            <input
                type="text"
                className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                value={String(resource[field] || "")}
                onChange={(e) => handleChange(field, e.target.value)}
            />
        </div>
    );

    const renderTextArea = (label: string, field: keyof Resource) => (
        <div className="mb-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{label}</label>
            <textarea
                className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white focus:ring-1 focus:ring-indigo-500 focus:outline-none h-20"
                value={String(resource[field] || "")}
                onChange={(e) => handleChange(field, e.target.value)}
            />
        </div>
    );

    const renderTagInput = (label: string, field: string) => (
        <div className="mb-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{label}</label>
            <TagInput
                value={(resource as any)[field] || []}
                onChange={(vals) => handleArrayChange(field as keyof Resource, vals)}
                fieldName={field}
            />
        </div>
    );

    const renderBoolSelect = (label: string, field: keyof Resource) => (
        <div className="mb-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{label}</label>
            <select
                className="w-full rounded bg-white dark:bg-slate-950 border border-gray-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                value={resource[field] === true ? "true" : resource[field] === false ? "false" : ""}
                onChange={(e) => {
                    const val = e.target.value;
                    handleChange(field, val === "true" ? true : val === "false" ? false : null);
                }}
            >
                <option value="">Unknown / Null</option>
                <option value="true">True</option>
                <option value="false">False</option>
            </select>
        </div>
    );

    const RenderSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
        <div className="mb-6 p-4 border border-gray-200 dark:border-slate-800 rounded bg-gray-50/50 dark:bg-slate-900/20">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-4 uppercase tracking-wider border-b border-gray-200 dark:border-slate-800 pb-1">
                {title}
            </h3>
            <div className="grid grid-cols-1 gap-4">
                {children}
            </div>
        </div>
    );

    return (
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
            <div className="flex items-center gap-4 border-b border-gray-200 dark:border-slate-800 pb-4 mb-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Edit Resource</h2>
                <div className="flex gap-2 ml-auto">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white border border-gray-300 dark:border-slate-700 rounded hover:bg-gray-100 dark:hover:bg-slate-800"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isSaving}
                        className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>

            {saveError && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-200 text-xs">
                    Error saving: {saveError}
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 border-b border-gray-200 dark:border-slate-800 mb-4 overflow-x-auto">
                {(["required", "identification", "provenance", "object", "administrative", "related"] as const).map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === tab
                            ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                            : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                            }`}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </div>

            <div className="flex-1 overflow-y-auto pr-2">

                {activeTab === "required" && (
                    <div className="space-y-4 p-1">
                        {renderTextField("ID", "id", true)}
                        {renderTextField("Title", "dct_title_s", true)}
                        {renderTextField("Access Rights", "dct_accessRights_s", true)}
                        {renderTagInput("Resource Class", "gbl_resourceClass_sm")}
                        {renderTextField("Metadata Version", "gbl_mdVersion_s")}
                    </div>
                )}

                {activeTab === "identification" && (
                    <div className="space-y-1">
                        <RenderSection title="Descriptive">
                            {renderTagInput("Alternative Title", "dct_alternative_sm")}
                            {renderTagInput("Description", "dct_description_sm")}
                            {renderTagInput("Language", "dct_language_sm")}
                        </RenderSection>

                        <RenderSection title="Credits">
                            {renderTagInput("Creator", "dct_creator_sm")}
                            {renderTagInput("Publisher", "dct_publisher_sm")}
                        </RenderSection>

                        <RenderSection title="Categories">
                            {renderTagInput("Resource Type", "gbl_resourceType_sm")}
                            {renderTagInput("Subject", "dct_subject_sm")}
                            {renderTagInput("Theme", "dcat_theme_sm")}
                            {renderTagInput("Keyword", "dcat_keyword_sm")}
                            {renderTextField("Format", "dct_format_s")}
                        </RenderSection>

                        <RenderSection title="Temporal">
                            {renderTextField("Date Issued", "dct_issued_s")}
                            {renderTextField("Index Year", "gbl_indexYear_im")}
                            {renderTagInput("Date Range", "gbl_dateRange_drsim")}
                            {renderTagInput("Temporal Coverage", "dct_temporal_sm")}
                        </RenderSection>

                        <RenderSection title="Spatial">
                            {renderTagInput("Spatial Coverage", "dct_spatial_sm")}
                            {renderBoolSelect("Georeferenced", "gbl_georeferenced_b")}
                            {renderTextField("Centroid", "dcat_centroid")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "provenance" && (
                    <div className="space-y-1">
                        <RenderSection title="Provenance Entity">
                            {renderTextField("Provider", "schema_provider_s")}
                        </RenderSection>
                        <RenderSection title="Provenance Activity">
                            <p className="text-xs text-slate-500 italic">No specific Aardvark fields mapped yet.</p>
                        </RenderSection>
                    </div>
                )}

                {activeTab === "object" && (
                    <div className="space-y-1">
                        <RenderSection title="Geometry">
                            {renderTextArea("Geometry (WKT/Envelope)", "locn_geometry")}
                            {renderTextArea("Bounding Box", "dcat_bbox")}
                        </RenderSection>
                        <RenderSection title="Technical">
                            {renderTextField("File Size", "gbl_fileSize_s")}
                            {renderTextField("WxS Identifier", "gbl_wxsIdentifier_s")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "administrative" && (
                    <div className="space-y-1">
                        <RenderSection title="Codes">
                            {renderTagInput("Identifier", "dct_identifier_sm")}
                        </RenderSection>

                        <RenderSection title="Rights">
                            {renderTagInput("Rights", "dct_rights_sm")}
                            {renderTagInput("Rights Holder", "dct_rightsHolder_sm")}
                        </RenderSection>

                        <RenderSection title="Permissions">
                            {renderTagInput("License", "dct_license_sm")}
                            {renderBoolSelect("Suppressed", "gbl_suppressed_b")}
                        </RenderSection>

                        <RenderSection title="Relationships">
                            {renderTagInput("Member Of", "pcdm_memberOf_sm")}
                            {renderTagInput("Is Part Of", "dct_isPartOf_sm")}
                            {renderTagInput("Is Version Of", "dct_isVersionOf_sm")}
                            {renderTagInput("Replaces", "dct_replaces_sm")}
                            {renderTagInput("Is Replaced By", "dct_isReplacedBy_sm")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "related" && (
                    <div className="space-y-1">
                        <RenderSection title="Related Items">
                            {renderTagInput("Source", "dct_source_sm")}
                            {renderTagInput("Relation", "dct_relation_sm")}
                        </RenderSection>

                        <RenderSection title="Distributions & Assets">
                            <div className="space-y-4">
                                <div className="flex justify-between items-center mb-2">
                                    <p className="text-xs text-slate-500 dark:text-slate-400">Manage download links, WMS services, etc.</p>
                                    <button type="button" onClick={addDistribution} className="text-xs bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-slate-700 dark:text-slate-200">
                                        + Add Item
                                    </button>
                                </div>

                                {distributions.length === 0 ? (
                                    <div className="p-4 bg-white dark:bg-slate-950 rounded border border-gray-200 dark:border-slate-800 text-center text-xs text-slate-500">
                                        No distributions defined.
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {distributions.map((dist, idx) => (
                                            <div key={idx} className="flex gap-2 items-start bg-white dark:bg-slate-950 p-2 rounded border border-gray-200 dark:border-slate-800">
                                                <div className="flex-1">
                                                    <label className="block text-[10px] text-slate-600 dark:text-slate-500 mb-0.5">Type (Relation)</label>
                                                    <input
                                                        className="w-full bg-gray-50 dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                                        placeholder="e.g. download, wms"
                                                        value={dist.relation_key}
                                                        onChange={(e) => updateDistribution(idx, "relation_key", e.target.value)}
                                                    />
                                                </div>
                                                <div className="flex-1">
                                                    <label className="block text-[10px] text-slate-600 dark:text-slate-500 mb-0.5">Label (Optional)</label>
                                                    <input
                                                        className="w-full bg-gray-50 dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                                        placeholder="e.g. Shapefile, TIFF"
                                                        value={dist.label || ""}
                                                        onChange={(e) => updateDistribution(idx, "label", e.target.value)}
                                                    />
                                                </div>
                                                <div className="flex-[2]">
                                                    <label className="block text-[10px] text-slate-600 dark:text-slate-500 mb-0.5">URL</label>
                                                    <input
                                                        className="w-full bg-gray-50 dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white"
                                                        placeholder="https://..."
                                                        value={dist.url}
                                                        onChange={(e) => updateDistribution(idx, "url", e.target.value)}
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => removeDistribution(idx)}
                                                    className="mt-4 text-slate-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </RenderSection>

                        <RenderSection title="Extra (Read Only)">
                            {renderTagInput("Display Note", "gbl_displayNote_sm")}
                            <div className="p-4 bg-white dark:bg-slate-950 rounded border border-gray-200 dark:border-slate-800 text-xs font-mono text-slate-600 dark:text-slate-400 max-h-40 overflow-auto">
                                {JSON.stringify(resource.extra || {}, null, 2)}
                            </div>
                        </RenderSection>
                    </div>
                )}
            </div>
        </form>
    );
};
