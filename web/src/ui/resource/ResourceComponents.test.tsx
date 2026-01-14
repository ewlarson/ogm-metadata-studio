import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { ResourceHeader } from './ResourceHeader';
import { ResourceSidebar } from './ResourceSidebar';
import { Resource } from '../../aardvark/model';

// Mock dependencies
vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
    TileLayer: () => <div data-testid="tile-layer" />,
    Rectangle: () => <div data-testid="rectangle" />
}));

vi.mock('./CopyButton', () => ({
    CopyButton: ({ text }: { text: string }) => <button data-testid="copy-btn" onClick={() => { }}>Copy</button>
}));

const FIXTURE_RES: Resource = {
    id: 'test-1',
    dct_title_s: 'Test Resource',
    gbl_resourceClass_sm: ['Map'],
    gbl_resourceType_sm: ['Paper Map'],
    dct_spatial_sm: ['USA'],
    dcat_bbox: 'ENVELOPE(-100,-80,40,30)',
    dct_references_s: JSON.stringify({ "http://schema.org/downloadUrl": "http://dl.com" }),
    gbl_indexYear_im: 2020,
    dct_creator_sm: ['Creator A'],
    dct_publisher_sm: ['Publisher B']
};

describe('ResourceHeader', () => {
    const mockOnNavigate = vi.fn();
    const mockOnDelete = vi.fn();
    const pagination = {
        position: 1,
        total: 10,
        prevId: 'prev-1',
        nextId: 'next-1'
    };

    it('renders breadcrumbs and title', () => {
        render(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        expect(screen.getByText('Test Resource')).toBeDefined();
        expect(screen.getByText('Map')).toBeDefined();
        expect(screen.getByText('Paper Map')).toBeDefined();
        expect(screen.getByText('USA')).toBeDefined();
        expect(screen.getByText('Publisher B')).toBeDefined();
        expect(screen.getByText(/2020/)).toBeDefined();
    });

    it('handles navigation', () => {
        render(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        fireEvent.click(screen.getByText('Next'));
        expect(mockOnNavigate).toHaveBeenCalledWith('next-1');

        fireEvent.click(screen.getByText('Prev'));
        expect(mockOnNavigate).toHaveBeenCalledWith('prev-1');
    });

    it('handles delete', () => {
        render(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        fireEvent.click(screen.getByText('Delete'));
        expect(mockOnDelete).toHaveBeenCalledWith('test-1');
    });
});

describe('ResourceSidebar', () => {
    it('renders map with bounds', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        expect(screen.getByTestId('map-container')).toBeDefined();
        expect(screen.getByTestId('rectangle')).toBeDefined();
    });

    it('renders download link', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        expect(screen.getByText('Download Resource')).toHaveAttribute('href', 'http://dl.com');
    });

    it('renders citation', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        // Citation: Creator A. (2020). Test Resource. Publisher B. window.location.href.
        expect(screen.getByText(/Creator A/)).toBeDefined();
        expect(screen.getByText(/Publisher B/)).toBeDefined();
    });

    it('handles missing bbox gracefully', () => {
        const res = { ...FIXTURE_RES, dcat_bbox: undefined };
        render(<ResourceSidebar resource={res} />);
        expect(screen.getByText('No map extent available')).toBeDefined();
    });
});
