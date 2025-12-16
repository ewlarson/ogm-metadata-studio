// Core TypeScript models for Aardvark resources and distributions.
// Mirrors the Python dataclasses in aardvark_toolkit/models.py.

export type AardvarkJson = Record<string, unknown>;

export interface Resource {
  // Required
  id: string;
  dct_title_s: string;
  gbl_resourceClass_sm: string[];
  dct_accessRights_s: string;
  dct_format_s?: string | null;
  gbl_mdVersion_s: string; // should always be "Aardvark"

  // Identification
  dct_alternative_sm: string[];
  dct_description_sm: string[];
  dct_language_sm: string[];
  gbl_displayNote_sm: string[];

  // Credits
  dct_creator_sm: string[];
  dct_publisher_sm: string[];
  schema_provider_s?: string | null;

  // Categories
  gbl_resourceType_sm: string[];
  dct_subject_sm: string[];
  dcat_theme_sm: string[];
  dcat_keyword_sm: string[];

  // Temporal
  dct_temporal_sm: string[];
  dct_issued_s?: string | null;
  gbl_dateRange_drsim: string[];

  // Spatial
  dct_spatial_sm: string[];
  dcat_bbox?: string | null;
  locn_geometry?: string | null;
  gbl_georeferenced_b?: boolean | null;

  // Administrative
  dct_identifier_sm: string[];
  gbl_wxsIdentifier_s?: string | null;
  dct_rights_sm: string[];
  dct_rightsHolder_sm: string[];
  dct_license_sm: string[];
  gbl_suppressed_b?: boolean | null;

  // Object
  gbl_fileSize_s?: string | null;

  // Relations
  pcdm_memberOf_sm: string[];
  dct_isPartOf_sm: string[];
  dct_source_sm: string[];
  dct_isVersionOf_sm: string[];
  dct_replaces_sm: string[];
  dct_relation_sm: string[];

  // Bag for any unmodeled fields so we don't lose information.
  extra: Record<string, unknown>;
}

export interface Distribution {
  resource_id: string;
  relation_key: string;
  url: string;
}

export const REPEATABLE_STRING_FIELDS: string[] = [
  "dct_alternative_sm",
  "dct_description_sm",
  "dct_language_sm",
  "gbl_displayNote_sm",
  "dct_creator_sm",
  "dct_publisher_sm",
  "gbl_resourceClass_sm",
  "gbl_resourceType_sm",
  "dct_subject_sm",
  "dcat_theme_sm",
  "dcat_keyword_sm",
  "dct_temporal_sm",
  "gbl_dateRange_drsim",
  "dct_spatial_sm",
  "dct_identifier_sm",
  "dct_rights_sm",
  "dct_rightsHolder_sm",
  "dct_license_sm",
  "pcdm_memberOf_sm",
  "dct_isPartOf_sm",
  "dct_source_sm",
  "dct_isVersionOf_sm",
  "dct_replaces_sm",
  "dct_relation_sm",
];

export const SCALAR_FIELDS: string[] = [
  "id",
  "dct_title_s",
  "dct_accessRights_s",
  "dct_format_s",
  "gbl_mdVersion_s",
  "schema_provider_s",
  "dct_issued_s",
  "dcat_bbox",
  "locn_geometry",
  "gbl_georeferenced_b",
  "gbl_wxsIdentifier_s",
  "gbl_suppressed_b",
  "gbl_fileSize_s",
  "dct_references_s", // kept only in JSON, not in resources table
  "gbl_mdModified_dt",
];

const REQUIRED_FIELDS = [
  "id",
  "dct_title_s",
  "gbl_resourceClass_sm",
  "dct_accessRights_s",
  "gbl_mdVersion_s",
];

function ensureMdVersion(data: AardvarkJson): void {
  if (data["gbl_mdVersion_s"] !== "Aardvark") {
    data["gbl_mdVersion_s"] = "Aardvark";
  }
}

