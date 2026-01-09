import { useState, useCallback } from 'react';
import { GithubService } from '../services/GithubService';

export interface ScanResult {
    path: string;
    sha: string;
}

export type SchemaMode = 'aardvark' | 'gbl1';

export const useGithubScanner = () => {
    // Inputs
    const [repoUrl, setRepoUrl] = useState("https://github.com/OpenGeoMetadata/edu.umn");
    const [branch, setBranch] = useState("main");
    const [token, setToken] = useState("");

    // State
    const [isScanning, setIsScanning] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const [foundFiles, setFoundFiles] = useState<ScanResult[]>([]);
    const [schemaMode, setSchemaMode] = useState<SchemaMode>('aardvark');

    const parseRepoUrl = (url: string): { owner: string; repo: string } | null => {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        } catch {
            const parts = url.split('/');
            if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
        }
        return null;
    };

    const scan = useCallback(async () => {
        setIsScanning(true);
        setScanError(null);
        setFoundFiles([]);
        setSchemaMode('aardvark');

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) {
            setScanError("Invalid Repository URL. Expected format: https://github.com/owner/repo");
            setIsScanning(false);
            return;
        }

        const client = new GithubService({ token: token || undefined });

        try {
            // 0. Auto-detect default branch if possible
            let effectiveBranch = branch;
            try {
                const repoData = await client.fetchRepoInfo(repoRef.owner, repoRef.repo);
                if (repoData.default_branch && branch === "main" && repoData.default_branch !== "main") {
                    console.log(`[GithubImport] Switch branch 'main' -> '${repoData.default_branch}' (repo default)`);
                    effectiveBranch = repoData.default_branch;
                    setBranch(effectiveBranch);
                }
            } catch (e) {
                console.warn("Could not fetch repo info for default branch check", e);
            }

            // 1. Try 'metadata-aardvark' first
            console.log(`[GithubImport] Attempting smart fetch for 'metadata-aardvark' subtree on ${effectiveBranch}...`);
            let files: ScanResult[] = [];
            let mode: SchemaMode = 'aardvark';

            try {
                const subtreeFiles = await client.fetchSubtree({ ...repoRef, branch: effectiveBranch }, "metadata-aardvark");
                if (subtreeFiles.length === 0) throw new Error("metadata-aardvark not found or empty");

                files = subtreeFiles.map(f => ({ ...f, path: `metadata-aardvark/${f.path}` }));
                console.log(`[GithubImport] Found metadata-aardvark. Got ${files.length} items.`);
                mode = 'aardvark';
            } catch (e) {
                console.warn("[GithubImport] No metadata-aardvark folder found. Keeping checks open.");

                // 2. Fallback: Check for 'json' folder (common in GBL v1 repos like Harvard)
                try {
                    console.log(`[GithubImport] Checking for legacy 'json' folder...`);
                    const subtreeFiles = await client.fetchSubtree({ ...repoRef, branch: effectiveBranch }, "json");
                    if (subtreeFiles.length === 0) throw new Error("json folder not found or empty");

                    files = subtreeFiles.map(f => ({ ...f, path: `json/${f.path}` }));
                    console.log(`[GithubImport] Found json folder. Got ${files.length} items.`);
                    mode = 'gbl1';
                } catch (e2) {
                    // 3. Fallback: Full Scan
                    console.warn("[GithubImport] No json folder found either. Falling back to full recursive.");
                    files = await client.fetchRecursiveTree({ ...repoRef, branch: effectiveBranch });
                }
            }

            setSchemaMode(mode);

            // Filter for JSON
            let jsonFiles = files.filter(f => f.path.endsWith(".json"));

            // Heuristic detection if we have JSONs but not from known folders
            if (jsonFiles.length > 0) {
                const aardvark = jsonFiles.filter(f => f.path.includes("metadata-aardvark"));
                const legacy = jsonFiles.filter(f => f.path.split("/").includes("json"));

                if (aardvark.length > 0) {
                    jsonFiles = aardvark;
                    setSchemaMode('aardvark');
                } else if (legacy.length > 0) {
                    jsonFiles = legacy;
                    setSchemaMode('gbl1');
                } else {
                    setSchemaMode('gbl1');
                }
            }

            if (jsonFiles.length === 0) {
                const sample = files.slice(0, 5).map(f => f.path).join(", ");
                setScanError(`Scanned ${files.length} files but found no JSON files. Sample paths: ${sample}`);
            } else {
                setFoundFiles(jsonFiles);
            }

        } catch (err: any) {
            console.error(err);
            setScanError(err.message || "Failed to scan repository.");
        } finally {
            setIsScanning(false);
        }
    }, [repoUrl, branch, token]);

    return {
        // State
        repoUrl, setRepoUrl,
        branch, setBranch,
        token, setToken,
        isScanning,
        scanError,
        foundFiles,
        schemaMode,
        // Actions
        scan,
        parseRepoUrl // Exporting if needed externally, though mostly internal
    };
};
