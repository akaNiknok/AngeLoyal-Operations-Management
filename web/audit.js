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
                    from.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

                setLoading("Loading the audit log…");
                call("getAuditLog", {
                    from: isoToMDY(from),
                    to: isoToMDY(to),
                    search: document.getElementById("au-search").value,
                    limit: AUDIT_PAGE,
                    offset: offset,
                })
                    .then((r) => {
                        hideLoading();
                        auditOffset = offset;
                        auditHasMore = !!r.hasMore;
                        renderAudit(r.entries || []);
                    })
                    .catch((err) => {
                        hideLoading();
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
                    .map(
                        (e) => `<tr>
    <td style="font-family:'DM Mono',monospace;font-size:11px;white-space:nowrap">${esc(e.timestamp)}</td>
    <td>${esc(e.userEmail)}</td>
    <td style="font-family:'DM Mono',monospace;font-size:11px">${esc(e.action)}</td>
    <td style="color:var(--muted)">${esc(e.tableName)}${e.rowId ? " #" + e.rowId : ""}</td>
    <td>${esc(e.detail)}</td>
    <td style="color:var(--muted)">${auditValue(e.oldValue)}</td>
    <td>${auditValue(e.newValue)}</td>
  </tr>`,
                    )
                    .join("");
            }
