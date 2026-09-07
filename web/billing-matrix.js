            // ══════════════════════════════════════════════════════════
            //  BILLING MATRIX PANEL
            //  The DOE freight rate matrix, one origin warehouse at a
            //  time, plus the weekly diesel price history it indexes on.
            // ══════════════════════════════════════════════════════════

            // The 25 diesel price bands, mirrored from _fuelBandLabel() in
            // Internals.gs. Both sides must name a band the same way or a
            // rate edit writes to a column the server does not know.
            const FUEL_BANDS = Array.from(
                { length: 25 },
                (_, i) => `${30 + 5 * i}.01-${35 + 5 * i}`,
            );

            let rateMatrix = []; // rows for the selected origin
            let fuelPrices = [];
            let seedRatesParsed = null; // { sheets: [{ name, rows }] }

            function bandIndexForPrice(price) {
                const p = Number(price);
                if (!isFinite(p)) return 1;
                return Math.min(Math.max(Math.ceil((p - 30) / 5), 1), 25);
            }

            function bandLabelForPrice(price) {
                return FUEL_BANDS[bandIndexForPrice(price) - 1];
            }

            // ── Panel entry ───────────────────────────────────────────

            function openBillingMatrix() {
                const sel = document.getElementById("bm-origin");
                const keep = sel.value;
                sel.innerHTML = (origins || [])
                    .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
                    .join("");
                if (keep && origins.includes(keep)) sel.value = keep;

                refreshFuelPrices();
                if (sel.value) loadRateMatrix();
                else renderRateMatrix();
            }

            function refreshFuelPrices() {
                call("getFuelPrices").then((list) => {
                    fuelPrices = list || [];
                    renderFuelPrices();
                    renderRateMatrix(); // the band hint depends on the price
                }, toastError);
            }

            function loadRateMatrix() {
                const origin = document.getElementById("bm-origin").value;
                if (!origin) {
                    rateMatrix = [];
                    renderRateMatrix();
                    return;
                }
                setLoading("Loading rates…");
                call("getFreightRates", origin).then((list) => {
                    hideLoading();
                    rateMatrix = list || [];
                    populateEffectiveDates();
                    renderRateMatrix();
                }, (e) => {
                    hideLoading();
                    toastError(e);
                });
            }

            function populateEffectiveDates() {
                const sel = document.getElementById("bm-effective");
                const keep = sel.value;
                const dates = [...new Set(rateMatrix.map((r) => r.effectiveDate))]
                    .filter(Boolean)
                    .sort((a, b) => new Date(b) - new Date(a));
                sel.innerHTML = dates
                    .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
                    .join("");
                if (keep && dates.includes(keep)) sel.value = keep;
            }

            // ── Fuel prices ───────────────────────────────────────────

            function renderFuelPrices() {
                const tbody = document.getElementById("fuel-prices-tbody");
                if (!tbody) return;
                tbody.innerHTML = fuelPrices
                    .map(
                        (p) => `<tr>
  <td>${esc(p.effectiveDate)}</td>
  <td style="font-family:'DM Mono',monospace">${Number(p.dieselPrice).toFixed(2)}</td>
  <td style="font-family:'DM Mono',monospace;color:var(--muted)">${esc(bandLabelForPrice(p.dieselPrice))}</td>
  <td>${esc(p.sourceNote) || "—"}</td>
  <td style="color:var(--muted);font-size:11px">${esc(p.addedBy)}</td>
</tr>`,
                    )
                    .join("");
            }

            function submitFuelPrice() {
                const dateVal = document.getElementById("fp-date").value;
                const priceVal = document.getElementById("fp-price").value;
                if (!dateVal) {
                    showToast("Pick the date the price takes effect.", "warning");
                    return;
                }
                if (!(Number(priceVal) > 0)) {
                    showToast("Enter the diesel price.", "warning");
                    return;
                }

                call("addFuelPrice", {
                    effectiveDate: isoToMDY(dateVal),
                    dieselPrice: Number(priceVal),
                    sourceNote: document.getElementById("fp-note").value.trim(),
                }).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    fuelPrices.unshift(r.fuelPrice);
                    fuelPrices.sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
                    document.getElementById("fp-price").value = "";
                    document.getElementById("fp-note").value = "";
                    renderFuelPrices();
                    renderRateMatrix();
                    showToast(
                        `Price saved — band ${r.fuelPrice.band}.`,
                        "success",
                    );
                }, toastError);
            }

            // ── Rate matrix ───────────────────────────────────────────

            function renderRateMatrix() {
                const thead = document.getElementById("rate-matrix-thead");
                const tbody = document.getElementById("rate-matrix-tbody");
                if (!thead || !tbody) return;

                const effective = document.getElementById("bm-effective").value;
                const search = document
                    .getElementById("bm-search")
                    .value.trim()
                    .toUpperCase();
                const isAdmin = currentUser.role === "Admin";

                // The band the newest price lands in, highlighted so the column
                // in use is obvious in a 25-column table.
                const liveBand = fuelPrices.length
                    ? bandLabelForPrice(fuelPrices[0].dieselPrice)
                    : "";
                document.getElementById("bm-band-hint").textContent = liveBand
                    ? `Current band ${liveBand}`
                    : "No diesel price recorded yet";

                const rows = rateMatrix
                    .filter((r) => !effective || r.effectiveDate === effective)
                    .filter((r) => !search || r.area.toUpperCase().includes(search));

                document.getElementById("bm-count").textContent =
                    `${rows.length} rates`;

                thead.innerHTML =
                    `<tr><th style="width:150px">Area</th><th style="width:60px">Type</th>` +
                    FUEL_BANDS.map(
                        (b) =>
                            `<th style="width:70px${b === liveBand ? ";background:var(--blue-bg)" : ""}">${esc(b)}</th>`,
                    ).join("") +
                    `</tr>`;

                tbody.innerHTML = rows
                    .map((r) => {
                        const cells = FUEL_BANDS.map((b) => {
                            const v = r.bands[b];
                            const shown = v === null || v === undefined ? "" : v;
                            const hl = b === liveBand ? "background:var(--blue-bg)" : "";
                            return isAdmin
                                ? `<td style="${hl}"><input class="cell-input" style="width:64px;text-align:right" value="${esc(shown)}" onchange="saveRateCell(${r.id},'${b}',this.value)"></td>`
                                : `<td style="${hl};text-align:right;font-family:'DM Mono',monospace">${esc(shown) || "—"}</td>`;
                        }).join("");
                        return `<tr><td>${esc(r.area)}</td><td>${esc(r.truckType)}</td>${cells}</tr>`;
                    })
                    .join("");
            }

            function saveRateCell(rateId, band, value) {
                const row = rateMatrix.find((r) => r.id === rateId);
                if (!row) return;
                const old = row.bands[band];
                const next = value.trim() === "" ? null : Number(value);
                if (old === next) return;

                row.bands[band] = next;
                bgSave("updateFreightRate", [rateId, band, value.trim()], {
                    revert: () => {
                        row.bands[band] = old;
                        renderRateMatrix();
                    },
                });
            }

            // ── Seeding from the rates workbook ───────────────────────

            function openSeedRatesModal() {
                seedRatesParsed = null;
                document.getElementById("sr-file").value = "";
                document.getElementById("sr-date").value = todayStr();
                document.getElementById("sr-sheets").innerHTML =
                    '<span class="tb-label">Pick a file first.</span>';
                document.getElementById("sr-submit").disabled = true;
                openModal("modal-seed-rates");
            }

            /**
             * Parses a rates workbook. Every sheet is one origin warehouse and
             * has the same shape: row 3 holds the band midpoints across the
             * columns, and each row from 4 down is an area, a truck type and
             * that row's rate in every band.
             *
             * Midpoints are read rather than the band labels in row 2, because
             * row 2 only labels the first fourteen columns in the source file.
             */
            function parseRatesWorkbook(ws) {
                const midToBand = {};
                for (let c = 4; c <= ws.columnCount; c++) {
                    const mid = Number(cellValue(ws.getRow(3).getCell(c)));
                    if (!isFinite(mid) || mid <= 0) continue;
                    // A column's midpoint sits 2.5 above the band's lower edge.
                    const band = FUEL_BANDS[bandIndexForPrice(mid) - 1];
                    if (band) midToBand[c] = band;
                }

                const rows = [];
                for (let r = 4; r <= ws.rowCount; r++) {
                    const area = String(cellValue(ws.getRow(r).getCell(1)) || "").trim();
                    const type = String(cellValue(ws.getRow(r).getCell(2)) || "").trim();
                    if (!area || !type) continue;

                    const bands = {};
                    let any = false;
                    Object.keys(midToBand).forEach((c) => {
                        const v = Number(cellValue(ws.getRow(r).getCell(Number(c))));
                        if (isFinite(v) && v > 0) {
                            bands[midToBand[c]] = v;
                            any = true;
                        }
                    });
                    if (any) rows.push({ area, truckType: type, bands });
                }
                return rows;
            }

            async function onSeedRatesFile(ev) {
                const file = ev.target.files[0];
                if (!file) return;
                if (!excelJsReady) {
                    showToast("Excel reader still loading — retry in a second.", "warning");
                    return;
                }

                setLoading("Reading rates…");
                try {
                    const wb = new ExcelJS.Workbook();
                    await wb.xlsx.load(await file.arrayBuffer());

                    const sheets = [];
                    wb.eachSheet((ws) => {
                        const rows = parseRatesWorkbook(ws);
                        if (rows.length) sheets.push({ name: ws.name, rows });
                    });
                    hideLoading();

                    if (!sheets.length) {
                        showToast(
                            "No rate rows found — check that row 3 holds the band midpoints.",
                            "error",
                        );
                        return;
                    }

                    seedRatesParsed = { sheets };
                    document.getElementById("sr-sheets").innerHTML = sheets
                        .map(
                            (s, i) =>
                                `<label style="display:flex;align-items:center;gap:6px;padding:2px 0">
  <input type="checkbox" id="sr-sheet-${i}" checked>
  <strong>${esc(s.name)}</strong>
  <span class="tb-label">${s.rows.length} rates</span>
</label>`,
                        )
                        .join("");
                    document.getElementById("sr-submit").disabled = false;
                } catch (e) {
                    hideLoading();
                    showToast("Could not read the file: " + e.message, "error");
                }
            }

            function submitSeedRates() {
                if (!seedRatesParsed) return;
                const dateVal = document.getElementById("sr-date").value;
                if (!dateVal) {
                    showToast("Pick the effective date.", "warning");
                    return;
                }
                const effective = isoToMDY(dateVal);

                const chosen = seedRatesParsed.sheets.filter(
                    (_, i) => document.getElementById("sr-sheet-" + i).checked,
                );
                if (!chosen.length) {
                    showToast("Pick at least one sheet.", "warning");
                    return;
                }

                // One call per origin. They run in series so a failure names
                // the sheet it happened on, and each is a locked writer anyway.
                setLoading("Importing rates…");
                const results = [];
                const next = (i) => {
                    if (i >= chosen.length) {
                        hideLoading();
                        closeModal("modal-seed-rates");
                        showToast(
                            results
                                .map((r) => `${r.origin}: ${r.imported} rates`)
                                .join(", "),
                            "success",
                        );
                        origins = [
                            ...new Set([...origins, ...chosen.map((s) => s.name)]),
                        ].sort();
                        populateOriginOptions();
                        openBillingMatrix();
                        return;
                    }
                    const sheet = chosen[i];
                    call("importFreightRates", sheet.name, effective, sheet.rows).then(
                        (r) => {
                            if (!r.success) {
                                hideLoading();
                                showToast(`${sheet.name}: ${r.error}`, "error");
                                return;
                            }
                            results.push({ origin: sheet.name, imported: r.imported });
                            next(i + 1);
                        },
                        (e) => {
                            hideLoading();
                            showToast(`${sheet.name}: ${e.message}`, "error");
                        },
                    );
                };
                next(0);
            }
