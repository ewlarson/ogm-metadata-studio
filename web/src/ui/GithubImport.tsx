import React, { useState } from 'react';
import { GithubService } from '../services/GithubService';
import { importJsonData, saveDb } from '../duckdb/duckdbClient';
import { gbl1ToAardvark } from '../aardvark/gbl1_to_aardvark';
import { useGithubScanner } from '../hooks/useGithubScanner';
import { ScanForm } from './import/ScanForm';
import { ImportProgress } from './import/ImportProgress';

export const GithubImport: React.FC = () => {
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

            await Promise.all(chunk.map(async (file) => {
                try {
                    let json = await client.fetchPublicJson({ ...repoRef, branch }, file.path);

                    // GBL v1 Handling
                    if (schemaMode === 'gbl1') {
                        // Check for double-encoded string (e.g. Harvard)
                        if (typeof json === 'string') {
                            try {
                                json = JSON.parse(json);
                            } catch (e) {
                                // Maybe it was just a string? Unlikely for metadata
                                throw new Error("Failed to parse double-encoded JSON string");
                            }
                        }

                        // Crosswalk
                        json = gbl1ToAardvark(json);
                    }

                    const count = await importJsonData(json, { skipSave: true });

                    if (count > 0) {
                        successes++;
                    } else {
                        failures++;
                        setErrorLogs(prev => [...prev.slice(-99), { path: file.path, error: "No Resource ID found" }]);
                    }
                } catch (e: any) {
                    console.error(`Failed to import ${file.path}`, e);
                    failures++;
                    setErrorLogs(prev => [...prev.slice(-99), { path: file.path, error: e.message || String(e) }]);
                }
            }));

            setImportProgress(prev => ({
                ...prev,
                current: Math.min(i + CHUNK_SIZE, foundFiles.length),
                successes,
                failures
            }));
        }

        // Final Save
        await saveDb();

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
