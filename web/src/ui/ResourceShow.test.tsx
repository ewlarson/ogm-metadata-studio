import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceShow } from './ResourceShow';
import * as duckdbClient from '../duckdb/duckdbClient';
import { databaseService } from '../services/DatabaseService';
import * as processedResourceRecovery from '../services/processedResourceRecovery';

// Mock dependencies
vi.mock('../duckdb/duckdbClient', () => ({
    queryResourceById: vi.fn(),
    querySimilarResources: vi.fn(),
    getSearchNeighbors: vi.fn(),
    queryDistributionsForResource: vi.fn()
}));

vi.mock('../duckdb/dbInit', () => ({
    waitForDuckDbRestore: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/processedResourceRecovery', () => ({
    recoverProcessedS3ResourceToLocalCatalog: vi.fn()
}));

vi.mock('../services/DatabaseService', () => ({
    databaseService: {
        deleteResource: vi.fn()
    }
}));

vi.mock('./shared/ToastContext', () => ({
    useToast: () => ({ addToast: vi.fn() })
}));

// Mock Child Components
vi.mock('./ResourceViewer', () => ({ ResourceViewer: () => <div>Resource Viewer</div> }));
vi.mock('./resource/ResourceSidebar', () => ({ ResourceSidebar: () => <div>Resource Sidebar</div> }));
vi.mock('./resource/ResourceMetadata', () => ({ ResourceMetadata: () => <div>Resource Metadata</div> }));
vi.mock('./resource/SimilarResourcesCarousel', () => ({ SimilarResourcesCarousel: () => <div>Similar Resources</div> }));
vi.mock('./resource/ResourceHeader', () => ({
    ResourceHeader: ({ onDelete }: any) => <button onClick={() => onDelete('1')}>Delete Resource</button>
}));

const mockResource = {
    id: '1',
    dct_title_s: 'Test Resource',
    gbl_resourceClass_sm: ['Map']
};

