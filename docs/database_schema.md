# Database Schema

The application uses DuckDB-WASM as its client-side database. The database is persisted to IndexedDB but runs in-memory during the session.

## Tables

### `resources`

Stores the scalar (single-value) metadata fields for each resource.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `VARCHAR` | Unique identifier (Primary Key) |
| `dct_title_s` | `VARCHAR` | Title of the resource |
| `dct_accessRights_s` | `VARCHAR` | Access rights (e.g., "Public") |
| `gbl_resourceClass_sm` | `VARCHAR` | *Note*: While mapped as string, this is often treated as list in logic. |
| ... (All other SCALAR_FIELDS) | `VARCHAR` | See `src/aardvark/model.ts` for full list of scalar fields. |
| `geom` | `GEOMETRY` | PostGIS-compatible geometry derived from `dcat_bbox`. Used for spatial search. |
| `embedding` | `FLOAT[]` | Vector embedding of the resource metadata for semantic search. |

**Key Scalar Fields:**
- `dct_format_s`
- `gbl_mdVersion_s`
- `schema_provider_s`
- `dct_issued_s`
- `gbl_indexYear_im`
- `dcat_bbox`
- `locn_geometry`
- `dcat_centroid`
- `gbl_georeferenced_b`
- `gbl_wxsIdentifier_s`
- `gbl_suppressed_b`
- `gbl_fileSize_s`
- `gbl_mdModified_dt`

### `resources_mv`

Stores multivalued fields in a normalized "long" format.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `VARCHAR` | Foreign Key to `resources.id` |
| `field` | `VARCHAR` | Field name (e.g., "dct_subject_sm") |
| `val` | `VARCHAR` | Single value for the field |

**Common Multivalued Fields:**
- `dct_subject_sm`
- `dct_creator_sm`
- `dct_spatial_sm`
- `dcat_keyword_sm`
- `dcat_theme_sm`

### `distributions`

Stores links to external resources (downloads, services, etc.). These are reconstructed into the `dct_references_s` JSON blob for the Aardvark schema.

| Column | Type | Description |
| :--- | :--- | :--- |
| `resource_id` | `VARCHAR` | Foreign Key to `resources.id` |
| `relation_key` | `VARCHAR` | Type of link (e.g., "download", "wms", "iiif") |
| `url` | `VARCHAR` | The URL of the detailed resource |
| `label` | `VARCHAR` | Optional label for the link |

### `resources_image_service`

Stores cached thumbnail images to prevent repeated fetching.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `VARCHAR` | Foreign Key to `resources.id` |
| `data` | `VARCHAR` | Base64 encoded image data |
| `last_updated` | `UBIGINT` | Timestamp (ms) of when the thumbnail was cached |

## Relationships

- `resources.id` is the primary key.
- `resources_mv.id` -> `resources.id` (One-to-Many)
- `distributions.resource_id` -> `resources.id` (One-to-Many)
- `resources_image_service.id` -> `resources.id` (One-to-One)

## Persistence

The database file `records.duckdb` is saved to the browser's IndexedDB under the store `aardvark-duckdb`. On page load, the application attempts to hydrate DuckDB from this file.
