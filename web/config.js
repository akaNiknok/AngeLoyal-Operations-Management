// ── ENVIRONMENT CONFIG ────────────────────────────────────────
// The backend is a Pages Function on the same origin (/api), so the page
// never has to know which environment it is in — only the Settings danger
// zone shows the label. No build step, no env vars.
const OMS_ENVIRONMENTS = {
    "angeloyal-oms.pages.dev": { label: "prod" },
    "develop.angeloyal-oms.pages.dev": { label: "dev" },
    // `wrangler pages dev web` — local frontend, local D1.
    localhost: { label: "local" },
};

// Unknown host (a CF preview deployment, someone's fork) → "local", never prod.
const OMS_ENV = OMS_ENVIRONMENTS[location.hostname] || OMS_ENVIRONMENTS.localhost;

const API_URL = "/api";

// The OAuth Web client ID (GCP → APIs & Services → Credentials; also
// wrangler.toml [vars]). Public by design — a client ID is not a secret. It
// must be the client whose Authorized JavaScript origins list the hosts above,
// since GIS checks the calling origin against that list.
const OAUTH_CLIENT_ID = "118714839189-3h6n4p3bgjrp6ue2vfq4sk3c3a1q9sq8.apps.googleusercontent.com";
