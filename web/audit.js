            // ══════════════════════════════════════════════════════════
            //  AUDIT LOG PANEL
            //  One page of the append-only audit_log, newest first.
            //  The log only grows, so the panel always sends a date
            //  range and pages through the result — it never asks for
            //  the whole table.
            // ══════════════════════════════════════════════════════════

            const AUDIT_PAGE = 200;
            let auditOffset = 0;
            let auditHasMore = false;

            function openAudit() {
                const from = document.getElementById("au-from");
                const to = document.getElementById("au-to");
                if (!from.value) {
                    const d = new Date();
                    to.value = todayStr();
                    d.setDate(d.getDate() - 6);
                    from.value = isoDate(d);
                }
                loadAudit(0);
            }

            // A filter change always restarts at page 1: page 3 of the old
            // range means nothing in the new one.
            function reloadAudit() {
                loadAudit(0);
            }

            function loadAudit(offset) {
                const from = document.getElementById("au-from").value;
                const to = document.getElementById("au-to").value;
                if (!from || !to) return;

                setPanelLoading("audit", "Loading the audit log…");
                call("getAuditLog", {
                    from: isoToMDY(from),
                    to: isoToMDY(to),
                    search: document.getElementById("au-search").value,
                    limit: AUDIT_PAGE,
                    offset: offset,
                })
                    .then((r) => {
                        setPanelLoading("audit", "");
                        auditOffset = offset;
                        auditHasMore = !!r.hasMore;
                        renderAudit(r.entries || []);
                    })
                    .catch((err) => {
                        setPanelLoading("audit", "");
                        toastError(err);
                    });
            }

            function auditPage(delta) {
                const next = auditOffset + delta * AUDIT_PAGE;
                if (next < 0 || (delta > 0 && !auditHasMore)) return;
                loadAudit(next);
            }

            // Old and new values are free text and can hold a whole JSON row.
            // The cell shows the head of it; the full value is the tooltip.
            function auditValue(v) {
                if (!v) return "";
                const short = v.length > 60 ? v.slice(0, 60) + "…" : v;
                return `<span title="${esc(v)}">${esc(short)}</span>`;
            }

            function renderAudit(entries) {
                const first = entries.length ? auditOffset + 1 : 0;
                document.getElementById("au-count").textContent = entries.length
                    ? `${first}–${auditOffset + entries.length}${auditHasMore ? "" : " of " + (auditOffset + entries.length)}`
                    : "No entries";
                document.getElementById("au-prev").disabled = auditOffset === 0;
                document.getElementById("au-next").disabled = !auditHasMore;

                document.getElementById("au-tbody").innerHTML = entries
                    .map(auditRowHtml)
                    .join("");
            }

            // One log entry as a table row. The Audit Log panel and the
            // History modal share it, so both read the same way.
            function auditRowHtml(e) {
                return `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;white-space:nowrap">${esc(e.timestamp)}</td>
    <td>${esc(e.userEmail)}</td>
    <td style="font-family:'DM Mono',monospace;font-size:11px">${esc(e.action)}</td>
    <td style="color:var(--muted)">${esc(e.tableName)}${e.rowId ? " #" + e.rowId : ""}</td>
    <td>${esc(e.detail)}</td>
    <td style="color:var(--muted)">${auditValue(e.oldValue)}</td>
    <td>${auditValue(e.newValue)}</td>
  </tr>`;
            }

            // ── HISTORY MODAL ─────────────────────────────────────────
            // The History button on a trip or a billing line. The server
            // adds the rows of its waybill and checks the permission for
            // the table, so any role that sees the record sees its history.
            let historyTicket = 0;

            function openHistory(tableName, rowId, title) {
                const ticket = ++historyTicket;
                const body = document.getElementById("hist-body");
                const note = (msg) => `<tr><td colspan="7" class="tb-label">${esc(msg)}</td></tr>`;
                document.getElementById("hist-title").textContent = "History · " + title;
                body.innerHTML = note("Loading…");
                openModal("modal-history");
                call("getRowHistory", tableName, rowId).then(
                    (r) => {
                        // A newer History click owns the modal.
                        if (ticket !== historyTicket) return;
                        body.innerHTML = r.entries.length
                            ? r.entries.map(auditRowHtml).join("") +
                              (r.hasMore ? note("Showing the newest " + r.entries.length + " changes.") : "")
                            : note("No changes recorded.");
                    },
                    (e) => {
                        if (ticket !== historyTicket) return;
                        closeModal("modal-history");
                        toastError(e);
                    },
                );
            }
