            // ── EXPORT (dispatch day → FINAL-ROUTE print / xlsx) ──────
            // Client-only: everything needed is already in dispatchData +
            // the master-data caches. The exported layout mirrors the
            // dispatcher-worked "FINAL ROUTE" files (cols B..X + the
            // driver/helper/waybill/plate annotations on load-start rows).

            const EXPORT_TYPE_COLS = ["10W", "6WF", "6WC", "4WC", "L300"];

            function toggleExportMenu(e) {
                e.stopPropagation();
                document
                    .getElementById("export-dropdown")
                    .classList.toggle("open");
            }
            document.addEventListener("click", () => {
                const dd = document.getElementById("export-dropdown");
                if (dd) dd.classList.remove("open");
            });

            // Maps a Truck Billing Category back to one of the route file's
            // type-count columns. Exact name match first, else the first
            // active Route Type Map entry pointing at that category.
            function categoryToTypeCode(cat) {
                if (!cat) return "";
                const CAT = String(cat).toUpperCase();
                if (EXPORT_TYPE_COLS.includes(CAT)) return CAT;
                const m = (routeTypeMap || []).find(
                    (r) =>
                        r.active &&
                        String(r.billingCategory).toUpperCase() === CAT &&
                        EXPORT_TYPE_COLS.includes(
                            String(r.fileTypeCode).toUpperCase(),
                        ),
                );
                return m ? m.fileTypeCode.toUpperCase() : "";
            }

            /**
             * Builds the shared export row model from the loaded day:
             * trips sorted so convoy groups sit adjacent (group → FO →
             * board order), names joined from the master caches, and the
             * first row of each (FO, truck) load marked `loadStart` — the
             * row that carries the driver/helper/waybill/plate annotations.
             */
            function buildFinalRouteModel() {
                // orderedDayTrips (Core.html) is the single source of truth for
                // day order — the board and the export must always agree.
                const trips = orderedDayTrips(
                    (dispatchData && dispatchData.trips) || [],
                );
                const outletMap = indexById(outlets);
                const truckMap = indexById(trucks);
                const empMap = indexById(employees);

                const seenLoad = new Set();
                return trips.map((t) => {
                    // Same load key as the dispatch board (Core.html) — the
                    // export's annotated "load start" rows and the board's
                    // merged cells must mark out the same loads.
                    const loadKey = foKey(t) || "t" + t.id;
                    const loadStart = !seenLoad.has(loadKey);
                    seenLoad.add(loadKey);

                    const outlet = outletMap[t.outletId] || {};
                    const truck = truckMap[t.truckId] || {};
                    const driver = empMap[t.driverId] || {};
                    const helperList = (t.helperIds || [])
                        .map((h) => empMap[h])
                        .filter(Boolean);
                    const helper = helperList[0] || {};

                    return {
                        trip: t,
                        loadStart,
                        area: t.area || outlet.area || "",
                        customer: outlet.customerGroup || "",
                        outletName: outlet.outletName || "",
                        address: outlet.address || "",
                        waybill: t.waybillConfirmed || t.waybillSuggested || "",
                        driverName: String(
                            driver.firstName || driver.nick || "",
                        ).toUpperCase(),
                        helperName: String(
                            helper.firstName || helper.nick || "",
                        ).toUpperCase(),
                        helperNames: helperList.map((h) =>
                            String(h.firstName || h.nick || "").toUpperCase(),
                        ),
                        plate: truck.plate || "",
                        billingCategory:
                            t.truckBillingCategory || truck.billingCategory || "",
                        typeCode: categoryToTypeCode(
                            t.truckBillingCategory || truck.billingCategory,
                        ),
                    };
                });
            }

            // Exported rows carry fill colors, so this goes through ExcelJS
            // (also the import parser's library — see web/import.js).
            const BATCH_FILLS = ["FFFFF2CC", "FFDCE6F1"]; // alternating pastel yellow/blue, mirrors the manual FINAL ROUTE convention

            async function exportDispatchXlsx() {
                if (!excelJsReady) {
                    showToast("Excel writer still loading — retry in a second.", "warning");
                    return;
                }
                const rows = buildFinalRouteModel();
                if (!rows.length) {
                    showToast("No trips to export for this date.", "warning");
                    return;
                }
                const dateVal = document.getElementById("dispatch-date").value;

                const header = [
                    "ORIGINAL RDD", "REVISED RDD", "STATUS", "Sold-to party",
                    "AREA", "CUSTOMER", "OUTLET", "ADDRESS",
                    "UNLOADING LOCATION", "QTY in packs/ cartons", "CBM",
                    "Scheduled Last Week",
                    "ACTUAL BO PICKED UP LAST WEEK", "Pick up BO",
                    "FREIGHT ORDER", ...EXPORT_TYPE_COLS, "TOTAL", "TIER",
                    "DRIVER", "HELPER", "WAYBILL", "PLATE",
                ];

                const wb = new ExcelJS.Workbook();
                const ws = wb.addWorksheet("ROUTE");
                ws.addRow([dateVal]);
                ws.addRow(header);
                ws.columns = header.map((h, i) => ({
                    width: i === 6 || i === 7 ? 30 : 12,
                }));

                let batchParity = 0;
                let prevLoadKey = null;
                rows.forEach((r) => {
                    const t = r.trip;
                    const loadKey = foKey(t) || "t" + t.id;
                    if (prevLoadKey !== null && loadKey !== prevLoadKey)
                        batchParity ^= 1;
                    prevLoadKey = loadKey;

                    const counts = EXPORT_TYPE_COLS.map((c) =>
                        r.loadStart && r.typeCode === c ? 1 : "",
                    );
                    const row = ws.addRow([
                        "", "", "", "",
                        r.area, r.customer, r.outletName, r.address, "",
                        t.quantity || "", t.cbm || "",
                        "", "", "",
                        t.foNumber || "", ...counts,
                        r.loadStart ? 1 : "", t.tier || "",
                        r.loadStart ? r.driverName : "",
                        r.loadStart ? r.helperName : "",
                        r.loadStart ? r.waybill : "",
                        r.loadStart ? r.plate : "",
                    ]);
                    const fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: BATCH_FILLS[batchParity] },
                    };
                    row.eachCell({ includeEmpty: true }, (cell) => {
                        cell.fill = fill;
                    });
                });

                const buf = await wb.xlsx.writeBuffer();
                const url = URL.createObjectURL(
                    new Blob([buf], { type: "application/octet-stream" }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `FINAL ROUTE ${dateVal} (ANGELOYAL).xlsx`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            }

            // Renders a full HTML document into a hidden same-origin iframe
            // and prints it (popups are unreliable in the Apps Script
            // sandbox; the browser's Print dialog does the PDF part).
            function printHtmlDocument(html) {
                const old = document.getElementById("print-frame");
                if (old) old.remove();
                const frame = document.createElement("iframe");
                frame.id = "print-frame";
                frame.style.cssText =
                    "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
                document.body.appendChild(frame);
                const doc = frame.contentDocument;
                doc.open();
                doc.write(html);
                doc.close();
                setTimeout(() => {
                    frame.contentWindow.focus();
                    frame.contentWindow.print();
                }, 150);
            }

            // Rasterizes the same print HTML to a downloadable .jpg. Renders
            // into a fixed-width offscreen iframe (style isolation) so the
            // capture width is deterministic, then html2canvas grabs it.
            // ponytail: fixed width per orientation; make it a param if a
            // third layout ever needs a different one.
            async function exportHtmlAsJpg(html, filename, width) {
                if (!html2canvasReady) {
                    showToast("Image writer still loading — retry in a second.", "warning");
                    return;
                }
                const old = document.getElementById("jpg-frame");
                if (old) old.remove();
                const frame = document.createElement("iframe");
                frame.id = "jpg-frame";
                frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:10px;border:0;background:#fff`;
                document.body.appendChild(frame);
                const doc = frame.contentDocument;
                doc.open();
                doc.write(html);
                doc.close();
                await new Promise((r) => setTimeout(r, 250)); // let layout + fonts settle
                const body = doc.body;
                frame.style.height = body.scrollHeight + "px";
                try {
                    const canvas = await html2canvas(body, {
                        scale: 2,
                        backgroundColor: "#fff",
                        windowWidth: width,
                        width: body.scrollWidth,
                        height: body.scrollHeight,
                    });
                    const a = document.createElement("a");
                    a.href = canvas.toDataURL("image/jpeg", 0.92);
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                } catch (err) {
                    showToast("Couldn't build the image — try Print instead.", "error");
                    console.error(err);
                } finally {
                    frame.remove();
                }
            }

            const PRINT_BASE_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; padding: 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h1 { font-size: 14px; margin-bottom: 2px; }
    .sub { font-size: 10px; color: #555; margin-bottom: 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 2px 4px; text-align: left; }
    th { background: #eee; font-size: 9px; text-transform: uppercase; }
    @page { size: landscape; margin: 10mm; }`;

            // ── SHARE TO DRIVERS ──────────────────────────────────────
            // One card per truck load, convoy trucks merged into one card
            // (they travel together and the drivers coordinate). Cards are
            // reorderable before printing; the order lives only in this
            // dialog — it's a message to the group chat, not data.
            let driverShareCards = [];

            function buildDriverShareCards() {
                const rows = buildFinalRouteModel();
                const cards = [];
                const byKey = {};
                // Driver group-chat cards go by nickname, unlike the Rebisco
                // xlsx which is first-name-first — so re-resolve names here.
                const empMap = indexById(employees);
                const shareName = (id) => {
                    const e = empMap[id] || {};
                    return String(e.nick || e.firstName || "").toUpperCase();
                };
                rows.forEach((r) => {
                    const t = r.trip;
                    const key = t.convoyGroup
                        ? "cg|" + t.convoyGroup
                        : t.truckId
                          ? "tk|" + t.truckId
                          : "fo|" + (t.foNumber || "t" + t.id);
                    let card = byKey[key];
                    if (!card) {
                        card = {
                            convoy: t.convoyGroup || "",
                            legs: [],
                            legKeys: {},
                            stops: [],
                        };
                        byKey[key] = card;
                        cards.push(card);
                    }
                    const legKey = foKey(t) || "t" + t.id;
                    if (!card.legKeys[legKey]) {
                        card.legKeys[legKey] = true;
                        card.legs.push({
                            plate: r.plate,
                            billingCategory: r.billingCategory,
                            driverName: shareName(t.driverId),
                            helperNames: (t.helperIds || [])
                                .map(shareName)
                                .filter(Boolean),
                        });
                    }
                    card.stops.push({
                        outletName: r.outletName,
                        address: r.address,
                        area: r.area,
                        customer: r.customer,
                        quantity: t.quantity,
                        cbm: t.cbm,
                        remarks: t.remarks || "",
                        status: t.tripStatus,
                        foNumber: t.foNumber || "",
                        waybill: r.waybill,
                    });
                });
                return cards;
            }

            function openDriverShareView() {
                driverShareCards = buildDriverShareCards();
                if (!driverShareCards.length) {
                    showToast("No trips to share for this date.", "warning");
                    return;
                }
                renderDriverShareCards();
                openModal("modal-driver-share");
            }

            function moveDriverShareCard(idx, delta) {
                const to = idx + delta;
                if (to < 0 || to >= driverShareCards.length) return;
                const [card] = driverShareCards.splice(idx, 1);
                driverShareCards.splice(to, 0, card);
                renderDriverShareCards();
            }

            function driverShareCardHtml(card, forPrint) {
                const legs = card.legs
                    .map((l) => {
                        const crew =
                            (esc(l.driverName) || "—") +
                            (l.helperNames && l.helperNames.length
                                ? " + " + l.helperNames.map(esc).join(" + ")
                                : "");
                        return `<div class="ds-leg">
        <span class="ds-crew">${crew}</span>
        <span class="ds-plate">${esc(l.plate) || "UNASSIGNED"}</span>
        ${l.billingCategory ? colorChip(l.billingCategory) : ""}
      </div>`;
                    })
                    .join("");
                const stops = card.stops
                    .map(
                        (s, i) => `<div class="ds-stop">
        <div class="ds-stop-top">
          <span class="ds-stop-n">${i + 1}.</span>
          ${s.foNumber ? `<span class="ds-fo">FO ${esc(s.foNumber)}</span>` : ""}
          ${s.waybill ? `<span class="ds-wb">WB ${esc(s.waybill)}</span>` : ""}
        </div>
        <div class="ds-outlet">
          ${colorChip(s.customer)}
          <span>${esc(s.outletName)} <span class="ds-area">(${esc(s.area)})</span></span>
          <span class="ds-qty">${s.quantity ? "QTY " + s.quantity : ""}${s.cbm ? " · " + s.cbm + " cbm" : ""}</span>
        </div>
        ${s.address ? `<div class="ds-address">${esc(s.address)}</div>` : ""}
        ${s.remarks ? `<div class="ds-remarks">✎ ${esc(s.remarks)}</div>` : ""}
      </div>`,
                    )
                    .join("");
                return `<div class="ds-card">
      ${card.convoy ? `<div class="ds-convoy">⛓ CONVOY C${esc(card.convoy)} — trucks travel together</div>` : ""}
      ${legs}
      <div class="ds-stops">${stops}</div>
    </div>`;
            }

            function renderDriverShareCards() {
                const wrap = document.getElementById("driver-share-cards");
                wrap.innerHTML = driverShareCards
                    .map(
                        (card, i) => `<div class="ds-card-row">
        <div class="ds-card-controls">
          <button class="btn btn-ghost btn-sm" onclick="moveDriverShareCard(${i},-1)" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn btn-ghost btn-sm" onclick="moveDriverShareCard(${i},1)" ${i === driverShareCards.length - 1 ? "disabled" : ""}>↓</button>
        </div>
        ${driverShareCardHtml(card)}
      </div>`,
                    )
                    .join("");
            }

            // The .jpg goes to the drivers' Messenger group chat. On Android,
            // Messenger's image viewer only zooms an image until it fills the
            // phone's width — you can't pinch in past that. So the on-screen
            // text size at max zoom is font_px × (phoneWidth ÷ imageWidth):
            // the FINAL ROUTE table above stays wide (800px, ~11px font) and
            // becomes unreadable there. For the share card we instead render
            // narrow with big fonts so that font÷width stays high enough for
            // the text to survive fit-to-width on a phone (~13–14px). The
            // Print/PDF path keeps its compact A4-portrait sizing.
            const SHARE_JPG_WIDTH = 520; // px; ≈ phone width, so fit-to-width barely shrinks it

            function printDriverShare(mode) {
                const isJpg = mode === "jpg";
                const dateVal = document.getElementById("dispatch-date").value;
                const cards = driverShareCards
                    .map((c) => driverShareCardHtml(c, true))
                    .join("");
                // Two size profiles for the same markup: compact for A4 print,
                // enlarged for the phone-shared .jpg (see SHARE_JPG_WIDTH note).
                const shareCss = isJpg
                    ? `
    body { font-size: 18px; line-height: 1.4; padding: 14px; }
    h1 { font-size: 22px; }
    .sub { font-size: 15px; }
    .ds-card { border: 2px solid #333; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
    .ds-convoy {
      display: inline-block; font-weight: bold; font-size: 18px; margin-bottom: 8px;
      padding: 5px 10px; border: 2px solid #5c3a8f; border-radius: 5px;
      color: #5c3a8f; background: #f5f0fa;
    }
    .ds-leg { display: flex; gap: 14px; align-items: baseline; font-size: 22px; font-weight: bold; margin-bottom: 6px; }
    .ds-crew { letter-spacing: 0.2px; }
    .ds-plate { font-family: monospace; }
    .ds-wb { margin-left: auto; font-family: monospace; font-weight: normal; font-size: 16px; color: #333; white-space: nowrap; }
    .ds-stops { margin-top: 8px; border-top: 1px dashed #999; padding-top: 8px; }
    .ds-stop { font-size: 18px; margin-bottom: 9px; }
    .ds-stop-top { display: flex; align-items: baseline; gap: 8px; }
    .ds-stop-n { font-weight: bold; }
    .ds-fo { font-family: monospace; font-weight: bold; color: #333; white-space: nowrap; }
    .ds-outlet { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; margin-left: 20px; }
    .ds-area { color: #555; white-space: nowrap; }
    .ds-qty { color: #555; white-space: nowrap; }
    .ds-remarks { font-size: 15px; color: #333; margin-left: 20px; }
    .ds-address { font-size: 15px; color: #555; margin-left: 20px; }
    .color-chip { display: inline-block; font-size: 14px; font-weight: bold; padding: 2px 8px; border-radius: 99px; border: 1px solid #ccc; }`
                    : `
    @page { size: portrait; margin: 10mm; }
    body { font-size: 11px; line-height: 1.4; }
    .ds-card { border: 1.5px solid #333; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; page-break-inside: avoid; }
    .ds-convoy {
      display: inline-block; font-weight: bold; font-size: 12px; margin-bottom: 6px;
      padding: 3px 8px; border: 1.5px solid #5c3a8f; border-radius: 4px;
      color: #5c3a8f; background: #f5f0fa;
      /* border + text label carry the meaning, so this still reads in B&W print */
    }
    .ds-leg { display: flex; gap: 12px; align-items: baseline; font-size: 13px; font-weight: bold; margin-bottom: 4px; }
    .ds-crew { letter-spacing: 0.2px; }
    .ds-plate { font-family: monospace; }
    .ds-wb { margin-left: auto; font-family: monospace; font-weight: normal; font-size: 11px; color: #333; white-space: nowrap; }
    .ds-stops { margin-top: 6px; border-top: 1px dashed #999; padding-top: 6px; }
    .ds-stop { font-size: 12px; margin-bottom: 6px; }
    .ds-stop-top { display: flex; align-items: baseline; gap: 6px; }
    .ds-stop-n { font-weight: bold; }
    .ds-fo { font-family: monospace; font-weight: bold; color: #333; white-space: nowrap; }
    .ds-outlet { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin-left: 16px; }
    .ds-area { color: #555; white-space: nowrap; }
    .ds-qty { color: #555; white-space: nowrap; }
    .ds-remarks { font-size: 10px; color: #333; margin-left: 16px; }
    .ds-address { font-size: 10px; color: #555; margin-left: 16px; }
    .color-chip { display: inline-block; font-size: 9px; font-weight: bold; padding: 1px 6px; border-radius: 99px; border: 1px solid #ccc; }`;
                const html = `<!DOCTYPE html><html><head><title>Trips ${esc(dateVal)}</title>
  <style>${PRINT_BASE_CSS}${shareCss}
  </style></head><body>
  <h1>TRIPS ${esc(dateVal)} (ANGELOYAL)</h1>
  <div class="sub">Grouped by truck / convoy — sequence as arranged by the dispatcher</div>
  ${cards}</body></html>`;
                if (isJpg)
                    exportHtmlAsJpg(
                        html,
                        `TRIPS ${dateVal} (ANGELOYAL).jpg`,
                        SHARE_JPG_WIDTH,
                    );
                else printHtmlDocument(html);
            }

            function truncate(s, max) {
                s = String(s || "");
                return s.length > max ? s.slice(0, max - 1) + "…" : s;
            }

            // Lightens a "#rrggbb" convoy color for use as a cell background
            // tint (text stays black so it still reads if printed in B&W).
            function tint(hex, alpha) {
                const h = hex.replace("#", "");
                const r = parseInt(h.substr(0, 2), 16);
                const g = parseInt(h.substr(2, 2), 16);
                const b = parseInt(h.substr(4, 2), 16);
                return `rgba(${r},${g},${b},${alpha})`;
            }

            function printDispatchDay(mode) {
                const rows = buildFinalRouteModel();
                if (!rows.length) {
                    showToast("No trips to print for this date.", "warning");
                    return;
                }
                const dateVal = document.getElementById("dispatch-date").value;

                // Cycle print-safe convoy colors in model order — the stripe on
                // the Convoy cell is the convoy indicator (kept as-is).
                const cgColor = {};
                const palette = ["#1e88e5", "#43a047", "#e53935", "#8e24aa", "#f4511e", "#00897b"];
                rows.forEach((r) => {
                    const g = r.trip.convoyGroup;
                    if (g && !(g in cgColor))
                        cgColor[g] = palette[Object.keys(cgColor).length % 6];
                });

                // Group-highlight by Driver + Helper instead of convoy — the
                // convoy already has its own colored stripe, so the
                // background tint is more useful marking which stops share a
                // crew (which can span multiple convoys/loads in a day).
                const crewColor = {};
                rows.forEach((r) => {
                    if (!r.loadStart || !r.driverName) return;
                    const key = r.driverName + "|" + r.helperName;
                    if (!(key in crewColor))
                        crewColor[key] = palette[Object.keys(crewColor).length % 6];
                });

                let currentCrewKey = null;
                const body = rows
                    .map((r) => {
                        const t = r.trip;
                        const g = t.convoyGroup;
                        const stripe = g
                            ? `border-left:4px solid ${cgColor[g]}`
                            : "";
                        if (r.loadStart)
                            currentCrewKey = r.driverName
                                ? r.driverName + "|" + r.helperName
                                : null;
                        const crewBg =
                            currentCrewKey && crewColor[currentCrewKey]
                                ? `background:${tint(crewColor[currentCrewKey], 0.14)}`
                                : "";
                        return `<tr>
        <td>${esc(r.area)}</td>
        <td>${colorChip(r.customer)}</td>
        <td>${esc(r.outletName)}</td>
        <td>${esc(truncate(r.address, 48))}</td>
        <td style="text-align:right">${t.quantity || ""}</td>
        <td style="text-align:right">${t.cbm || ""}</td>
        <td>${esc(t.foNumber) || ""}</td>
        <td>${r.loadStart ? esc(r.typeCode) : ""}</td>
        <td>${esc(t.tier || "")}</td>
        <td style="${stripe}">${g ? "C" + esc(g) : ""}</td>
        <td style="${crewBg}">${r.loadStart ? esc(r.driverName) : ""}</td>
        <td style="${crewBg}">${r.loadStart ? esc(r.helperName) : ""}</td>
        <td>${r.loadStart ? esc(r.waybill) : ""}</td>
        <td style="${crewBg}">${r.loadStart ? esc(r.plate) : ""}</td>
        <td>${esc(shortStatus(t.tripStatus))}</td>
        <td>${esc(t.remarks || "")}</td>
      </tr>`;
                    })
                    .join("");

                const html = `<!DOCTYPE html><html><head><title>ROUTE ${esc(dateVal)}</title>
  <style>${PRINT_BASE_CSS}
    .color-chip { display: inline-block; font-size: 8px; font-weight: bold; padding: 1px 5px; border-radius: 99px; border: 1px solid #ccc; }
  </style></head><body>
  <h1>FINAL ROUTE ${esc(dateVal)} (ANGELOYAL)</h1>
  <div class="sub">${rows.length} drops · generated from the AngeLoyal OMS dispatch board</div>
  <table><thead><tr>
    <th>Area</th><th>Cust</th><th>Outlet</th><th>Address</th><th>Qty</th><th>CBM</th>
    <th>FO</th><th>Type</th><th>Tier</th><th>Convoy</th><th>Driver</th><th>Helper</th><th>Waybill</th><th>Plate</th><th>Status</th><th>Remarks</th>
  </tr></thead><tbody>${body}</tbody></table>
  </body></html>`;
                if (mode === "jpg")
                    exportHtmlAsJpg(html, `FINAL ROUTE ${dateVal} (ANGELOYAL).jpg`, 1400);
                else printHtmlDocument(html);
            }
