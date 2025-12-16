import {
  AardvarkJson,
  Distribution,
  REPEATABLE_STRING_FIELDS,
  Resource,
  SCALAR_FIELDS,
  resourceFromJson,
  resourceToJson,
} from "./model";

function pipeJoin(values: string[]): string {
  const cleaned = Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))
  );
  cleaned.sort();
  return cleaned.join("|");
}

function pipeSplit(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split("|")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// JSON → tabular row for the resources table (no dct_references_s)
export function flattenResource(resource: Resource): Record<string, string> {
  const json = resourceToJson(resource);
  const row: Record<string, string> = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = json[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      row[field] = value ? "true" : "false";
    } else {
      row[field] = String(value);
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    const value = json[field];
    if (Array.isArray(value)) {
      row[field] = pipeJoin(value.map(String));
    }
  }

  if (!row["id"]) row["id"] = String(json["id"] ?? "");
  if (!row["dct_title_s"]) row["dct_title_s"] = String(json["dct_title_s"] ?? "");
  if (!row["dct_accessRights_s"]) {
    row["dct_accessRights_s"] = String(json["dct_accessRights_s"] ?? "");
  }

  return row;
}

// JSON -> DuckDB row (preserves arrays for repeatable fields)
export function flattenResourceForDuckDb(resource: Resource): Record<string, any> {
  const json = resourceToJson(resource);
  const row: Record<string, any> = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = json[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      row[field] = value ? "true" : "false";
    } else {
      row[field] = String(value);
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    const value = json[field];
    // Keep as array for DuckDB
    if (Array.isArray(value)) {
      row[field] = value.map(String);
    } else {
      row[field] = [];
    }
  }

  if (!row["id"]) row["id"] = String(json["id"] ?? "");
  if (!row["dct_title_s"]) row["dct_title_s"] = String(json["dct_title_s"] ?? "");
  if (!row["dct_accessRights_s"]) {
    row["dct_accessRights_s"] = String(json["dct_accessRights_s"] ?? "");
  }

  return row;
}

// resources.csv row (+ distributions) → Resource object with dct_references_s baked in.
export function resourceFromRow(
  row: Record<string, string>,
  distributionsForResource: Distribution[]
): Resource {
  const data: AardvarkJson = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = row[field];
    if (value === undefined || value === "") continue;
    if (field === "gbl_suppressed_b" || field === "gbl_georeferenced_b") {
      const v = value.toLowerCase();
      data[field] = v === "1" || v === "true" || v === "yes" || v === "y";
    } else {
      data[field] = value;
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    data[field] = pipeSplit(row[field]);
  }

  if (distributionsForResource.length > 0) {
    const refs: Record<string, string> = {};
    for (const d of distributionsForResource) {
      if (!d.relation_key || !d.url) continue;
      refs[d.relation_key] = d.url;
    }
    data["dct_references_s"] = JSON.stringify(refs);
  }

  if (!data["id"]) {
    throw new Error("resources.csv row is missing required 'id' column");
  }

  if (!data["gbl_resourceClass_sm"]) {
    data["gbl_resourceClass_sm"] = [];
  }

  return resourceFromJson(data);
}

// Parse dct_references_s JSON string → Distribution[]
export function extractDistributionsFromJson(
  json: AardvarkJson
): Distribution[] {
  const dctRefs = json["dct_references_s"];
  if (typeof dctRefs !== "string" || !dctRefs.trim()) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(dctRefs);
  } catch {
    return [];
  }
  if (typeof obj !== "object" || obj === null) return [];

  const resourceId = String(json["id"] ?? "");
  const distributions: Distribution[] = [];
  for (const [key, url] of Object.entries(obj as Record<string, unknown>)) {
    if (!url) continue;
    distributions.push({
      resource_id: resourceId,
      relation_key: String(key),
      url: String(url),
    });
  }
  return distributions;
}

// distributions for one resource → stringified dct_references_s JSON or undefined
export function buildDctReferencesS(
  distributions: Distribution[]
): string | undefined {
  const refs: Record<string, string> = {};
  for (const d of distributions) {
    if (!d.relation_key || !d.url) continue;
    refs[d.relation_key] = d.url;
  }
  if (Object.keys(refs).length === 0) return undefined;
  return JSON.stringify(refs, Object.keys(refs).sort(), 2);
}


