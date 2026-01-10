import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportPage } from './ImportPage';
import * as duckdbClient from '../duckdb/duckdbClient';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    importCsv: vi.fn(),
    importJsonData: vi.fn(),
    exportAardvarkJsonZip: vi.fn(),
    saveDb: vi.fn(),
    exportDbBlob: vi.fn()
}));

vi.mock('./GithubImport', () => ({
    GithubImport: () => <div>Github Import Component</div>
}));

// Polyfill File.text
if (!File.prototype.text) {
    File.prototype.text = async function () {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsText(this);
        });
    };
}

describe('ImportPage Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders welcome banner when no resources', () => {
        render(<ImportPage resourceCount={0} />);
        expect(screen.getByText(/Welcome to Aardvark Metadata Studio/i)).toBeDefined();
    });

    it('renders tabs', () => {
        render(<ImportPage resourceCount={10} />);
        expect(screen.getByText('Local File Upload')).toBeDefined();
        expect(screen.getByText('GitHub Import')).toBeDefined();
    });

    it('switches to Github tab', () => {
        render(<ImportPage resourceCount={10} />);
        fireEvent.click(screen.getByText('GitHub Import'));
        expect(screen.getByText('Github Import Component')).toBeDefined();
    });

    it('handles JSON import', async () => {
        const { container } = render(<ImportPage resourceCount={10} />);

        const input = container.querySelector('input[type="file"]');
        expect(input).toBeDefined();

        const file = new File(['{"id":"1"}'], 'test.json', { type: 'application/json' });
        // @ts-ignore
        fireEvent.change(input, { target: { files: [file] } });

        await waitFor(() => {
            expect(duckdbClient.importJsonData).toHaveBeenCalled();
        });
    });

    it('triggers export', () => {
        render(<ImportPage resourceCount={10} />);
        const exportBtn = screen.getByText('Download JSON Zip');
        fireEvent.click(exportBtn);
        expect(duckdbClient.exportAardvarkJsonZip).toHaveBeenCalled();
    });
});
