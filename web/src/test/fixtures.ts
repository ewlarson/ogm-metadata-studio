import { AardvarkJson } from "../aardvark/model";

export const FIXTURE_POINT: AardvarkJson = {
    id: "fixture-point-1",
    dct_title_s: "Fixture Point Dataset",
    dct_description_sm: ["A sample point dataset for testing."],
    gbl_resourceClass_sm: ["Datasets"],
    gbl_resourceType_sm: ["Point Data"],
    dcat_theme_sm: ["Transportation"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark",
    dcat_bbox: "ENVELOPE(-88.0, -87.0, 42.0, 41.0)", // W, E, N, S
    dct_references_s: "{\"http://schema.org/downloadUrl\":\"https://example.com/point.zip\"}"
};

export const FIXTURE_POLYGON: AardvarkJson = {
    id: "fixture-polygon-1",
    dct_title_s: "Fixture Polygon Dataset",
    dct_description_sm: ["A sample polygon dataset."],
    gbl_resourceClass_sm: ["Datasets"],
    gbl_resourceType_sm: ["Polygon Data"],
    dcat_theme_sm: ["Boundaries"],
    dct_accessRights_s: "Restricted", // Testing sensitive data
    gbl_mdVersion_s: "Aardvark",
    dcat_bbox: "ENVELOPE(-90.0, -89.0, 43.0, 42.0)",
    gbl_indexYear_im: 2023,
    dct_references_s: "{\"http://www.opengis.net/def/serviceType/ogc/wms\":\"https://example.com/wms\"}"
};

export const FIXTURE_SCANNED_MAP: AardvarkJson = {
    id: "fixture-map-1",
    dct_title_s: "Fixture Scanned Map",
    dct_description_sm: ["Old map from 1900."],
    gbl_resourceClass_sm: ["Maps"],
    gbl_resourceType_sm: ["Scan"],
    dcat_theme_sm: ["History"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark",
    // No bbox to test null handling
    gbl_indexYear_im: 1900,
    dct_references_s: "{\"http://iiif.io/api/image\":\"https://example.com/iiif/info.json\"}"
};

export const FIXTURE_MINIMAL: AardvarkJson = {
    id: "fixture-min-1",
    dct_title_s: "Minimal Record",
    gbl_resourceClass_sm: ["Collections"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark"
};
