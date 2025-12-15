// Core TypeScript models for Aardvark resources and distributions.
// Mirrors the Python dataclasses in aardvark_toolkit/models.py.

export type AardvarkJson = Record<string, unknown>;

export interface Resource {
  id: string;
  dct_title_s: string;
  gbl_resourceClass_sm: string[];
  dct_accessRights_s: string;
  gbl_mdVersion_s: string; // should always be "Aardvark"

  schema_provider_s?: string | null;
  dct_issued_s?: string | null;

  dct_description_sm: string[];
  dct_creator_sm: string[];
  dct_publisher_sm: string[];
  dct_subject_sm: string[];
  dcat_keyword_sm: string[];

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
  "gbl_indexYear_im",
  "gbl_dateRange_drsim",
  "dct_spatial_sm",
  "dct_relation_sm",
  "pcdm_memberOf_sm",
  "dct_isPartOf_sm",
  "dct_source_sm",
  "dct_isVersionOf_sm",
  "dct_replaces_sm",
  "dct_isReplacedBy_sm",
  "dct_rights_sm",
  "dct_rightsHolder_sm",
  "dct_license_sm",
  "dct_identifier_sm",
];

export const SCALAR_FIELDS: string[] = [
  "id",
  "dct_title_s",
  "schema_provider_s",
  "dct_issued_s",
  "locn_geometry",
  "dcat_bbox",
  "dcat_centroid",
  "dct_accessRights_s",
  "dct_format_s",
  "gbl_fileSize_s",
  "gbl_wxsIdentifier_s",
  "dct_references_s", // kept only in JSON, not in resources table
  "gbl_mdModified_dt",
  "gbl_mdVersion_s",
  "gbl_suppressed_b",
  "gbl_georeferenced_b",
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
    schema_provider_s: (raw["schema_provider_s"] as string | undefined) ?? null,
    dct_issued_s: (raw["dct_issued_s"] as string | undefined) ?? null,
    dct_description_sm: (raw["dct_description_sm"] as string[] | undefined) ?? [],
    dct_creator_sm: (raw["dct_creator_sm"] as string[] | undefined) ?? [],
    dct_publisher_sm: (raw["dct_publisher_sm"] as string[] | undefined) ?? [],
    dct_subject_sm: (raw["dct_subject_sm"] as string[] | undefined) ?? [],
    dcat_keyword_sm: (raw["dcat_keyword_sm"] as string[] | undefined) ?? [],
    extra: {},
  };

  const modeledKeys = new Set([
    "id",
    "dct_title_s",
    "dct_accessRights_s",
    "gbl_resourceClass_sm",
    "gbl_mdVersion_s",
    "schema_provider_s",
    "dct_issued_s",
    "dct_description_sm",
    "dct_creator_sm",
    "dct_publisher_sm",
    "dct_subject_sm",
    "dcat_keyword_sm",
  ]);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!modeledKeys.has(k)) {
      extra[k] = v;
    }
  }
  res.extra = extra;
  return res;
}

export function resourceToJson(resource: Resource): AardvarkJson {
  const base: AardvarkJson = {
    id: resource.id,
    dct_title_s: resource.dct_title_s,
    dct_accessRights_s: resource.dct_accessRights_s,
    gbl_resourceClass_sm: resource.gbl_resourceClass_sm,
    gbl_mdVersion_s: resource.gbl_mdVersion_s ?? "Aardvark",
    dct_description_sm: resource.dct_description_sm,
    dct_creator_sm: resource.dct_creator_sm,
    dct_publisher_sm: resource.dct_publisher_sm,
    dct_subject_sm: resource.dct_subject_sm,
    dcat_keyword_sm: resource.dcat_keyword_sm,
  };

  if (resource.schema_provider_s) {
    base["schema_provider_s"] = resource.schema_provider_s;
  }
  if (resource.dct_issued_s) {
    base["dct_issued_s"] = resource.dct_issued_s;
  }

  for (const [k, v] of Object.entries(resource.extra)) {
    base[k] = v;
  }

  ensureMdVersion(base);
  return base;
}


