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

            const PESO = (n) =>
                Number(n || 0).toLocaleString("en-PH", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                });

            // ── Panel entry ───────────────────────────────────────────

            function openBilling() {
                const from = document.getElementById("bl-from");
                const to = document.getElementById("bl-to");
                if (!from.value) {
                    // Default to the current week, which is how the company
                    // bills: one submission covers Monday to Saturday.
                    const today = new Date();
                    const monday = new Date(today);
                    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
                    from.value = monday.toISOString().slice(0, 10);
                    to.value = today.toISOString().slice(0, 10);
                }
                const docDate = document.getElementById("bl-doc-date");
                if (!docDate.value) docDate.value = todayStr();
                populateBillingFilters();
                loadBilling();
            }

            function populateBillingFilters() {
                const originSel = document.getElementById("bl-origin");
                originSel.innerHTML =
                    '<option value="">All origins</option>' +
                    (origins || [])
                        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
                        .join("");

                // Subcon = the waybill prefix namespace (AY, GL, …).
                const prefixSel = document.getElementById("bl-prefix");
                prefixSel.innerHTML =
                    '<option value="">All subcons</option>' +
                    waybillPrefixes
                        .map(
                            (p) =>
                                `<option value="${esc(p.prefix)}">${esc(p.prefix)} — ${esc(p.companyName)}</option>`,
                        )
                        .join("");
            }

            function loadBilling() {
                const from = document.getElementById("bl-from").value;
                const to = document.getElementById("bl-to").value;
                if (!from || !to) return;

                setLoading("Computing billing…");
                call("getBillingLines", isoToMDY(from), isoToMDY(to)).then(
                    (r) => {
                        hideLoading();
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
                            .sort((a, b) =>
                                a.waybillNumber.localeCompare(
                                    b.waybillNumber,
                                    undefined,
                                    { numeric: true },
                                ),
                            )
                            .map((l) => l.id);
                        billingSelected = new Set();
                        renderBilling();
                    },
                    (e) => {
                        hideLoading();
                        toastError(e);
                    },
                );
            }

            // ── Filtering ─────────────────────────────────────────────

            function visibleBillingLines() {
                const status = document.getElementById("bl-status").value;
                const origin = document.getElementById("bl-origin").value;
                const prefix = document.getElementById("bl-prefix").value;
                const byId = indexById(billingLines);

                return billingOrder
                    .map((id) => byId[id])
                    .filter((l) => l)
                    .filter((l) => {
                        if (status === "unbilled" && l.status !== "Not Billed") return false;
                        if (status === "billed" && l.status !== "Billed") return false;
                        if (status === "deferred" && l.status !== "Deferred") return false;
                        if (origin && l.origin !== origin) return false;
                        // A prefix matches the leading token of the number.
                        if (prefix && !l.waybillNumber.startsWith(prefix)) return false;
                        return true;
                    });
            }

            // ── Render ────────────────────────────────────────────────

            function renderBilling() {
                const thead = document.getElementById("billing-thead");
                const tbody = document.getElementById("billing-tbody");
                if (!thead || !tbody) return;

                const rows = visibleBillingLines();
                document.getElementById("bl-count").textContent =
                    `${rows.length} of ${billingLines.length} lines`;

                thead.innerHTML =
                    `<tr>
  <th style="width:28px"></th>
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

                tbody.innerHTML = rows
                    .map((l) => {
                        const locked = l.status === "Billed";
                        const money = (field) =>
                            locked
                                ? `<td style="text-align:right;font-family:'DM Mono',monospace">${PESO(l[field])}</td>`
                                : `<td style="text-align:right"><input class="cell-input" style="width:84px;text-align:right"
   title="${l.overrides.includes(field) ? "Typed over — clear the cell to recompute" : "Computed"}"
   value="${l[field] === 0 ? "" : l[field]}"
   onchange="saveBillingAmount(${l.id},'${field}',this.value)">${l.overrides.includes(field) ? '<span title="Typed over">✎</span>' : ""}</td>`;

                        const charges = billingChargeCols
                            .map((c) => {
                                const v = l.manualCharges[String(c.id)];
                                return locked
                                    ? `<td style="text-align:right;font-family:'DM Mono',monospace">${v ? PESO(v) : "—"}</td>`
                                    : `<td style="text-align:right"><input class="cell-input" style="width:76px;text-align:right" value="${v === undefined ? "" : v}" onchange="saveBillingCharge(${l.id},${c.id},this.value)"></td>`;
                            })
                            .join("");

                        return `<tr${l.warning ? ' style="background:var(--amber-bg)"' : ""}>
  <td><input type="checkbox" ${billingSelected.has(l.id) ? "checked" : ""} onchange="toggleBillingRow(${l.id},this.checked)"></td>
  <td>${esc(l.tripDate)}</td>
  <td>${esc(l.plateNumber) || "—"}</td>
  <td style="font-family:'DM Mono',monospace">${esc(l.waybillNumber)}</td>
  <td style="font-family:'DM Mono',monospace">${esc(l.foNumber) || "—"}</td>
  <td>${esc(l.truckType)}</td>
  <td>${esc(l.area) || "—"}${l.drops > 1 ? ` <span class="tb-label">×${l.drops}</span>` : ""}</td>
  ${charges}
  ${money("mano")}
  ${money("dropFee")}
  ${money("haulingRate")}
  <td style="text-align:right;font-family:'DM Mono',monospace"><strong>${PESO(l.total)}</strong></td>
  <td>${
      locked
          ? `<span class="tb-label">${esc(l.billingNumber)}</span>`
          : `<button class="btn btn-ghost btn-sm" onclick="toggleBillingDefer(${l.id})">${l.status === "Deferred" ? "Restore" : "Defer"}</button>`
  }</td>
</tr>`;
                    })
                    .join("");

                renderBillingWarnings(rows);
                renderBillingFooter(rows);
            }

            function renderBillingWarnings(rows) {
                const host = document.getElementById("bl-warnings");
                const flagged = rows.filter((l) => l.warning);
                host.innerHTML = flagged.length
                    ? `<div class="settings-section-hint" style="padding:8px 12px">
  <strong>${flagged.length} line${flagged.length === 1 ? "" : "s"} could not be priced in full:</strong>
  ${flagged.map((l) => `<div>${esc(l.waybillNumber)} — ${esc(l.warning)}</div>`).join("")}
</div>`
                    : "";
            }

            // Totals are recomputed from what is on screen so the footer always
            // matches the filter, and are never editable.
            function renderBillingFooter(rows) {
                const gross = rows.reduce((s, l) => s + Number(l.total || 0), 0);
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
                        renderBilling();
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
                const next = Object.assign({}, line.manualCharges);
                if (n === 0) delete next[String(chargeTypeId)];
                else next[String(chargeTypeId)] = n;

                bgSave("saveBillingLine", [lineId, { manualCharges: next }], {
                    onOk: (r) => {
                        if (r.line) Object.assign(line, r.line);
                        renderBilling();
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

            function stampBillingNumber() {
                const num = document.getElementById("bl-number").value.trim();
                const ids = [...billingSelected];
                if (!ids.length) {
                    showToast("Tick the lines this billing covers.", "warning");
                    return;
                }
                if (
                    !confirm(
                        num
                            ? `Stamp billing ${num} on ${ids.length} line(s)? They stop recomputing after this.`
                            : `Clear the billing number on ${ids.length} line(s)?`,
                    )
                )
                    return;

                call("setBillingNumber", ids, num).then((r) => {
                    if (!r.success) {
                        showToast(r.error, "error");
                        return;
                    }
                    showToast(`${r.updated} line(s) updated.`, "success");
                    loadBilling();
                }, toastError);
            }

            // ── Print / PDF ───────────────────────────────────────────

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

            // Reuses the dispatch print path: a self-contained document in a
            // hidden iframe, and the browser's own Print dialog makes the PDF.
            function printBilling() {
                const rows = visibleBillingLines();
                if (!rows.length) {
                    showToast("Nothing to print.", "warning");
                    return;
                }

                const gross = rows.reduce((s, l) => s + Number(l.total || 0), 0);
                const lessVat = (gross / 1.12) * 0.12;
                const net = gross - lessVat;
                const ewt = net * 0.02;

                const num = document.getElementById("bl-number").value.trim();
                const from = document.getElementById("bl-from").value;
                const to = document.getElementById("bl-to").value;
                const docDate = document.getElementById("bl-doc-date").value;

                const head =
                    `<th>DATE</th><th>PLATE #</th><th>WAYBILL #</th><th>FREIGHT ORDER #</th>
   <th>TRUCK TYPE</th><th>AREA</th>` +
                    billingChargeCols
                        .map((c) => `<th>${esc(c.label)}</th>`)
                        .join("") +
                    `<th>MANO</th><th>ADDITIONAL 500 PER 3 DROPS</th><th>HAULING RATE</th><th>TOTAL</th>`;

                const body = rows
                    .map((l) => {
                        const charges = billingChargeCols
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

                const html = `<!DOCTYPE html><html><head><title>BILLING ${esc(num || from)}</title>
  <style>${PRINT_BASE_CSS}
    .n { text-align: right; font-variant-numeric: tabular-nums; }
    .head { display: flex; align-items: flex-start; gap: 20px; margin-bottom: 8px; }
    .head img { height: 52px; }
    .head-meta { margin-left: auto; text-align: right; line-height: 1.6; }
    .head-meta .k { color: #555; }
    .head-meta .range { font-weight: bold; }
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
      <div><span class="k">BILLING #</span> ${esc(num) || "__________"}</div>
      <div><span class="k">DATE:</span> ${esc(isoToMDY(docDate)) || "__________"}</div>
      <div class="range">${esc(billingRangeLabel(from, to))}</div>
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

                printHtmlDocument(html);
            }
