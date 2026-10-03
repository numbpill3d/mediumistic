// Mediumistic — renderer. Menus, profiles, per-account webviews, dashboard.
import { Orrery, Loom, drawSigil } from './viz.js';
import { normalizeProfileRef, profileLabel, profileURL } from './profile.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// DOM builder — all external text goes through textContent, never innerHTML.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.style.cssText = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}

const GLYPHS = ['✶', '☉', '☽', '☿', '♀', '♂', '♃', '♄', '♅', '♆', '♇', '⚸', '✦', '✧', '❂', '⊕', '⊗', '△', '▽', '◈', '⌘', '☍', '☌', '♁'];
const START_PAGES = {
  home: ['Home feed', () => 'https://medium.com/'],
  write: ['New story', () => 'https://medium.com/new-story'],
  stats: ['Stats', () => 'https://medium.com/me/stats'],
  stories: ['Your stories', () => 'https://medium.com/me/stories/drafts'],
  profile: ['Public profile', (p) => (p.handle ? profileURL(p.handle) : 'https://medium.com/')],
  notifications: ['Notifications', () => 'https://medium.com/me/notifications'],
};
const MONO_CSS = 'html { filter: grayscale(1) contrast(1.12) !important; }';
const DAY = 86400000;

let store = null;
const webviews = new Map();   // id -> { el, monoKey, loading }
const feeds = new Map();      // id -> { ok, stale, error, feed }
const signed = new Map();     // id -> bool
let view = 'dash';
let focused = true;
let orrery, loom;

const active = () => store.profiles.find((p) => p.id === store.activeId) || null;
const byId = (id) => store.profiles.find((p) => p.id === id);
const save = debounce(() => window.mx.save(store), 250);

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ============================================================ sound
const Sound = (() => {
  let ctx;
  const ac = () => (ctx ||= new AudioContext());
  function tone(freq, dur, { type = 'square', vol = 0.05, at = 0, decay = true } = {}) {
    if (!store?.settings.sound) return;
    const a = ac(), t0 = a.currentTime + at;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.setValueAtTime(0, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  return {
    chime() { // the startup chord
      [261.63, 329.63, 392.0, 523.25, 659.25].forEach((f, i) => tone(f, 2.4, { type: 'triangle', vol: 0.045, at: i * 0.012 }));
      tone(130.81, 2.6, { type: 'sine', vol: 0.06 });
    },
    click() { tone(1800, 0.018, { vol: 0.03, decay: false }); },
    beep() { tone(880, 0.14, { vol: 0.05 }); tone(660, 0.18, { vol: 0.04, at: 0.1 }); },
    select() { tone(1200, 0.03, { vol: 0.025 }); tone(1600, 0.03, { vol: 0.02, at: 0.035 }); },
    omen() { [392, 466.16, 587.33, 698.46].forEach((f, i) => tone(f, 1.2, { type: 'sine', vol: 0.05, at: i * 0.18 })); },
  };
})();

// ============================================================ status
function status(msg) { $('#status').textContent = msg; }
function statusRight() {
  const n = store.profiles.length;
  const on = store.profiles.filter((p) => signed.get(p.id)).length;
  $('#status-right').textContent = `${n} profile${n === 1 ? '' : 's'} · ${on} signed in`;
  $('#coven-count').textContent = n ? `${on}/${n}` : '';
}

// ============================================================ modal
function modal({ title, body = [], buttons = [{ label: 'OK', value: true, def: true }], icon, onOpen }) {
  return new Promise((resolve) => {
    const layer = $('#modal-layer');
    const btns = buttons.map((b) => el('button', { class: 'btn' + (b.def ? ' default' : ''), text: b.label, onclick: () => done(b.value) }));
    const content = el('div', { class: 'dialog-inner' },
      icon ? el('div', { class: 'icon-row' }, typeof icon === 'string' ? el('div', { class: 'big', text: icon }) : icon, el('div', {}, title ? el('h2', { text: title }) : null, ...body))
        : [title ? el('h2', { text: title }) : null, ...body],
      el('div', { class: 'buttons' }, btns));
    const box = el('div', { class: 'dialog', role: 'dialog' }, content);
    layer.replaceChildren(box);
    layer.classList.remove('hidden');
    document.body.classList.add('menu-open');
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); const c = buttons.find((b) => b.cancel); done(c ? c.value : false); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); const d = buttons.find((b) => b.def); if (d) done(d.value); }
    };
    function done(v) {
      document.removeEventListener('keydown', key, true);
      layer.classList.add('hidden');
      layer.replaceChildren();
      document.body.classList.remove('menu-open');
      Sound.click();
      resolve(v);
    }
    document.addEventListener('keydown', key, true);
    onOpen?.(box);
    ($('input', box) || btns.find((b) => b.classList.contains('default')))?.focus();
  });
}

