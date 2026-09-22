const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  nativeImage,
  session,
  webFrameMain,
} = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const WINDOW_WIDTH = 280;
const WINDOW_HEIGHT = 158;
const READY_TIMEOUT_MS = 12000;
const DEFAULT_COUNT = 3;
const TICK_MS = 16;

const SUBWAY_ID = 'G8N6wAiNL1o';
const PARKOUR_IDS = ['GG11lZ_K3LY', '0c4KWfPhgWA'];

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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
    if (ad) {
      video.muted = true;
      video.playbackRate = 16;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(video.duration - 0.05, 0);
      }
    } else if (video.playbackRate !== 1) {
      video.playbackRate = 1;
    }
  };
  pass();
  setInterval(pass, 200);
})();`;

function installAdBlock() {
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: [
        '*://*.doubleclick.net/*',
        '*://*.googlesyndication.com/*',
        '*://*.googleadservices.com/*',
      ],
    },
    (_details, callback) => {
      callback({ cancel: true });
    }
  );
}

function attachAdSkip(win) {
  win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    let frame;
    try {
      frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    } catch {
      return;
    }
    if (!frame) return;
    const url = frame.url || '';
    if (!url.includes('youtube.com') && !url.includes('youtube-nocookie.com')) return;
    frame.executeJavaScript(AD_SKIP_SCRIPT).catch(() => {});
  });
}

function installEmbedReferer() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders;
      const refererKey = Object.keys(headers).find((name) => name.toLowerCase() === 'referer');
      if (!refererKey) headers.Referer = 'https://www.google.com/';
      callback({ requestHeaders: headers });
    }
  );
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
  win.webContents.setUserAgent(CHROME_UA);
  win.setOpacity(0);
  win.showInactive();
  attachAdSkip(win);
  win.webContents.on('media-started-playing', () => {
    markReady(win, gen);
  });

  const videoId = videoFor(index);
  win.loadFile(path.join(__dirname, 'player.html'), {
    query: { v: videoId, start: String(startAt) },
  });

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

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
  }
  installEmbedReferer();
  installAdBlock();
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
