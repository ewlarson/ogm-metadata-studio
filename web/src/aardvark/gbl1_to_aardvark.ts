import { Resource } from "./model";

// Helper to ensure array
function ensureArray(val: any): string[] {
    if (Array.isArray(val)) return val.map(String);
    if (val) return [String(val)];
    return [];
}

// Helper to ensure string
function ensureString(val: any): string {
    if (Array.isArray(val)) return String(val[0] || "");
    return String(val || "");
}

export function gbl1ToAardvark(r1: any): Resource {
    const r2: any = {};

    // Mappings based on kgjenkins/gbl2aardvark

    // 1. ID
    // layer_slug_s -> id
    if (r1.layer_slug_s) r2.id = r1.layer_slug_s;
    else if (r1.dc_identifier_s) r2.id = r1.dc_identifier_s; // Fallback
    else r2.id = "unknown_id_" + Math.random().toString(36).substr(2, 9);

    // layer_id_s -> gbl_wxsIdentifier_s (Needed for WMS)
    if (r1.layer_id_s) r2.gbl_wxsIdentifier_s = ensureString(r1.layer_id_s);

    // 2. Identification
    // dc_title_s -> dct_title_s
    r2.dct_title_s = ensureString(r1.dc_title_s);

    // dc_description_s -> dct_description_sm (array)
    r2.dct_description_sm = ensureArray(r1.dc_description_s);

    // dc_language_s / dc_language_sm -> dct_language_sm
    const langs = [...ensureArray(r1.dc_language_s), ...ensureArray(r1.dc_language_sm)];
    if (langs.length) r2.dct_language_sm = [...new Set(langs)];

    // dc_creator_sm -> dct_creator_sm
    r2.dct_creator_sm = ensureArray(r1.dc_creator_sm);

    // dc_publisher_s / dc_publisher_sm -> dct_publisher_sm
    const pubs = [...ensureArray(r1.dc_publisher_s), ...ensureArray(r1.dc_publisher_sm)];
    if (pubs.length) r2.dct_publisher_sm = [...new Set(pubs)];

    // dc_subject_sm -> dct_subject_sm
    r2.dct_subject_sm = ensureArray(r1.dc_subject_sm);

    // dcat_keyword_sm -> dcat_keyword_sm (copy)
    if (r1.dcat_keyword_sm) r2.dcat_keyword_sm = ensureArray(r1.dcat_keyword_sm);

    // dct_temporal_sm -> dct_temporal_sm (copy)
    if (r1.dct_temporal_sm) r2.dct_temporal_sm = ensureArray(r1.dct_temporal_sm);

    // dct_issued_s -> dct_issued_s (copy)
    if (r1.dct_issued_s) r2.dct_issued_s = ensureString(r1.dct_issued_s);

    // solr_year_i -> gbl_indexYear_im (array)
    if (r1.solr_year_i) r2.gbl_indexYear_im = [Number(r1.solr_year_i)];

    // dct_spatial_sm -> dct_spatial_sm (copy)
    if (r1.dct_spatial_sm) r2.dct_spatial_sm = ensureArray(r1.dct_spatial_sm);

    // solr_geom -> locn_geometry AND dcat_bbox
    if (r1.solr_geom) {
        r2.locn_geometry = r1.solr_geom;
        r2.dcat_bbox = r1.solr_geom; // Often same ENVELOPE syntax
    }

    // dcat_centroid -> dcat_centroid (copy)
    if (r1.dcat_centroid) r2.dcat_centroid = ensureString(r1.dcat_centroid);

    // dc_source_sm -> dct_source_sm
    if (r1.dc_source_sm) r2.dct_source_sm = ensureArray(r1.dc_source_sm);

    // Rights
    // dc_rights_s -> dct_accessRights_s
    if (r1.dc_rights_s) r2.dct_accessRights_s = ensureString(r1.dc_rights_s);
    else r2.dct_accessRights_s = "Public";

    // Others
    if (r1.dct_provenance_s) r2.schema_provider_s = ensureString(r1.dct_provenance_s);

    // References
    // dct_references_s (stringified JSON) -> dct_references_s (keep as stringified JSON)
    if (r1.dct_references_s) r2.dct_references_s = r1.dct_references_s;

    // Resource Class (Inference)
    // layer_geom_type_s -> gbl_resourceClass_sm
    if (r1.layer_geom_type_s) {
        const type = r1.layer_geom_type_s;
        if (type === "Raster") r2.gbl_resourceClass_sm = ["Datasets"];
        else if (type === "Polygon" || type === "Line" || type === "Point" || type === "Mixed") r2.gbl_resourceClass_sm = ["Datasets"];
        else if (type === "Image") r2.gbl_resourceClass_sm = ["Imagery"];
        else if (type === "Paper Map" || type === "Scanned Map") r2.gbl_resourceClass_sm = ["Maps"];
        else r2.gbl_resourceClass_sm = ["Other"];
    }

    // Fallback: dc_type_s
    if (!r2.gbl_resourceClass_sm && r1.dc_type_s) {
        if (r1.dc_type_s === "Dataset") r2.gbl_resourceClass_sm = ["Datasets"];
        else if (r1.dc_type_s === "Image") r2.gbl_resourceClass_sm = ["Imagery"];
        else if (r1.dc_type_s === "PhysicalObject") r2.gbl_resourceClass_sm = ["Maps"];
        else r2.gbl_resourceClass_sm = ["Other"];
    }

    if (!r2.gbl_resourceClass_sm) r2.gbl_resourceClass_sm = ["Other"];


    // Resource Type
    if (r1.layer_geom_type_s) {
        const t = r1.layer_geom_type_s;
        if (t === "Polygon" || t === "Line" || t === "Point") r2.gbl_resourceType_sm = [t + " data"];
        else if (t === "Raster") r2.gbl_resourceType_sm = ["Raster data"];
    }

    // Modified
    if (r1.layer_modified_dt) r2.gbl_mdModified_dt = r1.layer_modified_dt;

    // Identifiers
    if (r1.dc_identifier_s) r2.dct_identifier_sm = [r1.dc_identifier_s];

    // Final check for required fields or defaults
    r2.gbl_mdVersion_s = "Aardvark";

    return r2 as Resource;
}