export function resourceFromJson(raw: AardvarkJson): Resource {
  ensureMdVersion(raw);
  const missing = REQUIRED_FIELDS.filter(
    (f) => raw[f] === undefined || raw[f] === null || raw[f] === ""
  );
  if (missing.length) {
    throw new Error(`Missing required Aardvark fields: ${missing.join(", ")}`);
  }

  const id = String(raw["id"]);
  const title = String(raw["dct_title_s"]);
  const access = String(raw["dct_accessRights_s"]);
  const classes = (raw["gbl_resourceClass_sm"] as unknown[]) ?? [];

  const res: Resource = {
    id,
    dct_title_s: title,
    dct_accessRights_s: access,
    gbl_resourceClass_sm: classes.map(String),
    gbl_mdVersion_s: String(raw["gbl_mdVersion_s"] ?? "Aardvark"),
    dct_format_s: (raw["dct_format_s"] as string | undefined) ?? null,

    dct_alternative_sm: (raw["dct_alternative_sm"] as string[] | undefined) ?? [],
    dct_description_sm: (raw["dct_description_sm"] as string[] | undefined) ?? [],
    dct_language_sm: (raw["dct_language_sm"] as string[] | undefined) ?? [],
    gbl_displayNote_sm: (raw["gbl_displayNote_sm"] as string[] | undefined) ?? [],

    dct_creator_sm: (raw["dct_creator_sm"] as string[] | undefined) ?? [],
    dct_publisher_sm: (raw["dct_publisher_sm"] as string[] | undefined) ?? [],
    schema_provider_s: (raw["schema_provider_s"] as string | undefined) ?? null,

    gbl_resourceType_sm: (raw["gbl_resourceType_sm"] as string[] | undefined) ?? [],
    dct_subject_sm: (raw["dct_subject_sm"] as string[] | undefined) ?? [],
    dcat_theme_sm: (raw["dcat_theme_sm"] as string[] | undefined) ?? [],
    dcat_keyword_sm: (raw["dcat_keyword_sm"] as string[] | undefined) ?? [],

    dct_temporal_sm: (raw["dct_temporal_sm"] as string[] | undefined) ?? [],
    dct_issued_s: (raw["dct_issued_s"] as string | undefined) ?? null,
    gbl_dateRange_drsim: (raw["gbl_dateRange_drsim"] as string[] | undefined) ?? [],

    dct_spatial_sm: (raw["dct_spatial_sm"] as string[] | undefined) ?? [],
    dcat_bbox: (raw["dcat_bbox"] as string | undefined) ?? null,
    locn_geometry: (raw["locn_geometry"] as string | undefined) ?? null,
    gbl_georeferenced_b: (raw["gbl_georeferenced_b"] as boolean | undefined) ?? null,

    dct_identifier_sm: (raw["dct_identifier_sm"] as string[] | undefined) ?? [],
    gbl_wxsIdentifier_s: (raw["gbl_wxsIdentifier_s"] as string | undefined) ?? null,
    dct_rights_sm: (raw["dct_rights_sm"] as string[] | undefined) ?? [],
    dct_rightsHolder_sm: (raw["dct_rightsHolder_sm"] as string[] | undefined) ?? [],
    dct_license_sm: (raw["dct_license_sm"] as string[] | undefined) ?? [],
    gbl_suppressed_b: (raw["gbl_suppressed_b"] as boolean | undefined) ?? null,

    gbl_fileSize_s: (raw["gbl_fileSize_s"] as string | undefined) ?? null,

    pcdm_memberOf_sm: (raw["pcdm_memberOf_sm"] as string[] | undefined) ?? [],
    dct_isPartOf_sm: (raw["dct_isPartOf_sm"] as string[] | undefined) ?? [],
    dct_source_sm: (raw["dct_source_sm"] as string[] | undefined) ?? [],
    dct_isVersionOf_sm: (raw["dct_isVersionOf_sm"] as string[] | undefined) ?? [],
    dct_replaces_sm: (raw["dct_replaces_sm"] as string[] | undefined) ?? [],
    dct_relation_sm: (raw["dct_relation_sm"] as string[] | undefined) ?? [],

    extra: {},
  };

  const modeledKeys = new Set([
    ...SCALAR_FIELDS,
    ...REPEATABLE_STRING_FIELDS,
  ]);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!modeledKeys.has(k) && k !== "dct_references_s") {
      extra[k] = v;
    }
  }
  res.extra = extra;
  return res;
}

