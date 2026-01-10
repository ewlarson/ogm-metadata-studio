import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';
import * as duckdbClient from '../duckdb/duckdbClient';

// Use vi.hoisted to share state between mock factory and tests
const mocks = vi.hoisted(() => ({
    urlState: { view: 'dashboard', id: undefined as string | undefined },
    setUrlState: vi.fn(),
    countResources: vi.fn()
}));

// Mock hook implementation
const mockUseUrlState = () => {
    return [mocks.urlState, mocks.setUrlState];
};

vi.mock('./hooks/useUrlState', () => ({
    useUrlState: mockUseUrlState
}));

// Mock troublesome dependencies globally
vi.mock('react-syntax-highlighter', () => ({
    Prism: ({ children }: { children: any }) => <pre>{children}</pre>
}));

vi.mock('./hooks/useResourceSearch', () => ({
    useResourceSearch: () => ({
        resources: [],
        total: 10,
        loading: false,
        resourceCountLoading: false,
        count: 10
    })
}));

vi.mock('../duckdb/duckdbClient', () => ({
    queryResourceById: vi.fn(),
    upsertResource: vi.fn(),
    queryDistributionsForResource: vi.fn(),
    countResources: mocks.countResources
}));

// Mock Views
vi.mock('./Dashboard', () => ({
    Dashboard: ({ onEdit, onSelect }: any) => (
        <div>
            Dashboard View
            <button onClick={() => onEdit('123')}>Edit 123</button>
            <button onClick={() => onSelect('456')}>Select 456</button>
        </div>
    )
}));
vi.mock('./ImportPage', () => ({
    ImportPage: () => <div>Import View</div>
}));
vi.mock('./ResourceShow', () => ({
    ResourceShow: ({ onBack }: any) => (
        <div>
            Resource Show View
            <button onClick={onBack}>Back</button>
        </div>
    )
}));
vi.mock('./ResourceEdit', () => ({
    ResourceEdit: ({ onSave, onCancel }: any) => (
        <div>
            Resource Edit View
            <button onClick={() => onSave({ id: '1' }, [])}>Save</button>
            <button onClick={onCancel}>Cancel</button>
        </div>
    )
}));
vi.mock('./ThemeToggle', () => ({
    ThemeToggle: () => <div>Theme Toggle</div>
}));
vi.mock('./DistributionsList', () => ({
    DistributionsList: () => <div>Distributions List View</div>
}));

describe('App Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.urlState = { view: 'dashboard', id: undefined };
        mocks.countResources.mockResolvedValue(10);
    });

    it('renders dashboard by default', async () => {
        render(<App />);
        expect(await screen.findByText('Dashboard View')).toBeDefined();
    });



    it.skip('loads resource for edit', async () => {
        mocks.urlState = { view: 'edit', id: 'res-1' };
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue({ id: 'res-1', dct_title_s: 'Test' } as any);
        vi.mocked(duckdbClient.queryDistributionsForResource).mockResolvedValue([]);

        render(<App />);

        await waitFor(() => {
            expect(duckdbClient.queryResourceById).toHaveBeenCalledWith('res-1');
            expect(screen.getByText('Resource Edit View')).toBeDefined();
        });
    });

    it.skip('handles save and cancel in edit', async () => {
        mocks.urlState = { view: 'edit', id: 'res-1' };
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue({ id: 'res-1' } as any);

        render(<App />);
        await waitFor(() => screen.getByText('Resource Edit View'));

        // Save
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => {
            expect(duckdbClient.upsertResource).toHaveBeenCalled();
            expect(mocks.setUrlState).toHaveBeenCalledWith({ view: 'dashboard' });
        });

        // Cancel
        fireEvent.click(screen.getByText('Cancel'));
        expect(mocks.setUrlState).toHaveBeenCalledWith({ view: 'dashboard' });
    });
});
