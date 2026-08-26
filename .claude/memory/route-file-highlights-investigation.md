---
name: route-file-highlights-investigation
description: Findings on detecting xlsx highlight/fill colors in Rebisco route-file import (color-coding is consistent across 10 sample files)
metadata: 
  node_type: memory
  type: project
  originSessionId: 09dfb6a3-247d-4f3d-a2ae-650146b4c268
---

Investigated whether route-file import can group trips based on cell fill colors in the source `.xlsx`. **Update (2026-06-18):** checked 10 sample files in `Sample Files/` — both the raw Rebisco files (`ROUTE MAY 12-16`) and the dispatcher's worked copies (`FINAL ROUTE MAY 12-16`). Color-coding is **consistent and meaningful**; the coloring comes from Rebisco itself (already present in the raw ROUTE files), the dispatcher only extends it.

Two independent color systems, in different columns (so a parser must be column-scoped):

1. **Customer column (col G) = chain code color.** Stable palette across all 10 files, identical between ROUTE and FINAL of the same date. Mapping is many-to-one (not 1:1): PG=green `FF92D050`, SM=blue `FF00B0F0`, WM=yellow `FFFFFF00`, RO **and** SW=pink `FFE5B8B7`, PS **and** ALFA=orange `FFFFC000`. (Informational, not the truck grouping.)

2. **Truck-type count columns (cols R–V: 10W/6WF/6WC/4WC/L300) = truck-batch grouping.** Exactly two colors used everywhere — yellow `FFFFFF00` / blue `FF00B0F0` — as an **alternating run delimiter**: each contiguous same-color run = one truck load. The colors carry no fixed meaning; they just toggle to separate neighbors. A run can span **multiple FOs** (e.g. ROUTE MAY 14 r9-10 = FO …7465+…7466 in one blue run; r17-18 = two FOs in one yellow) — richer than the FO-based grouping shipped in PR #44. Caveat: **some FO rows are left uncolored**, so color can't tag every row; parser needs run/boundary detection (color *change* = new batch) plus a fallback for blank rows, not a value→group map.

**Collision warning:** yellow/blue appear in BOTH systems (WM/SM customer colors == the two batch colors), so only read fills in cols R–V for batching, col G for chain.

Anomalies (rare, ignorable): `FFFF0000` red = one-off PRIORITY/alert tags; FINAL files add many theme-colored scratch annotations in cols Y–AL (dispatcher's own notes — noise). A separate **TIER column (X = 1/2/3)** is another grouping dimension (delivery wave), not color-based.

**Parser limitation lifted (2026-08-26):** SheetJS is gone. `web/import.js` now reads grid *and* fills from one **ExcelJS** load (`sheetToGrid` + `parseConvoyFills`, both in `web/import.js`; ExcelJS is vendored at `web/vendor/exceljs.min.js`). Trap found doing it: ExcelJS drops `result` from a formula cell's `value` when the cached number is 0, so read `cell.result` — the route file's TOTAL is a shared `SUM` that is 0 on every convoy rider.

Implication: color-based truck batching is now viable to implement and would capture multi-FO loads that FO-grouping misses. Import logic lives in `Import.html` (parser) and `importRouteFile` in `DataWriters.gs`. See [[clasp-deploy-setup]] for deploy.
