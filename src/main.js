const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  nativeImage,
  session,
} = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch(
  'disable-features',
  'ExtensionManifestV2Unsupported,ExtensionManifestV2Disabled'
);

const WINDOW_WIDTH = 280;
const WINDOW_HEIGHT = 158;
const READY_TIMEOUT_MS = 12000;
const DEFAULT_COUNT = 3;
const TICK_MS = 16;

const SUBWAY_ID = 'G8N6wAiNL1o';
const PARKOUR_IDS = ['GG11lZ_K3LY', '0c4KWfPhgWA'];

const YT_PARTITION = 'persist:parkour';
const EMBED_REFERER = 'https://www.google.com/';

function chromeUserAgent() {
  const chrome = process.versions.chrome;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
  headers[name] = value;
}

function embedUrl(videoId, startAt) {
  const embed = new URL(`https://www.youtube.com/embed/${videoId}`);
  embed.search = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    modestbranding: '1',
    rel: '0',
    loop: '1',
    playlist: videoId,
    start: String(startAt),
    playsinline: '1',
    iv_load_policy: '3',
  }).toString();
  return embed.toString();
}

let tray = null;
let windows = [];
let movers = [];
let animTimer = null;
let readyTimer = null;
let active = false;
let loading = false;
let revealed = false;
let windowCount = DEFAULT_COUNT;
let generation = 0;
const readyIds = new Set();

