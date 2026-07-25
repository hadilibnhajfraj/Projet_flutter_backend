# Product Family + Diameter — Project Management

Adds a "Product Family" (Probar / Promesh) and dependent "Diameter" (mm)
notion to the `projects` table, exposed in both list screens
("Project Management" and "Project List"), the create/edit form, filters,
search, and Excel export.

Scope: **"Project" mode only** (`projectModele = 'project'`). Revendeur and
Applicateur projects always have `productFamily = null` and `diameterMm = null`,
the same way `typeProjet` behaves today.

## Data model

Two nullable columns on `projects`:

| Column         | Type                          | Notes                                   |
|----------------|-------------------------------|------------------------------------------|
| `productFamily`| `ENUM('PROBAR','PROMESH')`    | null for Revendeur/Applicateur           |
| `diameterMm`   | `INTEGER`                     | null for Revendeur/Applicateur           |

No label is ever stored as text (no `"Probar Ø12 mm"` string column). The
display label is always computed from `productFamily` + `diameterMm`:

- Backend: `Backend Master/src/constants/productFamily.js`
- Frontend: `Dash Master Toolkit/lib/forms/constants/product_family.dart`
  (`productFamilyLabel()`, `diameterLabel()`, `productFamilyDiameterLabel()`)

### Valid diameters per family

```
PROBAR:  4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32
PROMESH: 4, 5, 6, 8, 10
```

Selecting a Product Family in the form resets the Diameter field if the
previously-selected diameter isn't valid for the new family.

## Migration

`Backend Master/src/migrations/20260727000100-add-product-family-diameter-to-projects.js`

```
node ../node_modules/.bin/sequelize-cli db:migrate
```

Adds `productFamily` (ENUM, nullable), `diameterMm` (INTEGER, nullable), and
an index on `productFamily`. `down()` drops both columns and the enum type
(Postgres enum values themselves cannot be individually dropped).

## Backend changes

| File | Change |
|---|---|
| `src/constants/productFamily.js` (new) | `PRODUCT_FAMILIES`, `DIAMETERS_BY_FAMILY` |
| `src/models/Project.js` | `productFamily`/`diameterMm` fields + index |
| `src/routes/projects.routes.js` (legacy router — actual create/update logic) | `normalizePayload()` coercion, `validatePayload()` cross-field validation (diameter must belong to the selected family, project mode only), `POST /` create payload, `PUT /:id` update whitelist + explicit `Number()` coercion (the generic `clean()` helper stringifies everything otherwise), **`GET /` list filters by `productFamily`/`diameterMm`, and `q` full-text search now also matches `productFamily` and an exact `diameterMm` match when `q` is numeric** |
| `src/modules/projects/repositories/project.repository.js` | `LIST_ATTRIBUTES`, `buildBaseWhere()` filters (used by the Kanban `/projects/pipeline` list) |
| `src/modules/projects/services/project.service.js` | pass-through filters |
| `src/modules/projects/validators/project.validator.js` | Joi validation for `productFamily`/`diameterMm` query params |
| `src/modules/kanban/services/kanban.service.js` | `toProjectCard()` DTO includes both fields |
| `src/modules/projects/controllers/projectExport.controller.js` | Excel export (`/projects/export`) — new "Product Family"/"Diameter (mm)" columns + query filters |

**Important gotcha found during testing:** two routers are both mounted at
`/projects` (`src/modules/projects/routes/project.routes.js` and the legacy
`src/routes/projects.routes.js`). The modular router has no bare `GET /` —
only `GET /pipeline` (Kanban). The plain `GET /projects` list used by *both*
Flutter screens is served by the **legacy** router, so the productFamily/
diameterMm filters and search had to be added there directly (not just in
the modular repository) — otherwise the "Project List" screen's filters
would silently have no effect.

### Validation rules (`validatePayload`, project mode only)

- `productFamily`, if provided, must be `'PROBAR'` or `'PROMESH'`.
- `diameterMm`, if provided, must belong to `DIAMETERS_BY_FAMILY[productFamily]`.
- `diameterMm` without `productFamily` → rejected ("productFamily est requis
  lorsque diameterMm est renseigné").
- Both fields are optional, like `typeProjet`.

## Frontend changes (Flutter)

| File | Change |
|---|---|
| `lib/forms/constants/product_family.dart` (new) | Shared constants/labels, mirrors the backend file |
| `lib/application/users/model/project_grid_data.dart` | `productFamily`/`diameterMm` fields, `diameterLabel`/`productFamilyLabelText` getters, `copyWith()` |
| `lib/forms/controller/project_form_controller.dart` | `Rxn<String> productFamily`, `Rxn<int> diameterMm` — wired into `resetForm()`/`loadProject()` |
| `lib/forms/view/sections/details_section.dart` | Product Family chips + dependent Diameter dropdown, inserted right after "Project Type (optional)" |
| `lib/forms/view/project_form_screen.dart` | `_submit()` payload includes both fields (project mode only) |
| `lib/application/users/view/user_grid_screen.dart` ("Project Management") | Diameter column before "Modèle" (inline-editable dropdown, mirrors the existing Status dropdown's optimistic-update/rollback pattern), Product Family + Diameter filter dropdowns, Excel export columns |
| `lib/application/users/controller/user_grid_controller.dart` | Search now also matches Product Family/Diameter labels; `_mergeFromOld()` now preserves `productFamily`/`diameterMm` (previously would have silently nulled them after certain PUT responses) |
| `lib/forms/view/projects_explorer_screen.dart` ("Project List") | Product Family/Diameter columns (read-only) in the on-screen `DataTable` and in `_kCols`/`_kGetters` (Excel export), Product Family + Diameter filter dropdowns |

### Inline diameter edit (Project Management screen)

Same pattern as the existing Status dropdown: optimistic update on both
`controller.projects` and `controller.filtered`, then
`PUT /projects/:id` with `{'diameterMm': value}` only, with rollback of
both lists on error.

## Tests

`Backend Master/src/scripts/test-product-family-diameter.js` — this repo has
no Jest/Mocha/Supertest setup, so this follows the existing `src/scripts/`
convention (standalone Node scripts run manually) instead of introducing a
new test framework. It drives the real HTTP API of an already-running dev
server with a signed JWT and asserts on the responses; it creates its own
rows and deletes them again (safe to re-run).

```
node src/scripts/test-product-family-diameter.js
```

Requires: the dev server running (`npm run dev`), and a user row for
`TEST_USER_EMAIL` (defaults to `manegerofficecbi@gmail.com`) that isn't
blocked from `/projects` by `moduleAccessGuard.js`.

Covers: create with a valid family/diameter combo (persisted as real
integers, not strings), create with an invalid combo (rejected, HTTP 400),
update to a valid combo, update to an invalid combo (rejected, previous
value untouched), and `GET /projects?productFamily=...` filtering.

Last run: 11/11 assertions passed.

## Manual verification performed

- `flutter analyze` on the full project: 0 errors (only pre-existing
  warnings/infos unrelated to this feature).
- Created a project as Probar → diameter list showed 4–32 → switched to
  Promesh → diameter list narrowed to 4–10 and the previous out-of-range
  diameter was cleared automatically.
- Edited diameter directly from the "Project Management" table (no need to
  open the project) → persisted after reload.
- Product Family / Diameter filters on both list screens.
- Excel export on both screens includes the new columns with correct
  values and colors/column widths for the shifted columns.
