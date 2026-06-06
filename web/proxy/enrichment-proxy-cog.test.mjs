import { describe, expect, it } from "vitest";
import {
  bboxFields,
  buildAardvarkForGeospatialPackage,
  buildAardvarkForUpload,
  cogPreviewRenderOptions,
  effectiveBatchDefaults,
  generatedAardvarkResourceId,
  normalizeAardvarkResource,
  normalizeAardvarkFormat,
  rasterThumbnailOutsizeArgs,
  shouldPromoteRasterPackageToImageUpload,
} from "./enrichment-proxy.mjs";

describe("COG preview render options", () => {
  it("bypasses lossy overviews for binary palette rasters", () => {
    const options = cogPreviewRenderOptions({
      bands: [{
        type: "Byte",
        colorInterpretation: "Palette",
        colorTable: {
          entries: [
            [0, 0, 0, 255],
            [255, 255, 255, 255],
          ],
        },
        metadata: {
          "": { LAYER_TYPE: "athematic", STATISTICS_HISTONUMBINS: "2" },
          IMAGE_STRUCTURE: { NBITS: "1" },
        },
      }],
    });

    expect(options).toMatchObject({
      expandPalette: true,
      resampling: "near",
      disableOverviews: true,
      scaleToByte: false,
    });
  });

  it("keeps overviews enabled for RGB rasters", () => {
    const options = cogPreviewRenderOptions({
      bands: [
        { type: "Byte", colorInterpretation: "Red" },
        { type: "Byte", colorInterpretation: "Green" },
        { type: "Byte", colorInterpretation: "Blue" },
      ],
    });

    expect(options).toMatchObject({
      expandPalette: false,
      resampling: "bilinear",
      disableOverviews: false,
      scaleToByte: false,
    });
  });
});

describe("raster thumbnail sizing", () => {
  it("preserves aspect ratio for tall rasters", () => {
    expect(rasterThumbnailOutsizeArgs({ size: [106414, 156018] })).toEqual(["-outsize", "0", "512"]);
  });

  it("preserves aspect ratio for wide rasters", () => {
    expect(rasterThumbnailOutsizeArgs({ size: [156018, 106414] })).toEqual(["-outsize", "512", "0"]);
  });
});

describe("unreferenced raster package promotion", () => {
  it("promotes image-readable raster packages only when GDAL finds no georeference", () => {
    const baseAnalysis = {
      raster: { source: { name: "Reno_1893_rpt1948.tif" } },
      manifest: {
        dataset: { kind: "raster", bbox: null },
        crs: { wkt: "", normalized: "" },
      },
    };

    expect(shouldPromoteRasterPackageToImageUpload(baseAnalysis)).toBe(true);
    expect(shouldPromoteRasterPackageToImageUpload({
      ...baseAnalysis,
      manifest: {
        dataset: { kind: "raster", bbox: { west: -120, south: 39, east: -119, north: 40 } },
        crs: { wkt: "GEOGCS[\"WGS 84\"]", normalized: "GDAL-detected coordinate reference system" },
      },
    })).toBe(false);
    expect(shouldPromoteRasterPackageToImageUpload({
      ...baseAnalysis,
      raster: { source: { name: "atlas.sid" } },
    })).toBe(false);
  });
});