describe('ResourceShow Component', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(duckdbClient.queryDistributionsForResource).mockResolvedValue([]);
        vi.mocked(duckdbClient.querySimilarResources).mockResolvedValue([]);
        vi.mocked(duckdbClient.getSearchNeighbors).mockResolvedValue({ position: 0, total: 0 });
        vi.mocked(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).mockResolvedValue(null);
    });

    it('renders loading state initially', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockReturnValue(new Promise(() => { })); // Hang
        render(<ResourceShow id="1" onBack={() => { }} />);
        expect(screen.getByText('Loading resource...')).toBeDefined();
    });

    it('renders resource details when loaded', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(mockResource as any);
        vi.mocked(duckdbClient.querySimilarResources).mockResolvedValue([]);
        vi.mocked(duckdbClient.getSearchNeighbors).mockResolvedValue({ position: 1, total: 10 });

        render(<ResourceShow id="1" onBack={() => { }} />);

        await waitFor(() => {
            expect(screen.getByText('Resource Viewer')).toBeDefined();
        });
        expect(screen.getByText('Resource Metadata')).toBeDefined();
        expect(screen.getByText('Resource Sidebar')).toBeDefined();
    });

    it('renders not found state', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(null);
        render(<ResourceShow id="999" onBack={() => { }} />);
        await waitFor(() => {
            expect(screen.getByText('Resource not found: 999')).toBeDefined();
        });
    });

    it('recovers a missing processed resource from S3', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(null);
        vi.mocked(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).mockResolvedValue({
            resource: mockResource as any,
            distributions: [],
            storageProfileId: 's3-profile',
            storageProfileName: 'S3 profile',
            s3Resource: { resourceId: '1' } as any,
        });
        vi.mocked(duckdbClient.querySimilarResources).mockResolvedValue([]);
        vi.mocked(duckdbClient.getSearchNeighbors).mockResolvedValue({ position: 1, total: 1 });

        render(<ResourceShow id="1" onBack={() => { }} />);

        await waitFor(() => {
            expect(screen.getByText('Resource Viewer')).toBeDefined();
        });
        expect(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).toHaveBeenCalledWith('1', expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
    });

    it('refreshes an existing stale processed raster from S3', async () => {
        const staleRaster = {
            id: '1',
            dct_title_s: 'Reno, Nevada, 1893 (reprinted 1948)',
            dct_format_s: 'GeoTIFF',
            gbl_resourceClass_sm: ['Datasets'],
            gbl_resourceType_sm: ['Raster data'],
            gbl_displayNote_sm: ['GDAL did not find raster georeferencing; no bounding box, centroid, or CRS is available.'],
            dct_references_s: JSON.stringify({
                'http://schema.org/downloadUrl': [
                    { url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/original_file/Reno_1893_rpt1948.zip', label: 'Original geospatial raster package' },
                ],
                'https://opengeometadata.org/reference/aardvark-json': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/aardvark.json',
            }),
        };
        const refreshed = {
            ...mockResource,
            dct_title_s: 'Reno sheet, Nevada',
            gbl_resourceClass_sm: ['Maps'],
            gbl_resourceType_sm: ['Topographic maps'],
            dct_references_s: JSON.stringify({
                'http://iiif.io/api/image': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/iiif/info.json',
                'https://opengeometadata.org/reference/enrichment-response': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/enrichment_response.json',
            }),
        };
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(staleRaster as any);
        vi.mocked(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).mockResolvedValue({
            resource: refreshed as any,
            distributions: [],
            storageProfileId: 's3-profile',
            storageProfileName: 'S3 profile',
            s3Resource: { resourceId: '1' } as any,
        });

        render(<ResourceShow id="1" onBack={() => { }} />);

        await waitFor(() => {
            expect(screen.getByText('Resource Viewer')).toBeDefined();
        });
        expect(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).toHaveBeenCalledWith('1', expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
    });

    it('repairs a promoted processed map whose local primary URL still points at the ZIP', async () => {
        const localPromotedWithZipUrl = {
            id: '1',
            dct_title_s: 'Reno sheet, Nevada',
            dct_format_s: 'TIFF',
            gbl_resourceClass_sm: ['Maps'],
            gbl_resourceType_sm: ['Topographic maps'],
            dct_references_s: JSON.stringify({
                'http://schema.org/url': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/original_file/Reno_1893_rpt1948.zip',
                'http://iiif.io/api/image': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/iiif/info.json',
            }),
        };
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(localPromotedWithZipUrl as any);
        vi.mocked(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).mockResolvedValue({
            resource: {
                ...localPromotedWithZipUrl,
                dct_references_s: JSON.stringify({
                    'http://schema.org/url': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/original_file/Reno_1893_rpt1948.tif',
                    'http://iiif.io/api/image': 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/1/iiif/info.json',
                }),
            } as any,
            distributions: [],
            storageProfileId: 's3-profile',
            storageProfileName: 'S3 profile',
            s3Resource: { resourceId: '1' } as any,
        });

        render(<ResourceShow id="1" onBack={() => { }} />);

        await waitFor(() => {
            expect(screen.getByText('Resource Viewer')).toBeDefined();
        });
        expect(processedResourceRecovery.recoverProcessedS3ResourceToLocalCatalog).toHaveBeenCalledWith('1', expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
    });

    it('handles delete action', async () => {
        vi.mocked(duckdbClient.queryResourceById).mockResolvedValue(mockResource as any);
        const onBack = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<ResourceShow id="1" onBack={onBack} />);

        await waitFor(() => expect(screen.getByText('Delete Resource')).toBeDefined());

        fireEvent.click(screen.getByText('Delete Resource'));

        await waitFor(() => {
            expect(databaseService.deleteResource).toHaveBeenCalledWith('1');
            expect(onBack).toHaveBeenCalled();
        });
    });
});
