export const config = {
  // OAuth "Web application" client ID from Google Cloud Console (see README).
  googleClientId: '643562071508-g0f7ul7kol4p2426076h3o7cmjs1hf4p.apps.googleusercontent.com',

  // ViaggiaTreno sends no CORS headers, so calls go through a proxy:
  // dev-server.mjs when running locally, the Deno Deploy proxy (deno/) when published.
  vtBase: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? '/vt'
    : 'https://traim-proxy.deno.dev/vt',

  // STA (South Tyrol) journey planner, an EFA backend that allows cross-origin calls.
  staBase: 'https://efa.sta.bz.it/apb',

  // Name of the Google Sheet created in Drive to hold routes and settings.
  spreadsheetName: 'Traim',

  // Current train + up to 3 following ones.
  maxTrains: 4,

  refreshSeconds: 60,
};
