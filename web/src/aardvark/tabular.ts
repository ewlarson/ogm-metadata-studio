import { Resource } from "./model";
import { flattenResource, extractDistributionsFromJson } from "./mapping";
import { resourceToJson } from "./model";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildResourcesCsv(resources: Resource[]): string {
  const rows = resources.map(flattenResource);
  if (rows.length === 0) return "";

  const fieldnames = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r)))
  ).sort();

  const lines: string[] = [];
  lines.push(fieldnames.join(","));

  for (const row of rows) {
    const line = fieldnames
      .map((name) => csvEscape(String(row[name] ?? "")))
      .join(",");
    lines.push(line);
  }

  return lines.join("\n");
}

export function buildDistributionsCsv(resources: Resource[]): string {
  const distRows: { resource_id: string; relation_key: string; url: string }[] =
    [];

  for (const res of resources) {
    const json = resourceToJson(res);
    const dists = extractDistributionsFromJson(json);
    for (const d of dists) {
      distRows.push({
        resource_id: d.resource_id,
        relation_key: d.relation_key,
        url: d.url,
      });
    }
  }

  if (distRows.length === 0) return "";

  const fieldnames = ["resource_id", "relation_key", "url"];
  const lines: string[] = [];
  lines.push(fieldnames.join(","));

  for (const row of distRows) {
    const line = fieldnames
      .map((name) => csvEscape(String(row[name as keyof typeof row] ?? "")))
      .join(",");
    lines.push(line);
  }

  return lines.join("\n");
}