const alertBox = (title, text, icon = '⚠') => modal({ title, icon, body: [el('p', { text })] });
const confirmBox = (title, text, ok = 'OK', icon = '⚠') => modal({
  title, icon, body: [el('p', { text })],
  buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: ok, value: true, def: true }],
});

// ============================================================ profiles
function newId() { return Math.random().toString(36).slice(2, 10); }

async function profileDialog(existing) {
  const p = existing ? { ...existing } : { id: newId(), name: '', handle: '', glyph: GLYPHS[store.profiles.length % GLYPHS.length], start: 'home' };
  const name = el('input', { value: p.name, placeholder: 'e.g. Night Writer' });
  const handle = el('input', { value: p.handle, placeholder: '@username  (or publication URL)' });
  const start = el('select', {}, Object.entries(START_PAGES).map(([k, [lbl]]) => el('option', { value: k, text: lbl, selected: k === p.start })));
  const big = el('div', { class: 'big', text: p.glyph });
  const pick = el('div', { class: 'glyph-pick' }, GLYPHS.map((g) => el('button', {
    class: g === p.glyph ? 'sel' : '', text: g, type: 'button',
    onclick: (e) => { p.glyph = g; big.textContent = g; $$('button', pick).forEach((b) => b.classList.toggle('sel', b === e.currentTarget)); Sound.click(); },
  })));
  const ok = await modal({
    title: existing ? 'Edit Profile' : 'Summon a New Profile',
    icon: big,
    body: [
      el('p', { class: 'note', text: 'Each profile keeps its own cookies — sign into a different Medium account in each.' }),
      el('div', { class: 'row' }, el('label', { text: 'Name' }), name),
      el('div', { class: 'row' }, el('label', { text: 'Handle' }), handle),
      el('div', { class: 'row' }, el('label', { text: 'Opens to' }), start),
      el('div', { class: 'row' }, el('label', { text: 'Sigil' }), pick),
    ],
    buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: existing ? 'Save' : 'Summon', value: true, def: true }],
  });
  if (!ok) return null;
  p.name = name.value.trim() || p.handle.replace(/^@/, '') || 'Unnamed';
  p.handle = normalizeProfileRef(handle.value);
  p.start = start.value;
  return p;
}

async function newProfile() {
  const p = await profileDialog(null);
  if (!p) return;
  store.profiles.push(p);
  save();
  await selectProfile(p.id, { toBrowser: true });
  refreshFeed(p);
}

async function editProfile(id = store.activeId) {
  const cur = byId(id);
  if (!cur) return Sound.beep();
  const p = await profileDialog(cur);
  if (!p) return;
  const handleChanged = p.handle !== cur.handle;
  Object.assign(cur, p);
  save();
  renderAll();
  if (handleChanged) refreshFeed(cur);
}

async function deleteProfile(id = store.activeId) {
  const p = byId(id);
  if (!p) return Sound.beep();
  Sound.beep();
  const ok = await confirmBox(`Banish “${p.name}”?`, 'This removes the profile, its Grimoire notes, and signs it out by wiping its cookies and cache. Your Medium account itself is untouched.', 'Banish', '☠');
  if (!ok) return;
  webviews.get(id)?.el.remove();
  webviews.delete(id);
  feeds.delete(id);
  signed.delete(id);
  delete store.notes[id];
  store.profiles = store.profiles.filter((x) => x.id !== id);
  await window.mx.clearSession(id);
  if (store.activeId === id) store.activeId = store.profiles[0]?.id || null;
  save();
  if (store.activeId) selectProfile(store.activeId); else renderAll();
  status(`Banished ${p.name}.`);
}

async function clearSessionActive() {
  const p = active();
  if (!p) return Sound.beep();
  const ok = await confirmBox('Sign Out & Forget?', `Erase every cookie and cached file for “${p.name}”? You'll need to sign in again.`, 'Erase');
  if (!ok) return;
  await window.mx.clearSession(p.id);
  const wv = webviews.get(p.id);
  if (wv) wv.el.loadURL(startURL(p));
  signed.set(p.id, false);
  renderProfiles();
  statusRight();
}

async function selectProfile(id, { toBrowser = false } = {}) {
  if (!byId(id)) return;
  store.activeId = id;
  save();
  Sound.select();
  if (toBrowser || view === 'browser') await ensureWebview(byId(id));
  if (toBrowser) setView('browser');
  renderAll();
}

