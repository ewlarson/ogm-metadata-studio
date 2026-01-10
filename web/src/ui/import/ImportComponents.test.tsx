import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScanForm } from './ScanForm';
import { ImportProgress } from './ImportProgress';

describe('Import Components', () => {
    describe('ScanForm', () => {
        it('renders inputs and interacts', () => {
            const setRepoUrl = vi.fn();
            const onScan = vi.fn();

            render(
                <ScanForm
                    repoUrl="http://test"
                    setRepoUrl={setRepoUrl}
                    branch="main"
                    setBranch={vi.fn()}
                    token=""
                    setToken={vi.fn()}
                    onScan={onScan}
                    isScanning={false}
                    scanError={null}
                />
            );

            const input = screen.getByDisplayValue('http://test');
            fireEvent.change(input, { target: { value: 'http://new' } });
            expect(setRepoUrl).toHaveBeenCalledWith('http://new');

            fireEvent.click(screen.getByText('Scan Repository'));
            expect(onScan).toHaveBeenCalled();
        });

        it('disables button when scanning', () => {
            render(
                <ScanForm
                    repoUrl="" setRepoUrl={vi.fn()}
                    branch="" setBranch={vi.fn()}
                    token="" setToken={vi.fn()}
                    onScan={vi.fn()}
                    isScanning={true}
                    scanError={null}
                />
            );
            expect(screen.getByText('Scanning...')).toBeDisabled();
        });

        it('displays error', () => {
            render(
                <ScanForm
                    repoUrl="" setRepoUrl={vi.fn()}
                    branch="" setBranch={vi.fn()}
                    token="" setToken={vi.fn()}
                    onScan={vi.fn()}
                    isScanning={false}
                    scanError="Failed to fetch"
                />
            );
            expect(screen.getByText('Failed to fetch')).toBeDefined();
        });
    });

    describe('ImportProgress', () => {
        it('renders nothing if no files', () => {
            const { container } = render(
                <ImportProgress
                    foundFiles={[]}
                    schemaMode={null}
                    isImporting={false}
                    onImport={vi.fn()}
                    progress={{ current: 0, total: 0, successes: 0, failures: 0 }}
                    errorLogs={[]}
                />
            );
            expect(container).toBeEmptyDOMElement();
        });

        it('renders found files and start button', () => {
            const onImport = vi.fn();
            render(
                <ImportProgress
                    foundFiles={[{ path: 'file.json', sha: '123' }]}
                    schemaMode="aardvark"
                    isImporting={false}
                    onImport={onImport}
                    progress={{ current: 0, total: 1, successes: 0, failures: 0 }}
                    errorLogs={[]}
                />
            );

            expect(screen.getByText('Found 1 files')).toBeDefined();
            expect(screen.getByText('aardvark')).toBeDefined(); // Uppercase in UI potentially

            fireEvent.click(screen.getByText('Start Import'));
            expect(onImport).toHaveBeenCalled();
        });

        it('renders progress bar when importing', () => {
            render(
                <ImportProgress
                    foundFiles={[{ path: 'f1.json', sha: '1' }, { path: 'f2.json', sha: '2' }]}
                    schemaMode="aardvark"
                    isImporting={true}
                    onImport={vi.fn()}
                    progress={{ current: 1, total: 2, successes: 1, failures: 0 }}
                    errorLogs={[]}
                />
            );

            expect(screen.getByText('Processing: 1 / 2')).toBeDefined();
            expect(screen.queryByText('Start Import')).toBeNull();
        });

        it('renders error logs', () => {
            render(
                <ImportProgress
                    foundFiles={[{ path: 'f1.json', sha: '1' }]}
                    schemaMode="aardvark"
                    isImporting={false}
                    onImport={vi.fn()}
                    progress={{ current: 0, total: 0, successes: 0, failures: 0 }}
                    errorLogs={[{ path: 'f1.json', error: 'Parsing failed' }]}
                />
            );

            expect(screen.getByText('Error Log (Last 100)')).toBeDefined();
            expect(screen.getByText('Parsing failed')).toBeDefined();
        });
    });
});
