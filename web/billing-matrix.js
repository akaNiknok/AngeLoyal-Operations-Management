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

            // The DOE posts NCR pump prices on a Monday and each posting runs
            // Tuesday to the following Monday, so an effective date is always a
            // Tuesday. Verified against the DOE's own postings, which are all
            // titled Tuesday-to-Monday ("September 1 to 7 2026").
            const DOE_PRICE_URL =
                "https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices";

            function isTuesdayIso(iso) {
                return !!iso && new Date(iso + "T00:00:00").getDay() === 2;
            }

            /** The Tuesday on or before `iso` (today when omitted), as ISO. */
            function latestTuesdayIso(iso) {
                const d = iso ? new Date(iso + "T00:00:00") : new Date();
                d.setDate(d.getDate() - ((d.getDay() + 5) % 7)); // Tue (2) → 0
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            }

            /** M/d/yyyy → yyyy-mm-dd, the format a date input wants. */
            function mdyToIso(mdy) {
                const [m, d, y] = String(mdy || "").split("/");
                if (!y) return "";
                return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            }

            // ── Panel entry ───────────────────────────────────────────

            function openBillingMatrix() {
                const sel = document.getElementById("bm-origin");
                const keep = sel.value;
                // "All origins" reads the whole matrix and groups it by
                // warehouse — the same area name prices differently per origin,
                // and comparing them side by side is the point.
                sel.innerHTML =
                    '<option value="">All origins</option>' +
                    (origins || [])
                        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
                        .join("");
                sel.value = keep && origins.includes(keep) ? keep : (origins[0] || "");

                const fp = document.getElementById("fp-date");
                if (!fp.value) fp.value = latestTuesdayIso();

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
                setLoading("Loading rates…");
                call("getFreightRates", origin).then((list) => {
                    hideLoading();
                    rateMatrix = list || [];
                    populateEffectiveDates();
                    populateTruckTypes();
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

            function populateTruckTypes() {
                const sel = document.getElementById("bm-type");
                const keep = sel.value;
                const types = [...new Set(rateMatrix.map((r) => r.truckType))]
                    .filter(Boolean)
                    .sort();
                sel.innerHTML =
                    '<option value="">All types</option>' +
                    types
                        .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
                        .join("");
                if (types.includes(keep)) sel.value = keep;
            }

            // ── Fuel prices ───────────────────────────────────────────

            function renderFuelPrices() {
                const tbody = document.getElementById("fuel-prices-tbody");
                if (!tbody) return;
                const canEditRates = currentUser.role === "Admin";

                tbody.innerHTML = fuelPrices
                    .map((p) => {
                        const offCycle = !isTuesdayIso(mdyToIso(p.effectiveDate));
                        return `<tr>
  <td>${esc(p.effectiveDate)}${offCycle ? ' <span class="tb-label" title="The DOE week starts on a Tuesday">not a Tuesday</span>' : ""}</td>
  <td style="font-family:'DM Mono',monospace">${Number(p.dieselPrice).toFixed(2)}</td>
  <td style="font-family:'DM Mono',monospace;color:var(--muted)">${esc(bandLabelForPrice(p.dieselPrice))}</td>
  <td style="color:var(--muted);font-size:11px">${esc(p.addedBy)}</td>
  <td>${
      canEditRates
          ? `<button class="btn btn-ghost btn-sm" onclick="editFuelPrice(${p.id})">Edit</button>
             <button class="btn btn-ghost btn-sm" onclick="removeFuelPrice(${p.id})">Remove</button>`
          : ""
  }</td>
</tr>`;
                    })
                    .join("");

                renderFuelReminder();
            }

            // Warns when the current DOE week has no price yet. A billing dated
            // this week would otherwise silently index on last week's band.
            function renderFuelReminder() {
                const host = document.getElementById("fp-reminder");
                if (!host) return;
                const due = latestTuesdayIso();
                const have = fuelPrices.some(
                    (p) => mdyToIso(p.effectiveDate) === due,
                );
                host.innerHTML = have
                    ? ""
                    : `<div class="settings-section-hint" style="padding:8px 12px;background:var(--amber-bg);border-radius:var(--radius-sm);margin-bottom:8px">
  <strong>No price yet for the week of ${esc(isoToMDY(due))}.</strong>
  The DOE posted it the Monday before. Add it before you bill this week —
  <a href="${DOE_PRICE_URL}" target="_blank" rel="noopener noreferrer">open the DOE NCR posting ↗</a>
</div>`;
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
                // A DOE week always starts on a Tuesday, but a mid-week special
                // adjustment does happen — so confirm rather than refuse.
                if (
                    !isTuesdayIso(dateVal) &&
                    !confirm(
                        `${isoToMDY(dateVal)} is not a Tuesday. A DOE price week runs Tuesday to the following Monday. Save it anyway?`,
                    )
                )
                    return;

                call("addFuelPrice", {
                    effectiveDate: isoToMDY(dateVal),
                    dieselPrice: Number(priceVal),
                }).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    fuelPrices.unshift(r.fuelPrice);
                    sortFuelPrices();
                    document.getElementById("fp-price").value = "";
                    renderFuelPrices();
                    renderRateMatrix();
                    showToast(
                        `Price saved — band ${r.fuelPrice.band}.`,
                        "success",
                    );
                }, toastError);
            }

            function sortFuelPrices() {
                fuelPrices.sort(
                    (a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate),
                );
            }

            function editFuelPrice(priceId) {
                const p = fuelPrices.find((x) => x.id === priceId);
                if (!p) return;

                const dateIn = prompt(
                    "Effective date (M/d/yyyy) — a DOE week starts on a Tuesday",
                    p.effectiveDate,
                );
                if (dateIn === null) return;
                const priceIn = prompt("Diesel price", String(p.dieselPrice));
                if (priceIn === null) return;
                if (!(Number(priceIn) > 0)) {
                    showToast("Enter the diesel price.", "warning");
                    return;
                }

                call("updateFuelPrice", priceId, {
                    effectiveDate: dateIn.trim(),
                    dieselPrice: Number(priceIn),
                }).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    Object.assign(p, r.fuelPrice);
                    sortFuelPrices();
                    renderFuelPrices();
                    renderRateMatrix();
                    showToast(`Price updated — band ${r.fuelPrice.band}.`, "success");
                }, toastError);
            }

            function removeFuelPrice(priceId) {
                const p = fuelPrices.find((x) => x.id === priceId);
                if (!p) return;
                if (
                    !confirm(
                        `Remove the ${Number(p.dieselPrice).toFixed(2)} price effective ${p.effectiveDate}? A billing already stamped with a billing number keeps the rate it was priced at.`,
                    )
                )
                    return;

                call("deleteFuelPrice", priceId).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    fuelPrices = fuelPrices.filter((x) => x.id !== priceId);
                    renderFuelPrices();
                    renderRateMatrix();
                    showToast("Price removed.", "success");
                }, toastError);
            }

            // ── Rate matrix ───────────────────────────────────────────

            function renderRateMatrix() {
                const thead = document.getElementById("rate-matrix-thead");
                const tbody = document.getElementById("rate-matrix-tbody");
                if (!thead || !tbody) return;

                const effective = document.getElementById("bm-effective").value;
                const truckType = document.getElementById("bm-type").value;
                const allOrigins = !document.getElementById("bm-origin").value;
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

                // "Current band only" drops the 24 columns nobody is pricing
                // from today. It is the difference between one screen and six.
                const focus =
                    document.getElementById("bm-focus-band").checked && liveBand;
                const cols = focus ? [liveBand] : FUEL_BANDS;

                const rows = rateMatrix
                    .filter((r) => !effective || r.effectiveDate === effective)
                    .filter((r) => !truckType || r.truckType === truckType)
                    .filter((r) => !search || r.area.toUpperCase().includes(search))
                    .sort(
                        (a, b) =>
                            a.origin.localeCompare(b.origin) ||
                            a.area.localeCompare(b.area) ||
                            a.truckType.localeCompare(b.truckType),
                    );

                document.getElementById("bm-count").textContent =
                    `${rows.length} rates`;

                thead.innerHTML =
                    `<tr><th class="rm-pin" style="width:150px">Area</th><th class="rm-pin rm-pin-2" style="width:60px">Type</th>` +
                    cols
                        .map(
                            (b) =>
                                `<th style="width:70px${b === liveBand ? ";background:var(--blue-bg)" : ""}">${esc(b)}</th>`,
                        )
                        .join("") +
                    `</tr>`;

                // Rows come out grouped: a heading row per origin when the
                // filter is "All origins", and alternating shading per area so
                // one area's truck types read as one block.
                const span = cols.length + 2;
                let lastOrigin = null;
                let lastArea = null;
                let alt = false;

                tbody.innerHTML = rows
                    .map((r) => {
                        let head = "";
                        if (allOrigins && r.origin !== lastOrigin) {
                            lastOrigin = r.origin;
                            lastArea = null;
                            alt = false;
                            head = `<tr class="rm-origin-head"><td colspan="${span}"><span>${esc(r.origin)}</span></td></tr>`;
                        }
                        if (r.area !== lastArea) {
                            lastArea = r.area;
                            alt = !alt;
                        }

                        const cells = cols
                            .map((b) => {
                                const v = r.bands[b];
                                const shown = v === null || v === undefined ? "" : v;
                                const hl =
                                    b === liveBand ? "background:var(--blue-bg)" : "";
                                return isAdmin
                                    ? `<td style="${hl}"><input class="cell-input" style="width:64px;text-align:right" value="${esc(shown)}" onchange="saveRateCell(${r.id},'${b}',this.value)"></td>`
                                    : `<td style="${hl};text-align:right;font-family:'DM Mono',monospace">${esc(shown) || "—"}</td>`;
                            })
                            .join("");

                        return `${head}<tr${alt ? ' class="rm-alt"' : ""}><td class="rm-pin">${esc(r.area)}</td><td class="rm-pin rm-pin-2">${esc(r.truckType)}</td>${cells}</tr>`;
                    })
                    .join("");

                // The Type column pins beside Area, so its offset is the width
                // Area actually rendered at, not the width the markup asked for.
                const table = document.getElementById("rate-matrix-table");
                const first = thead.querySelector("th");
                if (table && first) {
                    table.style.setProperty(
                        "--rm-pin-2-left",
                        first.offsetWidth + "px",
                    );
                }
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
                                `<label>
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
