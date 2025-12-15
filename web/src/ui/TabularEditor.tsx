import React, { useEffect, useState } from "react";
import { executeQuery, queryResources } from "../duckdb/duckdbClient";
import { Resource } from "../aardvark/model";
import { resourceFromRow } from "../aardvark/mapping";

interface TabularEditorProps {
  onSelectResource: (resource: Resource) => void;
  onRefresh: () => void;
}

export const TabularEditor: React.FC<TabularEditorProps> = ({
  onSelectResource,
  onRefresh,
}) => {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTableData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTableData() {
    setIsLoading(true);
    setError(null);
    try {
      const resources = await queryResources();
      if (resources.length === 0) {
        setColumns([]);
        setRows([]);
        setIsLoading(false);
        return;
      }

      // Get all unique column names from all resources
      const allColumns = new Set<string>();
      for (const res of resources) {
        const json = JSON.parse(JSON.stringify(res));
        Object.keys(json).forEach((k) => {
          if (k !== "extra" && typeof json[k] !== "object") {
            allColumns.add(k);
          }
        });
      }

      const columnList = Array.from(allColumns).sort();
      setColumns(columnList);

      // Convert resources to rows
      const rowData = resources.map((res) => {
        const row: Record<string, any> = {};
        for (const col of columnList) {
          const value = (res as any)[col];
          if (Array.isArray(value)) {
            row[col] = value.join(" | ");
          } else if (value === null || value === undefined) {
            row[col] = "";
          } else {
            row[col] = String(value);
          }
        }
        return row;
      });

      setRows(rowData);
    } catch (err) {
      console.error("Failed to load table data", err);
      setError(
        err instanceof Error ? err.message : "Failed to load resources from DuckDB"
      );
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <p className="text-xs text-slate-400">Loading table data from DuckDB...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {error}
        </div>
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <p className="text-xs text-slate-400">
          No resources found. Create a resource to see it in the table view.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold">Tabular Editor (DuckDB-powered)</h2>
        <button
          type="button"
          onClick={() => {
            loadTableData();
            onRefresh();
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800/70"
        >
          Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-block min-w-full align-middle">
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
            <table className="min-w-full divide-y divide-slate-800 text-xs">
              <thead className="bg-slate-900/80">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col}
                      className="px-3 py-2 text-left font-semibold text-slate-400 uppercase tracking-wide text-[10px] whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                {rows.map((row, idx) => (
                  <tr
                    key={idx}
                    className="hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => {
                      // Find the resource by ID
                      const resourceId = row.id;
                      if (resourceId) {
                        queryResources().then((resources) => {
                          const resource = resources.find((r) => r.id === resourceId);
                          if (resource) {
                            onSelectResource(resource);
                          }
                        });
                      }
                    }}
                  >
                    {columns.map((col) => (
                      <td
                        key={col}
                        className="px-3 py-2 text-[11px] text-slate-200 max-w-xs truncate"
                        title={String(row[col] || "")}
                      >
                        {String(row[col] || "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

