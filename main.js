// Mediumistic — main process.
// One window, many Medium accounts: each profile lives in its own persistent
// session partition ("persist:medium-<id>"), so cookies never cross.
const { app, BrowserWindow, ipcMain, session, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Mediumistic');
// Wayland app_id / WM class must match the .desktop basename.
app.commandLine.appendSwitch('class', 'mediumistic');

const PARTITION_PREFIX = 'persist:medium-';
const userData = app.getPath('userData');
const STORE_FILE = path.join(userData, 'mediumistic.json');
const FEED_DIR = path.join(userData, 'feeds');

let win = null;

// Google / Medium refuse sign-in from anything that admits to being Electron.
function cleanUA(ua) {
  return ua.replace(/\s*Electron\/\S+/i, '').replace(/\s*mediumistic\/\S+/i, '');
}

// ---------------------------------------------------------------- store
const DEFAULT_STORE = {
  profiles: [],
  activeId: null,
  settings: { sound: true, mono: false, splash: true },
  notes: {},
};

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { ...DEFAULT_STORE, ...raw, settings: { ...DEFAULT_STORE.settings, ...(raw.settings || {}) } };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function saveStore(data) {
  fs.mkdirSync(userData, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_FILE);
  return true;
}

// ---------------------------------------------------------------- feeds
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const body = tag(b, 'content:encoded');
    const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    items.push({
      title: tag(b, 'title'),
      link: tag(b, 'link').split('?')[0],
      date: new Date(tag(b, 'pubDate')).toISOString(),
      categories: [...b.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => decode(c[1])),
      words,
    });
  }
  return {
    title: tag(xml.split('<item>')[0], 'title'),
    image: tag(xml.split('<item>')[0], 'url'),
    items,
  };
}

function feedURL(handle) {
  const h = String(handle || '').trim();
  if (/^https?:\/\//i.test(h)) return h.replace(/\/$/, '') + '/feed';
  return 'https://medium.com/feed/@' + h.replace(/^@/, '');
}

function cachePath(handle) {
  return path.join(FEED_DIR, String(handle).replace(/[^a-z0-9_.-]/gi, '_') + '.json');
}

async function fetchFeed(handle) {
  if (!handle) return { ok: false, error: 'no handle' };
  try {
    const res = await net.fetch(feedURL(handle), { headers: { 'User-Agent': cleanUA(app.userAgentFallback) } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const feed = parseFeed(await res.text());
    feed.fetchedAt = new Date().toISOString();
    fs.mkdirSync(FEED_DIR, { recursive: true });
    fs.writeFileSync(cachePath(handle), JSON.stringify(feed));
    return { ok: true, stale: false, feed };
  } catch (err) {
    try {
      const feed = JSON.parse(fs.readFileSync(cachePath(handle), 'utf8'));
      return { ok: true, stale: true, error: String(err.message || err), feed };
    } catch {
      return { ok: false, error: String(err.message || err) };
    }
  }
}

// ---------------------------------------------------------------- sessions
function partitionFor(id) {
  return PARTITION_PREFIX + String(id).replace(/[^a-z0-9_-]/gi, '');
}

function prepareSession(id) {
  const ses = session.fromPartition(partitionFor(id));
  ses.setUserAgent(cleanUA(ses.getUserAgent()));
  return ses;
}

async function signedIn(id) {
  const ses = session.fromPartition(partitionFor(id));
  const cookies = await ses.cookies.get({ domain: 'medium.com' });
  const uid = cookies.find((c) => c.name === 'uid');
  const sid = cookies.find((c) => c.name === 'sid');
  return !!(sid && uid && !uid.value.startsWith('lo_'));
}

// Shortcuts that should reach our menus even while a Medium page has focus.
// Never forward b/i/k/e: those are bold/italic/link etc. in Medium's editor.
const HOST_KEYS = new Set(['n', 'l', 'd', 'r', 'q', 'g', '[', ']', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;

  // Popups (Google/Apple/X OAuth, "open in new tab") stay in the SAME session,
  // otherwise the login cookie would land in the wrong profile.
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 700,
        parent: win || undefined,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          session: contents.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });

  if (process.env.MX_SNAPSHOT) {
    contents.on('did-create-window', (child) => console.log('[popup] same session as its profile:', child.webContents.session === contents.session));
  }

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    if (!HOST_KEYS.has(key)) return;
    event.preventDefault();
    win?.webContents.send('shortcut', { key, shift: input.shift });
  });
});

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    frame: false,
    title: 'Mediumistic',
    backgroundColor: '#a8a8a8',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  // Only allow our own, locked-down Medium webviews.
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!String(params.partition || '').startsWith(PARTITION_PREFIX)) event.preventDefault();
    if (!/^https:\/\//i.test(params.src || 'https://')) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => win.show());
  // Dev aid: MX_SNAPSHOT=/path.png captures the window after a few seconds and quits.
  if (process.env.MX_SNAPSHOT) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
    if (process.env.MX_JS) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.executeJavaScript(process.env.MX_JS).catch(() => {}), 1500));
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MX_SNAPSHOT, img.toPNG());
      app.quit();
    }, Number(process.env.MX_DELAY || 6000));
  }
  win.on('focus', () => win.webContents.send('focus', true));
  win.on('blur', () => win.webContents.send('focus', false));
  win.on('maximize', () => win.webContents.send('zoomed', true));
  win.on('unmaximize', () => win.webContents.send('zoomed', false));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ---------------------------------------------------------------- ipc
ipcMain.handle('store:load', () => loadStore());
ipcMain.handle('store:save', (_e, data) => saveStore(data));
ipcMain.handle('feed:fetch', (_e, handle) => fetchFeed(handle));
ipcMain.handle('session:prepare', (_e, id) => { prepareSession(id); return partitionFor(id); });
ipcMain.handle('session:signedIn', (_e, id) => signedIn(id).catch(() => false));
ipcMain.handle('session:clear', async (_e, id) => {
  const ses = session.fromPartition(partitionFor(id));
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});
ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('win:close', () => win?.close());
ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:zoom', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.handle('app:quit', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    app.userAgentFallback = cleanUA(app.userAgentFallback);
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
