import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportPage } from './ImportPage';
import * as duckdb from '../duckdb/duckdbClient';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    importCsv: vi.fn(),
    saveDb: vi.fn(),
    exportDbBlob: vi.fn(),
    importJsonData: vi.fn(),
    exportAardvarkJsonZip: vi.fn()
}));

vi.mock('./GithubImport', () => ({
    GithubImport: () => <div data-testid="github-import">Github Import Component</div>
}));

// Mock URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:url');
global.URL.revokeObjectURL = vi.fn();

describe('ImportPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders welcome message when resourceCount is 0', () => {
        render(<ImportPage resourceCount={0} />);
        expect(screen.getByText(/Welcome to Aardvark Metadata Studio/)).toBeDefined();
    });

    it('does not render welcome message when resources exist', () => {
        render(<ImportPage resourceCount={5} />);
        expect(screen.queryByText(/Welcome to Aardvark Metadata Studio/)).toBeNull();
    });

    it('switches tabs', () => {
        render(<ImportPage />);

        // Default Local
        expect(screen.getByText('1. CSV / JSON / DuckDB Import')).toBeDefined();

        // Switch to Github
        fireEvent.click(screen.getByText('GitHub Import'));
        expect(screen.getByTestId('github-import')).toBeDefined();
        expect(screen.queryByText('1. CSV / JSON / DuckDB Import')).toBeNull();

        // Switch back
        fireEvent.click(screen.getByText('Local File Upload'));
        expect(screen.getByText('1. CSV / JSON / DuckDB Import')).toBeDefined();
    });

    it('handles JSON import', async () => {
        vi.mocked(duckdb.importJsonData).mockResolvedValue(10);

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeDefined();

        const file = new File(['{"id":"1"}'], 'test.json', { type: 'application/json' });
        // Mock text() method as it might not be implemented in jsdom perfectly or standard File ctor
        Object.defineProperty(file, 'text', {
            value: vi.fn().mockResolvedValue('{"id":"1"}')
        });

        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdb.importJsonData).toHaveBeenCalled();
            expect(screen.getByText(/Import complete! Loaded 10 resources/)).toBeDefined();
        });
    });

    it('handles CSV import', async () => {
        vi.mocked(duckdb.importCsv).mockResolvedValue({ success: true, count: 5 });

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeDefined();

        const file = new File(['id,title'], 'test.csv', { type: 'text/csv' });
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdb.importCsv).toHaveBeenCalled();
            expect(screen.getByText(/Import complete! Loaded 5 resources/)).toBeDefined();
        });
    });

    it('handles export JSON zip', async () => {
        vi.mocked(duckdb.exportAardvarkJsonZip).mockResolvedValue(new Blob(['zip data']));

        render(<ImportPage />);

        const btn = screen.getByText('Download JSON Zip');
        fireEvent.click(btn);

        await waitFor(() => {
            expect(duckdb.exportAardvarkJsonZip).toHaveBeenCalled();
            expect(screen.getByText('JSON OGM Export downloaded.')).toBeDefined();
        });
    });

    it('handles save DB', async () => {
        vi.mocked(duckdb.exportDbBlob).mockResolvedValue(new Blob(['db data']));

        render(<ImportPage />);

        const btn = screen.getByText('Download records.duckdb');
        fireEvent.click(btn);

        await waitFor(() => {
            expect(duckdb.saveDb).toHaveBeenCalled();
            expect(duckdb.exportDbBlob).toHaveBeenCalled();
            expect(screen.getByText(/Database downloaded/)).toBeDefined();
        });
    });

    it('handles errors during import', async () => {
        vi.mocked(duckdb.importCsv).mockResolvedValue({ success: false, message: 'Invalid CSV' });

        const { container } = render(<ImportPage />);

        const input = container.querySelector('input[type="file"]');
        const file = new File(['bad'], 'bad.csv', { type: 'text/csv' });
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() => {
            expect(screen.getByText(/Error:/)).toBeDefined();
            expect(screen.getByText(/Invalid CSV/)).toBeDefined();
        });
    });
});
