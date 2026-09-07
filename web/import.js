            // ── IMPORT ────────────────────────────────────────────────
            // { headerIdx, typeCols } from the last parseRebiscoFile run —
            // parseConvoyFills needs them to scope the fill scan.
            let importParseMeta = null;

            function handleDragOver(e) {
                e.preventDefault();
                document.getElementById("drop-zone").classList.add("drag-over");
            }
            function handleDragLeave() {
                document
                    .getElementById("drop-zone")
                    .classList.remove("drag-over");
            }
            function handleDrop(e) {
                e.preventDefault();
                handleDragLeave();
                const f = e.dataTransfer.files[0];
                if (f) processFile(f);
            }
            function handleFileSelect(e) {
                const f = e.target.files[0];
                if (f) processFile(f);
            }

            async function processFile(file) {
                if (!excelJsReady || !window.ExcelJS) {
                    showToast(
                        "File parser still loading — try again in a second.",
                        "warning",
                    );
                    return;
                }
                document.getElementById("import-filename").textContent =
                    file.name;
                document.getElementById("import-file-info").style.display = "";

                try {
                    const wb = new ExcelJS.Workbook();
                    await wb.xlsx.load(await file.arrayBuffer());
                    const ws = wb.worksheets[0];
                    importRows = parseRebiscoFile(sheetToGrid(ws));
                    importExcluded = new Set();
                    renderImportPreview();
                    document.getElementById("btn-run-import").disabled =
                        importRows.length === 0;

                    // Convoy detection reads fill colors off the SAME sheet
                    // object — strictly an enhancement, so any failure leaves
                    // the rows on screen with no groups.
                    try {
                        if (
                            importParseMeta &&
                            importParseMeta.typeCols.length &&
                            assignConvoyGroups(
                                parseConvoyFills(ws, importParseMeta),
                            ) > 0
                        )
                            renderImportPreview();
                    } catch (err) {
                        console.warn("Convoy fill parse skipped:", err);
                    }
                } catch (err) {
                    showToast("Could not read file: " + err.message, "error");
                }
            }

            /**
             * One cell's plain value — what it reads as on screen, which is
             * what the parser wants. ExcelJS hands back objects for rich text,
             * hyperlinks and formulas.
             */
            function cellValue(cell) {
                // A formula cell is read through cell.result, NOT value.result:
                // ExcelJS leaves result off the value object when the cached
                // number is 0 (every shared SUM in the route file), and a
                // TOTAL of 0 is load-bearing — it is how Rebisco marks the FOs
                // riding along in a convoy.
                const v = cell.formula !== undefined ? cell.result : cell.value;
                if (v === null || v === undefined) return "";
                if (typeof v !== "object") return v;
                if (v.richText) return v.richText.map((t) => t.text || "").join("");
                if (v.text !== undefined) return v.text; // hyperlink
                if (v.error !== undefined) return ""; // #REF!, #N/A …
                return v; // a date cell — the one object with no plainer reading
            }

            /**
             * ExcelJS worksheet → the 0-indexed array-of-arrays the parser wants:
             * grid[r - 1] is sheet row r, grid[r - 1][c - 1] is column c, gaps are
             * "". A row with no cells stays an empty array, which the parser's
             * blank-row check already skips.
             */
            function sheetToGrid(ws) {
                const grid = Array.from({ length: ws.rowCount }, () => []);
                ws.eachRow({ includeEmpty: true }, (row, r) => {
                    const cells = [];
                    row.eachCell({ includeEmpty: true }, (cell, c) => {
                        cells[c - 1] = cellValue(cell);
                    });
                    for (let i = 0; i < cells.length; i++)
                        if (cells[i] === undefined) cells[i] = "";
                    grid[r - 1] = cells;
                });
                return grid;
            }

            /** Groups truck units (['L300','L300','6W']) back into slots. */
            function slotsFromUnits(units) {
                const out = [];
                units.forEach((t) => {
                    const hit = out.find((s) => s.type === t);
                    if (hit) hit.count++;
                    else out.push({ type: t, count: 1 });
                });
                return out;
            }

            /** "2×L300, 6W" — the preview's Type column. */
            function displayFromSlots(slots) {
                return slots
                    .map((s) => (s.count > 1 ? `${s.count}×${s.type}` : s.type))
                    .join(", ");
            }

            /**
             * Parses the raw Rebisco route file rows into structured trip objects.
             * The Rebisco file has a fixed header row; we find it by looking for "FREIGHT ORDER".
             */
            function parseRebiscoFile(raw) {
                // Find header row
                let headerIdx = -1;
                let headers = [];
                for (let i = 0; i < Math.min(raw.length, 20); i++) {
                    const row = raw[i].map((c) =>
                        String(c).trim().toUpperCase(),
                    );
                    if (
                        row.some(
                            (c) =>
                                c.includes("FREIGHT ORDER") ||
                                c.includes("FO NO"),
                        )
                    ) {
                        headerIdx = i;
                        headers = raw[i].map((c) =>
                            String(c).trim().toUpperCase(),
                        );
                        break;
                    }
                }
                if (headerIdx === -1) {
                    showToast(
                        'Could not find header row (looking for "FREIGHT ORDER" column).',
                        "error",
                    );
                    return [];
                }

                // Column index helpers — tries multiple possible column names
                const col = (...names) => {
                    for (const n of names) {
                        const idx = headers.findIndex((h) => h.includes(n));
                        if (idx !== -1) return idx;
                    }
                    return -1;
                };

                const ciFO = col("FREIGHT ORDER", "FO NO", "FO NUMBER");
                const ciOutlet = col(
                    "OUTLET",
                    "STORE NAME",
                    "DELIVERY POINT",
                    "DESTINATION",
                );
                const ciArea = col("AREA", "PROVINCE", "REGION", "CITY");
                const ciQty = col("QTY", "QUANTITY", "CASES", "CARTONS", "PCS");
                const ciCBM = col("CBM");
                // "Restrictions" is the client's requested vehicle constraint
                // (e.g. "6W"). It is NOT the truck type — that lives in the
                // per-type count columns identified below.
                const ciRestriction = col("RESTRICTION");
                const ciTier = col("TIER");
                const ciAddress = col("ADDRESS", "DELIVERY ADDRESS");
                const ciCustomer = col("CUSTOMER GROUP", "CUSTOMER", "CUST", "CHAIN");

                // Truck-type columns: each is a code (10W, 6WF, 6WC, 4WC,
                // L300…) and the number under it is how many trucks of that
                // type the FO needs. They sit between FREIGHT ORDER and TOTAL.
                const ciTotal = headers.findIndex((h) => h === "TOTAL");
                const typeCols = [];
                const isTypeCode = (h) => /^(\d+\s*W[A-Z]*|L\d{3})$/.test(h);
                if (ciFO >= 0 && ciTotal > ciFO) {
                    for (let c = ciFO + 1; c < ciTotal; c++) {
                        if (headers[c]) typeCols.push({ idx: c, code: headers[c] });
                    }
                } else {
                    headers.forEach((h, c) => {
                        if (isTypeCode(h)) typeCols.push({ idx: c, code: h });
                    });
                }

                importParseMeta = { headerIdx, typeCols };

                const result = [];
                for (let i = headerIdx + 1; i < raw.length; i++) {
                    const row = raw[i];
                    if (
                        !row ||
                        row.every(
                            (c) => c === "" || c === null || c === undefined,
                        )
                    )
                        continue;
                    const fo = String(row[ciFO] ?? "").trim();
                    const outletName = String(row[ciOutlet] ?? "").trim();
                    if (!fo && !outletName) continue;
                    // Dispatcher-worked files stack a second block with a
                    // repeated header row — skip it, it's not a trip.
                    if (/FREIGHT ORDER|FO NO/i.test(fo)) continue;

                    // Truck slots requested on this row, from the type columns.
                    const slots = [];
                    typeCols.forEach((tc) => {
                        const n = Number(row[tc.idx]);
                        if (n > 0) slots.push({ type: tc.code, count: n });
                    });

                    result.push({
                        _rowIdx: i,
                        foNumber: fo,
                        outletName: outletName,
                        area:
                            ciArea >= 0 ? String(row[ciArea] || "").trim() : "",
                        address:
                            ciAddress >= 0
                                ? String(row[ciAddress] || "").trim()
                                : "",
                        quantity:
                            ciQty >= 0 ? Number(row[ciQty]) || null : null,
                        cbm: ciCBM >= 0 ? Number(row[ciCBM]) || null : null,
                        restrictions:
                            ciRestriction >= 0
                                ? String(row[ciRestriction] || "").trim()
                                : "",
                        tier: ciTier >= 0 ? Number(row[ciTier]) || null : null,
                        customer:
                            ciCustomer >= 0
                                ? String(row[ciCustomer] || "").trim()
                                : "",
                        slots: slots,
                        total: ciTotal >= 0 && row[ciTotal] !== "" && row[ciTotal] != null
                            ? Number(row[ciTotal])
                            : null,
                    });
                }

                // Resolve each row's truck type, back-filling blank rows.
                // A blank type row inherits a prior line's type, in order:
                //   1. a prior line with the SAME FO — a continuation stop on
                //      the same truck, so it adds no new truck slot; or
                //   2. if none, the line DIRECTLY ABOVE regardless of FO — in
                //      which case it becomes its own truck slot of that type so
                //      it still gets a truck instead of being left blank.
                const primaryTypeByFO = {};
                let lastRowType = "";
                result.forEach((r) => {
                    if (r.slots.length) {
                        r.displayType = displayFromSlots(r.slots);
                        lastRowType = r.slots[0].type;
                        if (r.foNumber)
                            primaryTypeByFO[r.foNumber] = lastRowType;
                    } else if (r.foNumber && primaryTypeByFO[r.foNumber]) {
                        // same-FO continuation — rides that FO's truck
                        r.displayType = primaryTypeByFO[r.foNumber];
                        lastRowType = primaryTypeByFO[r.foNumber];
                    } else if (r.total === 0) {
                        // TOTAL explicitly says this FO needs no truck of its
                        // own — Rebisco sometimes stacks a whole batch's truck
                        // counts on the batch's first row, leaving TOTAL=0 on
                        // the other FOs sharing that run. Don't fabricate one.
                        r.displayType = "";
                    } else if (lastRowType) {
                        // fallback: copy the line directly above, regardless of
                        // FO, and give this row its own truck slot of that type
                        r.displayType = lastRowType;
                        r.slots = [{ type: lastRowType, count: 1 }];
                        if (r.foNumber)
                            primaryTypeByFO[r.foNumber] = lastRowType;
                    } else {
                        r.displayType = "";
                    }
                });

                // Redistribute convoy slots: when a row asks for more than one
                // truck, Rebisco is sometimes reporting the WHOLE convoy's
                // requirement on that one row (its TOTAL is the convoy total),
                // while the other FO(s) riding along sit right after it with
                // blank type columns and TOTAL=0. Hand each surplus truck to
                // the next such FO in file order instead of piling every
                // truck onto the anchor FO.
                result.forEach((r, i) => {
                    const units = [];
                    (r.slots || []).forEach((s) => {
                        for (let k = 0; k < (s.count || 1); k++)
                            units.push(s.type);
                    });
                    if (units.length <= 1) return;

                    let unitIdx = 1;
                    for (
                        let j = i + 1;
                        j < result.length && unitIdx < units.length;
                        j++
                    ) {
                        const cand = result[j];
                        if (cand.foNumber === r.foNumber) continue; // same-FO stop, not a recipient
                        if (cand.total !== 0) break; // outside this convoy's blank run
                        if (cand.slots && cand.slots.length) break; // already has its own truck
                        cand.slots = [{ type: units[unitIdx], count: 1 }];
                        cand.displayType = units[unitIdx];
                        unitIdx++;
                    }
                    // Anchor keeps its own truck PLUS any surplus that found no
                    // recipient row (short blank run) — assigning the anchor
                    // before placing would silently drop those trucks. The
                    // dispatcher re-seats them on the board; importRouteFile
                    // expands count>1 into one trip per truck.
                    r.slots = slotsFromUnits([units[0], ...units.slice(unitIdx)]);
                    r.displayType = displayFromSlots(r.slots);
                });
                return result;
            }

            /**
             * Reads the fill colors of the truck-type count columns (only —
             * the Customer column reuses the same palette for chain codes)
             * and returns { rawRowIdx: colorKey|null }. Rebisco marks truck
             * batches as contiguous same-color runs (alternating yellow/blue);
             * the color itself carries no meaning, a color CHANGE = new batch.
             */
            function parseConvoyFills(ws, meta) {
                const colorByRow = {};
                for (let r = meta.headerIdx + 2; r <= ws.rowCount; r++) {
                    let key = null;
                    for (const tc of meta.typeCols) {
                        const f = ws.getRow(r).getCell(tc.idx + 1).fill;
                        if (
                            f &&
                            f.type === "pattern" &&
                            f.pattern &&
                            f.pattern !== "none" &&
                            f.fgColor
                        ) {
                            // Key on the whole color object so theme-indexed
                            // fills (no argb) still delimit runs. Skip white.
                            if (
                                f.fgColor.argb === "FFFFFFFF" ||
                                f.fgColor.argb === "00FFFFFF"
                            )
                                continue;
                            key = JSON.stringify(f.fgColor);
                            break;
                        }
                    }
                    colorByRow[r - 1] = key; // 0-based, matching raw[] indexes
                }
                return colorByRow;
            }

            /**
             * Turns color runs into convoy groups on importRows. Contiguous
             * same-color rows form a batch; uncolored rows join the batch of
             * a colored row sharing their FO (Rebisco leaves some rows of a
             * batch unfilled). Only batches needing ≥2 truck slots are
             * convoys — a single truck's multi-drop run isn't. Returns the
             * number of convoy groups assigned (rows get .convoyGroup 1..n).
             */
            function assignConvoyGroups(colorByRow) {
                const batches = [];
                const batchByFO = {};
                let currentBatch = null;
                let prevKey = null;

                importRows.forEach((r) => {
                    delete r.convoyGroup;
                    const key = colorByRow[r._rowIdx] || null;
                    if (key) {
                        if (key !== prevKey || !currentBatch) {
                            currentBatch = { rows: [] };
                            batches.push(currentBatch);
                        }
                        currentBatch.rows.push(r);
                        if (r.foNumber && !batchByFO[r.foNumber])
                            batchByFO[r.foNumber] = currentBatch;
                        prevKey = key;
                    } else {
                        currentBatch = null;
                        prevKey = null;
                    }
                });
                // Second pass: uncolored rows fall back to FO grouping.
                importRows.forEach((r) => {
                    if (colorByRow[r._rowIdx]) return;
                    const b = r.foNumber && batchByFO[r.foNumber];
                    if (b) b.rows.push(r);
                });

                let n = 0;
                batches.forEach((b) => {
                    const slotCount = b.rows.reduce(
                        (sum, r) =>
                            sum +
                            (r.slots || []).reduce(
                                (x, s) => x + (s.count || 1),
                                0,
                            ),
                        0,
                    );
                    if (slotCount >= 2) {
                        n += 1;
                        b.rows.forEach((r) => {
                            r.convoyGroup = String(n);
                        });
                    }
                });
                return n;
            }

            /**
             * Drops these rows will become on the board — one per truck, per stop.
             * A file row is not a drop: importRouteFile groups rows by FO, sends the
             * FO’s first truck round every one of its rows, and adds one more drop
             * for each extra truck the FO asks for (a split load, e.g. "2×L300").
             * Mirrors the grouping in importRouteFile (DataWriters.gs) — keep in step.
             */
            function dropCount(rows) {
                const byFO = new Map();
                let drops = 0;
                rows.forEach((r) => {
                    const trucks = (r.slots || []).reduce(
                        (n, s) => n + (s.count || 1),
                        0,
                    );
                    const g = r.foNumber ? byFO.get(r.foNumber) : null;
                    if (g) {
                        g.rows += 1;
                        g.trucks += trucks;
                    } else if (r.foNumber) {
                        byFO.set(r.foNumber, { rows: 1, trucks });
                    } else {
                        drops += Math.max(trucks, 1); // no FO — the row stands alone
                    }
                });
                // Every row of an FO is a stop its first truck makes, and every truck
                // past the first adds one more drop on the FO’s first stop.
                byFO.forEach((g) => {
                    drops += g.rows + Math.max(g.trucks, 1) - 1;
                });
                return drops;
            }

            function renderImportPreview() {
                const toolbar = document.getElementById("preview-toolbar");
                const wrap = document.getElementById("import-preview-table");

                if (importRows.length === 0) {
                    toolbar.style.display = "none";
                    wrap.innerHTML = `<div class="empty-import"><div style="font-size:28px">⚠</div><div style="font-size:13px;font-weight:500;color:var(--muted)">No data rows found</div><div style="font-size:12px;color:var(--hint);text-align:center">Check that the file has a "FREIGHT ORDER" column header.</div></div>`;
                    return;
                }

                toolbar.style.display = "";
                const included = importRows.length - importExcluded.size;
                const drops = dropCount(
                    importRows.filter((_, i) => !importExcluded.has(i)),
                );
                document.getElementById("preview-count").innerHTML =
                    `<strong>${included}</strong> of ${importRows.length} rows will be imported` +
                    (drops === included
                        ? ""
                        : ` &rarr; <strong>${drops}</strong> drops`);

                wrap.innerHTML = `
    <table class="preview-table">
      <thead><tr>
        <th style="width:100px">FO #</th>
        <th style="width:190px">Outlet</th>
        <th style="width:80px">Area</th>
        <th style="width:50px;text-align:right">Qty</th>
        <th style="width:60px">Type</th>
        <th style="width:55px">Restr.</th>
        <th style="width:55px">Convoy</th>
        <th style="width:60px"></th>
      </tr></thead>
      <tbody>
        ${importRows
            .map((r, i) => {
                const exc = importExcluded.has(i);
                return `<tr class="${exc ? "excluded" : ""}">
            <td style="font-family:'DM Mono',monospace;font-size:11px">${esc(r.foNumber) || "—"}</td>
            <td>${esc(r.outletName) || "—"}</td>
            <td style="font-size:11px;color:var(--muted)">${esc(r.area) || "—"}</td>
            <td style="font-family:'DM Mono',monospace;text-align:right">${r.quantity || "—"}</td>
            <td style="font-size:11px;font-weight:500">${esc(r.displayType) || "—"}</td>
            <td style="font-size:11px;color:var(--muted)">${esc(r.restrictions) || "—"}</td>
            <td style="font-family:'DM Mono',monospace;font-size:11px">${r.convoyGroup ? "C" + esc(r.convoyGroup) : ""}</td>
            <td><button class="row-toggle-btn" onclick="toggleRow(${i})">${exc ? "Include" : "Exclude"}</button></td>
          </tr>`;
            })
            .join("")}
      </tbody>
    </table>`;
            }

            function toggleRow(idx) {
                if (importExcluded.has(idx)) importExcluded.delete(idx);
                else importExcluded.add(idx);
                renderImportPreview();
                document.getElementById("btn-run-import").disabled =
                    importRows.length - importExcluded.size === 0;
            }

            function toggleAllRows(include) {
                if (include) importExcluded.clear();
                else importRows.forEach((_, i) => importExcluded.add(i));
                renderImportPreview();
                document.getElementById("btn-run-import").disabled = !include;
            }

            // Fills the origin datalist from the warehouses the rate matrix
            // already carries. It only suggests — the input stays free text so
            // a new warehouse can be imported before anyone seeds its rates.
            function populateOriginOptions() {
                const list = document.getElementById("import-origin-options");
                if (!list) return;
                list.innerHTML = (origins || [])
                    .map((o) => `<option value="${esc(o)}"></option>`)
                    .join("");
            }

            function runImport() {
                if (!canEdit()) {
                    showToast("Your role cannot import trips.", "warning");
                    return;
                }
                const dateVal = document.getElementById("import-date").value;
                if (!dateVal) {
                    showToast("Select a trip date first.", "warning");
                    return;
                }

                const rowsToImport = importRows.filter(
                    (_, i) => !importExcluded.has(i),
                );
                if (rowsToImport.length === 0) {
                    showToast("No rows selected.", "warning");
                    return;
                }

                // One route file is one warehouse. Billing reads the origin back
                // to pick the right sheet of the rate matrix, so a blank one
                // leaves every trip in the file unpriceable.
                const originVal = document
                    .getElementById("import-origin")
                    .value.trim();
                if (!originVal) {
                    showToast(
                        "Enter the origin warehouse — billing needs it to find the rate.",
                        "warning",
                    );
                    return;
                }

                setLoading(`Importing ${rowsToImport.length} rows…`);
                call(
                    "importRouteFile",
                    isoToMDY(dateVal),
                    rowsToImport,
                    originVal,
                ).then(
                    (r) => {
                        hideLoading();
                        if (!r.success) {
                            showToast("Import failed: " + r.errors[0], "error");
                            return;
                        }
                        // Duplicates get their own sentence: "skipped" alone
                        // reads as a parse problem, but a re-import is the
                        // system refusing to write the same route file twice.
                        const dup = r.duplicates || 0;
                        const other = (r.skipped || 0) - dup;
                        const msg =
                            `Imported ${r.imported} drops in Prepping.` +
                            (dup > 0
                                ? ` ${dup} already on this date — not imported again.`
                                : "") +
                            (other > 0 ? ` ${other} skipped.` : "");
                        showToast(msg, r.skipped > 0 ? "warning" : "success");
                        if (r.errors.length)
                            console.warn("Import errors:", r.errors);
                        // Merge outlets the import created — otherwise their
                        // names show blank on the Dispatch board until reload.
                        (r.newOutlets || []).forEach((o) => outlets.push(o));
                        clearImport();
                        // Switch to dispatch for the imported date. Drop that
                        // date's dispatch cache first — the panel switch paints
                        // from cache, which doesn't have the new trips yet.
                        delete dispatchCache[isoToMDY(dateVal)];
                        document.getElementById("dispatch-date").value =
                            dateVal;
                        switchPanel("dispatch");
                    },
                    (e) => {
                        hideLoading();
                        showToast("Import error: " + e.message, "error");
                    },
                );
            }

            function clearImport() {
                importRows = [];
                importExcluded = new Set();
                document.getElementById("file-input").value = "";
                document.getElementById("import-file-info").style.display =
                    "none";
                document.getElementById("btn-run-import").disabled = true;
                document.getElementById("preview-toolbar").style.display =
                    "none";
                document.getElementById("import-preview-table").innerHTML =
                    `<div class="empty-import"><div style="font-size:32px">📤</div><div style="font-size:13px;font-weight:500;color:var(--muted)">No file loaded</div><div style="font-size:12px;text-align:center;max-width:260px;color:var(--hint)">Upload the Rebisco route Excel file to preview and review rows before importing.</div></div>`;
            }
