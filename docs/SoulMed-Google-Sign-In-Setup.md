# SoulMed: enable Continue with Google

Status: implementation prepared; Google OAuth Client ID and real browser acceptance test are still required. Existing email/password login remains available. No Google account password or OAuth client secret should be shared with the developer or placed in frontend configuration.

## 1. Create the Google configuration

1. Sign in to https://console.cloud.google.com/ with the Google account that should own SoulMed's project. Create or select a SoulMed project.
2. Open Google Auth Platform (or APIs & Services > OAuth consent screen, depending on the console view).
3. In Branding, set application name **SoulMed**, support email, developer contact, and the actual SoulMed homepage/privacy policy/terms URLs. Use URLs that exist and are publicly accessible. Add `soulmed.ai` as an authorized domain where requested; complete domain ownership verification if Google requests it.
4. Choose the External audience if students will use personal Gmail accounts. While the app is in Testing, add the Google accounts used for acceptance testing as test users. Publish to Production when ready for public sign-in; follow any branding/verification requirements shown in the console.
5. Use only basic identity information (openid, email, profile). Do not enable Gmail inbox scopes or request Drive access.
6. Under Clients, create an OAuth client of type **Web application**.
7. Add authorized JavaScript origins for the addresses actually used:
   - `https://soulmed.ai`
   - `http://localhost:5173` for local testing.
   - Add `http://localhost:5174`, `http://127.0.0.1:5173`, `https://www.soulmed.ai`, or another environment only if you actually use that exact origin. Origin scheme, hostname and port must match. No paths, wildcards or trailing login paths.
8. This implementation uses the Google Identity Services JavaScript popup/callback flow. It does not send Google's response to a redirect URI, so an OAuth redirect callback URI is not required for this flow.
9. Copy the **Client ID**, ending in `.apps.googleusercontent.com`. This ID is public. No client secret is used by this ID-token sign-in flow.

Separate development and production OAuth clients are preferable. Each backend accepts its own configured Client ID; it does not trust an ID supplied in a login request.

## 2. Configure SoulMed

Set **GOOGLE_CLIENT_ID** in the backend runtime. Keep the existing strong **JWT_SECRET**; the challenge uses it but never exposes it.

The frontend reads the public Client ID and a browser-bound nonce from `/api/auth/google/config`. There is no separate `VITE_GOOGLE_CLIENT_ID` to keep in sync. The API serves this configuration with no-store/private cache headers. When the backend has no Client ID, it returns `enabled: false` and the button is hidden. An older/unavailable backend also leaves password login usable.

For production, provide the public Client ID after creating it. Prepare a reviewed infrastructure/runtime configuration update for the migrated backend rather than making an untracked ECS console change. Deploy backend and frontend through their existing reviewed production release paths. This implementation does not modify AWS runtime configuration or deploy automatically.

## 3. Local test

Frontend branch: `feat/google-sign-in` in `D:\SoulMedAi\myBranch\frontend\soulmed-page-range-fix`.
Backend branch: `feat/google-sign-in` in `D:\SoulMedAi\myBranch\backend\backend-google-sign-in`.

Use your development database and development email settings. Do not copy production secrets into these folders.

Backend terminal (after existing local backend environment is configured):

```powershell
cd D:\SoulMedAi\myBranch\backend\backend-google-sign-in
$env:GOOGLE_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com'
$env:PORT = '4001'
npm.cmd run dev
```

Frontend terminal:

```powershell
cd D:\SoulMedAi\myBranch\frontend\soulmed-page-range-fix
```

Set `VITE_DEV_BACKEND_URL=http://localhost:4001` in that frontend's `.env.local`, then:

```powershell
npm.cmd run dev -- --port 5173 --strictPort
```

Open `http://localhost:5173/Login`. Keep the browser talking to the API through the same-origin `/api` proxy so the challenge/session cookies work. Do not visit the backend on a separate origin as the login UI.

## 4. Expected account behavior

- Existing Gmail user: matching email is found case-insensitively and linked to the existing account, preserving its password, subscription, progress, roles and permissions. Google confirms Gmail ownership. Google Workspace ownership with a verified hosted-domain claim is also accepted.
- Returning linked user: Google's stable subject ID identifies the same account. A changed Google email does not overwrite the SoulMed account email.
- Existing account with an unrelated third-party email provider: enter the existing **SoulMed password**, not the Google password, to confirm linking. Google email verification alone is insufficient for these addresses.
- New third-party email provider account: register and verify that email in SoulMed first, then link using its SoulMed password.
- New Gmail/Workspace user: creates a student account only. It does not create administrator/teacher privileges.
- Google-first user who wants password login: use the existing Forgot password flow for the account email to set a SoulMed password. Google passwords are never copied into SoulMed. Email delivery must be configured for this step.
- Inactive users remain blocked. Conflicting Google links, ambiguous duplicate email accounts and concurrent link changes fail closed rather than merging records.

Google ID tokens and linking passwords are used only for the authentication request. The frontend does not store them in localStorage/sessionStorage. Normal SoulMed HttpOnly session cookies are issued on success.

## 5. Acceptance checklist before production activation

1. Password login and normal registration still work when Google is unconfigured.
2. Google button appears with the correct SoulMed branding after configuration.
3. A new Gmail test user is created once, as a student.
4. An existing Gmail/password user signs in both ways and retains the same account ID and entitlements.
5. A linked Google-first user sets a SoulMed password via email reset and can use both methods.
6. A disabled user cannot sign in. No user is promoted to teacher/admin by Google sign-in.
7. Third-party email linking prompts for the existing SoulMed password; incorrect passwords fail.
8. Logout, refresh and subsequent Google sign-in work. Canceling Google's account chooser does not affect password login.
9. Test a mobile browser and the deployed HTTPS site. Check that CSP/COOP response headers allow the official Google library and popup to operate.
10. The browser config endpoint must not be cached by a proxy/CDN. Check for no-store/private headers and verify nonce binding for separate browser sessions.

Common errors: `origin_mismatch` means the actual browser origin is not in the OAuth client's authorized JavaScript origins. An invalid audience means the backend Client ID differs from the one that issued the token. Expired challenge or cookie failure should be retried through a fresh button; use the same-origin API proxy and HTTPS in production.

To disable the feature, remove GOOGLE_CLIENT_ID through the reviewed backend runtime configuration and deploy it. Existing password accounts and stored Google links are retained.

References:
- https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- https://developers.google.com/identity/gsi/web/reference/js-reference
