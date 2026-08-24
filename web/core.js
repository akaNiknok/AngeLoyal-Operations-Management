            // ── XLSX PARSER (SheetJS, vendored) ───────────────────────
            // These three live in web/vendor/ rather than on a CDN: served
            // from our own origin they can't be swapped under us, and the CSP
            // in web/_headers can then refuse every third-party script origin.
            // Still loaded async (2 MB combined), so the ready flags stay.
            // Update = re-download the pinned version, re-check the diff.
            const xlsxScript = document.createElement("script");
            xlsxScript.src =
                "vendor/xlsx.full.min.js";
            xlsxScript.onload = () => {
                xlsxReady = true;
            };
            document.head.appendChild(xlsxScript);
            let xlsxReady = false;

            // ExcelJS reads cell fill colors (convoy batches in the route
            // file), which the community SheetJS build can't. Optional: if it
            // fails to load, imports still work, just without convoy detection.
            const excelJsScript = document.createElement("script");
            excelJsScript.src =
                "vendor/exceljs.min.js";
            excelJsScript.onload = () => {
                excelJsReady = true;
            };
            document.head.appendChild(excelJsScript);
            let excelJsReady = false;

            // html2canvas rasterizes the print HTML to a .jpg for the drivers'
            // group chat (Print/PDF still uses the browser dialog). Optional:
            // if it fails to load, the JPG buttons just toast.
            const html2canvasScript = document.createElement("script");
            html2canvasScript.src =
                "vendor/html2canvas.min.js";
            html2canvasScript.onload = () => {
                html2canvasReady = true;
            };
            document.head.appendChild(html2canvasScript);
            let html2canvasReady = false;

            // ── GLOBAL STATE ──────────────────────────────────────────
            let currentUser = { email: "", displayName: "", role: null };
            let employees = [];
            let trucks = [];
            let waybillPrefixes = [];
            let outlets = [];
            let defaultAssignments = [];
            let billingCategories = [];
            let routeTypeMap = [];
            let customerGroupColors = [];

            // Dispatch state
            let dispatchData = null; // { trips, date }
            let statusFilter = "all";
            let selectedForGroup = new Set(); // trip ids checked for convoy grouping
            let lastSelectedId = null; // anchor for shift-click range selection
            let crewRailOpen = false; // crew drag-and-drop rail beside the table
            let crewRailSort = "driver"; // driver | plate | type
            let saving = false;

            // Roster state (Truck Roster assignment tool)
            let selectedRosterTruckId = null;
            let selectedRosterEmpId = null;

            // Import state
            let importRows = []; // parsed from xlsx
            let importExcluded = new Set(); // indices excluded by dispatcher

            // ── AUTH STATE ────────────────────────────────────────────
            // Session token from a verified Google sign-in (see Auth.gs). It is
            // sent with every backend call via srv() and persisted so a reload
            // doesn't force a fresh sign-in. localStorage access is guarded —
            // some sandboxed iframe contexts block it.
            function storeGet(k) {
                try {
                    return localStorage.getItem(k);
                } catch (_) {
                    return null;
                }
            }
            function storeSet(k, v) {
                try {
                    localStorage.setItem(k, v);
                } catch (_) {}
            }
            function storeDel(k) {
                try {
                    localStorage.removeItem(k);
                } catch (_) {}
            }

            let sessionToken = storeGet("oms_session") || null;

            // ── SERVER GATEWAY ────────────────────────────────────────
            // All authenticated backend calls POST to the Apps Script /exec
            // endpoint, which dispatches through rpc(sessionToken, fn, args).
            // srv() keeps the google.script.run builder shape it had when this
            // ran inside Apps Script, so no call site anywhere else changed.
            function srv() {
                let success = () => {};
                let failure = (err) => {
                    setSyncing(false);
                    showToast(
                        (err && err.message) || "Something went wrong",
                        "error",
                    );
                };
                let proxy;
                const builder = {
                    withSuccessHandler(fn) {
                        success = fn;
                        return proxy;
                    },
                    withFailureHandler(fn) {
                        failure = fn;
                        return proxy;
                    },
                };
                proxy = new Proxy(builder, {
                    get(target, prop) {
                        if (prop in target) return target[prop];
                        if (typeof prop !== "string") return undefined;
                        // Any other property is treated as the backend fn name.
                        return (...args) => {
                            callBackend({
                                token: sessionToken,
                                fn: prop,
                                args: args,
                            }).then(
                                (res) => success(res),
                                (err) => {
                                    if (
                                        err &&
                                        /AUTH_REQUIRED/.test(err.message || "")
                                    ) {
                                        handleSessionExpired();
                                        return;
                                    }
                                    failure(err);
                                },
                            );
                        };
                    },
                });
                return proxy;
            }

            // One POST per call, to the /exec URL for this environment.
            //
            // Deliberately header-free: any header beyond a CORS-safelisted
            // Content-Type makes this a preflighted request, and Apps Script
            // cannot serve OPTIONS — the call would die before it was sent. A
            // bare string body defaults to text/plain, which is safelisted.
            // CORS then works because /exec 302s to googleusercontent.com,
            // which answers with Access-Control-Allow-Origin: *.
            //
            // doPost never throws, so a non-ok payload is a real app error;
            // a rejected fetch is the network being down.
            function callBackend(body) {
                return fetch(EXEC_URL, {
                    method: "POST",
                    body: JSON.stringify(body),
                })
                    .then((res) => res.json())
                    .then((payload) => {
                        if (!payload || payload.ok !== true) {
                            throw new Error(
                                (payload && payload.error) || "Request failed",
                            );
                        }
                        return payload.data;
                    });
            }

            // ── OPTIMISTIC SAVE ───────────────────────────────────────
            // Inline edits apply to the local model and re-render immediately
            // (feels instant), then persist in the background. On failure we
            // run `revert` to undo the local change and re-render.
            // ponytail: last-write-wins, no request queue — fine for this
            // low-concurrency ops tool; upgrade to per-record locking only if
            // two dispatchers start racing on the same trip.
            function bgSave(rpcName, args, opts) {
                opts = opts || {};
                setSyncing(true);
                srv()
                    .withSuccessHandler((r) => {
                        setSyncing(false);
                        if (r && r.success === false) {
                            showToast(r.error || "Save failed", "error");
                            if (opts.revert) opts.revert();
                            return;
                        }
                        if (opts.onOk) opts.onOk(r);
                    })
                    .withFailureHandler((e) => {
                        setSyncing(false);
                        showToast("Error: " + (e && e.message), "error");
                        if (opts.revert) opts.revert();
                    })
                    [rpcName](...args);
            }

            // ── BOOT ──────────────────────────────────────────────────
            window.addEventListener("load", bootApp);

            function bootApp() {
                // Set today's date on all date inputs
                const today = todayStr();
                document.getElementById("dispatch-date").value = today;
                document.getElementById("import-date").value = today;
                document.getElementById("at-date").value = today;

                if (sessionToken) {
                    loadAppData(); // resumes; AUTH_REQUIRED falls back to sign-in
                } else {
                    showSignIn();
                }
            }

            // ── GOOGLE SIGN-IN (GIS) ─────────────────────────
            // The page is served from our own origin now, so the sandbox that
            // forced the old server-side redirect flow is gone: Google Identity
            // Services can render its button inline and hand us an ID token,
            // which we POST to login() to trade for an app session.
            //
            // Set right after a sign-in so the next loadAppData() skips the
            // cached paint (see loadAppData).
            let justSignedIn = false;

            // Called by the GIS script's onload (see index.html).
            function initGis() {
                if (!window.google || !google.accounts || !google.accounts.id) {
                    return;
                }
                if (!OAUTH_CLIENT_ID) return; // showSignIn explains why
                google.accounts.id.initialize({
                    client_id: OAUTH_CLIENT_ID,
                    callback: handleCredentialResponse,
                    auto_select: false,
                    cancel_on_tap_outside: true,
                });
                renderSignInButton();
            }

            // Safe to call before the GIS script has loaded — its onload
            // renders the button then.
            function renderSignInButton() {
                const el = document.getElementById("gsi-button");
                if (!el || !OAUTH_CLIENT_ID) return;
                if (!window.google || !google.accounts || !google.accounts.id) {
                    return;
                }
                el.innerHTML = "";
                google.accounts.id.renderButton(el, {
                    theme: "outline",
                    size: "large",
                    text: "signin_with",
                    shape: "pill",
                });
            }

            // GIS hands back a Google ID token; trade it for an app session.
            function handleCredentialResponse(res) {
                if (!res || !res.credential) return;
                setLoading("Signing in…");
                callBackend({ fn: "login", idToken: res.credential }).then(
                    (r) => {
                        if (!r || !r.success) {
                            showSignIn(
                                "Sign-in failed. Please try again, or ask an administrator.",
                            );
                            return;
                        }
                        sessionToken = r.sessionToken;
                        storeSet("oms_session", sessionToken);
                        // Another account's cached boot data must never flash
                        // on screen for this one.
                        justSignedIn = true;
                        storeDel("oms_boot");
                        document.getElementById("auth-overlay").style.display =
                            "none";
                        loadAppData();
                    },
                    () => showSignIn("Sign-in failed. Please try again."),
                );
            }

            function handleSessionExpired() {
                sessionToken = null;
                storeDel("oms_session");
                storeDel("oms_boot");
                currentUser = { email: "", displayName: "", role: null };
                hideLoading();
                showSignIn("Your session expired. Please sign in again.");
            }

            // ── DATA LOAD (after sign-in) ─────────────────────────────
            // SWR boot: paint instantly from the last visit's boot data in
            // localStorage, then getBootData() revalidates in the background.
            // Skipped right after a fresh sign-in, so one account's cached UI
            // never flashes for another account.
            function loadAppData() {
                const cachedRaw = justSignedIn ? null : storeGet("oms_boot");
                justSignedIn = false;
                let painted = false;
                if (cachedRaw) {
                    try {
                        const boot = JSON.parse(cachedRaw);
                        if (boot && boot.session && boot.session.role) {
                            applyBootData(boot);
                            painted = true;
                        }
                    } catch (_) {}
                }
                if (!painted) setLoading("Loading data…");
                setSyncing(true);
                srv()
                    .withSuccessHandler((boot) => {
                        setSyncing(false);
                        const raw = JSON.stringify(boot);
                        if (boot.session && boot.session.role) {
                            storeSet("oms_boot", raw);
                        } else {
                            storeDel("oms_boot");
                        }
                        // Cached paint already matches the server → done.
                        if (painted && raw === cachedRaw) return;
                        applyBootData(boot);
                    })
                    .withFailureHandler((err) => {
                        setSyncing(false);
                        hideLoading();
                        // AUTH_REQUIRED is handled inside srv(); others toast.
                        if (!/AUTH_REQUIRED/.test(err.message || "")) {
                            showToast(
                                "Could not load app data: " +
                                    (err.message || err),
                                "error",
                            );
                        }
                    })
                    .getBootData();
            }

            function applyBootData(boot) {
                currentUser = boot.session || { role: null };
                employees = boot.employees || [];
                trucks = boot.trucks || [];
                waybillPrefixes = boot.waybillPrefixes || [];
                outlets = boot.outlets || [];
                defaultAssignments = boot.defaultAssignments || [];
                billingCategories = boot.billingCategories || [];
                routeTypeMap = boot.routeTypeMap || [];
                customerGroupColors = boot.customerGroupColors || [];
                applyCustomerGroupColors();

                applyRoleToUI(currentUser.role);
                hideLoading();

                // Signed in but not authorized → the gate is shown.
                if (!currentUser.role) return;

                populatePrefixSelects();
                onMasterDataReady();
            }

            function onMasterDataReady() {
                renderTruckList();
                renderEmpList();
                renderOutlets();
                populateAddTripSelects();
                loadDispatch(true);
            }

            // ── RBAC ──────────────────────────────────────────────────
            function applyRoleToUI(role) {
                const userBadge = document.getElementById("user-role-badge");
                const userEmail = document.getElementById("user-email");
                const name =
                    currentUser.displayName ||
                    currentUser.email ||
                    "Not signed in";
                userEmail.textContent = name;
                userBadge.textContent = role || "No access";
                userBadge.className = `user-role-badge role-${(role || "viewer").toLowerCase()}`;

                // Populate the account dropdown identity.
                document.getElementById("account-name").textContent = name;
                document.getElementById("account-mail").textContent =
                    currentUser.email || "Not signed in";
                document.getElementById("account-avatar").textContent = (
                    name.trim()[0] || "?"
                ).toUpperCase();

                // Show admin-only nav items
                if (role === "Admin") {
                    document
                        .querySelectorAll(".admin-only")
                        .forEach((el) => el.classList.remove("admin-only"));
                }
                // Nav items open to both Admin and Dispatcher.
                if (role === "Admin" || role === "Dispatcher") {
                    document
                        .querySelectorAll(".dispatcher-only")
                        .forEach((el) =>
                            el.classList.remove("dispatcher-only"),
                        );
                }

                // A signed-in account with no role can't use the app — show the
                // gate (with a way to sign out and try another account).
                const overlay = document.getElementById("auth-overlay");
                if (!role) {
                    showSignIn();
                } else {
                    overlay.style.display = "none";
                    maybeShowWhatsNew();
                }
            }

            // Shows the sign-in / not-authorized gate and refreshes the Google
            // sign-in link. With a signed-in but unauthorized account, also
            // offers sign-out so they can switch accounts.
            function showSignIn(msg) {
                const overlay = document.getElementById("auth-overlay");
                const email = currentUser && currentUser.email;
                document.getElementById("auth-title").textContent = email
                    ? "Account not authorized"
                    : "Sign in";
                document.getElementById("auth-msg").textContent = !OAUTH_CLIENT_ID
                    ? "Sign-in isn't configured yet (missing OAUTH_CLIENT_ID in web/config.js)."
                    : msg ||
                    (email
                        ? `You're signed in as ${email}, but this account isn't authorized for AngeLoyal OMS. Sign out and use an authorized Google account, or ask an administrator for access.`
                        : "Sign in with your Google account to use AngeLoyal OMS.");
                document.getElementById("auth-signout").style.display = email
                    ? ""
                    : "none";
                overlay.style.display = "";
                hideLoading();
                renderSignInButton();
            }

            // ── ACCOUNT MENU (switch / sign out) ──────────────────────
            // Sign-out drops our app session and clears the GIS auto-select
            // hint, so signing in again offers the account chooser rather than
            // jumping straight back into the same account.
            function switchAccount() {
                closeAccountMenu();
                signOut(true);
            }

            function signOut(thenPrompt) {
                const t = sessionToken;
                sessionToken = null;
                storeDel("oms_session");
                storeDel("oms_boot");
                currentUser = { email: "", displayName: "", role: null };
                // Best-effort server cleanup; a dead session is already gone.
                if (t) {
                    callBackend({ token: t, fn: "logout", args: [t] }).catch(
                        () => {},
                    );
                }
                // Stops GIS from silently re-signing them into the same account.
                if (window.google && google.accounts && google.accounts.id) {
                    google.accounts.id.disableAutoSelect();
                }
                closeAccountMenu();
                showSignIn(
                    thenPrompt
                        ? "Choose a Google account to continue."
                        : "You've been signed out.",
                );
            }

            function toggleAccountMenu(e) {
                if (e) e.stopPropagation();
                const dd = document.getElementById("account-dropdown");
                const open = dd.classList.toggle("open");
                document
                    .getElementById("user-chip-btn")
                    .setAttribute("aria-expanded", open ? "true" : "false");
            }

            function closeAccountMenu() {
                document
                    .getElementById("account-dropdown")
                    .classList.remove("open");
                document
                    .getElementById("user-chip-btn")
                    .setAttribute("aria-expanded", "false");
            }

            // Close the account menu when clicking anywhere outside it.
            document.addEventListener("click", (e) => {
                const menu = document.getElementById("account-menu");
                if (menu && !menu.contains(e.target)) closeAccountMenu();
            });

            function canEdit() {
                return (
                    currentUser.role === "Admin" ||
                    currentUser.role === "Dispatcher"
                );
            }

            // ── PANEL NAVIGATION ──────────────────────────────────────
            function switchPanel(name) {
                document
                    .querySelectorAll(".panel")
                    .forEach((p) => p.classList.remove("active"));
                document
                    .querySelectorAll(".nav-btn")
                    .forEach((b) => b.classList.remove("active"));
                document
                    .getElementById("panel-" + name)
                    .classList.add("active");
                document.getElementById("nav-" + name).classList.add("active");

                if (name === "dispatch") {
                    loadDispatch(true);
                }
                if (name === "roster") {
                    renderTruckList();
                    renderEmpList();
                }
                if (name === "outlets") renderOutlets();
                if (name === "trucks") renderTrucksAdmin();
                if (name === "employees") renderEmployeesAdmin();
                if (name === "waybill-prefixes") {
                    renderWaybillPrefixesAdmin();
                    refreshWaybillPrefixes();
                }
                if (name === "settings") {
                    renderBillingCategoriesAdmin();
                    renderRouteTypeMapAdmin();
                    renderCustomerGroupColors();
                    renderAdminPanel();
                }
            }

            // ── MODAL HELPERS ──────────────────────────────────────────
            function openModal(id) {
                document.getElementById(id).classList.add("open");
            }
            function closeModal(id) {
                document.getElementById(id).classList.remove("open");
            }

            // ── UTILITY HELPERS ───────────────────────────────────────
            function statusChipClass(status) {
                const map = {
                    Prepping: "sc-prepping",
                    Backlog: "sc-backlog",
                    Scheduled: "sc-scheduled",
                    Preload: "sc-preload",
                    Delivered: "sc-delivered",
                    Undelivered: "sc-undelivered",
                    "Foul Trip - No Redeliver": "sc-fouln",
                    "Foul Trip - For Redeliver": "sc-foutr",
                    Redeliver: "sc-redeliver",
                    "Two-Day Trip": "sc-twoday",
                };
                return map[status] || "sc-scheduled";
            }
            function shortStatus(status) {
                const map = {
                    Prepping: "Prepping",
                    Backlog: "Backlog",
                    Scheduled: "Scheduled",
                    Preload: "Preload",
                    Delivered: "Delivered",
                    Undelivered: "Undelivered",
                    "Foul Trip - No Redeliver": "Foul – No RD",
                    "Foul Trip - For Redeliver": "Foul – For RD",
                    Redeliver: "Redeliver",
                    "Two-Day Trip": "Two-Day",
                };
                return map[status] || status;
            }

            // Builds <option> tags for a Billing Category <select>, from the
            // active billingCategories list. If `selected` is set but isn't
            // in the active list (e.g. an inactive/legacy category still
            // assigned to a truck), it's added as an extra option so it
            // isn't silently dropped on save.
            function billingCategoryOptions(selected) {
                const names = billingCategories
                    .filter((c) => c.active !== false)
                    .map((c) => c.name);
                if (selected && !names.includes(selected)) names.push(selected);

                let html = `<option value="">—</option>`;
                html += names
                    .map(
                        (name) =>
                            `<option value="${esc(name)}" ${name === selected ? "selected" : ""}>${esc(name)}</option>`,
                    )
                    .join("");
                return html;
            }

            // Deterministic pastel chip / dot color from a label string, so a
            // given customer group or billing category always reads the same
            // color across every panel (no stored palette needed).
            function labelHue(str) {
                let h = 0;
                const s = String(str || "");
                for (let i = 0; i < s.length; i++)
                    h = (h * 31 + s.charCodeAt(i)) % 360;
                return h;
            }
            // Chain codes the client reads by color on the Rebisco route file
            // (col G fills — see Docs/Schema.md). A fixed color wins over the
            // hash so the board matches the paper. These are only the built-in
            // fallbacks — the server seeds the same palette into the Customer
            // Group Colors sheet, and applyCustomerGroupColors() merges any
            // edits from there on top (keyed uppercase).
            const CG_COLORS = {
                PG: "#92d050",
                SM: "#00b0f0",
                WM: "#ffe94d",
                RO: "#e5b8b7",
                SW: "#e5b8b7",
                PS: "#ffc000",
                ALFA: "#ffc000",
            };
            // Fold saved customer-group colors into CG_COLORS. Active rows set
            // the color; an inactive/blank row deletes the key so the group
            // falls back to its hashed color.
            function applyCustomerGroupColors() {
                customerGroupColors.forEach((c) => {
                    const key = String(c.customerGroup || "")
                        .trim()
                        .toUpperCase();
                    if (!key) return;
                    if (c.active !== false && c.color) CG_COLORS[key] = c.color;
                    else delete CG_COLORS[key];
                });
            }
            function colorChip(label) {
                if (!label) return `<span class="color-chip empty">—</span>`;
                const fixed = CG_COLORS[String(label).trim().toUpperCase()];
                if (fixed)
                    return `<span class="color-chip" title="${esc(label)}" style="background:${fixed};color:#1f2328;border-color:rgba(0,0,0,.2)">${esc(label)}</span>`;
                const h = labelHue(label);
                return `<span class="color-chip" title="${esc(label)}" style="background:hsl(${h} 62% 91%);color:hsl(${h} 55% 30%);border-color:hsl(${h} 45% 78%)">${esc(label)}</span>`;
            }
            // The effective chip color for a group as a #rrggbb hex, so a
            // <input type="color"> can default to what the board currently
            // shows — a set/fixed color as-is, else the hashed light tint.
            function cgEffectiveHex(label) {
                const fixed = CG_COLORS[String(label).trim().toUpperCase()];
                if (fixed && /^#[0-9a-f]{6}$/i.test(fixed)) return fixed;
                return hslToHex(labelHue(label), 62, 91);
            }
            function hslToHex(h, s, l) {
                s /= 100;
                l /= 100;
                const a = s * Math.min(l, 1 - l);
                const f = (n) => {
                    const k = (n + h / 30) % 12;
                    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
                    return Math.round(255 * c)
                        .toString(16)
                        .padStart(2, "0");
                };
                return `#${f(0)}${f(8)}${f(4)}`;
            }
            function catSwatch(name) {
                if (!name) return "";
                const h = labelHue(name);
                return `<span class="cat-swatch" title="${esc(name)}" style="background:hsl(${h} 60% 55%)"></span>`;
            }

            // Single source of truth for a day's row order — used by both the
            // dispatch board (getFilteredTrips) and the export builder
            // (buildFinalRouteModel in Export.html), so the printed/exported
            // route always matches what the dispatcher arranged on screen.
            //
            // Order: explicit Sort Order (blank sorts last) with id as a
            // stable tiebreak, then convoy members are pulled contiguous by
            // anchoring each convoy block at its earliest position in that
            // sorted order (mirrors the group/FO anchor trick already used
            // in Export.html).
            // The FO is the load: after import every FO rides exactly one truck
            // (Import.html hands a convoy's surplus trucks to the following
            // FOs rather than piling them on the anchor), so one FO = one crew
            // = one waybill. Split shares are suffixed (e.g. "437463/B") and
            // key separately — a share is a different truck. Null = no FO #,
            // i.e. a group of one. Shared by the board and the exports so the
            // two can't drift apart.
            function foKey(t) {
                return t && t.foNumber
                    ? t.foNumber + "-" + (t.foSplitSuffix || "")
                    : null;
            }

            // Keeps every row of a group adjacent: each member sorts to where
            // the group's FIRST member landed, ties broken by incoming order.
            // Rows with a null key keep their own position.
            function clusterBy(list, keyOf) {
                const idx = new Map(list.map((t, i) => [t.id, i]));
                const anchor = {};
                list.forEach((t, i) => {
                    const k = keyOf(t);
                    if (k && !(k in anchor)) anchor[k] = i;
                });
                const at = (t) => {
                    const k = keyOf(t);
                    return k ? anchor[k] : idx.get(t.id);
                };
                return [...list].sort(
                    (a, b) => at(a) - at(b) || idx.get(a.id) - idx.get(b.id),
                );
            }

            // Day order: the dispatcher's sortOrder, then clustered so a load's
            // rows sit together and a convoy's loads sit together. Clustering
            // is applied on every read, so no drag can leave a load's rows
            // scattered — the board's merged cells depend on that adjacency.
            // Convoy runs last because it is the larger unit (a convoy contains
            // whole FOs); its stable tie-break preserves the FO clustering.
            function orderedDayTrips(trips) {
                const list = [...(trips || [])].sort((a, b) => {
                    const sa = a.sortOrder == null ? Infinity : a.sortOrder;
                    const sb = b.sortOrder == null ? Infinity : b.sortOrder;
                    return sa - sb || a.id - b.id;
                });
                return clusterBy(clusterBy(list, foKey), (t) =>
                    t.convoyGroup ? "cg-" + t.convoyGroup : null,
                );
            }

            function indexById(arr) {
                const m = {};
                (arr || []).forEach((item) => {
                    if (item.id != null) m[item.id] = item;
                });
                return m;
            }
            function roleBadgeClass(role) {
                if (role === "Driver") return "badge-driver";
                if (role === "Driver-Helper") return "badge-driver-helper";
                return "badge-helper";
            }
            function roleBadgeAbbr(role) {
                if (role === "Driver") return "D";
                if (role === "Driver-Helper") return "DH";
                return "H";
            }
            function esc(s) {
                return String(s || "")
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;");
            }
            function todayStr() {
                const d = new Date();
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            }
            function isoToMDY(iso) {
                if (!iso) return "";
                const [y, m, d] = iso.split("-");
                return `${Number(m)}/${Number(d)}/${y}`;
            }

            function setSyncing(on) {
                document
                    .getElementById("sync-dot")
                    .classList.toggle("loading", on);
                document.getElementById("sync-text").textContent = on
                    ? "Syncing…"
                    : "Synced";
            }
            function setLoading(msg) {
                document.getElementById("loading-text").textContent =
                    msg || "Loading…";
                document.getElementById("loading").style.display = "";
            }
            function hideLoading() {
                document.getElementById("loading").style.display = "none";
            }

            let toastTimer;
            function showToast(msg, type) {
                const t = document.getElementById("toast");
                t.textContent = msg;
                t.className = `toast show ${type || ""}`;
                clearTimeout(toastTimer);
                toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
            }
