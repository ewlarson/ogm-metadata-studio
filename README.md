# Aardvark Metadata Studio

A browser-based editor for [OpenGeoMetadata Aardvark](https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json) records, powered by **React**, **Vite**, and **DuckDB WASM**.

This application allows you to manage geospatial metadata JSON files stored in a GitHub repository directly from your browser, with powerful tabular editing capabilities backed by a local in-browser SQL database.

## Deployment

This project is configured to automatically deploy to **GitHub Pages** using GitHub Actions.

### One-Time Setup
1. Go to your repository **Settings** > **Pages**.
2. Under **Build and deployment** > **Source**, select **GitHub Actions**.
3. The `Data Pipeline & Deploy` workflow will automatically pick this up on the next push.

### Architecture
- **Source**: JSON files in `metadata/` are the source of truth.
- **Build**: The `build:db` script runs in CI, compiling all JSONs into a single `resources.parquet` file.
- **Frontend**: The React app loads this Parquet file on startup, enabling a fast, read-only experience without needing a GitHub token.

## Features

- **GitHub Integration**: Connect directly to your metadata repository using a Personal Access Token (PAT). No backend server required.
- **Local SQL Engine**: Runs [DuckDB WASM](https://duckdb.org/docs/api/wasm/overview) entirely in your browser to query and manage thousands of records efficiently.
- **Tabular Editing**: View and edit your metadata resources and distributions as tables.
- **Metadata Sync**:
  - Pulls JSON files from your GitHub repository `metadata/` folder.
  - Syncs them into a local DuckDB database.
  - Persists state locally using IndexedDB (so you don't lose work on refresh).
- **Aardvark Compliant**: Native support for the Aardvark schema, including proper handling of `dct_references_s` as a relational distributions table.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- A GitHub repository containing Aardvark JSON records in a `metadata/` folder (or an empty repo to start fresh).

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/ewlarson/gitcrud.git
   cd gitcrud/web
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser to the local URL (usually `http://localhost:5173`).

## Usage

### 1. Connect to GitHub
- Generate a [GitHub Personal Access Token (Classic)](https://github.com/settings/tokens) with `repo` scope.
- In the app, enter:
  - **Owner**: GitHub username or organization (e.g., `ewlarson`).
  - **Repository**: Repository name (e.g., `gitcrud`).
  - **Branch**: Main branch name (e.g., `main`).
  - **Metadata Path**: Folder where JSON files are stored (default: `metadata`).
  - **Token**: Your PAT.
- Click **Connect**. The app will verify access and load existing JSON files into the local DuckDB.

### 2. View and Edit
- **Resource List**: See all your records in a sortable list.
- **Tabular Editor**: Click "Show Tabular Editor" to view `resources` and `distributions` tables. You can run SQL queries directly against your metadata!
- **Edit Record**: Select a record to modify its fields (Title, Description, Rights, etc.).

### 3. Sync Changes
(Feature in progress)
- Changes made in the UI are applied to the local DuckDB database.
- Future updates will enable pushing changes back to GitHub as commits.

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Database**: DuckDB WASM (loaded via Vite assets)
- **Styling**: Tailwind CSS
- **Persistence**: IndexedDB (via DuckDB) + LocalStorage (for config)
- **API**: GitHub REST API (direct from browser)

## Troubleshooting

### DuckDB Loading Issues
If you see errors related to DuckDB initialization:
- Ensure you are running a modern browser with WebAssembly support.
- Check the console for CORS errors (Cross-Origin-Opener-Policy headers are configured in `vite.config.ts` to support WASM threads).

### GitHub Connection
- Verify your PAT has `repo` (Full control of private repositories) or `public_repo` (for public repos) scope.
- Ensure the repository exists and the branch name is correct.