function moveProfile(fromId, toId) {
  const a = store.profiles.findIndex((p) => p.id === fromId);
  const b = store.profiles.findIndex((p) => p.id === toId);
  if (a < 0 || b < 0 || a === b) return;
  const [p] = store.profiles.splice(a, 1);
  store.profiles.splice(b, 0, p);
  save();
  renderAll();
}

// ============================================================ webviews
function startURL(p) { return (START_PAGES[p.start] || START_PAGES.home)[1](p); }

async function ensureWebview(p) {
  if (!p) return null;
  if (webviews.has(p.id)) return webviews.get(p.id);
  const partition = await window.mx.prepare(p.id);
  const wv = document.createElement('webview');
  wv.setAttribute('partition', partition);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', startURL(p));
  const rec = { el: wv, monoKey: null, loading: true };
  webviews.set(p.id, rec);

  wv.addEventListener('did-start-loading', () => { rec.loading = true; syncBusy(); });
  wv.addEventListener('did-stop-loading', async () => {
    rec.loading = false; syncBusy();
    if (store.activeId === p.id) syncAddress();
    signed.set(p.id, await window.mx.signedIn(p.id));
    renderProfiles(); statusRight();
  });
  wv.addEventListener('did-navigate', () => store.activeId === p.id && syncAddress());
  wv.addEventListener('did-navigate-in-page', () => store.activeId === p.id && syncAddress());
  wv.addEventListener('page-title-updated', (e) => { if (store.activeId === p.id && view === 'browser') status(e.title); });
  wv.addEventListener('dom-ready', () => applyMono(rec));
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return; // aborted navigations are normal
    if (store.activeId === p.id) status(`The spirits are silent: ${e.errorDescription || e.errorCode}`);
  });
  wv.addEventListener('focus', () => closeMenus());
  $('#webviews').append(wv);
  return rec;
}

async function applyMono(rec) {
  try {
    if (store.settings.mono && !rec.monoKey) rec.monoKey = await rec.el.insertCSS(MONO_CSS);
    if (!store.settings.mono && rec.monoKey) { await rec.el.removeInsertedCSS(rec.monoKey); rec.monoKey = null; }
  } catch { /* not ready yet */ }
}

function currentWV() { return webviews.get(store.activeId)?.el || null; }

function syncAddress() {
  const wv = currentWV();
  const addr = $('#address');
  if (document.activeElement === addr) return;
  try { addr.value = wv ? wv.getURL() : ''; } catch { addr.value = ''; }
}

function syncBusy() {
  const rec = webviews.get(store.activeId);
  const busy = !!(rec?.loading && view === 'browser');
  document.body.classList.toggle('busy', busy);
  if (busy) status('Consulting the oracle…');
  else if (view === 'browser') status(active() ? `${active().name} — ready.` : 'Ready.');
}

async function go(where) {
  const p = active();
  if (!p) return Sound.beep();
  const rec = await ensureWebview(p);
  setView('browser');
  const wv = rec.el;
  const url = typeof where === 'string' && where.startsWith('http') ? where : (START_PAGES[where] || START_PAGES.home)[1](p);
  try { wv.loadURL(url); } catch { wv.src = url; }
}

function navigate(action) {
  const wv = currentWV();
  if (!wv || view !== 'browser') return Sound.beep();
  try {
    if (action === 'back') wv.canGoBack() ? wv.goBack() : Sound.beep();
    if (action === 'fwd') wv.canGoForward() ? wv.goForward() : Sound.beep();
    if (action === 'reload') wv.reload();
  } catch { Sound.beep(); }
}