function videoFor(index) {
  if (index % 2 === 0) return SUBWAY_ID;
  return PARKOUR_IDS[Math.floor(index / 2) % PARKOUR_IDS.length];
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function refreshMenu() {
  if (!tray) return;
  const counts = [1, 2, 3, 4, 5, 6].map((n) => ({
    label: String(n),
    type: 'radio',
    checked: windowCount === n,
    enabled: !loading,
    click: () => setCount(n),
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: loading ? 'Cargando…' : active ? 'Desactivar' : 'Activar',
      enabled: !loading,
      click: () => {
        if (active) stop();
        else start();
      },
    },
    { type: 'separator' },
    { label: 'Ventanas', submenu: counts },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        stop();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

const AD_SKIP_SCRIPT = `(() => {
  if (window.__parkourSkipAds) return;
  window.__parkourSkipAds = true;
  const skipSelectors = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-overlay-close-button',
  ];
  const pass = () => {
    for (const selector of skipSelectors) {
      for (const button of document.querySelectorAll(selector)) button.click();
    }
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video') || document.querySelector('video');
    if (!video) return;
    const ad = !!player && player.classList.contains('ad-showing');
    if (!ad) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    video.muted = true;
    video.playbackRate = 16;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.max(video.duration - 0.05, 0);
    }
  };
  pass();
  setInterval(pass, 200);
})();`;

function attachAdFilter(win) {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch {
    return;
  }

  dbg.on('message', async (_event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request, responseStatusCode, responseHeaders } = params;
    const url = request?.url || '';
    if (!url.includes('/youtubei/v1/player')) {
      dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    try {
      const { body, base64Encoded } = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      const json = JSON.parse(text);
      delete json.adPlacements;
      delete json.playerAds;
      delete json.adSlots;
      const headers = (responseHeaders || []).filter((header) => {
        const name = header.name.toLowerCase();
        return name !== 'content-encoding' && name !== 'content-length';
      });
      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId,
        responseCode: responseStatusCode || 200,
        responseHeaders: headers,
        body: Buffer.from(JSON.stringify(json)).toString('base64'),
      });
    } catch {
      dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });

  dbg.sendCommand('Fetch.enable', {
    patterns: [{ urlPattern: '*youtubei/v1/player*', requestStage: 'Response' }],
  }).catch(() => {});
}

function attachAdSkip(win) {
  win.webContents.on('dom-ready', () => {
    if (win.isDestroyed()) return;
    const url = win.webContents.getURL();
    if (!url.includes('youtube.com')) return;
    win.webContents.executeJavaScript(AD_SKIP_SCRIPT).catch(() => {});
  });
}

const UBLOCK_PATH = path.join(__dirname, '../vendor/ublock-origin/uBlock0.chromium');

async function loadUblock(ses) {
  const extension = await ses.loadExtension(UBLOCK_PATH);
  console.log(`uBlock Origin ${extension.version} cargado`);
}

function installYoutubeSession() {
  const ses = session.fromPartition(YT_PARTITION);
  const ua = chromeUserAgent();
  const major = process.versions.chrome.split('.')[0];
  ses.setUserAgent(ua);

  ses.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.youtube.com/*',
        '*://*.googlevideo.com/*',
        '*://*.ytimg.com/*',
        '*://*.ggpht.com/*',
        '*://*.google.com/*',
        '*://*.gstatic.com/*',
      ],
    },
    (details, callback) => {
      const headers = details.requestHeaders;
      setHeader(headers, 'User-Agent', ua);
      setHeader(
        headers,
        'Sec-CH-UA',
        `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`
      );
      setHeader(headers, 'Sec-CH-UA-Mobile', '?0');
      setHeader(headers, 'Sec-CH-UA-Platform', '"macOS"');
      const isEmbed = details.url.includes('youtube.com/embed/');
      const hasReferer = Object.keys(headers).some((key) => key.toLowerCase() === 'referer');
      if (isEmbed && !hasReferer) setHeader(headers, 'Referer', EMBED_REFERER);
      callback({ requestHeaders: headers });
    }
  );

  return ses;
}

function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../assets/trayTemplate.png')
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Parkour flotante');
  refreshMenu();
}

function destroyWindows() {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  movers = [];
  readyIds.clear();
  for (const win of windows) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows = [];
}

function createHiddenWindow(index, gen) {
  const area = workArea();
  const x = area.x + Math.random() * Math.max(0, area.width - WINDOW_WIDTH);
  const y = area.y + Math.random() * Math.max(0, area.height - WINDOW_HEIGHT);
  const startAt = Math.floor(Math.random() * 1200);

  const win = new BrowserWindow({
    x: Math.round(x),
    y: Math.round(y),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#000000',
    webPreferences: {
      partition: YT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setUserAgent(chromeUserAgent());
  win.setOpacity(0);
  win.showInactive();
  attachAdFilter(win);
  attachAdSkip(win);
  win.webContents.on('media-started-playing', () => {
    markReady(win, gen);
  });

  const videoId = videoFor(index);
  win.loadURL(embedUrl(videoId, startAt));

  return win;
}

function markReady(win, gen) {
  if (gen !== generation || win.isDestroyed()) return;
  readyIds.add(win.id);
  if (windows.length > 0 && windows.every((item) => readyIds.has(item.id) || item.isDestroyed())) {
    reveal(gen);
  }
}

function reveal(gen) {
  if (gen !== generation || !active || revealed) return;
  revealed = true;
  loading = false;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }

  const area = workArea();
  movers = [];
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    const bounds = win.getBounds();
    const speed = 1.2 + Math.random() * 1.4;
    const angle = Math.random() * Math.PI * 2;
    movers.push({
      win,
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - WINDOW_WIDTH),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - WINDOW_HEIGHT),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    });
    win.setOpacity(1);
  }

  animTimer = setInterval(tick, TICK_MS);
  refreshMenu();
}

function tick() {
  const area = workArea();
  const maxX = area.x + area.width - WINDOW_WIDTH;
  const maxY = area.y + area.height - WINDOW_HEIGHT;

  for (const mover of movers) {
    if (mover.win.isDestroyed()) continue;
    mover.x += mover.vx;
    mover.y += mover.vy;

    if (mover.x <= area.x) {
      mover.x = area.x;
      mover.vx = Math.abs(mover.vx);
    } else if (mover.x >= maxX) {
      mover.x = maxX;
      mover.vx = -Math.abs(mover.vx);
    }

    if (mover.y <= area.y) {
      mover.y = area.y;
      mover.vy = Math.abs(mover.vy);
    } else if (mover.y >= maxY) {
      mover.y = maxY;
      mover.vy = -Math.abs(mover.vy);
    }

    mover.win.setPosition(Math.round(mover.x), Math.round(mover.y));
  }
}

function start() {
  const gen = ++generation;
  active = true;
  loading = true;
  revealed = false;
  destroyWindows();
  refreshMenu();

  windows = Array.from({ length: windowCount }, (_, index) =>
    createHiddenWindow(index, gen)
  );

  readyTimer = setTimeout(() => reveal(gen), READY_TIMEOUT_MS);
}

function stop() {
  generation += 1;
  active = false;
  loading = false;
  revealed = false;
  destroyWindows();
  refreshMenu();
}

function setCount(next) {
  if (next === windowCount || loading) return;
  windowCount = next;
  refreshMenu();
  if (active) start();
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
  }
  app.userAgentFallback = chromeUserAgent();
  const ses = installYoutubeSession();
  try {
    await loadUblock(ses);
  } catch (error) {
    console.error('No se pudo cargar uBlock Origin:', error);
  }
  createTray();
  if (process.argv.includes('--on')) start();
});

app.on('window-all-closed', () => {
  // La app vive en la barra de menú, aunque no quede ninguna ventana.
});

app.on('before-quit', () => {
  generation += 1;
  destroyWindows();
});
