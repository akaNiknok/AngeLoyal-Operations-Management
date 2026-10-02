            // ══════════════════════════════════════════════════════════
            //  BILLING PANEL
            //  One row per billable waybill over a date range, priced
            //  from the rate matrix. Mirrors the Rebisco billing output.
            // ══════════════════════════════════════════════════════════

            let billingLines = [];
            let billingTotals = null;
            let billingChargeCols = []; // the active manual money columns
            // The visible order, held apart from the data. Rows sort by waybill
            // once per load and stay put after that: a re-render on every edit
            // would otherwise make a row jump out from under the cursor.
            let billingOrder = [];
            let billingSelected = new Set();
            // The last line ticked by hand: a shift-click ticks from here.
            let billingTickAnchor = null;
            // The status chip in force; a key of BILLING_STATUS_CHIPS.
            let billingStatus = "unbilled";
            // Lines whose "how it was built" row is open.
            let billingExpanded = new Set();
            // The document in the preview: a draft, a billing about to be
            // stamped, or a submitted billing read back from the server.
            let billingDoc = null;
            // id -> line, rebuilt only when a load replaces billingLines. An
            // edit assigns into the line objects the map already points at, so
            // it stays true between loads.
            let billingById = {};
            let billingByIdOf = null;

            function billingIndex() {
                if (billingByIdOf !== billingLines) {
                    billingByIdOf = billingLines;
                    billingById = indexById(billingLines);
                }
                return billingById;
            }

            const PESO = (n) =>
                Number(n || 0).toLocaleString("en-PH", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                });

            // Numeric-aware, so AY-9 sorts before AY-10.
            const byWaybillNumber = (a, b) =>
                a.waybillNumber.localeCompare(b.waybillNumber, undefined, { numeric: true });

            // ── Panel entry ───────────────────────────────────────────

            function openBilling() {
                const from = document.getElementById("bl-from");
                const to = document.getElementById("bl-to");
                if (!from.value) {
                    const range = billingDefaultRange(new Date());
                    from.value = range.from;
                    to.value = range.to;
                    document.getElementById("bl-preset").value = "this";
                }
                const docDate = document.getElementById("bl-doc-date");
                if (!docDate.value) docDate.value = todayStr();
                populateBillingFilters();
                loadBilling();
            }

            // The current week, which is how the company bills: one
            // submission covers Monday to Saturday.
            function billingDefaultRange(today) {
                const monday = new Date(today);
                monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
                return { from: isoDate(monday), to: isoDate(today) };
            }

            // The range presets. Last week runs Monday to Sunday, as the
            // default week does. The DOE week starts on the Tuesday the
            // current diesel price took effect.
            function billingPresetRange(name, today) {
                const week = billingDefaultRange(today);
                if (name === "this") return week;
                if (name === "doe") return { from: latestTuesdayIso(isoDate(today)), to: isoDate(today) };
                if (name !== "last") return null;
                const monday = new Date(week.from + "T00:00:00");
                monday.setDate(monday.getDate() - 7);
                const sunday = new Date(monday);
                sunday.setDate(monday.getDate() + 6);
                return { from: isoDate(monday), to: isoDate(sunday) };
            }

            function applyBillingPreset(name) {
                const range = billingPresetRange(name, new Date());
                if (!range) return;
                document.getElementById("bl-from").value = range.from;
                document.getElementById("bl-to").value = range.to;
                loadBilling();
            }

            // A date typed by hand no longer matches the preset.
            function billingRangeEdited() {
                document.getElementById("bl-preset").value = "";
                loadBilling();
            }

            // Each select keeps its choice across a refill, so a filter
            // survives a panel switch and a link can preset it.
            function populateBillingFilters() {
                const originSel = document.getElementById("bl-origin");
                const prefixSel = document.getElementById("bl-prefix");
                const keepOrigin = originSel.value;
                const keepPrefix = prefixSel.value;
                originSel.innerHTML =
                    '<option value="">All origins</option>' +
                    (origins || [])
                        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
                        .join("");

                // Subcon = the waybill prefix namespace (AY, GL, …).
                prefixSel.innerHTML =
                    '<option value="">All subcons</option>' +
                    waybillPrefixes
                        .map(
                            (p) =>
                                `<option value="${esc(p.prefix)}">${esc(p.prefix)} — ${esc(p.companyName)}</option>`,
                        )
                        .join("");
                originSel.value = (origins || []).includes(keepOrigin) ? keepOrigin : "";
                prefixSel.value = waybillPrefixes.some((p) => p.prefix === keepPrefix) ? keepPrefix : "";
            }

            function loadBilling() {
                const from = document.getElementById("bl-from").value;
                const to = document.getElementById("bl-to").value;
                if (!from || !to) return;

                setPanelLoading("billing", "Computing billing…");
                call("getBillingLines", isoToMDY(from), isoToMDY(to)).then(
                    (r) => {
                        setPanelLoading("billing", "");
                        if (!r.success) {
                            showToast(r.error, "error");
                            return;
                        }
                        billingLines = r.lines || [];
                        billingTotals = r.totals || null;
                        billingChargeCols = (r.chargeTypes || []).filter(
                            (c) => c.active !== false,
                        );
                        billingOrder = billingLines
                            .slice()
                            .sort(byWaybillNumber)
                            .map((l) => l.id);
                        billingSelected = new Set();
                        billingTickAnchor = null;
                        billingExpanded = new Set();
                        renderBilling();
                    },
                    (e) => {
                        setPanelLoading("billing", "");
                        toastError(e);
                    },
                );
            }

            // ── Filtering ─────────────────────────────────────────────

            // Each chip filters the table to the lines its test passes. A
            // warning on a stamped line needs no action, so it is not counted.
            const BILLING_STATUS_CHIPS = {
                unbilled: ["Not billed", (l) => l.status === "Not Billed"],
                attention: ["Needs attention", (l) => !!l.warning && l.status !== "Billed"],
                deferred: ["Deferred", (l) => l.status === "Deferred"],
                billed: ["Billed", (l) => l.status === "Billed"],
                all: ["All", () => true],
            };

            function setBillingStatus(key) {
                billingStatus = key;
                syncHash();
                renderBilling();
            }

            // The lines in the origin and subcon filters, in order. The chips
            // count these, so a count always matches what a click shows.
            function scopedBillingLines() {
                const origin = document.getElementById("bl-origin").value;
                const prefix = document.getElementById("bl-prefix").value;

                const byId = billingIndex();

                return billingOrder
                    .map((id) => byId[id])
                    .filter((l) => l)
                    .filter((l) => {
                        if (origin && l.origin !== origin) return false;
                        // A prefix matches the leading token of the number,
                        // up to its dash — "G" must not match "GL-0451".
                        if (prefix && !l.waybillNumber.startsWith(prefix + "-")) return false;
                        return true;
                    });
            }

            function visibleBillingLines() {
                return scopedBillingLines().filter(BILLING_STATUS_CHIPS[billingStatus][1]);
            }

            const PESO_SHORT = new Intl.NumberFormat("en-PH", {
                notation: "compact",
                maximumFractionDigits: 1,
            });

            function renderBillingChips() {
                const scoped = scopedBillingLines();
                document.getElementById("bl-chips").innerHTML = Object.entries(BILLING_STATUS_CHIPS)
                    .map(([key, [label, test]]) => {
                        const rows = scoped.filter(test);
                        const amount =
                            key === "unbilled"
                                ? ` · ₱${PESO_SHORT.format(rows.reduce((s, l) => s + Number(l.total || 0), 0))}`
                                : "";
                        const warn = key === "attention" && rows.length ? " bl-chip-warn" : "";
                        return `<button class="pill${key === billingStatus ? " active" : ""}${warn}" onclick="setBillingStatus('${key}')">${label} ${rows.length}${amount}</button>`;
                    })
                    .join("");
            }

            // ── Render ────────────────────────────────────────────────

            function renderBilling() {
                const thead = document.getElementById("billing-thead");
                const tbody = document.getElementById("billing-tbody");
                if (!thead || !tbody) return;

                const rows = visibleBillingLines();
                document.getElementById("bl-count").textContent =
                    `${rows.length} of ${billingLines.length} lines`;

                const allTicked = rows.length > 0 && rows.every((l) => billingSelected.has(l.id));
                thead.innerHTML =
                    `<tr>
  <th style="width:48px"><input type="checkbox" title="Tick every line shown" ${allTicked ? "checked" : ""} onchange="toggleAllBilling(this.checked)"></th>
  <th style="width:80px">Date</th>
  <th style="width:90px">Plate #</th>
  <th style="width:100px">Waybill #</th>
  <th style="width:110px">Freight Order #</th>
  <th style="width:55px">Type</th>
  <th style="width:120px">Area</th>` +
                    billingChargeCols
                        .map((c) => `<th style="width:90px">${esc(c.label)}</th>`)
                        .join("") +
                    `<th style="width:80px">Mano</th>
  <th style="width:90px">3 Drops</th>
  <th style="width:100px">Hauling Rate</th>
  <th style="width:100px">Total</th>
  <th style="width:70px"></th>
</tr>`;

                tbody.innerHTML = rows.map(billingRowHtml).join("");

                renderBillingChips();
                renderBillingFooter(rows);
            }

            // One row of the table. Held apart from renderBilling so a saved
            // edit can replace its own row instead of the whole body.
            function billingRowHtml(l) {
                const locked = l.status === "Billed";
                const money = (field) =>
                    locked
                        ? `<td style="text-align:right;font-family:'DM Mono',monospace">${PESO(l[field])}</td>`
                        : `<td style="text-align:right"><input class="cell-input" style="width:84px;text-align:right"
   data-field="${field}"
   title="${l.overrides.includes(field) ? "Typed over — clear the cell to recompute" : "Computed"}"
   value="${l[field] === 0 ? "" : l[field]}"
   onchange="saveBillingAmount(${l.id},'${field}',this.value)"><span class="bl-ovr" title="Typed over">${l.overrides.includes(field) ? "✎" : ""}</span></td>`;

                const charges = billingChargeCols
                    .map((c) => {
                        const v = l.manualCharges[String(c.id)];
                        return locked
                            ? `<td style="text-align:right;font-family:'DM Mono',monospace">${v ? PESO(v) : "—"}</td>`
                            : `<td style="text-align:right"><input class="cell-input" style="width:76px;text-align:right" data-charge="${c.id}" value="${v === undefined ? "" : v}" onchange="saveBillingCharge(${l.id},${c.id},this.value)"></td>`;
                    })
                    .join("");

                const open = billingExpanded.has(l.id);
                return `<tr data-line="${l.id}"${l.warning ? ' style="background:var(--amber-bg)"' : ""}>
  <td style="white-space:nowrap"><input type="checkbox" title="Shift-click to tick a range" ${billingSelected.has(l.id) ? "checked" : ""} onclick="tickBillingRow(${l.id},this.checked,event.shiftKey)"><button class="bl-caret" title="${open ? "Hide" : "Show"} how this line was priced" onclick="toggleBillingDetail(${l.id})">${open ? "▾" : "▸"}</button></td>
  <td>${esc(l.tripDate)}</td>
  <td>${esc(l.plateNumber) || "—"}</td>
  <td style="font-family:'DM Mono',monospace">${esc(l.waybillNumber)}</td>
  <td style="font-family:'DM Mono',monospace">${esc(l.foNumber) || "—"}</td>
  <td>${esc(l.truckType)}</td>
  <td>${esc(l.area) || "—"}${l.drops > 1 ? ` <span class="tb-label">×${l.drops}</span>` : ""}${l.warning ? `<div class="bl-warn">${esc(l.warning)}</div>` : ""}</td>
  ${charges}
  ${money("mano")}
  ${money("dropFee")}
  ${money("haulingRate")}
  <td class="bl-total" style="text-align:right;font-family:'DM Mono',monospace"><strong>${PESO(l.total)}</strong></td>
  <td>${
      locked
          ? `<span class="tb-label">${esc(l.billingNumber)}</span>`
          : `<button class="btn btn-ghost btn-sm" onclick="toggleBillingDefer(${l.id})">${l.status === "Deferred" ? "Restore" : "Defer"}</button>`
  }</td>
</tr>${open ? billingDetailHtml(l) : ""}`;
            }

            // The row under a line that shows how it was priced: the stops,
            // the rate each one found, and which rule set each amount. The
            // stops and the computed amounts come with getBillingLines, so
            // opening it costs no request.
            function billingDetailHtml(l) {
                const colspan = 12 + billingChargeCols.length;
                const stops = l.stops || [];
                const c = l.computed || {};
                const peso = (n) => (n === null || n === undefined ? "—" : "₱" + PESO(n));
                const top = stops.reduce(
                    (m, s) => (s.rate !== null && (!m || s.rate > m.rate) ? s : m),
                    null,
                );
                const typed = (field) =>
                    l.overrides.includes(field)
                        ? ` <strong>Typed over: ${peso(l[field])}.</strong>`
                        : "";

                const rules = [
                    `<li>Hauling rate: ${
                        top
                            ? `${peso(c.haulingRate)}, the highest rate among the stops (${esc(top.area)}).`
                            : "no stop has a rate in the matrix."
                    }${typed("haulingRate")}</li>`,
                    `<li>Mano: ${
                        c.mano
                            ? `${peso(c.mano)}, one fee for each full 100 cartons at one store.`
                            : "none. No store took 100 cartons or more."
                    }${typed("mano")}</li>`,
                    `<li>Drop fee: ${
                        c.dropFee
                            ? `${peso(c.dropFee)} for ${l.drops} drops.`
                            : `none for ${l.drops} drop${l.drops === 1 ? "" : "s"}.`
                    }${typed("dropFee")}</li>`,
                ];
                if (l.notes) rules.push(`<li>Notes: ${esc(l.notes)}</li>`);

                const meta = [
                    `Billing date ${esc(l.billingDate || l.tripDate)}` +
                        (l.billingDate && l.billingDate !== l.tripDate
                            ? ` (delivered ${esc(l.tripDate)})`
                            : ""),
                    `Diesel ${l.dieselPrice ? "₱" + esc(l.dieselPrice) : "—"}, band ${esc(l.rateBand) || "—"}`,
                    esc(l.origin) || "no origin",
                    esc(l.truckType) || "no type",
                    `${l.cartons || 0} cartons`,
                ].join(" · ");

                const stopRows = stops
                    .map(
                        (s) => `<tr${s === top ? ' class="bl-top"' : ""}>
  <td>${esc(s.outlet) || "—"}</td><td>${esc(s.area) || "—"}</td>
  <td class="n">${s.quantity}</td><td class="n">${peso(s.rate)}${s === top ? " ◂" : ""}</td>
  <td class="n">${s.mano ? peso(s.mano) : "—"}</td>
</tr>`,
                    )
                    .join("");

                return `<tr class="bl-detail" data-detail="${l.id}"><td colspan="${colspan}">
  <div class="bl-detail-meta">${meta} <button class="btn btn-ghost btn-sm" data-title="Waybill ${esc(l.waybillNumber)}" onclick="openHistory('billing_lines', ${l.id}, this.dataset.title)">History</button></div>
  <table class="bl-stops"><thead><tr><th>Outlet</th><th>Area</th><th>Cartons</th><th>Rate</th><th>Mano</th></tr></thead>
  <tbody>${stopRows}</tbody></table>
  <ul class="bl-rules">${rules.join("")}</ul>
</td></tr>`;
            }

            function toggleBillingDetail(lineId) {
                if (billingExpanded.has(lineId)) billingExpanded.delete(lineId);
                else billingExpanded.add(lineId);
                renderBilling();
            }

            // Refreshes what one saved edit changes: the row's own cells and
            // the footer. A full renderBilling() here rebuilds every row on
            // screen and pulls the cell out from under the cursor while the
            // user tabs along the row.
            function patchBillingRow(line) {
                const tr = document.querySelector(
                    `#billing-tbody tr[data-line="${line.id}"]`,
                );
                if (!tr) {
                    renderBilling();
                    return;
                }
                const total = tr.querySelector(".bl-total");
                if (total) total.innerHTML = `<strong>${PESO(line.total)}</strong>`;

                tr.querySelectorAll("input.cell-input").forEach((inp) => {
                    if (inp === document.activeElement) return; // still typing
                    const field = inp.dataset.field;
                    if (field) {
                        inp.value = line[field] === 0 ? "" : line[field];
                        const on = line.overrides.includes(field);
                        inp.title = on
                            ? "Typed over — clear the cell to recompute"
                            : "Computed";
                        const mark = inp.nextElementSibling;
                        if (mark) mark.textContent = on ? "✎" : "";
                        return;
                    }
                    const cid = inp.dataset.charge;
                    if (cid) {
                        const v = line.manualCharges[String(cid)];
                        inp.value = v === undefined ? "" : v;
                    }
                });

                // A typed-over amount changes what the open detail row says.
                if (billingExpanded.has(line.id)) {
                    const detail = document.querySelector(
                        `#billing-tbody tr[data-detail="${line.id}"]`,
                    );
                    if (detail) detail.outerHTML = billingDetailHtml(line);
                }

                renderBillingChips();
                renderBillingFooter(visibleBillingLines());
            }

            // Enter moves to the same cell one row down, as in Excel;
            // Shift+Enter moves up. A stamped row has no input and is skipped.
            // Leaving the cell fires its change, so the move also saves.
            function billingGridKey(e) {
                const inp = e.target;
                if (e.key !== "Enter" || !inp.matches || !inp.matches("input.cell-input")) return;
                const same = inp.dataset.field
                    ? `input[data-field="${inp.dataset.field}"]`
                    : `input[data-charge="${inp.dataset.charge}"]`;
                const rows = Array.from(document.querySelectorAll("#billing-tbody tr[data-line]"));
                const step = e.shiftKey ? -1 : 1;
                for (let i = rows.indexOf(inp.closest("tr")) + step; i >= 0 && i < rows.length; i += step) {
                    const next = rows[i].querySelector(same);
                    if (next) {
                        e.preventDefault();
                        next.focus();
                        next.select();
                        return;
                    }
                }
            }

            // Totals are recomputed from what is on screen so the footer always
            // matches the filter, and are never editable.
            function renderBillingFooter(rows) {
                const sum = (f) => rows.reduce((s, l) => s + Number(f(l) || 0), 0);
                const cell = (n) => `<td style="text-align:right;font-family:'DM Mono',monospace"><strong>${PESO(n)}</strong></td>`;
                // The totals row of the table, as the company workbook has it.
                // It sticks to the bottom of the scroller with the header.
                document.getElementById("billing-tfoot").innerHTML = rows.length
                    ? `<tr><td colspan="7"><strong>Total waybills: ${rows.length}</strong></td>` +
                      billingChargeCols.map((c) => cell(sum((l) => l.manualCharges[String(c.id)]))).join("") +
                      cell(sum((l) => l.mano)) +
                      cell(sum((l) => l.dropFee)) +
                      cell(sum((l) => l.haulingRate)) +
                      cell(sum((l) => l.total)) +
                      `<td></td></tr>`
                    : "";

                const gross = sum((l) => l.total);
                const lessVat = (gross / 1.12) * 0.12;
                const net = gross - lessVat;
                const ewt = net * 0.02;

                document.getElementById("billing-footer").innerHTML = `
<table class="data-table" style="width:420px;margin-left:auto">
  <tbody>
    <tr><td>Total waybills</td><td style="text-align:right">${rows.length}</td></tr>
    <tr><td>Total sales VAT inc</td><td style="text-align:right;font-family:'DM Mono',monospace">${PESO(gross)}</td></tr>
    <tr><td>Less VAT</td><td style="text-align:right;font-family:'DM Mono',monospace">${PESO(lessVat)}</td></tr>
    <tr><td>Amount net of VAT</td><td style="text-align:right;font-family:'DM Mono',monospace">${PESO(net)}</td></tr>
    <tr><td>Add VAT</td><td style="text-align:right;font-family:'DM Mono',monospace">${PESO(net * 0.12)}</td></tr>
    <tr><td>Less withholding tax</td><td style="text-align:right;font-family:'DM Mono',monospace">${PESO(ewt)}</td></tr>
    <tr><td><strong>Total amount due</strong></td><td style="text-align:right;font-family:'DM Mono',monospace"><strong>${PESO(gross - ewt)}</strong></td></tr>
  </tbody>
</table>`;
            }

            // ── Edits ─────────────────────────────────────────────────

            function toggleBillingRow(lineId, on) {
                if (on) billingSelected.add(lineId);
                else billingSelected.delete(lineId);
            }

            function toggleAllBilling(on) {
                visibleBillingLines().forEach((l) => toggleBillingRow(l.id, on));
                renderBilling();
            }

            // A tick by hand. With Shift held, every visible line from the
            // last hand tick to this one takes the same state.
            function tickBillingRow(lineId, on, shift) {
                const ids = visibleBillingLines().map((l) => l.id);
                const a = ids.indexOf(billingTickAnchor);
                const b = ids.indexOf(lineId);
                billingTickAnchor = lineId;
                if (!shift || a < 0 || b < 0) {
                    toggleBillingRow(lineId, on);
                    return;
                }
                ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((id) => toggleBillingRow(id, on));
                renderBilling();
            }

            function saveBillingAmount(lineId, field, value) {
                const line = billingLines.find((l) => l.id === lineId);
                if (!line) return;
                // A cleared cell drops the override and hands the field back to
                // the rate matrix, rather than billing it at zero.
                const next = value.trim() === "" ? null : Number(value);
                if (next !== null && !(next >= 0)) {
                    showToast("Enter an amount of zero or more.", "error");
                    renderBilling();
                    return;
                }

                const old = { value: line[field], overrides: line.overrides.slice(), total: line.total };
                bgSave("saveBillingLine", [lineId, { [field]: next }], {
                    onOk: (r) => {
                        if (r.line) Object.assign(line, r.line);
                        patchBillingRow(line);
                    },
                    revert: () => {
                        line[field] = old.value;
                        line.overrides = old.overrides;
                        line.total = old.total;
                        renderBilling();
                    },
                });
            }

            function saveBillingCharge(lineId, chargeTypeId, value) {
                const line = billingLines.find((l) => l.id === lineId);
                if (!line) return;
                const n = value.trim() === "" ? 0 : Number(value);
                if (!isFinite(n)) {
                    showToast("Enter a number.", "error");
                    renderBilling();
                    return;
                }

                const old = {
                    charges: Object.assign({}, line.manualCharges),
                    total: line.total,
                };

                // Send only this charge; the server merges it. A whole-object
                // send built from local state let a second save in flight
                // erase the first. A zero removes the charge.
                bgSave("saveBillingLine", [lineId, { manualCharges: { [chargeTypeId]: n } }], {
                    onOk: (r) => {
                        if (r.line) Object.assign(line, r.line);
                        patchBillingRow(line);
                    },
                    revert: () => {
                        line.manualCharges = old.charges;
                        line.total = old.total;
                        renderBilling();
                    },
                });
            }

            function toggleBillingDefer(lineId) {
                const line = billingLines.find((l) => l.id === lineId);
                if (!line) return;
                const next = line.status === "Deferred" ? "Not Billed" : "Deferred";
                const old = line.status;
                line.status = next;
                renderBilling();

                bgSave("setBillingLineStatus", [[lineId], next], {
                    revert: () => {
                        line.status = old;
                        renderBilling();
                    },
                });
            }

            // ── Billing documents: preview, stamp, print, .xlsx ──────
            //
            // One document feeds the preview, the print and the workbook:
            // { mode, number, docDate, from, to, lines, cols }, dates ISO.
            //   draft  — the visible lines, no number. Nothing is stamped.
            //   stamp  — the ticked lines about to take the typed number.
            //            It cannot print: a printout always matches a stamp.
            //   billed — a submitted billing, read back exactly as stored.

            // The ticked lines the filter still shows: a tick survives a
            // filter change, and the billing covers only what is visible.
            function tickedBillingLines() {
                return visibleBillingLines().filter((l) => billingSelected.has(l.id));
            }

            function billingToolbarHeader() {
                return {
                    docDate: document.getElementById("bl-doc-date").value,
                    from: document.getElementById("bl-from").value,
                    to: document.getElementById("bl-to").value,
                };
            }

            function openStampPreview() {
                const number = document.getElementById("bl-number").value.trim();
                const lines = tickedBillingLines();
                if (!lines.length) {
                    showToast("Tick the lines this billing covers.", "warning");
                    return;
                }
                if (!number) {
                    showToast("Type the billing number first.", "warning");
                    return;
                }
                showBillingPreview(
                    Object.assign(
                        { mode: "stamp", number, lines, cols: billingChargeCols },
                        billingToolbarHeader(),
                    ),
                );
            }

            function openDraftPreview() {
                const lines = visibleBillingLines();
                if (!lines.length) {
                    showToast("Nothing to preview.", "warning");
                    return;
                }
                showBillingPreview(
                    Object.assign(
                        { mode: "draft", number: "", lines, cols: billingChargeCols },
                        billingToolbarHeader(),
                    ),
                );
            }

            const BILLING_PREVIEW_TEXT = {
                draft: (d) => ["Draft billing", "A draft has no billing number. Tick the lines and stamp them to submit a billing."],
                stamp: (d) => [
                    `Stamp billing ${d.number}`,
                    `${d.lines.length} line(s) take billing ${d.number} and stop recomputing. Check the page, then stamp it.`,
                ],
                billed: (d) => [`Billing ${d.number}`, "This is the billing exactly as it was stamped."],
            };

            function showBillingPreview(doc) {
                billingDoc = doc;
                const [title, hint] = BILLING_PREVIEW_TEXT[doc.mode](doc);
                document.getElementById("bl-preview-title").textContent = title;
                document.getElementById("bl-preview-hint").textContent = hint;

                const show = (id, on) => (document.getElementById(id).style.display = on ? "" : "none");
                show("bl-preview-stamp", doc.mode === "stamp");
                show("bl-preview-reopen", doc.mode === "billed");
                show("bl-preview-xlsx", doc.mode !== "stamp");
                show("bl-preview-print", doc.mode !== "stamp");

                // A blank frame written in place, as printHtmlDocument does:
                // the CSP lets the OMS frame nothing but the Google sign-in.
                const d = document.getElementById("bl-preview-frame").contentDocument;
                if (d && d.open) {
                    d.open();
                    d.write(billingDocHtml(doc));
                    d.close();
                }
                openModal("modal-billing-preview");
            }

            // Stamps, then prints what the server now holds under that number.
            // A number already in use adds these lines to it, so the printout
            // reads the whole billing back instead of trusting the ticks.
            function confirmStampAndPrint() {
                const doc = billingDoc;
                if (!doc || doc.mode !== "stamp") return;
                return call("setBillingNumber", doc.lines.map((l) => l.id), doc.number, {
                    docDate: isoToMDY(doc.docDate),
                    from: isoToMDY(doc.from),
                    to: isoToMDY(doc.to),
                }).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    showToast(`Billing ${doc.number} stamped on ${r.updated} line(s).`, "success");
                    document.getElementById("bl-number").value = "";
                    loadBilling();
                    return openSavedBilling(r.billingId, true);
                }, toastError);
            }

            function openBillingsList() {
                call("getBillings").then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    document.getElementById("bl-list-body").innerHTML = r.billings.length
                        ? r.billings
                              .map(
                                  (b) => `<tr>
  <td style="font-family:'DM Mono',monospace">${esc(b.billingNumber)}</td>
  <td>${esc(b.from)} – ${esc(b.to)}</td>
  <td>${esc(b.docDate) || "—"}</td>
  <td style="text-align:right">${b.lineCount}</td>
  <td style="text-align:right;font-family:'DM Mono',monospace">${PESO(b.total)}</td>
  <td>${esc(b.stampedBy)}<div class="tb-label">${esc(b.stampedAt)}</div></td>
  <td><button class="btn btn-ghost btn-sm" onclick="openSavedBilling(${b.id})">Open</button></td>
</tr>`,
                              )
                              .join("")
                        : `<tr><td colspan="7" style="text-align:center;color:var(--hint)">No billing is stamped yet.</td></tr>`;
                    openModal("modal-billings");
                }, toastError);
            }

            function openSavedBilling(billingId, print) {
                return call("getBilling", billingId).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    const b = r.billing;
                    const lines = r.lines.slice().sort(byWaybillNumber);
                    closeModal("modal-billings");
                    showBillingPreview({
                        mode: "billed",
                        number: b.billingNumber,
                        docDate: mdyToIso(b.docDate),
                        from: mdyToIso(b.from),
                        to: mdyToIso(b.to),
                        lines,
                        // A retired charge type still prints where these
                        // lines carry an amount for it.
                        cols: (r.chargeTypes || []).filter(
                            (c) =>
                                c.active !== false ||
                                lines.some((l) => l.manualCharges[String(c.id)]),
                        ),
                    });
                    if (print) printBillingDoc();
                }, toastError);
            }

            function reopenSavedBilling() {
                const doc = billingDoc;
                if (!doc || doc.mode !== "billed") return;
                if (
                    !confirm(
                        `Reopen billing ${doc.number}? Its ${doc.lines.length} line(s) lose the number and recompute again.`,
                    )
                )
                    return;
                call("setBillingNumber", doc.lines.map((l) => l.id), "").then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    showToast(`Billing ${doc.number} is reopened.`, "success");
                    closeModal("modal-billing-preview");
                    loadBilling();
                }, toastError);
            }

            function printBillingDoc() {
                if (billingDoc) printHtmlDocument(billingDocHtml(billingDoc));
            }

            const BILLING_MONTHS = [
                "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
                "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
            ];

            // The line the paper billing carries under the billing number, e.g.
            // "BILLING JULY 2 - 6, 2026". A range that crosses a month or a
            // year spells both ends out rather than collapsing them.
            function billingRangeLabel(fromIso, toIso) {
                if (!fromIso || !toIso) return "";
                const a = new Date(fromIso + "T00:00:00");
                const b = new Date(toIso + "T00:00:00");
                const mo = (d) => BILLING_MONTHS[d.getMonth()];

                if (a.getFullYear() !== b.getFullYear()) {
                    return `BILLING ${mo(a)} ${a.getDate()}, ${a.getFullYear()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`;
                }
                if (a.getMonth() !== b.getMonth()) {
                    return `BILLING ${mo(a)} ${a.getDate()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`;
                }
                return `BILLING ${mo(a)} ${a.getDate()} - ${b.getDate()}, ${b.getFullYear()}`;
            }

            // The letterhead the paper billing prints, lifted from the company's
            // own format workbook. Resolved against the page URL because the
            // print document lives in an about:blank iframe.
            function billingLetterheadUrl() {
                return new URL("assets/billing-letterhead.png", location.href).href;
            }

            // The print document for a billing: the Rebisco paper format. The
            // preview shows this same page, and the browser's Print dialog
            // makes the PDF.
            function billingDocHtml(doc) {
                const rows = doc.lines;
                const cols = doc.cols;
                const gross = rows.reduce((s, l) => s + Number(l.total || 0), 0);
                const lessVat = (gross / 1.12) * 0.12;
                const net = gross - lessVat;
                const ewt = net * 0.02;
                const num = doc.mode === "draft" ? "" : doc.number;

                const head =
                    `<th>DATE</th><th>PLATE #</th><th>WAYBILL #</th><th>FREIGHT ORDER #</th>
   <th>TRUCK TYPE</th><th>AREA</th>` +
                    cols.map((c) => `<th>${esc(c.label)}</th>`).join("") +
                    `<th>MANO</th><th>ADDITIONAL 500 PER 3 DROPS</th><th>HAULING RATE</th><th>TOTAL</th>`;

                const body = rows
                    .map((l) => {
                        const charges = cols
                            .map((c) => {
                                const v = l.manualCharges[String(c.id)];
                                return `<td class="n">${v ? PESO(v) : ""}</td>`;
                            })
                            .join("");
                        return `<tr>
  <td>${esc(l.tripDate)}</td><td>${esc(l.plateNumber)}</td>
  <td>${esc(l.waybillNumber)}</td><td>${esc(l.foNumber)}</td>
  <td>${esc(l.truckType)}</td><td>${esc(l.area)}</td>
  ${charges}
  <td class="n">${l.mano ? PESO(l.mano) : ""}</td>
  <td class="n">${l.dropFee ? PESO(l.dropFee) : ""}</td>
  <td class="n">${l.haulingRate ? PESO(l.haulingRate) : ""}</td>
  <td class="n">${PESO(l.total)}</td>
</tr>`;
                    })
                    .join("");

                return `<!DOCTYPE html><html><head><title>BILLING ${esc(num || "DRAFT")}</title>
  <style>${PRINT_BASE_CSS}
    .n { text-align: right; font-variant-numeric: tabular-nums; }
    .head { display: flex; align-items: flex-start; gap: 20px; margin-bottom: 8px; }
    .head img { height: 52px; }
    .head-meta { margin-left: auto; text-align: right; line-height: 1.6; }
    .head-meta .k { color: #555; }
    .head-meta .range { font-weight: bold; }
    .draft { color: #b45309; font-weight: bold; }
    .totals { width: 300px; margin-left: auto; margin-top: 10px; }
    .totals td { border: none; padding: 1px 4px; }
    .totals .n { border-top: 1px solid #999; }
    .foot { display: flex; align-items: flex-start; gap: 40px; margin-top: 10px; }
    .wb-total { font-weight: bold; white-space: nowrap; }
    .sign { margin-top: 24px; display: flex; gap: 60px; }
    .sign .name { border-bottom: 1px solid #333; padding-top: 14px; width: 220px; text-align: center; font-weight: bold; }
  </style></head><body>
  <div class="head">
    <img src="${billingLetterheadUrl()}" alt="ANGELOYAL">
    <div class="head-meta">
      <div><span class="k">BILLING #</span> ${num ? esc(num) : '<span class="draft">DRAFT, NOT STAMPED</span>'}</div>
      <div><span class="k">DATE:</span> ${esc(isoToMDY(doc.docDate)) || "__________"}</div>
      <div class="range">${esc(billingRangeLabel(doc.from, doc.to))}</div>
    </div>
  </div>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  <div class="foot">
    <div>
      <div class="wb-total">TOTAL WAYBILLS: ${rows.length}</div>
      <div class="sign">
        <div><div>RECEIVED BY:</div><div class="name">&nbsp;</div></div>
        <div><div>APPROVED BY:</div><div class="name">ANGELO DYNALD S. MEDINA</div></div>
      </div>
    </div>
    <table class="totals"><tbody>
      <tr><td>TOTAL SALES VAT INC :</td><td class="n">${PESO(gross)}</td></tr>
      <tr><td>LESS VAT :</td><td class="n" style="border:none">${PESO(lessVat)}</td></tr>
      <tr><td>AMOUNT NET OF VAT :</td><td class="n" style="border:none">${PESO(net)}</td></tr>
      <tr><td>ADD VAT :</td><td class="n" style="border:none">${PESO(net * 0.12)}</td></tr>
      <tr><td>LESS WITH HOLDING TAX :</td><td class="n" style="border:none">${PESO(ewt)}</td></tr>
      <tr><td><strong>TOTAL AMOUNT DUE :</strong></td><td class="n"><strong>${PESO(gross - ewt)}</strong></td></tr>
    </tbody></table>
  </div>
  </body></html>`;
            }

            // ── .xlsx in the company's TRIPS BILLING workbook layout ──

            const XLSX_MONEY = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';
            const XLSX_PESO = '_-[$₱-3409]* #,##0.00_-;\\-[$₱-3409]* #,##0.00_-;_-[$₱-3409]* "-"??_-;_-@_-';

            // A date cell. ExcelJS writes a Date as UTC, and local midnight in
            // Manila is 16:00 the day before in UTC — Excel would show the
            // wrong day. Build the date at UTC midnight instead.
            function excelDate(mdy) {
                const [m, d, y] = String(mdy || "").split("/").map(Number);
                return y ? new Date(Date.UTC(y, m - 1, d)) : null;
            }

            function billingLetterheadDataUrl() {
                return fetch(billingLetterheadUrl())
                    .then((r) => r.blob())
                    .then(
                        (blob) =>
                            new Promise((resolve) => {
                                const fr = new FileReader();
                                fr.onload = () => resolve(fr.result);
                                fr.onerror = () => resolve(null);
                                fr.readAsDataURL(blob);
                            }),
                    )
                    .catch(() => null); // the sheet is still valid without it
            }

            // Mirrors "01 Billing Output Format.xlsx": the letterhead and the
            // number block on rows 1-3, headers on row 5, lines from row 6,
            // then the totals row and the VAT block. Row totals and footer
            // amounts are live formulas, as in the company's own workbook,
            // with the computed values cached so a viewer shows them at once.
            async function exportBillingXlsx() {
                const doc = billingDoc;
                if (!doc) return;
                if (!excelJsReady) {
                    showToast("Excel writer still loading — retry in a second.", "warning");
                    return;
                }

                const cols = doc.cols;
                const head = [
                    "DATE", "PLATE #", "WAYBILL #", "FREIGHT ORDER #", "TRUCK TYPE", "AREA",
                    ...cols.map((c) => c.label.toUpperCase()),
                    "MANO", "ADDITIONAL 500 PER 3 DROPS", "HAULING RATE", "TOTAL",
                ];
                const FIRST_MONEY = 7; // column G
                const TOTAL = head.length;
                const FIRST_ROW = 6;
                const lastRow = FIRST_ROW + doc.lines.length - 1;

                const wb = new ExcelJS.Workbook();
                const ws = wb.addWorksheet("TRIPS BILLING", {
                    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
                });
                ws.columns = [9, 14, 14, 18, 9, 25, ...cols.map(() => 14), 11, 14, 16, 15].map(
                    (width) => ({ width }),
                );
                const L = (n) => ws.getColumn(n).letter;
                const font = { name: "Cambria", size: 10 };
                const bold = { name: "Cambria", size: 10, bold: true };
                const thin = { style: "thin" };
                const box = { top: thin, left: thin, bottom: thin, right: thin };
                const put = (r, c, value, style) => {
                    const cell = ws.getCell(r, c);
                    cell.value = value;
                    cell.font = font;
                    Object.assign(cell, style || {});
                    return cell;
                };

                const logo = await billingLetterheadDataUrl();
                if (logo) {
                    ws.addImage(wb.addImage({ base64: logo, extension: "png" }), {
                        tl: { col: 0, row: 0 },
                        ext: { width: 330, height: 60 },
                    });
                }
                // The sample's positions, counted back from TOTAL so they
                // hold with any number of charge columns.
                put(1, TOTAL - 4, "BILLING #");
                put(1, TOTAL - 2, doc.mode === "draft" ? "DRAFT, NOT STAMPED" : doc.number, { font: bold });
                ws.mergeCells(1, TOTAL - 2, 1, TOTAL);
                put(2, TOTAL - 3, "DATE:");
                put(2, TOTAL - 2, excelDate(isoToMDY(doc.docDate)), { numFmt: "m/d/yyyy" });
                put(3, TOTAL - 6, billingRangeLabel(doc.from, doc.to), { font: bold });
                ws.mergeCells(3, TOTAL - 6, 3, TOTAL - 3);

                head.forEach((h, i) =>
                    put(5, i + 1, h, {
                        font: bold,
                        border: box,
                        alignment: { wrapText: true, vertical: "middle", horizontal: "center" },
                    }),
                );
                ws.getRow(5).height = 51;

                const sums = {};
                doc.lines.forEach((l, i) => {
                    const r = FIRST_ROW + i;
                    const money = [
                        ...cols.map((c) => Number(l.manualCharges[String(c.id)]) || null),
                        l.mano || null, l.dropFee || null, l.haulingRate || null,
                    ];
                    [excelDate(l.tripDate), l.plateNumber, l.waybillNumber, l.foNumber, l.truckType, l.area]
                        .forEach((v, c) => put(r, c + 1, v, { border: box }));
                    ws.getCell(r, 1).numFmt = "d-mmm";
                    money.forEach((v, k) => {
                        const c = FIRST_MONEY + k;
                        sums[c] = (sums[c] || 0) + (v || 0);
                        put(r, c, v, { border: box, numFmt: XLSX_MONEY });
                    });
                    sums[TOTAL] = (sums[TOTAL] || 0) + Number(l.total || 0);
                    put(r, TOTAL, {
                        formula: `SUM(${L(FIRST_MONEY)}${r}:${L(TOTAL - 1)}${r})`,
                        result: Number(l.total || 0),
                    }, { border: box, numFmt: XLSX_MONEY });
                });

                const tr = lastRow + 1;
                put(tr, 2, "TOTAL WAYBILLS: ", { font: bold });
                put(tr, 4, { formula: `COUNTA(C${FIRST_ROW}:C${lastRow})`, result: doc.lines.length }, { font: bold });
                for (let c = FIRST_MONEY; c <= TOTAL; c++) {
                    put(tr, c, {
                        formula: `SUM(${L(c)}${FIRST_ROW}:${L(c)}${lastRow})`,
                        result: sums[c] || 0,
                    }, { font: bold, numFmt: XLSX_MONEY });
                }

                const gross = sums[TOTAL] || 0;
                const lessVat = (gross / 1.12) * 0.12;
                const net = gross - lessVat;
                const M = L(TOTAL);
                const f = tr + 3;
                [
                    ["TOTAL SALES VAT INC :", `${M}${tr}`, gross],
                    ["LESS VAT :", `(${M}${f}/1.12)*12%`, lessVat],
                    ["AMOUNT NET OF VAT :", `${M}${f}-${M}${f + 1}`, net],
                    ["ADD VAT :", `${M}${f + 2}*12%`, net * 0.12],
                    ["LESS WITH HOLDING TAX :", `${M}${f + 2}*2%`, net * 0.02],
                    ["TOTAL AMOUNT DUE :", `${M}${f}-${M}${f + 4}`, gross - net * 0.02],
                ].forEach(([label, formula, result], i) => {
                    put(f + i, TOTAL - 2, label, { font: bold });
                    put(f + i, TOTAL, { formula, result }, { font: bold, numFmt: XLSX_PESO });
                });
                put(f, 1, "RECEIVED BY:");
                put(f + 3, 1, "APPROVED BY:");
                put(f + 4, 3, "ANGELO DYNALD S. MEDINA");

                const name = doc.mode === "draft" ? "DRAFT" : doc.number.replace(/[\\/:*?"<>|]/g, "-");
                saveBuffer(await wb.xlsx.writeBuffer(), `BILLING ${name} (${doc.from} to ${doc.to}).xlsx`);
            }
