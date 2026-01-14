import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ResourceEdit } from './ResourceEdit';
import { Resource } from '../aardvark/model';

describe('ResourceEdit Component', () => {
    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Title',
        dct_accessRights_s: 'Public',
        gbl_mdVersion_s: 'Aardvark',
        gbl_resourceClass_sm: ['Dataset'],
        dct_description_sm: [],
        dct_alternative_sm: [],
        dct_language_sm: [],
        gbl_displayNote_sm: [],
        dct_creator_sm: [],
        dct_publisher_sm: [],
        gbl_resourceType_sm: [],
        dct_subject_sm: [],
        dcat_theme_sm: [],
        dcat_keyword_sm: [],
        dct_temporal_sm: [],
        gbl_dateRange_drsim: [],
        dct_spatial_sm: [],
        dct_identifier_sm: [],
        dct_rights_sm: [],
        dct_rightsHolder_sm: [],
        dct_license_sm: [],
        pcdm_memberOf_sm: [],
        dct_isPartOf_sm: [],
        dct_source_sm: [],
        dct_isVersionOf_sm: [],
        dct_replaces_sm: [],
        dct_isReplacedBy_sm: [],
        dct_relation_sm: [],
        extra: {}
    };

    const mockOnSave = vi.fn();
    const mockOnCancel = vi.fn();

    it('renders initial resource data', () => {
        render(
            <ResourceEdit
                initialResource={mockResource}
                initialDistributions={[]}
                onSave={mockOnSave}
                onCancel={mockOnCancel}
                isSaving={false}
                saveError={null}
            />
        );
        expect(screen.getByDisplayValue('Test Title')).toBeDefined();
        expect(screen.getByDisplayValue('test-1')).toBeDefined();
    });

    it('calls onSave with updated data', async () => {
        render(
            <ResourceEdit
                initialResource={mockResource}
                initialDistributions={[]}
                onSave={mockOnSave}
                onCancel={mockOnCancel}
                isSaving={false}
                saveError={null}
            />
        );

        const titleInput = screen.getByDisplayValue('Test Title');
        fireEvent.change(titleInput, { target: { value: 'New Updated Title' } });

        const saveBtn = screen.getByText('Save Changes');
        fireEvent.click(saveBtn);

        expect(mockOnSave).toHaveBeenCalledWith(
            expect.objectContaining({ dct_title_s: 'New Updated Title' }),
            []
        );
    });

    it('handles tab switching', () => {
        render(
            <ResourceEdit
                initialResource={mockResource}
                initialDistributions={[]}
                onSave={mockOnSave}
                onCancel={mockOnCancel}
                isSaving={false}
                saveError={null}
            />
        );

        const identTab = screen.getByText('Identification');
        fireEvent.click(identTab);

        // Check for fields in identification tab
        expect(screen.getByText('Descriptive')).toBeDefined();
    });

    it('manages distributions', async () => {
        render(
            <ResourceEdit
                initialResource={mockResource}
                initialDistributions={[]}
                onSave={mockOnSave}
                onCancel={mockOnCancel}
                isSaving={false}
                saveError={null}
            />
        );

        // Switch to related tab
        fireEvent.click(screen.getByText('Related'));

        // Add item
        fireEvent.click(screen.getByText('+ Add Item'));
        expect(screen.getByPlaceholderText('https://...')).toBeDefined();

        // Update URL
        const urlInput = screen.getByPlaceholderText('https://...');
        fireEvent.change(urlInput, { target: { value: 'http://foo.com' } });

        // Save
        fireEvent.click(screen.getByText('Save Changes'));

        expect(mockOnSave).toHaveBeenCalledWith(
            expect.anything(),
            expect.arrayContaining([
                expect.objectContaining({ url: 'http://foo.com' })
            ])
        );
    });
});
