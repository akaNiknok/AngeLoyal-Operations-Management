// ── ENVIRONMENT CONFIG ────────────────────────────────────────
// The frontend is static (Cloudflare Pages) and the backend is the Apps Script
// /exec endpoint, so which backend a page talks to is decided by where the page
// itself is served from. One map, no build step, no env vars.
//
// Both values are public by design: the /exec URL is world-reachable (the app
// authenticates per request, not per URL) and an OAuth *client ID* is not a
// secret — the client secret is gone entirely now that sign-in is GIS.
const OMS_ENVIRONMENTS = {
    "angeloyal-oms.pages.dev": {
        label: "prod",
        execUrl:
            "https://script.google.com/macros/s/AKfycby8gSa29N58Ny3mJjkDgdbnaIWUfQocPQwJ0QochAh_mLDsmYslJaO0ANDCbuXYNYV0/exec",
    },
    "angeloyal-oms-dev.pages.dev": {
        label: "dev",
        execUrl:
            "https://script.google.com/macros/s/AKfycbziNYgamxGPl7B8OVB1YYb1bZ2VZEdb9RC59pTEtUzSOeVNxAZCVtMc-6jJrqmdk26XgQ/exec",
    },
    // `wrangler pages dev web` — local frontend against the DEV backend.
    localhost: {
        label: "local",
        execUrl:
            "https://script.google.com/macros/s/AKfycbziNYgamxGPl7B8OVB1YYb1bZ2VZEdb9RC59pTEtUzSOeVNxAZCVtMc-6jJrqmdk26XgQ/exec",
    },
};

// Unknown host (a CF preview deployment, someone's fork) → DEV, never prod.
const OMS_ENV = OMS_ENVIRONMENTS[location.hostname] || OMS_ENVIRONMENTS.localhost;

const EXEC_URL = OMS_ENV.execUrl;

// The OAuth Web client ID (Script Properties → OAUTH_CLIENT_ID, or GCP → APIs &
// Services → Credentials). It must be the same client whose Authorized JavaScript origins list the hosts
// above, since GIS checks the calling origin against that list.
const OAUTH_CLIENT_ID = "118714839189-3h6n4p3bgjrp6ue2vfq4sk3c3a1q9sq8.apps.googleusercontent.com";