function addressGo() {
  let v = $('#address').value.trim();
  if (!v) return;
  if (!/^https?:\/\//i.test(v)) {
    v = /^[\w-]+(\.[\w-]+)+/.test(v) ? 'https://' + v : 'https://medium.com/search?q=' + encodeURIComponent(v);
  }
  if (!/^https:\/\//i.test(v)) v = v.replace(/^http:/i, 'https:');
  go(v);
  $('#address').blur();
}

async function pasteSignInLink() {
  const p = active();
  if (!p) return alertBox('No Profile', 'Summon a profile first (File ▸ New Profile…).');
  let clip = '';
  try { clip = await navigator.clipboard.readText(); } catch { /* ignore */ }
  const input = el('input', { value: /medium\.com/i.test(clip) ? clip.trim() : '', placeholder: 'https://medium.com/m/callback/email?token=…', style: 'width:100%' });
  const ok = await modal({
    title: `Paste Sign-in Link for “${p.name}”`,
    icon: '✉',
    body: [
      el('p', { text: 'Medium emails a magic sign-in link. Copy it from your mail (don’t click it) and paste it here — it will sign in this profile only.' }),
      input,
    ],
    buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Sign In', value: true, def: true }],
  });
  if (!ok) return;
  let url;
  try { url = new URL(input.value.trim()); } catch { return alertBox('Malformed Link', 'That doesn’t look like a link.'); }
  if (url.protocol !== 'https:' || !/(^|\.)medium\.com$/i.test(url.hostname)) {
    return alertBox('Not a Medium Link', 'For safety, only https links on medium.com are accepted here.');
  }
  go(url.href);
}

// ============================================================ feeds & dashboard
function feedStats(feed) {
  const items = (feed?.items || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const now = Date.now();
  const ages = items.map((i) => (now - new Date(i.date)) / DAY);
  const gaps = [];
  for (let i = 1; i < items.length; i++) gaps.push((new Date(items[i - 1].date) - new Date(items[i].date)) / DAY);
  const tags = {};
  items.forEach((i) => i.categories.forEach((c) => { tags[c] = (tags[c] || 0) + 1; }));
  return {
    items,
    posts: items.length,
    cadence: ages.filter((a) => a <= 30).length,
    recent: ages.filter((a) => a <= 90).length,
    last: ages.length ? ages[0] : null,
    gap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    words: items.length ? Math.round(items.reduce((a, i) => a + i.words, 0) / items.length) : 0,
    tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

async function refreshFeed(p) {
  if (!p?.handle) { feeds.delete(p.id); renderDash(); return; }
  const res = await window.mx.feed(p.handle);
  feeds.set(p.id, res);
  renderDash();
}

async function refreshAllFeeds() {
  status('Reading the tea leaves…');
  for (const p of store.profiles) await refreshFeed(p);
  status('Feeds refreshed.');
}

function ago(days) {
  if (days == null) return '—';
  if (days < 1) return 'today';
  if (days < 2) return '1 day';
  if (days < 60) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} mo`;
}

function renderDash() {
  if (!orrery) return;
  const data = store.profiles.map((p) => {
    const s = feedStats(feeds.get(p.id)?.feed);
    return { id: p.id, name: p.name, handle: p.handle, glyph: p.glyph, posts: s.posts, cadence: s.cadence, recent: s.recent };
  });
  orrery.setData(data, store.activeId);

  const p = active();
  const res = p ? feeds.get(p.id) : null;
  const s = feedStats(res?.feed);
  const { inWindow } = loom.setData(s.items);
  $('#loom-caption').textContent = p ? `${inWindow} scroll${inWindow === 1 ? '' : 's'} in 12 weeks` : '12 weeks of publishing';
  $('#stats-title').textContent = p ? `Readings — ${p.name}` : 'Readings';
  $('#stats-fresh').textContent = !res ? '' : res.stale ? 'cached · offline' : res.ok ? `fetched ${new Date(res.feed.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';

  const stats = $('#stats');
  if (!p) {
    stats.replaceChildren(el('p', { class: 'note', text: 'No profile selected. File ▸ New Profile… to begin.' }));
  } else if (!p.handle) {
    stats.replaceChildren(el('p', { class: 'note', text: 'Give this profile a @handle (Profile ▸ Edit… ⌘I) to divine its public stats.' }));
  } else if (!res) {
    stats.replaceChildren(el('p', { class: 'note', text: 'Divining…' }));
  } else if (!res.ok) {
    stats.replaceChildren(el('p', { class: 'note', text: `Could not read ${profileLabel(p.handle)}'s feed (${res.error}). Check the handle, or you may be offline.` }));
  } else {
    const max = Math.max(1, ...s.tags.map((t) => t[1]));
    stats.replaceChildren(
      el('div', { class: 'kv' },
        el('div', {}, el('b', { text: String(s.posts) }), el('span', { text: 'recent posts' })),
        el('div', {}, el('b', { text: String(s.cadence) }), el('span', { text: 'last 30 days' })),
        el('div', {}, el('b', { text: ago(s.last) }), el('span', { text: 'since last' })),
        el('div', {}, el('b', { text: s.gap == null ? '—' : `${s.gap.toFixed(1)}d` }), el('span', { text: 'avg gap' })),
      ),
      el('div', { class: 'tags' },
        s.tags.length ? s.tags.map(([t, n]) => el('div', { class: 'tagrow' },
          el('span', { class: 't', text: t }),
          el('span', { class: 'bar' }, el('i', { style: `width:${(n / max) * 100}%` })),
          el('span', { text: String(n) }))) : el('p', { class: 'note', text: 'No tags in recent posts.' }),
      ),
      el('p', { class: 'note', text: `~${s.words.toLocaleString()} words (${Math.max(1, Math.round(s.words / 265))} min read) per post · Medium's public feed shows only the latest ~10 posts.` }),
    );
  }

  const list = $('#posts');
  list.replaceChildren(...s.items.map((it) => el('li', {
    title: it.link,
    onclick: () => { Sound.click(); go(it.link); },
  }, el('span', { class: 't', text: it.title }), el('span', { text: new Date(it.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) }))));
  if (!s.items.length) list.append(el('li', {}, el('span', { class: 't dim', text: p ? 'No scrolls to show.' : '—' })));
}

// ============================================================ rendering
function renderProfiles() {
  const ul = $('#profiles');
  ul.replaceChildren(...store.profiles.map((p, i) => {
    const li = el('li', {
      class: 'prof' + (p.id === store.activeId ? ' active' : ''),
      role: 'option', draggable: 'true',
      title: `${p.name}${i < 9 ? `  (⌘${i + 1})` : ''}`,
      onclick: () => selectProfile(p.id),
      ondblclick: () => selectProfile(p.id, { toBrowser: true }),
      oncontextmenu: (e) => { e.preventDefault(); selectProfile(p.id).then(() => editProfile(p.id)); },
      ondragstart: (e) => e.dataTransfer.setData('text/x-prof', p.id),
      ondragover: (e) => { e.preventDefault(); li.classList.add('dragover'); },
      ondragleave: () => li.classList.remove('dragover'),
      ondrop: (e) => { e.preventDefault(); li.classList.remove('dragover'); moveProfile(e.dataTransfer.getData('text/x-prof'), p.id); },
    },
    el('span', { class: 'glyph', text: p.glyph || '✶' }),
    el('span', { class: 'who' }, el('div', { class: 'name', text: p.name }), el('div', { class: 'handle dim', text: p.handle ? profileLabel(p.handle) : 'no handle' })),
    el('span', { class: 'dot' + (signed.get(p.id) ? ' on' : ''), title: signed.get(p.id) ? 'Signed in' : 'Not signed in' }));
    return li;
  }));
}

function renderAll() {
  renderProfiles();
  const p = active();
  $('#win-title').textContent = p ? `Mediumistic — ${p.name}` : 'Mediumistic';
  $('#profile-badge').textContent = p ? `${p.glyph} ${p.handle ? profileLabel(p.handle) : p.name}` : '';
  for (const [id, rec] of webviews) rec.el.classList.toggle('shown', id === store.activeId);
  $('#no-profile').classList.toggle('hidden', !!(p && webviews.has(p.id)));
  syncAddress();
  syncBusy();
  statusRight();
  renderDash();
  renderGrimoire();
}

function setView(v) {
  view = v;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === v));
  if (v === 'browser') {
    ensureWebview(active()).then(() => renderAll());
  } else {
    status('The orrery turns.');
  }
  syncBusy();
  loop.kick();
}

// ============================================================ grimoire (desk accessory)
function renderGrimoire() {
  const p = active();
  const ta = $('#grimoire-text');
  $('#grimoire-title').textContent = p ? `Grimoire — ${p.name}` : 'Grimoire';
  if (document.activeElement !== ta) ta.value = p ? store.notes[p.id] || '' : '';
  ta.disabled = !p;
  const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
  $('#grimoire-foot').textContent = p ? `${words} word${words === 1 ? '' : 's'}` : 'no profile';
}

function toggleGrimoire(force) {
  const g = $('#grimoire');
  const show = force ?? g.classList.contains('hidden');
  g.classList.toggle('hidden', !show);
  if (show) { renderGrimoire(); $('#grimoire-text').focus(); }
  Sound.click();
}

function makeDraggable(win, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.box')) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    win.style.right = 'auto'; win.style.bottom = 'auto';
    // Classic Mac: drag a dotted outline, then drop the window there.
    const ghost = el('div', { style: `position:fixed;z-index:90;border:1px dotted #000;pointer-events:none;width:${r.width}px;height:${r.height}px;left:${r.left}px;top:${r.top}px` });
    document.body.append(ghost);
    document.body.classList.add('menu-open');
    const mv = (ev) => {
      ghost.style.left = Math.max(0, ev.clientX - dx) + 'px';
      ghost.style.top = Math.max(22, ev.clientY - dy) + 'px';
    };
    const up = () => {
      win.style.left = ghost.style.left; win.style.top = ghost.style.top;
      ghost.remove();
      document.body.classList.remove('menu-open');
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
}

// ============================================================ mystic bits
function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((((date - ref) / DAY) % synodic) + synodic) % synodic;
  const f = age / synodic;
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  const idx = Math.round(f * 8) % 8;
  const glyph = ['●', '◐', '◐', '◐', '○', '◑', '◑', '◑'][idx];
  const illum = Math.round((1 - Math.cos(f * 2 * Math.PI)) / 2 * 100);
  return { glyph, name: names[idx], illum, age };
}

const OMENS = [
  'The draft you abandoned is waiting for its last paragraph.',
  'Write the title last. The story knows its own name.',
  'A reader you will never meet needs the thing you almost deleted.',
  'Cut your first sentence. Begin where the heat is.',
  'Three short posts outweigh one that never ships.',
  'The tag you avoid is the room you should enter.',
  'Answer a comment today; the thread is a doorway.',
  'Your quietest profile has the loudest idea.',
  'Publish before the moon is full.',
  'The algorithm is a weather, not a god. Write anyway.',
  'Read one stranger’s story to the end before writing your own.',
  'A list of seven wants to be a list of five.',
  'Rename the thing. The old name was a disguise.',
  'Tonight: fewer adjectives, more nouns.',
  'Something you believed last year deserves a rebuttal from you.',
];

function daySeed(extra = '') {
  const d = new Date();
  let h = 2166136261;
  for (const c of `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}${extra}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function showOmen() {
  const p = active();
  const seed = daySeed(p?.id || '');
  const c = el('canvas', { width: 64, height: 64, style: 'width:64px;height:64px' });
  drawSigil(c, seed);
  const m = moonPhase();
  const s = p ? feedStats(feeds.get(p.id)?.feed) : null;
  const nudge = s && s.last != null ? (s.last > 14 ? `${p.name} has been silent ${ago(s.last)}. The page is hungry.` : `${p.name} published ${ago(s.last)} ago. The current is with you.`) : '';
  Sound.omen();
  await modal({
    title: 'Omen of the Day',
    icon: c,
    body: [
      el('p', { class: 'omen', text: `“${OMENS[seed % OMENS.length]}”` }),
      el('p', { class: 'note', text: `${m.glyph} ${m.name}, ${m.illum}% illuminated.${nudge ? ' ' + nudge : ''}` }),
    ],
    buttons: [{ label: 'So Be It', value: true, def: true }],
  });
}

async function showAbout() {
  const c = el('canvas', { width: 64, height: 64, style: 'width:64px;height:64px' });
  drawSigil(c, 2133);
  const n = store.profiles.length;
  const totalPosts = store.profiles.reduce((a, p) => a + (feeds.get(p.id)?.feed?.items?.length || 0), 0);
  const used = Math.min(100, n * 9 + 12);
  await modal({
    title: 'Mediumistic',
    icon: c,
    body: [
      el('p', { text: 'Version 1.0 · a séance for your many selves.' }),
      el('p', { class: 'note', text: `${n} profile${n === 1 ? '' : 's'} bound · ${totalPosts} scrolls divined · each account sealed in its own session.` }),
      el('div', { class: 'row', style: 'grid-template-columns:120px 1fr' },
        el('span', { class: 'note', text: 'Aether in use' }),
        el('div', { class: 'progress', style: 'margin:0' }, el('div', { style: `height:100%;width:${used}%;background:repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/2px 2px;border-right:1px solid #000` }))),
      el('p', { class: 'note', text: '© 2026 scorn. Not affiliated with Medium.' }),
    ],
  });
}

// ============================================================ menus
function menuModel() {
  const p = active();
  const hasP = !!p;
  const inB = view === 'browser';
  return [
    { title: '☾', cls: 'apple', items: [
      { label: 'About Mediumistic…', action: showAbout },
      '-',
      { label: 'Omen of the Day…', action: showOmen },
      { label: 'Grimoire', key: 'K', action: () => toggleGrimoire() },
      '-',
      { label: 'Sounds', checked: store.settings.sound, action: () => { store.settings.sound = !store.settings.sound; save(); Sound.click(); } },
      { label: 'Welcome Screen', checked: store.settings.splash, action: () => { store.settings.splash = !store.settings.splash; save(); } },
    ] },
    { title: 'File', items: [
      { label: 'New Profile…', key: 'N', action: newProfile },
      { label: 'Paste Sign-in Link…', key: 'L', action: pasteSignInLink, disabled: !hasP },
      '-',
      { label: 'Open in System Browser', action: () => { const wv = currentWV(); if (wv) window.mx.openExternal(wv.getURL()); }, disabled: !(hasP && webviews.has(p.id)) },
      '-',
      { label: 'Quit', key: 'Q', action: () => window.mx.quit() },
    ] },
    { title: 'Edit', items: ['undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'selectAll'].map((c) => c === '-' ? '-' : {
      label: { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }[c],
      key: { undo: 'Z', redo: '⇧Z', cut: 'X', copy: 'C', paste: 'V', selectAll: 'A' }[c],
      action: () => editCommand(c),
    }) },
    { title: 'Go', items: [
      { label: 'Home Feed', key: 'G', action: () => go('home'), disabled: !hasP },
      { label: 'Write a Story', key: 'E', action: () => go('write'), disabled: !hasP },
      { label: 'Your Stories', action: () => go('stories'), disabled: !hasP },
      { label: 'Stats', action: () => go('stats'), disabled: !hasP },
      { label: 'Notifications', action: () => go('notifications'), disabled: !hasP },
      { label: 'Public Profile', action: () => go('profile'), disabled: !hasP },
      '-',
      { label: 'Back', key: '[', action: () => navigate('back'), disabled: !inB },
      { label: 'Forward', key: ']', action: () => navigate('fwd'), disabled: !inB },
      { label: 'Reload', key: 'R', action: () => navigate('reload'), disabled: !inB },
    ] },
    { title: 'Profile', items: [
      ...store.profiles.map((x, i) => ({ label: `${x.glyph}  ${x.name}`, key: i < 9 ? String(i + 1) : '', checked: x.id === store.activeId, action: () => selectProfile(x.id) })),
      ...(store.profiles.length ? ['-'] : []),
      { label: 'Edit Profile…', key: 'I', action: () => editProfile(), disabled: !hasP },
      { label: 'Banish Profile…', action: () => deleteProfile(), disabled: !hasP },
    ] },
    { title: 'View', items: [
      { label: 'Dashboard', key: 'D', checked: view === 'dash', action: () => setView('dash') },
      { label: 'Browser', key: 'B', checked: view === 'browser', action: () => setView('browser') },
      '-',
      { label: 'Monochrome Pages', checked: store.settings.mono, action: toggleMono },
      { label: 'Refresh Feeds', action: refreshAllFeeds },
    ] },
    { title: 'Special', items: [
      { label: 'Sign Out & Forget Profile…', action: clearSessionActive, disabled: !hasP },
      '-',
      { label: 'Restart', action: () => location.reload() },
      { label: 'Shut Down', action: () => window.mx.quit() },
    ] },
  ];
}