describe("Aardvark metadata generation", () => {
  const artifacts = {
    originalUrl: "https://example.test/original.zip",
    manifestUrl: "https://example.test/manifest.json",
    archivalSupplementUrl: "https://example.test/supplement.md",
    archivalSupplementJsonUrl: "https://example.test/supplement.json",
    aardvarkUrl: "https://example.test/aardvark.json",
    cogUrl: "https://example.test/derivatives/map.cog.tif",
  };

  it("generates configurable prefixed UUID resource IDs", () => {
    expect(effectiveBatchDefaults({}, { metadataIdPrefix: "UW", name: "University of Washington" })).toMatchObject({
      metadataIdPrefix: "uw",
      provider: "University of Washington",
    });
    expect(generatedAardvarkResourceId({ metadataIdPrefix: "UW" })).toMatch(/^uw-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("uses Aardvark spatial strings instead of GeoJSON for extracted bbox fields", () => {
    const fields = bboxFields({
      map_bbox_estimate: {
        west: -120,
        south: 39.5,
        east: -119.5,
        north: 40,
        confidence: 0.97,
      },
    });

    expect(fields.bboxString).toBe("ENVELOPE(-120,-119.5,40,39.5)");
    expect(fields.locnGeometry).toBe("POLYGON((-120 39.5, -119.5 39.5, -119.5 40, -120 40, -120 39.5))");
    expect(fields.centroid).toBe("39.75,-119.75");
  });

  it("maps image MIME types to suggested Aardvark format labels", () => {
    expect(normalizeAardvarkFormat("image/jpeg", { fileName: "scan.jpg" })).toBe("JPEG");
    expect(normalizeAardvarkFormat("", { fileName: "map.tif", contentType: "image/tiff", georeferenced: true })).toBe("GeoTIFF");
  });

  it("builds image upload fallback records with required and controlled fields", () => {
    const { resource } = buildAardvarkForUpload({
      resourceId: "unr-12345678-1234-4234-9234-123456789abc",
      checksum: "abc123",
      fileName: "boulder.png",
      fileSize: 1024,
      contentType: "image/png",
      extraction: {
        description: "",
        placenames: [],
        map_bbox_estimate: {
          west: -115,
          south: 35,
          east: -114,
          north: 36,
          confidence: 0.8,
        },
      },
      batchDefaults: { provider: "University of Nevada, Reno", themes: ["Location", "Not A Theme"] },
      artifacts: {
        originalUrl: "https://example.test/original.png",
        thumbnailUrl: "https://example.test/thumb.jpg",
        iiifInfoUrl: "https://example.test/iiif/info.json",
        extractionUrl: "https://example.test/extraction.json",
        aardvarkUrl: "https://example.test/aardvark.json",
      },
    });

    const normalized = normalizeAardvarkResource({}, resource, {
      resourceId: resource.id,
      checksum: "abc123",
      fileName: "boulder.png",
      contentType: "image/png",
      artifacts: { originalUrl: "https://example.test/original.png" },
      batchDefaults: { provider: "University of Nevada, Reno" },
    });

    expect(normalized.schema_provider_s).toBe("University of Nevada, Reno");
    expect(normalized.dct_format_s).toBe("PNG");
    expect(normalized.dcat_theme_sm).toEqual(["Location"]);
    expect(normalized.locn_geometry).toMatch(/^POLYGON\(\(/);
    expect(normalized.dcat_centroid).toBe("35.5,-114.5");
    expect(normalized.gbl_dateRange_drsim).toBe("");
  });

  it("builds geospatial package records with dataset vocabularies and date range strings", () => {
    const resource = buildAardvarkForGeospatialPackage({
      resourceId: "unr-abcdefab-1234-4234-9234-abcdefabcdef",
      checksum: "checksum",
      fileName: "boulder.zip",
      fileSize: 2048,
      manifest: {
        dataset: {
          kind: "vector",
          baseName: "boulder_city",
          sourceFormat: "ESRI Shapefile",
          geometryType: "Polygon",
          featureCount: 2,
          bbox: { west: -115, south: 35, east: -114, north: 36 },
        },
        temporal: { years: ["1952"], minIso: "1952", maxIso: "1952" },
        spatial: { names: ["Boulder City"] },
        attributes: { stats: {} },
        derivatives: [],
      },
      batchDefaults: { provider: "University of Nevada, Reno" },
      artifacts,
    });

    expect(resource.dct_format_s).toBe("Shapefile");
    expect(resource.gbl_resourceClass_sm).toEqual(["Datasets"]);
    expect(resource.gbl_resourceType_sm).toEqual(["Polygon data"]);
    expect(resource.dcat_theme_sm).toEqual(["Location"]);
    expect(resource.gbl_dateRange_drsim).toBe("[1952 TO 1952]");
    expect(resource.locn_geometry).toBe("POLYGON((-115 35, -114 35, -114 36, -115 36, -115 35))");
    expect(resource.dcat_centroid).toBe("35.5,-114.5");
  });
});
