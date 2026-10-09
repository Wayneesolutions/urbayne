// The app is the booth worker PWA served by this deployment (/w/). The phone loads it from the server, so a fix reaches every installed
// copy without a new store release, and the PWA's own service worker keeps it working with no signal.
//
// APP_URL is the public address of THIS region's API, for example https://api-in.example.com. One build per region: an Indian
// campaign's workers must talk to the Indian deployment and a Canadian campaign's to the Canadian one.
const url = process.env.APP_URL;
if (!url || !/^https:\/\/[a-z0-9.-]+$/i.test(url)) throw new Error('Set APP_URL to the region\'s https address, for example APP_URL=https://api-in.example.com');
const host = new URL(url).host;

module.exports = {
  appId: process.env.APP_ID || 'com.wayneesolutions.booth',
  appName: process.env.APP_NAME || 'Booth Worker',
  webDir: 'www',
  server: {
    url: `${url}/w/`,
    cleartext: false,
    // Nothing outside this deployment may load inside the app.
    allowNavigation: [host],
  },
  android: {
    allowMixedContent: false,
    // No remote debugging of the web view in a release build.
    webContentsDebuggingEnabled: false,
  },
};