function closeMenus() {
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
  document.body.classList.remove('menu-open');
}

function buildMenus() {
  const bar = $('#menus');
  let tracking = false;
  const open = (menuEl, def) => {
    closeMenus();
    const dd = menuEl.querySelector('.dropdown');
    dd.replaceChildren(...def.items.map((it) => {
      if (it === '-') return el('div', { class: 'sep' });
      const row = el('div', { class: 'mi' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '') },
        el('span', { text: it.label }), el('span', { class: 'key', text: it.key ? '⌘' + it.key : '' }));
      row.addEventListener('mouseup', () => {
        if (it.disabled) return;
        row.classList.add('flash');
        Sound.click();
        setTimeout(() => { closeMenus(); tracking = false; it.action?.(); }, 200);
      });
      return row;
    }));
    menuEl.classList.add('open');
    document.body.classList.add('menu-open');
  };
  const defs = () => menuModel();
  bar.replaceChildren(...defs().map((d, i) => {
    const m = el('div', { class: 'menu' }, el('div', { class: 'menu-title' + (d.cls ? ' ' + d.cls : ''), text: d.title }), el('div', { class: 'dropdown' }));
    m.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dropdown')) return;
      e.preventDefault();
      if (m.classList.contains('open')) { closeMenus(); tracking = false; return; }
      tracking = true; open(m, defs()[i]);
    });
    m.addEventListener('mouseenter', () => { if (tracking && !m.classList.contains('open')) open(m, defs()[i]); });
    return m;
  }));
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menus')) { closeMenus(); tracking = false; } });
}

