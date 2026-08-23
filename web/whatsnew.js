// ── WHAT'S NEW ────────────────────────────────────────────
// Shows the release notes from web/changelog.json, which
// scripts/sync-changelog.mjs generates from the GitHub Releases at
// deploy time. Because the file ships with the frontend, the notes
// always describe the code the person is actually running.
//
// It opens by itself once per release — on a first sign-in, and again
// after each update — and on demand from the account menu.

let changelogReleases = null; // cached after the first successful load

const SEEN_KEY = "oms_seen_release";

// Loads the changelog once per page load. Resolves to [] on any
// failure: a missing or malformed file must never block the app.
function loadChangelog() {
    if (changelogReleases) return Promise.resolve(changelogReleases);
    return fetch("changelog.json", { cache: "no-cache" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            changelogReleases =
                data && Array.isArray(data.releases) ? data.releases : [];
            return changelogReleases;
        })
        .catch(() => []);
}

// Show it when this browser has never seen a release (first sign-in)
// or has seen an older one than the newest we ship.
function shouldShowWhatsNew(latestVersion, seenVersion) {
    if (!latestVersion) return false;
    return seenVersion !== latestVersion;
}

// Called from bootApp once the user is signed in and authorized.
function maybeShowWhatsNew() {
    loadChangelog().then((releases) => {
        if (!releases.length) return;
        const latest = releases[0].version;
        if (!shouldShowWhatsNew(latest, storeGet(SEEN_KEY))) return;
        openWhatsNew();
    });
}

// Account menu → "What's new?". Always opens, seen or not.
function openWhatsNew() {
    closeAccountMenu();
    loadChangelog().then((releases) => {
        const body = document.getElementById("whatsnew-body");
        body.innerHTML = releases.length
            ? releases.map(renderRelease).join("")
            : '<div class="whatsnew-empty">No release notes yet.</div>';
        openModal("modal-whatsnew");
        // Opening it counts as reading it, so it doesn't reappear.
        if (releases.length) storeSet(SEEN_KEY, releases[0].version);
    });
}

function closeWhatsNew() {
    closeModal("modal-whatsnew");
}

function renderRelease(r) {
    return (
        '<div class="whatsnew-release">' +
        '<div class="whatsnew-head">' +
        '<span class="whatsnew-version">' +
        escapeHtml(r.version) +
        "</span>" +
        (r.date
            ? '<span class="whatsnew-date">' +
              escapeHtml(formatReleaseDate(r.date)) +
              "</span>"
            : "") +
        "</div>" +
        (r.title
            ? '<div class="whatsnew-title">' + escapeHtml(r.title) + "</div>"
            : "") +
        '<div class="whatsnew-notes">' +
        renderNotes(r.body || "") +
        "</div>" +
        "</div>"
    );
}

// "2026-08-23" → "23 Aug 2026". Left as-is if it isn't a plain date.
function formatReleaseDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return iso;
    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Renders the small slice of Markdown the release notes are written in:
// headings, bullet lists, paragraphs, **bold** and `code`.
//
// ponytail: a hand-rolled subset, not a Markdown library — we author these
// notes ourselves, so the input is known. Everything is HTML-escaped first,
// so an unsupported construct degrades to plain text rather than breaking
// out. Reach for a real parser only if the notes ever stop being ours.
function renderNotes(md) {
    const lines = escapeHtml(md).split("\n");
    const out = [];
    let inList = false;

    const closeList = () => {
        if (inList) {
            out.push("</ul>");
            inList = false;
        }
    };

    lines.forEach((raw) => {
        const line = raw.trim();

        if (!line) {
            closeList();
            return;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            closeList();
            out.push("<h4>" + inline(heading[2]) + "</h4>");
            return;
        }

        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) {
            if (!inList) {
                out.push("<ul>");
                inList = true;
            }
            out.push("<li>" + inline(bullet[1]) + "</li>");
            return;
        }

        closeList();
        out.push("<p>" + inline(line) + "</p>");
    });

    closeList();
    return out.join("");
}

function inline(s) {
    return s
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
}