export function resourceToJson(resource: Resource): AardvarkJson {
  const base: AardvarkJson = {
    // Required
    id: resource.id,
    dct_title_s: resource.dct_title_s,
    dct_accessRights_s: resource.dct_accessRights_s,
    gbl_resourceClass_sm: resource.gbl_resourceClass_sm,
    gbl_mdVersion_s: resource.gbl_mdVersion_s ?? "Aardvark",

    // Identification
    dct_alternative_sm: resource.dct_alternative_sm,
    dct_description_sm: resource.dct_description_sm,
    dct_language_sm: resource.dct_language_sm,
    gbl_displayNote_sm: resource.gbl_displayNote_sm,

    // Credits
    dct_creator_sm: resource.dct_creator_sm,
    dct_publisher_sm: resource.dct_publisher_sm,

    // Categories
    gbl_resourceType_sm: resource.gbl_resourceType_sm,
    dct_subject_sm: resource.dct_subject_sm,
    dcat_theme_sm: resource.dcat_theme_sm,
    dcat_keyword_sm: resource.dcat_keyword_sm,

    // Temporal
    dct_temporal_sm: resource.dct_temporal_sm,
    gbl_dateRange_drsim: resource.gbl_dateRange_drsim,

    // Spatial
    dct_spatial_sm: resource.dct_spatial_sm,

    // Administrative
    dct_identifier_sm: resource.dct_identifier_sm,
    dct_rights_sm: resource.dct_rights_sm,
    dct_rightsHolder_sm: resource.dct_rightsHolder_sm,
    dct_license_sm: resource.dct_license_sm,

    // Relations
    pcdm_memberOf_sm: resource.pcdm_memberOf_sm,
    dct_isPartOf_sm: resource.dct_isPartOf_sm,
    dct_source_sm: resource.dct_source_sm,
    dct_isVersionOf_sm: resource.dct_isVersionOf_sm,
    dct_replaces_sm: resource.dct_replaces_sm,
    dct_relation_sm: resource.dct_relation_sm,
  };

  // Optional Scalars
  if (resource.dct_format_s) base["dct_format_s"] = resource.dct_format_s;
  if (resource.schema_provider_s) base["schema_provider_s"] = resource.schema_provider_s;
  if (resource.dct_issued_s) base["dct_issued_s"] = resource.dct_issued_s;
  if (resource.dcat_bbox) base["dcat_bbox"] = resource.dcat_bbox;
  if (resource.locn_geometry) base["locn_geometry"] = resource.locn_geometry;
  if (resource.gbl_georeferenced_b !== null && resource.gbl_georeferenced_b !== undefined) base["gbl_georeferenced_b"] = resource.gbl_georeferenced_b;
  if (resource.gbl_wxsIdentifier_s) base["gbl_wxsIdentifier_s"] = resource.gbl_wxsIdentifier_s;
  if (resource.gbl_suppressed_b !== null && resource.gbl_suppressed_b !== undefined) base["gbl_suppressed_b"] = resource.gbl_suppressed_b;
  if (resource.gbl_fileSize_s) base["gbl_fileSize_s"] = resource.gbl_fileSize_s;


  for (const [k, v] of Object.entries(resource.extra)) {
    base[k] = v;
  }

  ensureMdVersion(base);
  return base;
}