function editCommand(cmd) {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    ae.focus();
    document.execCommand(cmd);
    return;
  }
  const wv = currentWV();
  if (wv && view === 'browser') { try { wv[cmd](); } catch { Sound.beep(); } } else Sound.beep();
}

async function toggleMono() {
  store.settings.mono = !store.settings.mono;
  save();
  for (const rec of webviews.values()) await applyMono(rec);
  status(store.settings.mono ? 'Pages rendered in monochrome.' : 'Colour restored to the pages.');
}

// ============================================================ shortcuts
function shortcut(key, shift = false) {
  const n = Number(key);
  if (n >= 1 && n <= 9) { const p = store.profiles[n - 1]; return p ? selectProfile(p.id) : Sound.beep(); }
  switch (key) {
    case 'n': return newProfile();
    case 'i': return editProfile();
    case 'l': return pasteSignInLink();
    case 'd': return setView('dash');
    case 'b': return setView('browser');
    case 'r': return navigate('reload');
    case 'e': return go('write');
    case 'g': return go('home');
    case 'k': return toggleGrimoire();
    case 'q': return window.mx.quit();
    case '[': return navigate('back');
    case ']': return navigate('fwd');
    default: return undefined;
  }
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !$('#modal-layer').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (!'nildbregkq[]123456789'.includes(k) || k.length !== 1) return;
  e.preventDefault();
  shortcut(k, e.shiftKey);
});

