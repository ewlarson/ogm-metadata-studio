import { describe, it, expect } from 'vitest';
import { gbl1ToAardvark } from './gbl1_to_aardvark';

describe('gbl1ToAardvark', () => {
    it('maps basic fields', () => {
        const input = {
            layer_slug_s: 'harvard-123',
            dc_title_s: 'Map Title',
            dc_description_s: 'A description',
            dc_subject_sm: ['subject1'],
            dct_issued_s: '2020',
            solr_year_i: 2020,
            dc_rights_s: 'Public'
        };

        const result = gbl1ToAardvark(input);

        expect(result.id).toBe('harvard-123');
        expect(result.dct_title_s).toBe('Map Title');
        expect(result.dct_description_sm).toEqual(['A description']);
        expect(result.dct_subject_sm).toEqual(['subject1']);
        expect(result.dct_issued_s).toBe('2020');
        expect(result.gbl_indexYear_im).toEqual([2020]);
        expect(result.dct_accessRights_s).toBe('Public');
        expect(result.gbl_mdVersion_s).toBe('Aardvark');
    });

    it('maps geometry', () => {
        const input = {
            solr_geom: 'ENVELOPE(-180, 180, 90, -90)'
        };
        const result = gbl1ToAardvark(input);
        expect(result.locn_geometry).toBe(input.solr_geom);
        expect(result.dcat_bbox).toBe(input.solr_geom);
    });

    it('infers resource class from layer_geom_type_s', () => {
        expect(gbl1ToAardvark({ layer_geom_type_s: 'Raster' }).gbl_resourceClass_sm).toEqual(['Datasets']);
        expect(gbl1ToAardvark({ layer_geom_type_s: 'Paper Map' }).gbl_resourceClass_sm).toEqual(['Maps']);
        expect(gbl1ToAardvark({ layer_geom_type_s: 'Image' }).gbl_resourceClass_sm).toEqual(['Imagery']);
    });

    it('infers resource class from dc_type_s fallback', () => {
        expect(gbl1ToAardvark({ dc_type_s: 'Dataset' }).gbl_resourceClass_sm).toEqual(['Datasets']);
        expect(gbl1ToAardvark({ dc_type_s: 'PhysicalObject' }).gbl_resourceClass_sm).toEqual(['Maps']);
    });

    it('handles arrays ensuring single/multiple correctly', () => {
        const input = {
            dc_language_s: 'eng',
            dc_language_sm: ['eng', 'fre'],
            dc_identifier_s: 'id-1'
        };
        const result = gbl1ToAardvark(input);

        // Should merge and dedupe
        expect(result.dct_language_sm).toEqual(['eng', 'fre']);
        expect(result.dct_identifier_sm).toEqual(['id-1']);
    });
});
