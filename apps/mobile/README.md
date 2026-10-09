# Booth Worker mobile app (Android first)

A thin Capacitor wrapper around the booth worker / canvassing PWA (`/w/`). It puts the app in the Play Store and on home screens, and
nothing else: the screens, the offline queue and the sync are the PWA's. The phone loads the PWA from the server, so fixes reach every
installed copy without a new store release, and the service worker keeps it working with no signal.

**Status: configured, not built.** The wrapper was written without an Android SDK, so no APK/AAB has been produced or tried on a phone.
Do the first build with the checks at the bottom.

## Before you ask for this

The PWA already installs from the browser ("Add to home screen") and works offline. A store app is worth it only if field teams ask
for it (a Play Store listing, or phones where installing from the browser is hard).

## Build (one app per region)

You need Node 20+, Android Studio (with an Android SDK) and a Google Play developer account.

```bash
cd apps/mobile
npm install                       # separate from the pnpm workspace on purpose
export APP_URL=https://api-in.example.com   # this region's address (Windows PowerShell: $env:APP_URL = "...")
npx cap add android               # creates android/ (not committed)
npx cap sync
npx cap open android              # builds in Android Studio: Build > Generate Signed Bundle (AAB)
```

- India build: `APP_URL` = the India deployment, `APP_ID=com.wayneesolutions.booth.in`. Canada: the Canada address and `.ca`.
  Two separate store listings, so a worker can never end up talking to the wrong region.
- Keep the signing key (`*.keystore`) safe and out of git. Losing it means you can never update the listing.
- Icons and splash: generate from `apps/api/src/public/worker/icon.svg` (export a 1024 px PNG and use `@capacitor/assets`).

## Check before the first release

1. Install the build on a real phone; sign in with a worker's number; see the assigned areas.
2. Switch on airplane mode, mark ten houses, switch it off: the visits sync and the dashboard shows them.
3. Force-close the app while offline, reopen it: the queued visits are still there.
4. Confirm the app cannot open any address outside `APP_URL` (`allowNavigation`).
5. Complete the Play Console data-safety form honestly: the app handles phone numbers (login) and location is not used.
6. iOS is not set up. It needs a Mac and an Apple developer account (`npx cap add ios`).
