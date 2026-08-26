            // ── SHARED HELPERS ──────────────────────────────────────────
            function statusChip(active) {
                return active === false
                    ? `<span class="status-chip" style="background:var(--red-bg);color:var(--red)">Inactive</span>`
                    : `<span class="status-chip" style="background:var(--green-bg);color:var(--green)">Active</span>`;
            }
            // Remove / Restore action button for an admin row.
            function rowActionBtn(fn, id, active) {
                return `<button class="row-del" style="border-color:var(--border)" onclick="${fn}(${id})">${active === false ? "Restore" : "Remove"}</button>`;
            }

            // Everything the five admin tables do identically, declared once. `list` is a
            // getter because applyBootData() reassigns these arrays on every boot — a
            // direct reference would go stale. `echo` is the key the create/update writer
            // returns the saved record under; `name` labels it in confirms and toasts.
            const ADMIN_RECORDS = {
                truck: {
                    list: () => trucks,
                    create: "createTruck",
                    update: "updateTruck",
                    echo: "truck",
                    modal: "modal-add-truck",
                    name: (t) => t.plate,
                    after: (r) => {
                        if (r && r.defaultAssignment)
                            defaultAssignments.push(r.defaultAssignment);
                        renderTrucksAdmin();
                        renderTruckList();
                    },
                },
                employee: {
                    list: () => employees,
                    create: "createEmployee",
                    update: "updateEmployee",
                    echo: "employee",
                    modal: "modal-add-employee",
                    name: (e) => e.nick,
                    after: () => {
                        renderEmployeesAdmin();
                        renderEmpList();
                    },
                },
                billingCategory: {
                    list: () => billingCategories,
                    create: "createBillingCategory",
                    update: "updateBillingCategory",
                    echo: "billingCategory",
                    modal: "modal-add-billing-category",
                    name: (c) => c.name,
                    after: renderBillingCategoriesAdmin,
                },
                routeTypeMap: {
                    list: () => routeTypeMap,
                    create: "createRouteTypeMapping",
                    update: "updateRouteTypeMapping",
                    echo: "mapping",
                    modal: "modal-add-route-type-map",
                    name: (m) => m.fileTypeCode,
                    noun: "mapping", // "…remove the 4WC mapping?"
                    addedName: (m) => `${m.fileTypeCode} → ${m.billingCategory}`,
                    after: renderRouteTypeMapAdmin,
                },
                waybillPrefix: {
                    list: () => waybillPrefixes,
                    create: "createWaybillPrefix",
                    update: "updateWaybillPrefix",
                    echo: "waybillPrefix",
                    modal: "modal-add-waybill-prefix",
                    name: (p) => p.prefix || "(blank prefix)",
                    after: () => {
                        renderWaybillPrefixesAdmin();
                        populatePrefixSelects();
                    },
                },
            };

            // Remove / Restore for an admin row: confirm, flip Active through bgSave,
            // merge whatever the server echoed back, re-render.
            function toggleRecordActive(key, id) {
                const spec = ADMIN_RECORDS[key];
                const rec = spec.list().find((x) => x.id === id);
                if (!rec) return;
                const name = spec.name(rec);
                const subject = spec.noun ? `the ${name} ${spec.noun}` : name;
                const makeActive = rec.active === false;
                const verb = makeActive ? "restore" : "remove";
                if (!confirm(`Are you sure you want to ${verb} ${subject}?`)) return;

                bgSave(spec.update, [id, { active: makeActive }], {
                    onOk: (r) => {
                        // Writers that echo the saved row win; updateEmployee returns only
                        // { success }, so fall back to the flag we just asked for.
                        if (r && r[spec.echo]) Object.assign(rec, r[spec.echo]);
                        else rec.active = makeActive;
                        showToast(
                            `${name} ${makeActive ? "restored" : "removed"}.`,
                            "success",
                        );
                        spec.after(r);
                    },
                });
            }

            // Add-modal submit: post the payload, adopt the created record locally, close,
            // toast, re-render. Per-form validation stays with the form.
            function submitAddRecord(key, payload) {
                const spec = ADMIN_RECORDS[key];
                setSyncing(true);
                call(spec.create, payload).then((r) => {
                    setSyncing(false);
                    if (!r.success) {
                        showToast("Add failed: " + r.error, "error");
                        return;
                    }
                    const rec = r[spec.echo];
                    spec.list().push(rec);
                    closeModal(spec.modal);
                    showToast(
                        `${(spec.addedName || spec.name)(rec)} added.`,
                        "success",
                    );
                    spec.after(r);
                }, toastError);
            }


            // ── TRUCKS ADMIN ──────────────────────────────────────────
            function renderTrucksAdmin() {
                const q = (
                    document.getElementById("trucks-search").value || ""
                ).toLowerCase();
                const showInactive = document.getElementById(
                    "trucks-show-inactive",
                ).checked;
                const catFilterEl = document.getElementById(
                    "trucks-category-filter",
                );
                if (catFilterEl.options.length <= 1) {
                    catFilterEl.innerHTML =
                        `<option value="">All categories</option>` +
                        billingCategories
                            .filter((c) => c.active !== false)
                            .map(
                                (c) =>
                                    `<option value="${esc(c.name)}">${esc(c.name)}</option>`,
                            )
                            .join("");
                }
                const catFilter = catFilterEl.value;
                const tbody = document.getElementById("trucks-tbody");
                const isAdmin = currentUser.role === "Admin";

                const filtered = trucks.filter((t) => {
                    if (!showInactive && t.active === false) return false;
                    if (catFilter && t.billingCategory !== catFilter)
                        return false;
                    return (
                        !q ||
                        (t.plate || "").toLowerCase().includes(q) ||
                        (t.brand || "").toLowerCase().includes(q) ||
                        (t.type || "").toLowerCase().includes(q)
                    );
                });
                document.getElementById("trucks-count").textContent =
                    `${filtered.length} trucks`;

                tbody.innerHTML = filtered
                    .map((t) => {
                        const f = (field, val) =>
                            isAdmin
                                ? `<input class="cell-input" value="${esc(val)}" onchange="updateTruckField(${t.id},'${field}',this.value)">`
                                : esc(val) || "—";
                        const cat = isAdmin
                            ? `<div class="cat-cell">${catSwatch(t.billingCategory)}<select class="cell-select" onchange="updateTruckField(${t.id},'billingCategory',this.value)">${billingCategoryOptions(t.billingCategory)}</select></div>`
                            : colorChip(t.billingCategory);
                        return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${t.id}</td>
    <td style="font-family:'DM Mono',monospace">${f("plate", t.plate)}</td>
    <td>${f("brand", t.brand)}</td>
    <td>${f("type", t.type)}</td>
    <td>${cat}</td>
    <td>${statusChip(t.active)}</td>
    <td>${isAdmin ? rowActionBtn("toggleTruckActive", t.id, t.active) : ""}</td>
  </tr>`;
                    })
                    .join("");
            }

            function updateTruckField(id, field, value) {
                const t = trucks.find((x) => x.id === id);
                if (!t) return;
                if (field === "plate" && !value.trim()) {
                    showToast("Plate number is required.", "error");
                    renderTrucksAdmin();
                    return;
                }
                const old = t[field];
                t[field] = value;
                bgSave("updateTruck", [id, { [field]: value }], {
                    onOk: (r) => {
                        Object.assign(t, r.truck);
                        if (field === "billingCategory") renderTrucksAdmin();
                        renderTruckList();
                    },
                    revert: () => {
                        t[field] = old;
                        renderTrucksAdmin();
                    },
                });
            }

            function toggleTruckActive(id) {
                toggleRecordActive("truck", id);
            }

            function openAddTruckModal() {
                document.getElementById("nt-plate").value = "";
                document.getElementById("nt-brand").value = "";
                document.getElementById("nt-type").value = "";
                document.getElementById("nt-billing-category").innerHTML =
                    billingCategoryOptions("");
                openModal("modal-add-truck");
            }

            function submitAddTruck() {
                const plate = document.getElementById("nt-plate").value.trim();
                if (!plate) {
                    showToast("Plate number is required.", "error");
                    return;
                }
                submitAddRecord("truck", {
                    plate,
                    brand: document.getElementById("nt-brand").value.trim(),
                    type: document.getElementById("nt-type").value.trim(),
                    billingCategory: document.getElementById("nt-billing-category").value,
                });
            }

            // ── EMPLOYEES ADMIN ───────────────────────────────────────
            function renderEmployeesAdmin() {
                const q = (
                    document.getElementById("employees-search").value || ""
                ).toLowerCase();
                const showInactive = document.getElementById(
                    "employees-show-inactive",
                ).checked;
                const roleFilter = document.getElementById(
                    "employees-role-filter",
                ).value;
                const tbody = document.getElementById("employees-tbody");
                const isAdmin = currentUser.role === "Admin";

                const filtered = employees.filter((e) => {
                    if (!showInactive && e.active === false) return false;
                    if (roleFilter && e.role !== roleFilter) return false;
                    return (
                        !q ||
                        (e.nick || "").toLowerCase().includes(q) ||
                        (e.firstName || "").toLowerCase().includes(q) ||
                        (e.lastName || "").toLowerCase().includes(q)
                    );
                });
                document.getElementById("employees-count").textContent =
                    `${filtered.length} employees`;

                tbody.innerHTML = filtered
                    .map((e) => {
                        const f = (field, val) =>
                            isAdmin
                                ? `<input class="cell-input" value="${esc(val)}" onchange="updateEmployeeField(${e.id},'${field}',this.value)">`
                                : esc(val) || "—";
                        const roleSel = isAdmin
                            ? `<select class="cell-select ${roleBadgeClass(e.role)}" onchange="updateEmployeeField(${e.id},'role',this.value)">
                 <option value="Driver" ${e.role === "Driver" ? "selected" : ""}>Driver</option>
                 <option value="Helper" ${e.role === "Helper" ? "selected" : ""}>Helper</option>
                 <option value="Driver-Helper" ${e.role === "Driver-Helper" ? "selected" : ""}>Driver-Helper</option>
               </select>`
                            : `<span class="badge ${roleBadgeClass(e.role)}">${esc(e.role)}</span>`;
                        return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${e.id}</td>
    <td>${f("nick", e.nick)}</td>
    <td>${f("firstName", e.firstName)}</td>
    <td>${f("middleName", e.middleName)}</td>
    <td>${f("lastName", e.lastName)}</td>
    <td>${roleSel}</td>
    <td>${statusChip(e.active)}</td>
    <td>${isAdmin ? rowActionBtn("toggleEmployeeActive", e.id, e.active) : ""}</td>
  </tr>`;
                    })
                    .join("");
            }

            function updateEmployeeField(id, field, value) {
                const em = employees.find((x) => x.id === id);
                if (!em) return;
                if (field === "nick" && !value.trim()) {
                    showToast("Nickname is required.", "error");
                    renderEmployeesAdmin();
                    return;
                }
                const old = em[field];
                em[field] = value;
                bgSave("updateEmployee", [id, { [field]: value }], {
                    onOk: () => {
                        renderEmpList();
                    },
                    revert: () => {
                        em[field] = old;
                        renderEmployeesAdmin();
                    },
                });
            }

            function toggleEmployeeActive(id) {
                toggleRecordActive("employee", id);
            }

            function openAddEmployeeModal() {
                document.getElementById("ne-nick").value = "";
                document.getElementById("ne-first").value = "";
                document.getElementById("ne-middle").value = "";
                document.getElementById("ne-last").value = "";
                document.getElementById("ne-role").value = "Driver";
                openModal("modal-add-employee");
            }

            function submitAddEmployee() {
                const nick = document.getElementById("ne-nick").value.trim();
                if (!nick) {
                    showToast("Nickname is required.", "error");
                    return;
                }
                submitAddRecord("employee", {
                    nick,
                    firstName: document.getElementById("ne-first").value.trim(),
                    middleName: document.getElementById("ne-middle").value.trim(),
                    lastName: document.getElementById("ne-last").value.trim(),
                    role: document.getElementById("ne-role").value,
                });
            }

            // ── BILLING CATEGORIES ADMIN ─────────────────────────────
            function renderBillingCategoriesAdmin() {
                const showInactive = document.getElementById(
                    "billing-categories-show-inactive",
                ).checked;
                const tbody = document.getElementById(
                    "billing-categories-tbody",
                );
                const isAdmin = currentUser.role === "Admin";

                const filtered = billingCategories.filter(
                    (c) => showInactive || c.active !== false,
                );
                document.getElementById(
                    "billing-categories-count",
                ).textContent = `${filtered.length} categories`;

                tbody.innerHTML = filtered
                    .map((c) => {
                        const nameCell = isAdmin
                            ? `<div class="cat-cell">${catSwatch(c.name)}<input class="cell-input" value="${esc(c.name)}" onchange="updateBillingCategoryName(${c.id},this.value)"></div>`
                            : colorChip(c.name);
                        return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${c.id}</td>
    <td>${nameCell}</td>
    <td>${statusChip(c.active)}</td>
    <td>${isAdmin ? rowActionBtn("toggleBillingCategoryActive", c.id, c.active) : ""}</td>
  </tr>`;
                    })
                    .join("");
            }

            function updateBillingCategoryName(id, name) {
                const bc = billingCategories.find((c) => c.id === id);
                if (!bc) return;
                if (!name.trim()) {
                    showToast("Name is required.", "error");
                    renderBillingCategoriesAdmin();
                    return;
                }
                const oldName = bc.name;
                bc.name = name;
                bgSave("updateBillingCategory", [id, { name }], {
                    onOk: (r) => {
                        Object.assign(bc, r.billingCategory);
                        // Cascade the rename onto any trucks that carried the
                        // old name, so the Trucks panel stays in sync.
                        if (oldName && oldName !== r.billingCategory.name) {
                            trucks.forEach((t) => {
                                if (t.billingCategory === oldName)
                                    t.billingCategory = r.billingCategory.name;
                            });
                        }
                        renderBillingCategoriesAdmin();
                        renderTrucksAdmin();
                    },
                    revert: () => {
                        bc.name = oldName;
                        renderBillingCategoriesAdmin();
                    },
                });
            }

            function toggleBillingCategoryActive(id) {
                toggleRecordActive("billingCategory", id);
            }

            function openAddBillingCategoryModal() {
                document.getElementById("nbc-name").value = "";
                openModal("modal-add-billing-category");
            }

            function submitAddBillingCategory() {
                const name = document.getElementById("nbc-name").value.trim();
                if (!name) {
                    showToast("Name is required.", "error");
                    return;
                }
                submitAddRecord("billingCategory", { name });
            }

            // ── ROUTE TYPE MAP ADMIN ─────────────────────────────────
            // Maps a Rebisco route-file truck-type column code (e.g. 4WC) to a
            // billing category, so import can assign the correct truck type.
            function renderRouteTypeMapAdmin() {
                const showInactive = document.getElementById(
                    "route-type-map-show-inactive",
                ).checked;
                const tbody = document.getElementById("route-type-map-tbody");
                const isAdmin = currentUser.role === "Admin";

                const filtered = routeTypeMap.filter(
                    (m) => showInactive || m.active !== false,
                );
                document.getElementById(
                    "route-type-map-count",
                ).textContent = `${filtered.length} mappings`;

                tbody.innerHTML = filtered
                    .map((m) => {
                        const codeCell = isAdmin
                            ? `<input class="cell-input" value="${esc(m.fileTypeCode)}" onchange="updateRouteTypeMapField(${m.id},'fileTypeCode',this.value)">`
                            : `<span style="font-family:'DM Mono',monospace">${esc(m.fileTypeCode)}</span>`;
                        const catCell = isAdmin
                            ? `<div class="cat-cell">${catSwatch(m.billingCategory)}<select class="cell-select" onchange="updateRouteTypeMapField(${m.id},'billingCategory',this.value)">${billingCategoryOptions(m.billingCategory)}</select></div>`
                            : colorChip(m.billingCategory);
                        return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${m.id}</td>
    <td>${codeCell}</td>
    <td>${catCell}</td>
    <td>${statusChip(m.active)}</td>
    <td>${isAdmin ? rowActionBtn("toggleRouteTypeMapActive", m.id, m.active) : ""}</td>
  </tr>`;
                    })
                    .join("");
            }

            function updateRouteTypeMapField(id, field, value) {
                const m = routeTypeMap.find((x) => x.id === id);
                if (!m) return;
                if (!value) {
                    showToast(
                        field === "fileTypeCode"
                            ? "File type code is required."
                            : "Billing category is required.",
                        "error",
                    );
                    renderRouteTypeMapAdmin();
                    return;
                }
                const old = m[field];
                m[field] = value;
                bgSave("updateRouteTypeMapping", [id, { [field]: value }], {
                    onOk: (r) => {
                        Object.assign(m, r.mapping);
                        if (field === "billingCategory")
                            renderRouteTypeMapAdmin();
                    },
                    revert: () => {
                        m[field] = old;
                        renderRouteTypeMapAdmin();
                    },
                });
            }

            function toggleRouteTypeMapActive(id) {
                toggleRecordActive("routeTypeMap", id);
            }

            function openAddRouteTypeMapModal() {
                document.getElementById("nrtm-code").value = "";
                document.getElementById("nrtm-category").innerHTML =
                    billingCategoryOptions("");
                openModal("modal-add-route-type-map");
            }

            function submitAddRouteTypeMap() {
                const fileTypeCode = document.getElementById("nrtm-code").value.trim();
                const billingCategory = document.getElementById("nrtm-category").value;
                if (!fileTypeCode) {
                    showToast("File type code is required.", "error");
                    return;
                }
                if (!billingCategory) {
                    showToast("Billing category is required.", "error");
                    return;
                }
                submitAddRecord("routeTypeMap", { fileTypeCode, billingCategory });
            }

            // ── WAYBILL PREFIXES (admin + dispatcher) ────────────────
            // The stored Last Sequence Number carries the booklet's digit
            // width in its own length ("0357" → width 4), so edits round-trip
            // as text and the padding survives.
            function prefixSeqText(p) {
                return String(p.lastSequenceNumber).padStart(
                    p.sequenceWidth || 0,
                    "0",
                );
            }

            // The counter advances server-side every time the board issues a
            // waybill, so the copy taken at boot goes stale the moment anyone
            // schedules a trip. Re-pull on panel open, otherwise the "Next"
            // column advertises a number that is already out — and editing the
            // sequence from that stale view would try to rewind the booklet.
            function refreshWaybillPrefixes() {
                call("getWaybillPrefixes").then(
                    (list) => {
                        if (!list) return;
                        waybillPrefixes = list;
                        renderWaybillPrefixesAdmin();
                        populatePrefixSelects();
                    },
                    () => {},
                );
            }

            function renderWaybillPrefixesAdmin() {
                const showInactive = document.getElementById(
                    "waybill-prefixes-show-inactive",
                ).checked;
                const tbody = document.getElementById("waybill-prefixes-tbody");
                const canEdit =
                    currentUser.role === "Admin" ||
                    currentUser.role === "Dispatcher";

                const filtered = waybillPrefixes.filter(
                    (p) => showInactive || p.active !== false,
                );
                document.getElementById(
                    "waybill-prefixes-count",
                ).textContent = `${filtered.length} prefixes`;

                tbody.innerHTML = filtered
                    .map((p) => {
                        const seq = prefixSeqText(p);
                        const next = String(p.lastSequenceNumber + 1).padStart(
                            p.sequenceWidth || 0,
                            "0",
                        );
                        const cell = (field, value, mono) =>
                            canEdit
                                ? `<input class="cell-input" value="${esc(value)}" onchange="updateWaybillPrefixField(${p.id},'${field}',this.value)">`
                                : `<span${mono ? ` style="font-family:'DM Mono',monospace"` : ""}>${esc(value)}</span>`;
                        return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${p.id}</td>
    <td>${cell("prefix", p.prefix, true)}</td>
    <td>${cell("companyName", p.companyName)}</td>
    <td>${cell("lastSequenceNumber", seq, true)}</td>
    <td style="font-family:'DM Mono',monospace;color:var(--muted)">${esc(p.prefix ? `${p.prefix}-${next}` : next)}</td>
    <td>${statusChip(p.active)}</td>
    <td>${canEdit ? rowActionBtn("toggleWaybillPrefixActive", p.id, p.active) : ""}</td>
  </tr>`;
                    })
                    .join("");
            }

            function updateWaybillPrefixField(id, field, value) {
                const p = waybillPrefixes.find((x) => x.id === id);
                if (!p) return;
                const old =
                    field === "lastSequenceNumber" ? prefixSeqText(p) : p[field];
                if (field === "companyName" && !value.trim()) {
                    showToast("Company name is required.", "error");
                    renderWaybillPrefixesAdmin();
                    return;
                }
                if (
                    field === "lastSequenceNumber" &&
                    !/^\d+$/.test(value.trim())
                ) {
                    showToast(
                        "Last sequence number must be digits only.",
                        "error",
                    );
                    renderWaybillPrefixesAdmin();
                    return;
                }
                if (field === "lastSequenceNumber") {
                    p.lastSequenceNumber = Number(value.trim());
                    p.sequenceWidth = value.trim().length;
                } else {
                    p[field] = value.trim();
                }
                renderWaybillPrefixesAdmin();
                bgSave("updateWaybillPrefix", [id, { [field]: value.trim() }], {
                    onOk: (r) => {
                        Object.assign(p, r.waybillPrefix);
                        renderWaybillPrefixesAdmin();
                        populatePrefixSelects();
                    },
                    revert: () => {
                        if (field === "lastSequenceNumber") {
                            p.lastSequenceNumber = Number(old);
                            p.sequenceWidth = String(old).length;
                        } else {
                            p[field] = old;
                        }
                        renderWaybillPrefixesAdmin();
                    },
                });
            }

            function toggleWaybillPrefixActive(id) {
                toggleRecordActive("waybillPrefix", id);
            }

            function openAddWaybillPrefixModal() {
                document.getElementById("nwp-prefix").value = "";
                document.getElementById("nwp-company").value = "";
                document.getElementById("nwp-sequence").value = "";
                openModal("modal-add-waybill-prefix");
            }

            function submitAddWaybillPrefix() {
                const prefix = document.getElementById("nwp-prefix").value.trim();
                const companyName = document.getElementById("nwp-company").value.trim();
                const lastSequenceNumber = document
                    .getElementById("nwp-sequence")
                    .value.trim();
                if (!companyName) {
                    showToast("Company name is required.", "error");
                    return;
                }
                if (!/^\d+$/.test(lastSequenceNumber)) {
                    showToast(
                        "Last sequence number must be digits only (e.g. 0000).",
                        "error",
                    );
                    return;
                }
                submitAddRecord("waybillPrefix", { prefix, companyName, lastSequenceNumber });
            }

            // ── ADMIN: DANGER ZONE ────────────────────────────────────
            // Wipes the transactional data of *this* environment — which one
            // that is follows from the backend this page talks to (config.js),
            // so the same panel serves dev and prod without a switch.
            const CLEAR_DATA_PHRASE = "PERMANENTLY DELETE ALL DATA";

            // ── CUSTOMER GROUP COLORS ────────────────────────────────
            // The color chip shown per customer group on the dispatch board.
            // Groups are the free-text Customer Group values on outlets; this
            // panel just assigns a color to each. Saved to a shared sheet so
            // every user sees the same colors (see CG_COLORS in core.js).
            // The group list for the current render, so row handlers pass an
            // index instead of interpolating a free-text group into onclick
            // (avoids breaking/injecting on quotes in the value).
            let _cgColorGroups = [];
            function renderCustomerGroupColors() {
                // Every group we know about: those used by outlets, plus any
                // that already carry a saved/seeded color.
                const groups = new Set();
                outlets.forEach((o) => {
                    const g = String(o.customerGroup || "").trim();
                    if (g) groups.add(g);
                });
                customerGroupColors.forEach((c) => {
                    const g = String(c.customerGroup || "").trim();
                    if (g) groups.add(g);
                });
                _cgColorGroups = [...groups].sort((a, b) =>
                    a.toUpperCase().localeCompare(b.toUpperCase()),
                );

                document.getElementById("cg-colors-count").textContent =
                    `${_cgColorGroups.length} groups`;

                const isAdmin = currentUser.role === "Admin";
                const tbody = document.getElementById("cg-colors-tbody");
                tbody.innerHTML = _cgColorGroups
                    .map((g, i) => {
                        const hex = cgEffectiveHex(g);
                        const picker = isAdmin
                            ? `<div class="cg-color-cell">
                                 <input type="color" class="cg-color-input" value="${hex}"
                                   onchange="saveCgColor(${i}, this.value)">
                                 <button class="btn btn-ghost btn-sm"
                                   onclick="saveCgColor(${i}, '')" title="Revert to automatic color">Auto</button>
                               </div>`
                            : `<span class="color-chip" style="background:${hex};border-color:rgba(0,0,0,.2)"></span>`;
                        return `<tr>
    <td style="font-family:'DM Mono',monospace">${esc(g)}</td>
    <td>${picker}</td>
    <td>${colorChip(g)}</td>
  </tr>`;
                    })
                    .join("");
            }

            function saveCgColor(index, color) {
                const group = _cgColorGroups[index];
                if (group == null) return;
                bgSave("saveCustomerGroupColor", [group, color], {
                    onOk: (r) => {
                        // Mirror the sheet change into the local caches so the
                        // board and this panel update without a reload.
                        const key = String(group).trim().toUpperCase();
                        const saved = r.customerGroupColor;
                        const existing = customerGroupColors.find(
                            (c) =>
                                String(c.customerGroup).trim().toUpperCase() ===
                                key,
                        );
                        if (existing) Object.assign(existing, saved);
                        else customerGroupColors.push(saved);
                        if (saved.active !== false && saved.color)
                            CG_COLORS[key] = saved.color;
                        else delete CG_COLORS[key];
                        renderCustomerGroupColors();
                    },
                });
            }

            function renderAdminPanel() {
                const env = (OMS_ENV && OMS_ENV.label) || "unknown";
                document.getElementById("admin-env-label").textContent = env;
                document.getElementById("admin-env-inline").textContent = env;
                // Never leave a matching phrase sitting in the box between
                // visits — the button must be re-armed deliberately each time.
                document.getElementById("admin-clear-confirm").value = "";
                onClearConfirmInput();
            }

            function onClearConfirmInput() {
                const typed = document
                    .getElementById("admin-clear-confirm")
                    .value.trim();
                document.getElementById("admin-clear-btn").disabled =
                    typed !== CLEAR_DATA_PHRASE;
            }

            function runClearAllData() {
                const phrase = document
                    .getElementById("admin-clear-confirm")
                    .value.trim();
                if (phrase !== CLEAR_DATA_PHRASE) return;

                const env = ((OMS_ENV && OMS_ENV.label) || "this").toUpperCase();
                if (
                    !confirm(
                        `LAST CHANCE — ${env}\n\nEvery trip, waybill, outlet, route-frequency row and audit entry in ${env} will be deleted permanently. This cannot be undone and there is no backup.\n\nDelete everything?`,
                    )
                )
                    return;

                setLoading("Clearing all data…");
                call("clearAllData", phrase).then(
                    (r) => {
                        hideLoading();
                        if (!r || !r.success) {
                            showToast(
                                "Clear failed: " + ((r && r.error) || "unknown"),
                                "error",
                            );
                            return;
                        }
                        showToast("All data cleared. Reloading…", "success");
                        // Every cached global (trips, outlets, the board) is
                        // stale now — a reload is cheaper than invalidating.
                        setTimeout(() => location.reload(), 900);
                    },
                    (err) => {
                        hideLoading();
                        showToast(
                            "Clear failed: " +
                                ((err && err.message) || "unknown"),
                            "error",
                        );
                    },
                );
            }
