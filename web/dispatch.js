            // ── DISPATCH BOARD ────────────────────────────────────────
            // Per-date cache. Navigation (useCache=true) paints instantly from
            // cache then revalidates in the background. After a load, the
            // adjacent dates are prefetched so day-to-day navigation is
            // instant on first visit too. Writes keep the cache honest one of
            // two ways: predictable edits are already applied optimistically
            // to the cached object (dispatchData IS dispatchCache[date]), and
            // writes that create rows the client can't predict either refetch
            // (loadDispatch() with no cache) or delete the affected date's
            // cache entry so its next visit does a full load.
            const dispatchCache = {};
            const dispatchPrefetching = new Set();

            // 'M/d/yyyy' + delta days → 'M/d/yyyy'
            function mdyAddDays(mdy, delta) {
                const [m, d, y] = mdy.split("/").map(Number);
                const dt = new Date(y, m - 1, d + delta);
                return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
            }

            // Silent background fill of an empty cache slot. Never overwrites
            // an existing entry — if the user navigated there mid-flight, the
            // real loadDispatch() owns that slot and its data is fresher.
            function prefetchDispatch(key) {
                if (dispatchCache[key] || dispatchPrefetching.has(key)) return;
                dispatchPrefetching.add(key);
                call("getDispatchBoardData", key).then(
                    (data) => {
                        dispatchPrefetching.delete(key);
                        if (!dispatchCache[key]) dispatchCache[key] = data;
                    },
                    () => dispatchPrefetching.delete(key),
                );
            }

            function loadDispatch(useCache) {
                const dateVal = document.getElementById("dispatch-date").value;
                if (!dateVal) return;
                const key = isoToMDY(dateVal);
                const cached = useCache && dispatchCache[key];
                if (cached) {
                    dispatchData = cached;
                    selectedForGroup.clear();
                    lastSelectedId = null;
                    renderDispatch();
                } else {
                    document
                        .getElementById("dispatch-loading")
                        .classList.add("on");
                }
                setSyncing(true);
                call("getDispatchBoardData", key).then(
                    (data) => {
                        dispatchCache[key] = data;
                        dispatchData = data;
                        if (!cached) {
                            selectedForGroup.clear();
                            lastSelectedId = null;
                        }
                        renderDispatch();
                        document
                            .getElementById("dispatch-loading")
                            .classList.remove("on");
                        setSyncing(false);
                        prefetchDispatch(mdyAddDays(key, -1));
                        prefetchDispatch(mdyAddDays(key, 1));
                    },
                    (e) => {
                        showToast(
                            "Dispatch load failed: " + e.message,
                            "error",
                        );
                        document
                            .getElementById("dispatch-loading")
                            .classList.remove("on");
                        setSyncing(false);
                    },
                );
            }

            function renderDispatch() {
                if (!dispatchData) return;
                const trips = getFilteredTrips();

                const outletMap = indexById(outlets);
                const empMap = indexById(employees);
                const truckMap = indexById(trucks);

                // Stats (always computed from full data, not filtered)
                const all = dispatchData.trips || [];
                document.getElementById("ds-total").textContent = all.length;
                const preppingCount = all.filter(
                    (t) => t.tripStatus === "Prepping",
                ).length;
                document.getElementById("ds-prepping").textContent =
                    preppingCount;
                document.getElementById("btn-mark-scheduled").style.display =
                    canEdit() && preppingCount > 0 ? "" : "none";
                const preppingCrewCount = all.filter(
                    (t) => t.tripStatus === "Prepping" && t.truckId,
                ).length;
                document.getElementById(
                    "btn-clear-prepping-crew",
                ).style.display =
                    canEdit() && preppingCrewCount > 0 ? "" : "none";
                document.getElementById("ds-scheduled").textContent =
                    all.filter((t) => t.tripStatus === "Scheduled").length;
                document.getElementById("ds-delivered").textContent =
                    all.filter((t) => t.tripStatus === "Delivered").length;
                document.getElementById("ds-undelivered").textContent =
                    all.filter((t) =>
                        [
                            "Undelivered",
                            "Foul Trip - No Redeliver",
                            "Foul Trip - For Redeliver",
                        ].includes(t.tripStatus),
                    ).length;
                const noWb = all.filter(
                    (t) => !t.waybillSuggested && !t.waybillConfirmed,
                ).length;
                document.getElementById("ds-nowb").textContent = noWb;
                document.getElementById("ds-unassigned-crew").textContent =
                    all.filter((t) => !t.truckId).length;
                updateConvoyButtons();
                renderCrewRail();

                // Table
                const empty = document.getElementById("dispatch-empty");
                const table = document.getElementById("dispatch-table");

                if (trips.length === 0) {
                    empty.style.display = "";
                    table.style.display = "none";
                    empty.querySelector(".msg").textContent =
                        all.length === 0
                            ? "No trips for this date"
                            : "No trips match the current filter";
                    empty.querySelector(".sub").textContent =
                        all.length === 0
                            ? "Import a Rebisco route file or add a manual trip."
                            : "Change the filter above to see other trips.";
                    return;
                }

                empty.style.display = "none";
                table.style.display = "";

                const tbody = document.getElementById("dispatch-tbody");

                // Alternating shade per load so all trips of one Freight Order
                // read as one visual group. Keyed the same way as the merged
                // cells below, so the shading and the merges can never disagree
                // about where a load starts and ends.
                const foParityByKey = {};
                let nextFoParity = 0;
                const foGroupCls = trips.map((t) => {
                    const key = foKey(t) || "none-" + t.id;
                    if (!(key in foParityByKey)) {
                        foParityByKey[key] = nextFoParity;
                        nextFoParity ^= 1;
                    }
                    return "fo-grp-" + foParityByKey[key];
                });

                // Merged (rowspan) cells: n = how many rows this cell covers,
                // 0 = covered by the run's first row, so render no cell at all.
                // A null key never merges (a group of one).
                const spanRuns = (keyOf) =>
                    trips.map((t, i) => {
                        const key = keyOf(t);
                        if (!key) return 1;
                        if (keyOf(trips[i - 1]) === key) return 0;
                        let n = 1;
                        while (keyOf(trips[i + n]) === key) n++;
                        return n;
                    });

                // The load (FO) is the unit for what the row's stops share:
                // one FO rides one truck, so its rows share a crew cell — and
                // one grip drags the whole load.
                const foSpan = spanRuns(foKey);

                // "Same FO = same waybill" (Schema.md): a load's stops share one
                // waybill number, stored as one Waybill row per trip. Keyed on
                // the number too, so a load left half-confirmed by older data
                // shows its rows separately instead of hiding the split.
                const waybillSpan = spanRuns((t) =>
                    foKey(t)
                        ? foKey(t) +
                          "|" +
                          (t.waybillConfirmed || "") +
                          "|" +
                          (t.waybillSuggested || "")
                        : null,
                );

                // Status is per outlet drop: a load can deliver one stop and
                // fail the next, and Redeliver/Foul-For-Redeliver spawns a
                // carry-over per row. So Status merges only while the load's
                // stops actually agree, and splits back into per-row selects
                // the moment they diverge — never forcing one stop's outcome
                // onto another.
                const statusSpan = spanRuns((t) =>
                    foKey(t) ? foKey(t) + "|" + t.tripStatus : null,
                );

                // Convoy groups: cycle a small palette per distinct token on
                // the loaded day (stripe + badge, distinct from FO shading).
                const convoyCls = {};
                (dispatchData.trips || []).forEach((t) => {
                    if (t.convoyGroup && !(t.convoyGroup in convoyCls)) {
                        convoyCls[t.convoyGroup] =
                            "cg-" + (Object.keys(convoyCls).length % 6);
                    }
                });

                const canE = canEdit();
                tbody.innerHTML = trips
                    .map((t, i) => {
                        const sourceCls =
                            t.source === "Manual"
                                ? "source-manual"
                                : t.source === "Carry-over"
                                  ? "source-carryover"
                                  : "";

                        const outlet = outletMap[t.outletId] || {};
                        const outletName = outlet.outletName || "";
                        const address = outlet.address || "";
                        const custGroup = outlet.customerGroup || "";
                        const truckPlate = (truckMap[t.truckId] || {}).plate || "";
                        const assignedTruckBillingCat = (truckMap[t.truckId] || {}).billingCategory || "";
                        const driverNick = (empMap[t.driverId] || {}).nick || "";
                        const helperNicks = (t.helperIds || [])
                            .map((hid) => (empMap[hid] || {}).nick)
                            .filter(Boolean)
                            .join(", ");

                        // Crew is a single unit: one card holds the assigned
                        // truck (type + plate) and its driver + helpers.
                        // Assignment is by dragging a crew from the rail onto
                        // the row; the ✕ unassigns.
                        const crewSub = driverNick
                            ? `<span class="crew-driver">${esc(driverNick)}</span>${helperNicks ? `<span class="crew-helper">+${esc(helperNicks)}</span>` : ""}`
                            : `<span class="crew-empty">no driver</span>`;
                        const unassignBtn = canE
                            ? `<button class="cb-unassign" onclick="assignCrew(${t.id}, '')" title="Unassign crew">✕</button>`
                            : "";
                        const crewCell = truckPlate
                            ? `<div class="crew-card">
           <div class="crew-card-body">
             <div class="crew-card-crew">${crewSub}</div>
             <div class="crew-card-top">${colorChip(assignedTruckBillingCat)}<span class="crew-card-plate">${esc(truckPlate)}</span></div>
           </div>
           ${unassignBtn}
         </div>`
                            : `<div class="crew-card empty"><span class="crew-empty">Unassigned${canE ? " — drag a crew here" : ""}</span></div>`;

                        // A merged select drives every stop it covers; an
                        // un-merged one (the load's stops disagree) drives only
                        // its own row.
                        const statusCell = canE
                            ? `<select class="cell-select ${statusChipClass(t.tripStatus)}" onchange="changeStatus(${t.id}, this.value, ${statusSpan[i] > 1})">${statusSelectOptions(t.tripStatus)}</select>`
                            : `<span class="status-chip ${statusChipClass(t.tripStatus)}">${shortStatus(t.tripStatus)}</span>`;

                        const remarksCell = canE
                            ? `<input class="cell-input remarks-in" type="text" title="${esc(t.remarks || "")}" value="${esc(t.remarks || "")}" placeholder="—" onchange="this.title=this.value; changeRemarks(${t.id}, this.value)">`
                            : `<span class="crew-helper" title="${esc(t.remarks || "")}">${esc(t.remarks || "")}</span>`;

                        // Rows are drop targets both for crew cards dragged
                        // from the crew rail (cb* handlers) and for other
                        // rows being reordered — rowDragOver/rowDrop tell
                        // the two apart by dataTransfer type and delegate.
                        const dz = canE
                            ? `ondragover="rowDragOver(event, ${t.id})" ondragleave="rowDragLeave(event)" ondrop="rowDrop(event, ${t.id})"`
                            : "";

                        // Grip lives inside the frozen FO cell so the row
                        // doesn't need a whole extra sticky column. One grip
                        // per load, on the load's first row: a drag moves the
                        // whole load, so a grip per row would promise a
                        // per-row move that can't happen. The other rows keep
                        // a same-width spacer so their FO #s stay aligned.
                        const dragHandle = !canE
                            ? ""
                            : foSpan[i]
                              ? `<span class="row-drag-handle" draggable="true" ondragstart="rowDragStart(event, ${t.id})" ondragend="rowDragEnd(event)" title="Drag to reorder">⠿</span>`
                              : `<span class="row-drag-handle spacer"></span>`;

                        const billingCat = t.truckBillingCategory || "";
                        const foFull =
                            t.foNumber +
                            (t.foSplitSuffix ? "-" + t.foSplitSuffix : "");

                        const cgCls = t.convoyGroup
                            ? convoyCls[t.convoyGroup]
                            : "";
                        const cgBadge = t.convoyGroup
                            ? `<span class="convoy-badge ${cgCls}">C${esc(t.convoyGroup)}</span>`
                            : "";
                        // ponytail: shown for every source — the server is the
                        // real gate and refuses once a waybill is confirmed.
                        const delBtn = canE
                            ? `<button class="row-del" title="Remove trip" onclick="confirmDeleteTrip(${t.id})">✕</button>`
                            : "";

                        // Rows are click-to-select (for convoy grouping) instead
                        // of a checkbox column — clicks on inputs/buttons/selects
                        // inside the row pass through instead of toggling.
                        const selCls = selectedForGroup.has(t.id) ? " selected" : "";
                        const rowClick = canE
                            ? `onclick="handleRowClick(event, ${t.id})"`
                            : "";

                        return `<tr data-tid="${t.id}" class="${sourceCls} ${foGroupCls[i]} ${cgCls}${selCls}" ${dz} ${rowClick} onmouseenter="hoverLoad(${t.id}, true)" onmouseleave="hoverLoad(${t.id}, false)">
      <td class="td-fo">${dragHandle}${esc(foFull) || "—"}</td>
      <td class="td-rdd">${esc(t.billingDate) || "—"}</td>
      <td>${colorChip(custGroup)}</td>
      <td class="td-outlet" title="${esc(outletName)}">${esc(outletName) || "—"}</td>
      <td class="td-address" title="${esc(address)}">${esc(address) || "—"}</td>
      <td class="td-area">${esc(t.area) || "—"}</td>
      <td class="td-qty">${t.quantity || "—"}</td>
      <td class="td-qty">${t.cbm || "—"}</td>
      <td>${esc(t.tier) || "—"}</td>
      <td class="td-billingcat"><div class="billingcat-cell">${colorChip(billingCat)}${cgBadge}</div></td>
      ${foSpan[i] ? `<td class="td-crew col-divider"${foSpan[i] > 1 ? ` rowspan="${foSpan[i]}"` : ""}>${crewCell}</td>` : ""}
      ${statusSpan[i] ? `<td class="td-status col-divider"${statusSpan[i] > 1 ? ` rowspan="${statusSpan[i]}"` : ""}>${statusCell}</td>` : ""}
      ${waybillSpan[i] ? `<td class="td-wb"${waybillSpan[i] > 1 ? ` rowspan="${waybillSpan[i]}"` : ""}>${waybillCellHtml(t, canE)}</td>` : ""}
      <td class="td-remarks"><div class="remarks-cell">${remarksCell}${delBtn}</div></td>
    </tr>`;
                    })
                    .join("");
            }

            // Every row of the load a row belongs to (itself, if it has no FO #).
            function loadBlockIds(tripId) {
                const trips = dispatchData.trips || [];
                const key = foKey(trips.find((t) => t.id === tripId));
                return key
                    ? trips.filter((t) => foKey(t) === key).map((t) => t.id)
                    : [tripId];
            }

            // Hover highlights the whole load. A merged cell is transparent, so
            // per-row hover would tint only the slice of it sitting over the
            // hovered row — the load is the unit, so it lights up as one.
            function hoverLoad(tripId, on) {
                loadBlockIds(tripId).forEach((id) => {
                    const tr = document.querySelector(`tr[data-tid="${id}"]`);
                    if (tr) tr.classList.toggle("load-hover", on);
                });
            }

            // Row click toggles convoy-group / bulk-action selection (highlight
            // instead of a checkbox column). Clicks on inline controls inside
            // the row (inputs, selects, buttons, links) act on that control
            // instead. Shift extends a range over the currently displayed
            // order; Ctrl/Cmd toggles one row; a plain click replaces the
            // selection. Selection works in whole loads, for the same reason
            // hover does — and because the convoy grouping it feeds is a
            // per-truck decision, so half a load is never a useful selection.
            function handleRowClick(e, tripId) {
                if (e.target.closest("input, select, button, a")) return;

                const block = loadBlockIds(tripId);
                if (e.shiftKey && lastSelectedId != null) {
                    const ids = getFilteredTrips().map((t) => t.id);
                    const a = ids.indexOf(lastSelectedId);
                    const b = ids.indexOf(tripId);
                    if (a !== -1 && b !== -1) {
                        const lo = Math.min(a, b);
                        const hi = Math.max(a, b);
                        // Expand the range to whole loads at both ends.
                        selectedForGroup = new Set(
                            ids
                                .slice(lo, hi + 1)
                                .flatMap((id) => loadBlockIds(id)),
                        );
                    } else {
                        selectedForGroup = new Set(block);
                    }
                } else if (e.ctrlKey || e.metaKey) {
                    const drop = selectedForGroup.has(tripId);
                    block.forEach((id) =>
                        drop
                            ? selectedForGroup.delete(id)
                            : selectedForGroup.add(id),
                    );
                    lastSelectedId = tripId;
                } else {
                    selectedForGroup = new Set(block);
                    lastSelectedId = tripId;
                }
                updateConvoyButtons();
                renderDispatch();
            }

            function updateConvoyButtons() {
                const n = selectedForGroup.size;
                const editing = canEdit();
                document.getElementById("btn-group-convoy").style.display =
                    editing && n >= 2 ? "" : "none";
                document.getElementById("btn-ungroup-convoy").style.display =
                    editing && n >= 1 ? "" : "none";

                const show = editing && n >= 1;
                const countEl = document.getElementById("selection-count");
                if (countEl) {
                    countEl.style.display = show ? "" : "none";
                    countEl.textContent = `${n} selected`;
                }
                const bulkStatusEl = document.getElementById("bulk-status");
                if (bulkStatusEl) {
                    bulkStatusEl.style.display = show ? "" : "none";
                    // Populate once from the same option list used per-row, so
                    // the two never drift apart.
                    if (!bulkStatusEl.dataset.populated) {
                        bulkStatusEl.innerHTML =
                            `<option value="">Set status…</option>` +
                            statusSelectOptions(null);
                        bulkStatusEl.dataset.populated = "1";
                    }
                }
            }

            // Applies one status to every selected trip in one round trip.
            // Reuses bulkSetTripStatus (server) which itself reuses
            // saveTripChanges per id — carry-over spawn keeps working.
            function bulkChangeStatus(status) {
                if (!canEdit() || !status || !dispatchData) return;
                const ids = [...selectedForGroup];
                if (!ids.length) return;
                // Same Prepping → Scheduled prompt as the per-row select:
                // promotions need a booklet prefix for the suggested waybills.
                const trips = dispatchData.trips || [];
                if (
                    status === "Scheduled" &&
                    ids.some((id) => {
                        const t = trips.find((x) => x.id === id);
                        return (
                            t &&
                            t.tripStatus === "Prepping" &&
                            !t.suggestedWaybillId &&
                            !t.waybillConfirmed
                        );
                    })
                ) {
                    document.getElementById("bulk-status").value = "";
                    openTripScheduleModal(ids);
                    return;
                }
                doBulkStatus(ids, status, null);
            }

            function doBulkStatus(ids, status, prefixId) {
                const olds = new Map();
                ids.forEach((id) => {
                    const trip = (dispatchData.trips || []).find(
                        (t) => t.id === id,
                    );
                    if (trip) {
                        olds.set(id, trip.tripStatus);
                        trip.tripStatus = status;
                    }
                });
                selectedForGroup.clear();
                updateConvoyButtons();
                renderDispatch();

                bgSave("bulkSetTripStatus", [ids, status, prefixId], {
                    onOk: (r) => {
                        if (r.newTripIds && r.newTripIds.length) {
                            showToast(
                                `${r.newTripIds.length} carry-over trip${r.newTripIds.length === 1 ? "" : "s"} created for next day.`,
                                "success",
                            );
                            // Carry-overs land on the NEXT day — the current
                            // board is already correct; just make sure the
                            // next day's visit does a full load.
                            delete dispatchCache[
                                mdyAddDays(dispatchData.date, 1)
                            ];
                        }
                        if (prefixId) {
                            // Refetch so the new suggested waybills show —
                            // the bulk response doesn't carry them per trip.
                            delete dispatchCache[dispatchData.date];
                            loadDispatch();
                        }
                    },
                    revert: () => {
                        ids.forEach((id) => {
                            const trip = (dispatchData.trips || []).find(
                                (t) => t.id === id,
                            );
                            if (trip && olds.has(id))
                                trip.tripStatus = olds.get(id);
                        });
                        renderDispatch();
                    },
                });
            }

            // ── ROW DRAG-TO-REORDER ────────────────────────────────────
            // A grip inside the FO cell (rendered by renderDispatch) starts
            // the drag. Row dragover/drop is shared with the crew-card drop
            // zone (cbDragOver/cbTripDrop in CrewBoard.html) — the dataTransfer
            // type tells the two apart so crew-card drops keep working.
            const ROW_DRAG_TYPE = "application/x-oms-rows";
            let draggingTripId = null;

            function isRowDrag(e) {
                return e.dataTransfer.types.includes(ROW_DRAG_TYPE);
            }

            function clearRowDropIndicator() {
                document
                    .querySelectorAll(
                        ".drop-before, .drop-after, .drop-after-merged",
                    )
                    .forEach((el) =>
                        el.classList.remove(
                            "drop-before",
                            "drop-after",
                            "drop-after-merged",
                        ),
                    );
            }

            // The set a drag actually moves: an explicit multi-selection, else
            // the dragged row's convoy, else its load — in day order. A load's
            // rows move together so a drag can never strand the rest (and
            // orderedDayTrips re-clusters anyway). The indicator and the drop
            // both read it, so what lights up is what moves.
            function dragUnitIds(tripId) {
                const trips = (dispatchData || {}).trips || [];
                const byId = indexById(trips);
                const order = orderedDayTrips(trips).map((t) => t.id);
                if (selectedForGroup.has(tripId) && selectedForGroup.size > 1)
                    return order.filter((id) => selectedForGroup.has(id));
                const cg = (byId[tripId] || {}).convoyGroup;
                if (cg)
                    return order.filter(
                        (id) => (byId[id] || {}).convoyGroup === cg,
                    );
                const fk = foKey(byId[tripId]);
                return fk ? order.filter((id) => foKey(byId[id]) === fk) : [tripId];
            }

            // The rendered rows of a trip's load, top to bottom (DOM order, so
            // the status filter can't scramble it).
            function loadBlockRows(tripId) {
                const ids = new Set(loadBlockIds(tripId));
                return [
                    ...document.querySelectorAll("#dispatch-tbody tr[data-tid]"),
                ].filter((tr) => ids.has(Number(tr.dataset.tid)));
            }

            // Before/after is judged against the whole load block, not the row
            // under the cursor: a 3-row load has one insertion point above it
            // and one below, matching where finishRowReorder actually lands.
            function dropBefore(e, rows) {
                const top = rows[0].getBoundingClientRect().top;
                const bottom =
                    rows[rows.length - 1].getBoundingClientRect().bottom;
                return e.clientY < (top + bottom) / 2;
            }

            // Draw the line on the load, not the hovered row. A merged cell
            // lives on the block's first row and ends at the block's bottom,
            // so the "after" line is drawn there too — otherwise it stops
            // short at the Crew column (see the CSS).
            function markRowDropIndicator(rows, before) {
                if (before) rows[0].classList.add("drop-before");
                else {
                    rows[rows.length - 1].classList.add("drop-after");
                    rows[0].classList.add("drop-after-merged");
                }
            }

            function rowDragStart(e, tripId) {
                e.dataTransfer.setData(ROW_DRAG_TYPE, String(tripId));
                e.dataTransfer.effectAllowed = "move";
                draggingTripId = tripId;
                // Ghost the FO cell, not the grip — a lone "⠿" trailing the
                // cursor says nothing about which load is in flight.
                const cell = e.target.closest("td");
                if (cell) e.dataTransfer.setDragImage(cell, 12, 12);
                // Fade every row that's moving, not just the gripped one.
                dragUnitIds(tripId).forEach((id) =>
                    document
                        .querySelector(`tr[data-tid="${id}"]`)
                        ?.classList.add("row-dragging"),
                );
            }

            function rowDragEnd() {
                draggingTripId = null;
                clearRowDropIndicator();
                document
                    .querySelectorAll(".row-dragging")
                    .forEach((el) => el.classList.remove("row-dragging"));
            }

            function rowDragOver(e, tripId) {
                if (!isRowDrag(e)) {
                    cbDragOver(e, tripId);
                    return;
                }
                e.preventDefault();
                clearRowDropIndicator();
                const rows = loadBlockRows(tripId);
                // Hovering the set that's being dragged is a no-op — show no
                // insertion line rather than one the drop won't honour.
                if (
                    !rows.length ||
                    draggingTripId == null ||
                    dragUnitIds(draggingTripId).includes(tripId)
                ) {
                    e.dataTransfer.dropEffect = "none";
                    return;
                }
                e.dataTransfer.dropEffect = "move";
                markRowDropIndicator(rows, dropBefore(e, rows));
            }

            function rowDragLeave(e) {
                if (!isRowDrag(e)) cbDragLeave(e);
            }

            function rowDrop(e, tripId) {
                if (!isRowDrag(e)) {
                    cbTripDrop(e, tripId);
                    return;
                }
                e.preventDefault();
                const rows = loadBlockRows(tripId);
                if (!rows.length) return;
                const before = dropBefore(e, rows);
                clearRowDropIndicator();
                finishRowReorder(tripId, before);
            }

            // Moves the dragged set (multi-select, else the dragged row's
            // convoy block, else just the row) to just before/after the drop
            // target, within the FULL day order (not just the filtered view)
            // — so the persisted order stays correct regardless of the
            // status filter currently applied on screen.
            function finishRowReorder(targetTripId, before) {
                if (!dispatchData || draggingTripId == null) return;

                const movedIds = dragUnitIds(draggingTripId);
                const movedSet = new Set(movedIds);
                // Dropping onto a row that's part of the moved set (its own
                // load, convoy, or selection) has nowhere to land — leave the
                // order alone rather than flinging it to the end of the day.
                if (movedSet.has(targetTripId)) return;

                const trips = dispatchData.trips || [];
                const byId = indexById(trips);
                const remaining = orderedDayTrips(trips)
                    .map((t) => t.id)
                    .filter((id) => !movedSet.has(id));

                // Land outside the target's whole load, never between two of
                // its rows — a drop mid-load would split a merged cell.
                const tk = foKey(byId[targetTripId]);
                const block = tk
                    ? remaining.filter((id) => foKey(byId[id]) === tk)
                    : [];
                const anchorId = block.length
                    ? before
                        ? block[0]
                        : block[block.length - 1]
                    : targetTripId;
                const idx = remaining.indexOf(anchorId);
                remaining.splice(before ? idx : idx + 1, 0, ...movedIds);

                applyReorder(remaining, movedIds);
            }

            function applyReorder(newOrderIds, flashIds) {
                const byId = indexById(dispatchData.trips);
                const prevTrips = dispatchData.trips;
                // Stamp local sortOrder so a re-render (before the server
                // round trip completes) keeps showing the new order.
                dispatchData.trips = newOrderIds.map((id, i) =>
                    Object.assign({}, byId[id], { sortOrder: i * 10 }),
                );
                flipRender(renderDispatch);
                // Flash the rows that just moved so the eye can follow them.
                (flashIds || []).forEach((id) =>
                    document
                        .querySelector(`tr[data-tid="${id}"]`)
                        ?.classList.add("just-moved"),
                );
                bgSave("reorderTrips", [dispatchData.date, newOrderIds], {
                    revert: () => {
                        dispatchData.trips = prevTrips;
                        renderDispatch();
                    },
                });
            }

            // FLIP: record each row's screen position, run the re-render (which
            // rebuilds the tbody), then translate each row back to where it was
            // and release the transform so it glides to its new home. Rows are
            // matched across the render by data-tid.
            // ponytail: transform on a <tr> briefly breaks the sticky FO cell's
            // horizontal pin — only visible mid-glide when scrolled sideways.
            function flipRender(renderFn) {
                const tbody = document.getElementById("dispatch-tbody");
                const reduce = window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                ).matches;
                if (!tbody || reduce) return renderFn();

                const before = {};
                tbody
                    .querySelectorAll("tr[data-tid]")
                    .forEach((tr) => {
                        before[tr.dataset.tid] =
                            tr.getBoundingClientRect().top;
                    });

                renderFn();

                const moved = [];
                tbody.querySelectorAll("tr[data-tid]").forEach((tr) => {
                    const prev = before[tr.dataset.tid];
                    if (prev == null) return;
                    const delta = prev - tr.getBoundingClientRect().top;
                    if (!delta) return;
                    tr.style.transform = `translateY(${delta}px)`;
                    moved.push(tr);
                });
                if (!moved.length) return;

                requestAnimationFrame(() => {
                    moved.forEach((tr) => {
                        tr.style.transition = "transform 0.22s ease";
                        tr.style.transform = "";
                        tr.addEventListener(
                            "transitionend",
                            () => {
                                tr.style.transition = "";
                            },
                            { once: true },
                        );
                    });
                });
            }

            function groupSelectedTrips(action) {
                const ids = [...selectedForGroup];
                if (!ids.length) return;
                setSyncing(true);
                call("setTripConvoyGroup", ids, action).then(
                    (r) => {
                        setSyncing(false);
                        if (!r.success) {
                            showToast(r.error, "error");
                            return;
                        }
                        (dispatchData.trips || []).forEach((t) => {
                            if (selectedForGroup.has(t.id))
                                t.convoyGroup = r.group;
                        });
                        selectedForGroup.clear();
                        updateConvoyButtons();
                        renderDispatch();
                        showToast(
                            action === "group"
                                ? `Convoy C${r.group} created (${ids.length} trips).`
                                : "Convoy grouping removed.",
                            "success",
                        );
                    },
                    toastError,
                );
            }

            function getFilteredTrips() {
                if (!dispatchData) return [];
                const trips = dispatchData.trips || [];
                let filtered = trips;
                if (statusFilter === "carry")
                    filtered = trips.filter((t) => t.source === "Carry-over");
                else if (statusFilter !== "all")
                    filtered = trips.filter(
                        (t) => t.tripStatus === statusFilter,
                    );
                return orderedDayTrips(filtered);
            }

            function setStatusFilter(f, btn) {
                statusFilter = f;
                document
                    .querySelectorAll("#status-pills .pill")
                    .forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                renderDispatch();
            }

            function shiftDate(delta) {
                const inp = document.getElementById("dispatch-date");
                const d = new Date(inp.value + "T00:00:00");
                d.setDate(d.getDate() + delta);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const dd = String(d.getDate()).padStart(2, "0");
                inp.value = `${yyyy}-${mm}-${dd}`;
                loadDispatch(true);
            }

            function goToday() {
                document.getElementById("dispatch-date").value = todayStr();
                loadDispatch(true);
            }

            // ── INLINE TRIP EDITING ───────────────────────────────────
            // Options come straight off TRIP_STATUSES (core.js) so the dropdown can never
            // offer a status the chips and labels do not know about.
            function statusSelectOptions(current) {
                return TRIP_STATUSES.map(
                    ([v]) =>
                        `<option value="${esc(v)}" ${current === v ? "selected" : ""}>${esc(shortStatus(v))}</option>`,
                ).join("");
            }

            function waybillCellHtml(t, canE) {
                if (t.waybillConfirmed) {
                    return `<span class="wb-confirmed">${esc(t.waybillConfirmed)}</span>`;
                }
                const suggested = t.waybillSuggested || "";
                if (canE && t.suggestedWaybillId) {
                    return `<span class="wb-inline"><input id="wb-in-${t.id}" type="text" class="cell-input wb-in" value="${esc(suggested)}" placeholder="AY-…" onchange="saveSuggestedWaybill(${t.id}, this.value)"><button class="row-confirm" onclick="confirmWaybillInline(${t.id})">✓</button></span>`;
                }
                return suggested
                    ? `<span class="wb-suggested">${esc(suggested)}</span>`
                    : `<span class="wb-none">—</span>`;
            }

            // Assign a whole crew (truck + its default driver & helpers) to a
            // trip in one move — and to every other row of the same FO, which
            // is what the board's merged crew cell promises. Optimistic: apply
            // + re-render immediately.
            function assignCrew(tripId, truckIdRaw) {
                const trips = dispatchData.trips || [];
                const trip = trips.find((t) => t.id === tripId);
                if (!trip) return;
                const truckId = Number(truckIdRaw) || null;
                let driverId = null;
                let helperIds = [];
                if (truckId) {
                    const def = defaultAssignments.find(
                        (a) => Number(a.truckId) === truckId,
                    );
                    if (def) {
                        driverId =
                            def.defaultDriverId != null
                                ? Number(def.defaultDriverId)
                                : null;
                        helperIds = (def.defaultHelperIds || []).map(Number);
                    }
                }
                const key = foKey(trip);
                const targets = key
                    ? trips.filter((t) => foKey(t) === key)
                    : [trip];
                targets.forEach((t) =>
                    applyCrew(t, truckId, driverId, helperIds),
                );
            }

            function applyCrew(trip, truckId, driverId, helperIds) {
                const tripId = trip.id;
                // Already carries this exact crew — an FO sibling reached twice
                // (multi-select overlapping an FO, clear-all over an FO's rows)
                // would otherwise re-save and re-audit a no-op.
                if (
                    trip.truckId === truckId &&
                    trip.driverId === driverId &&
                    String(trip.helperIds) === String(helperIds)
                )
                    return;
                const old = {
                    truckId: trip.truckId,
                    driverId: trip.driverId,
                    helperIds: trip.helperIds,
                    truckBillingCategory: trip.truckBillingCategory,
                };
                Object.assign(trip, { truckId, driverId, helperIds });
                renderDispatch();
                bgSave("saveTripChanges", [tripId, { truckId, driverId, helperIds }], {
                    onOk: (r) => {
                        if (r.trip) {
                            Object.assign(trip, r.trip);
                            renderDispatch();
                        }
                        if (r.routeFrequencyWarning) {
                            showToast(
                                `⚠ Driver assigned to ${r.routeFrequencyWarning.outletName} ${r.routeFrequencyWarning.count}× in last 21 days`,
                                "warning",
                            );
                        }
                    },
                    revert: () => {
                        Object.assign(trip, old);
                        renderDispatch();
                    },
                });
            }

            // `wholeLoad` comes from the merged Status cell: the select the
            // dispatcher touched visibly covered every stop of the load, so it
            // sets every stop. An un-merged select sets only its own row.
            function changeStatus(tripId, status, wholeLoad) {
                const trips = dispatchData.trips || [];
                const trip = trips.find((t) => t.id === tripId);
                if (!trip) return;
                const key = wholeLoad && foKey(trip);
                const targets = key
                    ? trips.filter((t) => foKey(t) === key)
                    : [trip];
                // Prepping → Scheduled by hand still needs a suggested waybill
                // (markDayScheduled covers the whole-day path). Ask which
                // booklet prefix to draw from before saving.
                if (
                    status === "Scheduled" &&
                    targets.some(
                        (t) =>
                            t.tripStatus === "Prepping" &&
                            !t.suggestedWaybillId &&
                            !t.waybillConfirmed,
                    )
                ) {
                    openTripScheduleModal(targets.map((t) => t.id));
                    renderDispatch(); // snap the select back until confirmed
                    return;
                }
                targets.forEach((t) => applyStatus(t, status));
            }

            function applyStatus(trip, status) {
                const tripId = trip.id;
                if (trip.tripStatus === status) return;
                const old = trip.tripStatus;
                trip.tripStatus = status;
                renderDispatch();
                bgSave("saveTripChanges", [tripId, { tripStatus: status }], {
                    onOk: (r) => {
                        if (r.trip) {
                            Object.assign(trip, r.trip);
                            renderDispatch();
                        }
                        if (r.newTripId) {
                            showToast(
                                `Carry-over trip created for next day (ID ${r.newTripId}).`,
                                "success",
                            );
                            // Carry-over lands on the NEXT day, not this board.
                            delete dispatchCache[
                                mdyAddDays(dispatchData.date, 1)
                            ];
                        }
                    },
                    revert: () => {
                        trip.tripStatus = old;
                        renderDispatch();
                    },
                });
            }

            function changeRemarks(tripId, val) {
                const trip = (dispatchData.trips || []).find(
                    (t) => t.id === tripId,
                );
                if (!trip || (trip.remarks || "") === val) return;
                const old = trip.remarks || "";
                trip.remarks = val;
                // No re-render — keep the input focused.
                bgSave("saveTripChanges", [tripId, { remarks: val }], {
                    onOk: (r) => {
                        if (r.trip) trip.remarks = r.trip.remarks;
                    },
                    revert: () => {
                        trip.remarks = old;
                        renderDispatch();
                    },
                });
            }

            // Edit the suggested waybill number and keep it Suggested (not
            // locked) — the pre-confirmation correction dispatchers need when a
            // load's booklet series differs from the auto-suggested one. Saved
            // server-side so it survives reload and other users see it; ✓ still
            // confirms/locks. Mirrors changeRemarks: no re-render, keep focus.
            function saveSuggestedWaybill(tripId, val) {
                if (!canEdit()) return;
                const trips = dispatchData.trips || [];
                const trip = trips.find((t) => t.id === tripId);
                if (!trip || !trip.suggestedWaybillId) return;
                const newNumber = (val || "").trim();
                if (!newNumber || newNumber === trip.waybillSuggested) return;
                // One number covers the whole load — move every stop together,
                // same as confirmWaybillInline.
                const key = foKey(trip);
                const targets = key
                    ? trips.filter((t) => foKey(t) === key)
                    : [trip];
                const olds = targets.map((t) => ({
                    trip: t,
                    waybillSuggested: t.waybillSuggested,
                }));
                const waybillId = trip.suggestedWaybillId;
                targets.forEach((t) => (t.waybillSuggested = newNumber));
                bgSave("updateSuggestedWaybill", [waybillId, newNumber], {
                    onOk: (r) => {
                        targets.forEach(
                            (t) => (t.waybillSuggested = r.waybillNumber),
                        );
                    },
                    revert: () => {
                        olds.forEach(({ trip: t, ...prev }) =>
                            Object.assign(t, prev),
                        );
                        renderDispatch();
                    },
                });
            }

            function confirmWaybillInline(tripId) {
                if (!canEdit()) return;
                const input = document.getElementById("wb-in-" + tripId);
                if (!input) return;
                const customNumber = input.value.trim();
                if (!customNumber) {
                    showToast("Enter a waybill number first.", "warning");
                    return;
                }
                const trips = dispatchData.trips || [];
                const trip = trips.find((t) => t.id === tripId);
                if (!trip || !trip.suggestedWaybillId) {
                    showToast("No waybill to confirm for this trip yet.", "warning");
                    return;
                }
                // One waybill covers the whole load, and confirmWaybill locks
                // every row of it server-side — so every stop of the load has
                // to move together here too, or the board would show the rest
                // still awaiting a number they no longer need.
                const key = foKey(trip);
                const targets = key
                    ? trips.filter((t) => foKey(t) === key)
                    : [trip];
                // Optimistic: lock the rows in immediately so confirming feels
                // instant, then reconcile/revert once the server responds.
                const olds = targets.map((t) => ({
                    trip: t,
                    waybillConfirmed: t.waybillConfirmed,
                    waybillSuggested: t.waybillSuggested,
                    suggestedWaybillId: t.suggestedWaybillId,
                }));
                const waybillId = trip.suggestedWaybillId;
                targets.forEach((t) => {
                    t.waybillConfirmed = customNumber;
                    t.waybillSuggested = "";
                    t.suggestedWaybillId = null;
                });
                renderDispatch();
                bgSave("confirmWaybill", [waybillId, customNumber], {
                    onOk: (r) => {
                        targets.forEach((t) => (t.waybillConfirmed = r.waybillNumber));
                        showToast(
                            `Waybill ${r.waybillNumber} confirmed` +
                                (r.confirmed > 1 ? ` for ${r.confirmed} stops.` : "."),
                            "success",
                        );
                        renderDispatch();
                    },
                    revert: () => {
                        olds.forEach(({ trip: t, ...prev }) =>
                            Object.assign(t, prev),
                        );
                        renderDispatch();
                    },
                });
            }

            // Clears crew (truck/driver/helpers) from every Prepping trip on
            // the loaded day. Reuses assignCrew's optimistic apply + revert
            // per trip — this is a dispatcher "start the day over" action.
            function clearAllPreppingCrew() {
                if (!canEdit()) return;
                const targets = (dispatchData.trips || []).filter(
                    (t) => t.tripStatus === "Prepping" && t.truckId,
                );
                if (!targets.length) {
                    showToast("No Prepping trips have a crew assigned.", "warning");
                    return;
                }
                if (
                    !confirm(
                        `Clear crew from ${targets.length} Prepping trip${targets.length === 1 ? "" : "s"}? This cannot be undone.`,
                    )
                )
                    return;
                targets.forEach((t) => assignCrew(t.id, ""));
            }

            function confirmDeleteTrip(tripId) {
                if (
                    !confirm(
                        "Remove this trip? It will be deleted permanently if it has no confirmed waybill.",
                    )
                )
                    return;
                setSyncing(true);
                call("deleteImportedTrip", tripId).then(
                    (r) => {
                        setSyncing(false);
                        if (!r.success) {
                            showToast("Delete failed: " + r.error, "error");
                            return;
                        }
                        showToast("Trip removed.", "success");
                        // Remove locally — dispatchData is the cached object,
                        // so the per-date cache stays correct too.
                        dispatchData.trips = (dispatchData.trips || []).filter(
                            (t) => t.id !== tripId,
                        );
                        selectedForGroup.delete(tripId);
                        updateConvoyButtons();
                        renderDispatch();
                    },
                    (e) => {
                        setSyncing(false);
                        showToast("Error: " + e.message, "error");
                    },
                );
            }

            // ── ADD MANUAL TRIP MODAL ──────────────────────────────────
            function openMarkScheduledModal() {
                if (!canEdit()) {
                    showToast("Your role cannot schedule trips.", "warning");
                    return;
                }
                pendingScheduleIds = null;
                document.getElementById("mds-hint").style.display = "";
                const prepping = (dispatchData?.trips || []).filter(
                    (t) => t.tripStatus === "Prepping",
                );
                if (prepping.length === 0) {
                    showToast("No Prepping trips on this date.", "warning");
                    return;
                }
                const noCrew = prepping.filter(
                    (t) => !t.truckId && !t.driverId,
                ).length;
                const date = document.getElementById("dispatch-date").value;
                document.getElementById("mds-summary").textContent =
                    `${prepping.length - noCrew} Prepping trip${prepping.length - noCrew === 1 ? "" : "s"} on ${date} will be marked Scheduled` +
                    (noCrew
                        ? `; ${noCrew} without a crew will be marked Backlog and carried over to the next business day.`
                        : ".");
                populatePrefixSelects();
                openModal("modal-mark-scheduled");
            }

            // Trip ids the modal is prompting a prefix for on a manual
            // Prepping → Scheduled change (per-row select, whole load, or
            // bulk action) instead of the whole day. The save goes through
            // bulkSetTripStatus — one sequential server call — so a load's
            // first stop reserves a number and its later stops join it.
            let pendingScheduleIds = null;

            function openTripScheduleModal(ids) {
                pendingScheduleIds = ids;
                document.getElementById("mds-summary").textContent =
                    `${ids.length} trip${ids.length === 1 ? "" : "s"} will be marked Scheduled and a waybill suggested.`;
                document.getElementById("mds-hint").style.display = "none";
                populatePrefixSelects();
                openModal("modal-mark-scheduled");
            }

            function submitMarkScheduled() {
                const dateVal = document.getElementById("dispatch-date").value;
                const prefixId = Number(
                    document.getElementById("mds-prefix").value,
                );
                if (!prefixId) {
                    showToast("Select a waybill prefix.", "warning");
                    return;
                }
                closeModal("modal-mark-scheduled");
                if (pendingScheduleIds) {
                    const ids = pendingScheduleIds;
                    pendingScheduleIds = null;
                    doBulkStatus(ids, "Scheduled", prefixId);
                    return;
                }
                setSyncing(true);
                call("markDayScheduled", isoToMDY(dateVal), prefixId).then(
                    (r) => {
                        setSyncing(false);
                        if (!r.success) {
                            showToast(
                                "Scheduling failed: " + r.error,
                                "error",
                            );
                            return;
                        }
                        showToast(
                            `${r.promoted} trips Scheduled, ${r.waybillsSuggested} waybills suggested.` +
                                (r.backlogged
                                    ? ` ${r.backlogged} trip${r.backlogged === 1 ? "" : "s"} without a crew marked Backlog and carried over.`
                                    : ""),
                            "success",
                        );
                        loadDispatch();
                    },
                    toastError,
                );
            }

            function openAddTripModal() {
                if (!canEdit()) {
                    showToast("Your role cannot add trips.", "warning");
                    return;
                }
                document.getElementById("at-date").value =
                    document.getElementById("dispatch-date").value;
                populateAddTripSelects();
                openModal("modal-add-trip");
            }

            function populateAddTripSelects() {
                const outletSel = document.getElementById("at-outlet");
                if (outletSel) {
                    outletSel.innerHTML =
                        `<option value="">— Select outlet —</option>` +
                        outlets
                            .map(
                                (o) =>
                                    `<option value="${o.id}">${esc(o.outletName)}</option>`,
                            )
                            .join("");
                }
                const truckSel = document.getElementById("at-truck");
                if (truckSel) {
                    truckSel.innerHTML =
                        `<option value="">— Unassigned —</option>` +
                        trucks
                            .filter((t) => t.active !== false)
                            .map(
                                (t) =>
                                    `<option value="${t.id}">${esc(t.plate)} (${esc(t.type)})</option>`,
                            )
                            .join("");
                }
                const driverSel = document.getElementById("at-driver");
                if (driverSel) {
                    driverSel.innerHTML =
                        `<option value="">— Unassigned —</option>` +
                        employees
                            .filter(
                                (e) =>
                                    (e.role === "Driver" ||
                                        e.role === "Driver-Helper") &&
                                    e.active !== false,
                            )
                            .map(
                                (e) =>
                                    `<option value="${e.id}">${esc(e.nick)}</option>`,
                            )
                            .join("");
                }
            }

            function populatePrefixSelects() {
                ["at-prefix", "mds-prefix"].forEach((id) => {
                    const sel = document.getElementById(id);
                    if (!sel) return;
                    sel.innerHTML = waybillPrefixes
                        .filter((p) => p.active !== false)
                        .map(
                            (p) =>
                                `<option value="${p.id}">${esc(p.prefix)} — ${esc(p.companyName)}</option>`,
                        )
                        .join("");
                });
            }

            function submitAddTrip() {
                const outletId = Number(
                    document.getElementById("at-outlet").value,
                );
                const outlet = outlets.find((o) => o.id === outletId);
                const truckId =
                    Number(document.getElementById("at-truck").value) || null;
                const driverId =
                    Number(document.getElementById("at-driver").value) || null;
                const qty =
                    Number(document.getElementById("at-qty").value) || null;
                const dateVal = document.getElementById("at-date").value;
                const prefixId =
                    Number(document.getElementById("at-prefix").value) || null;
                const remarks = document.getElementById("at-remarks").value;
                const fo = document.getElementById("at-fo").value.trim();

                if (!outletId) {
                    showToast("Select an outlet.", "warning");
                    return;
                }

                const tripData = {
                    foNumber: fo,
                    outletName: outlet ? outlet.outletName : "",
                    area: outlet ? outlet.area : "",
                    truckId,
                    driverId,
                    quantity: qty,
                    tripDate: isoToMDY(dateVal),
                    prefixId,
                    remarks,
                    source: "Manual",
                };

                setSyncing(true);
                call("createTrip", tripData).then(
                    (r) => {
                        setSyncing(false);
                        if (!r.success) {
                            showToast("Add trip failed: " + r.error, "error");
                            return;
                        }
                        closeModal("modal-add-trip");
                        showToast(
                            `Trip added (ID ${r.tripId})${r.waybillSuggested ? " — waybill " + r.waybillSuggested + " suggested" : ""}`,
                            "success",
                        );
                        // The trip may be on a different date than the board;
                        // drop that date's cache so its next visit refetches.
                        delete dispatchCache[isoToMDY(dateVal)];
                        loadDispatch();
                    },
                    (e) => {
                        setSyncing(false);
                        showToast("Error: " + e.message, "error");
                    },
                );
            }
