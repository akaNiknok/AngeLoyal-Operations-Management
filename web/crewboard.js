            // ── CREW RAIL (drag-and-drop crew assignment) ─────────────
            // A toggled rail of draggable crew cards (one per active truck,
            // showing its default driver/helpers) beside the dispatch table.
            // Table rows are the drop targets (see renderDispatch): dragging a
            // crew onto a row assigns that truck + its whole default crew via
            // assignCrew() — optimistic, saves in the background.

            function toggleCrewRail() {
                crewRailOpen = !crewRailOpen;
                document.getElementById("crew-rail").style.display =
                    crewRailOpen ? "" : "none";
                document
                    .getElementById("btn-crew-rail")
                    .classList.toggle("active", crewRailOpen);
                if (crewRailOpen) renderCrewRail();
            }

            function cbCrewCardHtml(tk, empMap, tripCountByTruck) {
                const def = defaultAssignments.find(
                    (a) => Number(a.truckId) === Number(tk.id),
                );
                const driver =
                    def && def.defaultDriverId
                        ? (empMap[def.defaultDriverId] || {}).nick
                        : "";
                const helpers = def
                    ? (def.defaultHelperIds || [])
                          .map((h) => (empMap[h] || {}).nick)
                          .filter(Boolean)
                    : [];
                const drag = canEdit()
                    ? `draggable="true" ondragstart="cbCrewDragStart(event, ${tk.id})"`
                    : "";
                // Trucks already assigned to a trip today read as dimmed.
                const tripCount = tripCountByTruck[tk.id] || 0;
                const dim = tripCount > 0 ? " assigned" : "";
                const crewLine = driver
                    ? `<span class="cb-crew-driver">${esc(driver)}</span>${helpers.length ? ` <span class="cb-crew-helpers">+ ${esc(helpers.join(", "))}</span>` : ""}`
                    : `<span class="cb-crew-default">no default crew</span>`;
                const badge = tripCount
                    ? `<span class="cb-crew-badge" title="${tripCount} trip${tripCount === 1 ? "" : "s"} assigned today">${tripCount}</span>`
                    : "";
                // Truck type (color-coded) first, plate second.
                return `<div class="cb-crew-card${dim}" ${drag} title="Drag onto a trip row to assign">
      ${badge}
      <div class="cb-crew-line">${crewLine}</div>
      <div class="cb-crew-plate">${colorChip(tk.billingCategory || tk.type)} <span class="cb-crew-platenum">${esc(tk.plate)}</span></div>
    </div>`;
            }

            function setCrewRailSort(mode) {
                crewRailSort = mode;
                renderCrewRail();
            }

            function renderCrewRail() {
                if (!crewRailOpen || !dispatchData) return;
                const empMap = indexById(employees);
                const tripCountByTruck = {};
                (dispatchData.trips || []).forEach((t) => {
                    if (!t.truckId) return;
                    tripCountByTruck[t.truckId] =
                        (tripCountByTruck[t.truckId] || 0) + 1;
                });
                const active = trucks.filter((tk) => tk.active !== false);
                const driverNick = (tk) => {
                    const def = defaultAssignments.find(
                        (a) => Number(a.truckId) === Number(tk.id),
                    );
                    return def && def.defaultDriverId
                        ? (empMap[def.defaultDriverId] || {}).nick || ""
                        : "";
                };
                if (crewRailSort === "plate") {
                    active.sort((a, b) =>
                        String(a.plate).localeCompare(String(b.plate)),
                    );
                } else if (crewRailSort === "type") {
                    active.sort(
                        (a, b) =>
                            String(a.type || "").localeCompare(
                                String(b.type || ""),
                            ) || String(a.plate).localeCompare(String(b.plate)),
                    );
                } else {
                    active.sort(
                        (a, b) =>
                            driverNick(a).localeCompare(driverNick(b)) ||
                            String(a.plate).localeCompare(String(b.plate)),
                    );
                }
                document.getElementById("cb-rail-count").textContent =
                    active.length;
                document.getElementById("cb-rail-list").innerHTML = active.length
                    ? active
                          .map((tk) =>
                              cbCrewCardHtml(tk, empMap, tripCountByTruck),
                          )
                          .join("")
                    : `<div class="cb-empty">No active trucks.</div>`;
            }

            function cbCrewDragStart(e, truckId) {
                e.dataTransfer.setData("text/plain", String(truckId));
                e.dataTransfer.effectAllowed = "move";
            }
            // The rows a crew drop actually writes: a multi-selection if the
            // hovered row is in one, else the row's whole load (assignCrew
            // covers every row of the FO — it never assigns half a load).
            // Highlighting the hovered row alone would under-promise on a
            // merged load, and tint only the slice of a merged cell sitting
            // over that row.
            function cbDropTargetIds(tripId) {
                return selectedForGroup.has(tripId) && selectedForGroup.size > 1
                    ? [...selectedForGroup]
                    : loadBlockIds(tripId);
            }
            function cbClearDropHover() {
                document
                    .querySelectorAll(".cb-drop-hover")
                    .forEach((el) => el.classList.remove("cb-drop-hover"));
            }
            function cbDragOver(e, tripId) {
                e.preventDefault();
                cbClearDropHover();
                cbDropTargetIds(tripId).forEach((id) =>
                    document
                        .querySelector(`tr[data-tid="${id}"]`)
                        ?.classList.add("cb-drop-hover"),
                );
            }
            function cbDragLeave() {
                cbClearDropHover();
            }
            function cbTripDrop(e, tripId) {
                e.preventDefault();
                cbClearDropHover();
                const truckId = Number(e.dataTransfer.getData("text/plain"));
                if (!truckId) return;
                // Dropping onto a row that's part of a multi-selection
                // assigns the same crew to every selected trip.
                if (selectedForGroup.has(tripId) && selectedForGroup.size > 1) {
                    selectedForGroup.forEach((id) => assignCrew(id, truckId));
                } else {
                    assignCrew(tripId, truckId);
                }
            }
