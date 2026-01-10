import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceMetadata } from './ResourceMetadata';
import { SimilarResourcesCarousel } from './SimilarResourcesCarousel';
import { Resource } from '../../aardvark/model';

describe('Resource Components Coverage', () => {
    describe('ResourceMetadata', () => {
        const mockResource: Resource = {
            id: '1',
            dct_title_s: 'Test Title',
            dct_creator_sm: ['Creator 1', 'Creator 2'], // Facetable
            dct_description_sm: ['Description'], // Not facetable
            gbl_resourceClass_sm: ['Map'], // Facetable
            dct_issued_s: '2020',
            _hidden: 'should not show'
        } as any;

        it('renders fields and links facetable fields', () => {
            render(<ResourceMetadata resource={mockResource} />);

            expect(screen.getByText('Full Details')).toBeDefined();
            expect(screen.getByText('Creator')).toBeDefined();
            // Description appears twice (label and value), checked later

            // Facetable should be links
            const creatorLink = screen.getByText('Creator 1').closest('a');
            expect(creatorLink).toHaveAttribute('href', '/?include_filters[dct_creator_sm][]=Creator%201');

            // Non-facetable should be text (Label 'Description' and value 'Description')
            const descElements = screen.getAllByText('Description');
            expect(descElements.length).toBeGreaterThan(0);

            // Check matching value doesn't have link
            const descValue = descElements.find(el => el.tagName === 'DD');
            expect(descValue).toBeDefined();
            expect(descValue?.closest('a')).toBeNull();

            // Hidden fields ignored
            expect(screen.queryByText('should not show')).toBeNull();
        });
    });

    describe('SimilarResourcesCarousel', () => {
        const mockItems: Resource[] = Array.from({ length: 6 }).map((_, i) => ({
            id: `id-${i}`,
            dct_title_s: `Title ${i}`,
            dct_publisher_sm: ['Pub'],
            gbl_indexYear_im: [2000 + i]
        } as any));

        it('renders carousel with pagination', () => {
            render(<SimilarResourcesCarousel items={mockItems} />);

            // Page 1: Items 0-3
            expect(screen.getByText('Title 0')).toBeDefined();
            expect(screen.getByText('Title 3')).toBeDefined();
            expect(screen.queryByText('Title 4')).toBeNull();

            expect(screen.getByText('Similar Items')).toBeDefined();

            // Pagination controls exist
            const nextBtn = screen.getByLabelText('Next page');
            fireEvent.click(nextBtn);

            // Page 2: Items 4-5
            expect(screen.getByText('Title 4')).toBeDefined();
            expect(screen.queryByText('Title 0')).toBeNull();

            // Prev
            const prevBtn = screen.getByLabelText('Previous page');
            fireEvent.click(prevBtn);
            expect(screen.getByText('Title 0')).toBeDefined();
        });

        it('renders nothing if empty', () => {
            const { container } = render(<SimilarResourcesCarousel items={[]} />);
            expect(container).toBeEmptyDOMElement();
        });
    });
});