// ============================================================ animation loop
const loop = (() => {
  let raf = 0, last = 0;
  const running = () => view === 'dash' && focused && !document.hidden;
  function tick(t) {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
    last = t;
    orrery.frame(dt, t / 1000);
    loom.frame(dt);
    raf = requestAnimationFrame(tick);
  }
  return { kick() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(tick); } } };
})();

// ============================================================ clock
function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const m = moonPhase(d);
  $('#moon').textContent = m.glyph;
  $('#moon').title = `${m.name} · ${m.illum}% illuminated`;
}

// ============================================================ splash
async function splash() {
  const s = $('#splash');
  if (!store.settings.splash) { s.classList.add('gone'); return; }
  drawSigil($('#splash-sigil'), daySeed());
  Sound.chime();
  const bar = $('#splash-bar');
  for (let i = 1; i <= 12; i++) {
    bar.style.width = `${(i / 12) * 100}%`;
    await new Promise((r) => setTimeout(r, 90 + Math.random() * 80));
  }
  s.classList.add('gone');
}

// ============================================================ boot
async function boot() {
  await document.fonts.load('16px Chicago12');
  store = await window.mx.load();
  if (store.activeId && !byId(store.activeId)) store.activeId = null;
  if (!store.activeId && store.profiles[0]) store.activeId = store.profiles[0].id;

  const splashDone = splash();

  orrery = new Orrery($('#orrery'), {
    onPick: (id) => selectProfile(id),
    onHover: (d) => { if (view === 'dash') status(d ? `${d.name} — ${d.posts} recent posts, ${d.cadence} in 30 days. Click to select.` : 'The orrery turns.'); },
  });
  loom = new Loom($('#loom'));

  buildMenus();
  tickClock();
  setInterval(tickClock, 15000);

  // chrome
  $('#btn-close').onclick = () => window.mx.close();
  $('#btn-zoom').onclick = () => window.mx.zoom();
  $('#menubar').addEventListener('dblclick', (e) => { if (!e.target.closest('#menus')) window.mx.zoom(); });
  $('#btn-new').onclick = newProfile;
  $('#btn-grimoire').onclick = () => toggleGrimoire();
  $('#grimoire-close').onclick = () => toggleGrimoire(false);
  $('#moon').onclick = showOmen;
  makeDraggable($('#grimoire'), $('#grimoire .titlebar'));
  $('#grimoire-text').addEventListener('input', (e) => {
    const p = active();
    if (!p) return;
    store.notes[p.id] = e.target.value;
    save();
    renderGrimoire();
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => { Sound.click(); setView(t.dataset.view); }));
  $('#nav-back').onclick = () => navigate('back');
  $('#nav-fwd').onclick = () => navigate('fwd');
  $('#nav-reload').onclick = () => navigate('reload');
  $('#nav-home').onclick = () => go('home');
  $('#nav-write').onclick = () => go('write');
  $('#nav-stats').onclick = () => go('stats');
  $('#address').addEventListener('keydown', (e) => { if (e.key === 'Enter') addressGo(); if (e.key === 'Escape') { e.target.blur(); syncAddress(); } });

  window.mx.on('shortcut', ({ key, shift }) => shortcut(key, shift));
  window.mx.on('focus', (f) => { focused = f; document.body.classList.toggle('inactive', !f); if (!f) closeMenus(); loop.kick(); });
  document.addEventListener('visibilitychange', () => loop.kick());

  // sign-in state for every profile, without loading pages
  await Promise.all(store.profiles.map(async (p) => signed.set(p.id, await window.mx.signedIn(p.id))));

  renderAll();
  await splashDone;
  loop.kick();

  refreshAllFeeds();
  setInterval(refreshAllFeeds, 30 * 60 * 1000);

  if (!store.profiles.length) {
    await modal({
      title: 'Welcome to Mediumistic',
      icon: '☾',
      body: [
        el('p', { text: 'Mediumistic keeps each of your Medium accounts in its own sealed session, all in one window.' }),
        el('p', { class: 'note', text: 'Summon a profile, sign in inside it, then summon the next. ⌘1–⌘9 switches between them.' }),
      ],
      buttons: [{ label: 'Summon First Profile', value: true, def: true }],
    });
    newProfile();
  }
}

boot().catch((err) => {
  console.error(err);
  alertBox('A Bomb Has Occurred', String(err?.stack || err), '✺');
});
