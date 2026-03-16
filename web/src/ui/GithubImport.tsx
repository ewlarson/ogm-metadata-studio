import React, { useState } from 'react';
import { GithubService } from '../services/GithubService';
import { importJsonData, saveDb } from '../duckdb/duckdbClient';
import { gbl1ToAardvark } from '../aardvark/gbl1_to_aardvark';
import { useGithubScanner } from '../hooks/useGithubScanner';
import { ScanForm } from './import/ScanForm';
import { ImportProgress } from './import/ImportProgress';

export const GithubImport: React.FC<{ onImported?: () => void | Promise<void> }> = ({ onImported }) => {
    // Use the hook
    const {
        repoUrl, setRepoUrl,
        branch, setBranch,
        token, setToken,
        isScanning,
        scanError,
        foundFiles,
        schemaMode,
        scan,
        parseRepoUrl
    } = useGithubScanner();

    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState({ current: 0, total: 0, successes: 0, failures: 0 });
    const [errorLogs, setErrorLogs] = useState<{ path: string, error: string }[]>([]);

    const appendErrorLog = (path: string, error: string) => {
        setErrorLogs(prev => [...prev.slice(-99), { path, error }]);
    };

    const loadJsonForFile = async (
        client: GithubService,
        repoRef: { owner: string; repo: string },
        filePath: string,
        currentBranch: string,
        currentSchemaMode: 'aardvark' | 'gbl1' | null
    ) => {
        let json = await client.fetchPublicJson({ ...repoRef, branch: currentBranch }, filePath);

        if (currentSchemaMode === 'gbl1') {
            if (typeof json === 'string') {
                try {
                    json = JSON.parse(json);
                } catch {
                    throw new Error("Failed to parse double-encoded JSON string");
                }
            }

            json = gbl1ToAardvark(json);
        }

        return json;
    };

    const handleImport = async () => {
        if (foundFiles.length === 0) return;

        setIsImporting(true);

        setErrorLogs([]);
        setImportProgress({ current: 0, total: foundFiles.length, successes: 0, failures: 0 });

        const repoRef = parseRepoUrl(repoUrl);
        if (!repoRef) return;

        const client = new GithubService({ token: token || undefined });

        const CHUNK_SIZE = 50;
        let successes = 0;
        let failures = 0;

        for (let i = 0; i < foundFiles.length; i += CHUNK_SIZE) {
            const chunk = foundFiles.slice(i, i + CHUNK_SIZE);

            const fetched = await Promise.all(chunk.map(async (file) => {
                try {
                    const json = await loadJsonForFile(client, repoRef, file.path, branch, schemaMode);
                    return { file, json, error: null as string | null };
                } catch (e: any) {
                    console.error(`Failed to import ${file.path}`, e);
                    return { file, json: null, error: e?.message || String(e) };
                }
            }));

            const valid = fetched.filter((item) => item.error === null && item.json != null);
            for (const item of fetched) {
                if (item.error) {
                    failures++;
                    appendErrorLog(item.file.path, item.error);
                }
            }

            if (valid.length > 0) {
                try {
                    const importedCount = await importJsonData(valid.map((item) => item.json), { skipSave: true });
                    successes += importedCount;

                    const missingIds = valid.length - importedCount;
                    if (missingIds > 0) {
                        for (const item of valid) {
                            const record = item.json as Record<string, unknown>;
                            if (!record?.id) {
                                failures++;
                                appendErrorLog(item.file.path, "No Resource ID found");
                            }
                        }
                    }
                } catch (batchError: any) {
                    console.warn("Batch import failed, falling back to per-file import", batchError);
                    for (const item of valid) {
                        try {
                            const count = await importJsonData(item.json, { skipSave: true });
                            if (count > 0) {
                                successes += count;
                            } else {
                                failures++;
                                appendErrorLog(item.file.path, "No Resource ID found");
                            }
                        } catch (singleError: any) {
                            console.error(`Failed to import ${item.file.path}`, singleError);
                            failures++;
                            appendErrorLog(item.file.path, singleError?.message || String(singleError));
                        }
                    }
                }
            }

            setImportProgress(prev => ({
                ...prev,
                current: Math.min(i + CHUNK_SIZE, foundFiles.length),
                successes,
                failures
            }));
        }

        // Final Save
        await saveDb();
        await onImported?.();

        setIsImporting(false);
        alert(`Import Complete! Imported ${successes} files. Failed ${failures}.`);
    };

    return (
        <div className="space-y-6">
            <ScanForm
                repoUrl={repoUrl}
                setRepoUrl={setRepoUrl}
                branch={branch}
                setBranch={setBranch}
                token={token}
                setToken={setToken}
                onScan={scan}
                isScanning={isScanning || isImporting}
                scanError={scanError}
            />

            <ImportProgress
                foundFiles={foundFiles}
                schemaMode={schemaMode}
                isImporting={isImporting}
                onImport={handleImport}
                progress={importProgress}
                errorLogs={errorLogs}
            />
        </div>
    );
};
