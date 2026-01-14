# OGM Metadata Studio

A browser-native metadata management workspace for the [OpenGeoMetadata Aardvark](https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json) standard.

**Aardvark Metadata Studio** enables libraries and researchers to manage geospatial metadata repositories (like OpenGeoMetadata) entirely in the browser. It combines the speed of a local database engine with the persistence of standard Git workflows.

Built with **React**, **Vite**, **DuckDB-WASM**, and **GitHub REST API**.

## ✨ Features

*   **Browser-Native SQL Engine**: Uses [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) to perform sub-millisecond queries, filtering, and aggregation on thousands of records directly in the client. No backend server required.
*   **Git-Backed Persistence**: "Database" changes are actually local state changes that can be synced back to GitHub as `git commit` actions. Your metadata remains in standard JSON files, version-controlled and forkable.
*   **Faceted Search & Discovery**: Powerful faceted search UI (similar to GeoBlacklight) for exploring your metadata collection, powered by SQL `GROUP BY` and `ILIKE` logic.
*   **Interactive Mapping**: Integrated Leaflet maps to visual bounding boxes (`dcat_bbox`) and spatial footprints.
*   **Data Ingestion**: Import data from CSV or JSON sources, with automatic validation against the Aardvark schema constants.
*   **Embeddings & AI**: (Experimental) Local Web Worker-based text embedding generation for semantic search capabilities.

## 🛠️ Architecture

*   **Frontend**: React + TypeScript + Vite
*   **Database**: DuckDB WASM (Persistent `records.duckdb` stored in IndexedDB)
*   **Testing**: Vitest + React Testing Library + JSDOM
*   **Styling**: Tailwind CSS
*   **API**: Direct GitHub REST API calls (no intermediate auth server)

## 🚀 Getting Started

### Prerequisites

*   Node.js (v18+)
*   A GitHub Personal Access Token (PAT) with `repo` scope (for private repos) or public access.

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/ewlarson/ogm-metadata-studio.git
    cd ogm-metadata-studio/web
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run the Development Server:
    ```bash
    npm run dev
    ```
    The app will start at `http://localhost:5173`.

## 🧪 Testing

This project maintains a high standard of test coverage using **Vitest**.

### Running Tests
Run the full unit and integration test suite:
```bash
npm test
```

### Coverage Reports
Generate a coverage report (check `coverage/` directory for HTML output):
```bash
npm run coverage
```
*Note: Due to source-mapping limitations in the JSDOM+Vite environment, console coverage reports may show 0% despite tests passing. This is a known tooling artifact; rely on the pass/fail status.*

## 📦 Data Workflow

1.  **Connect**: Provide your GitHub Owner/Repo/Branch/Token to pull the latest `metadata/*.json` files.
2.  **Ingest**: The app loads these JSONs into `records.duckdb` (client-side).
3.  **Edit/Search**: Use the dashboard to filter, search, and edit records.
4.  **Sync**: (In Progress) Edits are committed back to your GitHub repository as new JSON versions.

## 🤝 Contributing

Contributions are welcome! Please ensure any new features are accompanied by tests in `src/duckdb/` or `src/ui/`.
