/* Booth worker / canvasser app. Works offline: turfs are cached in IndexedDB and
   every visit is queued locally with a client id, then synced when there is signal.
   The server ignores duplicates, so syncing twice is always safe. */
(() => {
  const T = {
    pa: { title: 'ਬੂਥ ਵਰਕਰ', phone: 'ਮੋਬਾਈਲ ਨੰਬਰ', sendCode: 'ਕੋਡ ਭੇਜੋ', code: 'ਕੋਡ', signIn: 'ਅੰਦਰ ਜਾਓ', myAreas: 'ਮੇਰੇ ਇਲਾਕੇ', none: 'ਹਾਲੇ ਕੋਈ ਇਲਾਕਾ ਨਹੀਂ ਮਿਲਿਆ। ਆਪਣੇ ਕੋਆਰਡੀਨੇਟਰ ਨੂੰ ਪੁੱਛੋ।', done: 'ਘਰ ਹੋ ਗਏ', of: 'ਵਿੱਚੋਂ',
      back: 'ਵਾਪਸ', pending: 'ਫ਼ੋਨ ਵਿੱਚ ਸੰਭਾਲੇ, ਭੇਜਣੇ ਬਾਕੀ', synced: 'ਸਭ ਭੇਜ ਦਿੱਤੇ', syncNow: 'ਹੁਣ ਭੇਜੋ', offline: 'ਨੈੱਟ ਨਹੀਂ ਹੈ — ਕੰਮ ਜਾਰੀ ਰੱਖੋ, ਬਾਅਦ ਵਿੱਚ ਭੇਜਾਂਗੇ',
      supporter: 'ਸਾਡੇ ਨਾਲ', undecided: 'ਹਾਲੇ ਤੈਅ ਨਹੀਂ', not_interested: 'ਦਿਲਚਸਪੀ ਨਹੀਂ', not_home: 'ਘਰ ਨਹੀਂ ਸੀ', needs_help: 'ਮਦਦ ਚਾਹੀਦੀ', wants_sign: 'ਸਾਈਨ ਚਾਹੀਦਾ',
      note: 'ਨੋਟ (ਜੇ ਲੋੜ ਹੋਵੇ)', save: 'ਸੰਭਾਲੋ', saved: 'ਸੰਭਾਲਿਆ', addDoor: 'ਸੂਚੀ ਤੋਂ ਬਾਹਰ ਦਾ ਘਰ ਜੋੜੋ', add: 'ਜੋੜੋ', signOut: 'ਬਾਹਰ ਜਾਓ', badCode: 'ਕੋਡ ਸਹੀ ਨਹੀਂ। ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।' },
    hi: { title: 'बूथ वर्कर', phone: 'मोबाइल नंबर', sendCode: 'कोड भेजें', code: 'कोड', signIn: 'अंदर जाएँ', myAreas: 'मेरे इलाके', none: 'अभी कोई इलाका नहीं मिला। अपने कोऑर्डिनेटर से पूछें।', done: 'घर हो गए', of: 'में से',
      back: 'वापस', pending: 'फ़ोन में सहेजे, भेजने बाकी', synced: 'सब भेज दिए', syncNow: 'अभी भेजें', offline: 'नेट नहीं है — काम जारी रखें, बाद में भेजेंगे',
      supporter: 'हमारे साथ', undecided: 'अभी तय नहीं', not_interested: 'रुचि नहीं', not_home: 'घर पर नहीं', needs_help: 'मदद चाहिए', wants_sign: 'साइन चाहिए',
      note: 'नोट (अगर ज़रूरी हो)', save: 'सहेजें', saved: 'सहेजा', addDoor: 'सूची से बाहर का घर जोड़ें', add: 'जोड़ें', signOut: 'बाहर जाएँ', badCode: 'कोड सही नहीं। फिर कोशिश करें।' },
    en: { title: 'Canvassing', phone: 'Mobile number', sendCode: 'Send code', code: 'Code', signIn: 'Sign in', myAreas: 'My areas', none: 'No area assigned yet. Ask your coordinator.', done: 'doors done', of: 'of',
      back: 'Back', pending: 'saved on this phone, waiting to send', synced: 'Everything sent', syncNow: 'Send now', offline: 'No signal: keep going, visits will send later',
      supporter: 'Supporter', undecided: 'Undecided', not_interested: 'Not interested', not_home: 'Not home', needs_help: 'Needs help', wants_sign: 'Wants a sign',
      note: 'Note (optional)', save: 'Save', saved: 'Saved', addDoor: 'Add a door not on the list', add: 'Add', signOut: 'Sign out', badCode: 'That code did not work. Try again.' },
  };
  // Sign-in strings (email and password).
  const EXTRA = {
    pa: { email: 'ਈਮੇਲ', password: 'ਪਾਸਵਰਡ', newPassword: 'ਨਵਾਂ ਪਾਸਵਰਡ (ਘੱਟੋ-ਘੱਟ 10 ਅੱਖਰ)', chooseNew: 'ਆਪਣਾ ਨਵਾਂ ਪਾਸਵਰਡ ਚੁਣੋ।', badLogin: 'ਈਮੇਲ ਜਾਂ ਪਾਸਵਰਡ ਸਹੀ ਨਹੀਂ।', showPw: 'ਪਾਸਵਰਡ ਵੇਖੋ', hidePw: 'ਪਾਸਵਰਡ ਲੁਕਾਓ' },
    hi: { email: 'ईमेल', password: 'पासवर्ड', newPassword: 'नया पासवर्ड (कम से कम 10 अक्षर)', chooseNew: 'अपना नया पासवर्ड चुनें।', badLogin: 'ईमेल या पासवर्ड सही नहीं।', showPw: 'पासवर्ड दिखाएँ', hidePw: 'पासवर्ड छिपाएँ' },
    en: { email: 'Email', password: 'Password', newPassword: 'New password (at least 10 characters)', chooseNew: 'Choose your own new password.', badLogin: 'Email or password is not right.', showPw: 'Show password', hidePw: 'Hide password' },
  };
  const ICONS = {
    supporter: '<path d="m5 12 5 5L20 7"/>', undecided: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01"/>',
    not_interested: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', not_home: '<path d="M3 11 12 4l9 7v9H3z"/><path d="M9 20v-6h6v6"/>',
    needs_help: '<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"/>', wants_sign: '<path d="M12 3v18M6 5h12l-2 4 2 4H6z"/>',
  };

  // ---------- storage ----------
  const DB = new Promise((res, rej) => {
    const r = indexedDB.open('booth', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('queue', { keyPath: 'clientUuid' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const store = async (name, mode, fn) => { const db = await DB; return new Promise((res, rej) => { const tx = db.transaction(name, mode); const out = fn(tx.objectStore(name)); tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }); };
  const kvGet = (k) => store('kv', 'readonly', (s) => s.get(k));
  const kvSet = (k, v) => store('kv', 'readwrite', (s) => s.put(v, k));
  const queueAll = () => store('queue', 'readonly', (s) => s.getAll());
  const queueAdd = (v) => store('queue', 'readwrite', (s) => s.put(v));
  const queueDel = (ids) => store('queue', 'readwrite', (s) => ids.forEach((id) => s.delete(id)));

  // ---------- state ----------
  const S = { lang: localStorage.getItem('booth.lang') || 'pa', token: localStorage.getItem('booth.token'), refresh: localStorage.getItem('booth.refresh'), tenant: localStorage.getItem('booth.tenant'), region: localStorage.getItem('booth.region') || 'IN', turfs: [], queue: [], view: 'list', turfId: null, house: null, loginStep: 'login', email: '', pw: '', err: '' };
  const t = (k) => (T[S.lang] || T.en)[k] || (EXTRA[S.lang] || EXTRA.en)[k] || T.en[k] || EXTRA.en[k];
  const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

  async function api(path, opts = {}, retried) {
    const res = await fetch(`/api${path}`, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401 && !retried && S.refresh) {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: S.refresh }) });
      if (r.ok) { S.token = (await r.json()).accessToken; localStorage.setItem('booth.token', S.token); return api(path, opts, true); }
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || body.error || 'error'), { status: res.status });
    return body;
  }

  // ---------- sync ----------
  let syncing = false;
  async function sync() {
    if (syncing || !navigator.onLine || !S.tenant) return;
    syncing = true;
    try {
      const q = await queueAll();
      if (q.length) {
        const out = await api(`/t/${S.tenant}/field/visits/batch`, { body: { visits: q.map(({ label, ...v }) => v) } });
        await queueDel(q.map((v) => v.clientUuid).filter((id) => !out.rejected.includes(id)));
      }
      const turfs = await api(`/t/${S.tenant}/field/my-turfs`);
      S.turfs = turfs; await kvSet('turfs', turfs);
    } catch (e) { /* stay offline-first: try again later */ }
    finally { syncing = false; S.queue = await queueAll(); render(); }
  }
  addEventListener('online', sync);
  setInterval(sync, 30000);

  // ---------- views ----------
  function render() {
    const app = document.getElementById('app');
    document.documentElement.lang = S.lang;
    if (!S.token) return app.replaceChildren(loginView());
    const turf = S.turfs.find((x) => x.id === S.turfId);
    const head = $(`<div class="top"><button aria-label="${esc(t('back'))}" ${S.view === 'list' ? 'hidden' : ''}>‹</button><h1>${esc(S.view === 'list' ? t('myAreas') : areaName(turf?.area))}</h1><button aria-label="${esc(t('signOut'))}">⎋</button></div>`);
    head.children[0].onclick = () => { S.view = S.view === 'house' ? 'turf' : 'list'; render(); };
    head.children[2].onclick = () => { localStorage.clear(); location.reload(); };
    const banner = syncBanner();
    const main = document.createElement('main');
    if (S.view === 'list') main.append(langs(), ...turfList());
    if (S.view === 'turf' && turf) main.append(...houseList(turf));
    if (S.view === 'house' && turf) main.append(resultView(turf));
    app.replaceChildren(head, banner, main);
  }
  function areaName(a) { return !a ? '' : (S.lang === 'pa' && a.namePa) || (S.lang === 'hi' && a.nameHi) || a.nameEn; }
  function langs() {
    const d = $(`<div class="langs"><button data-l="pa">ਪੰਜਾਬੀ</button><button data-l="hi">हिंदी</button><button data-l="en">English</button></div>`);
    d.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.l === S.lang)); b.onclick = () => { S.lang = b.dataset.l; localStorage.setItem('booth.lang', S.lang); render(); }; });
    return d;
  }
  function syncBanner() {
    const n = S.queue.length;
    if (!navigator.onLine) return $(`<div class="sync">${esc(t('offline'))}${n ? ` · ${n}` : ''}</div>`);
    if (!n) return $(`<div class="sync ok">${esc(t('synced'))}</div>`);
    const d = $(`<div class="sync">${n} ${esc(t('pending'))}<button>${esc(t('syncNow'))}</button></div>`);
    d.querySelector('button').onclick = sync;
    return d;
  }
  function lastResult(turf, h) {
    const q = S.queue.filter((v) => v.turfId === turf.id && (h.contactId ? v.contactId === h.contactId : v.household === h.household)).sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))[0];
    return q ? { result: q.result, pending: true } : h.lastResult ? { result: h.lastResult, pending: false } : null;
  }
  function turfList() {
    if (!S.turfs.length) return [$(`<p class="muted">${esc(t('none'))}</p>`)];
    return S.turfs.map((turf) => {
      const total = turf.households.length + turf.extraDoors.length;
      const doneN = turf.households.filter((h) => lastResult(turf, h)).length + turf.extraDoors.length;
      const pct = total ? doneN / total : 0;
      const b = $(`<button class="card turf"><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="#E3E4EE" stroke-width="5"/><circle cx="18" cy="18" r="15" fill="none" stroke="#2F7D5B" stroke-width="5" stroke-dasharray="${(pct * 94.2).toFixed(1)} 94.2" transform="rotate(-90 18 18)" stroke-linecap="round"/></svg><div><strong>${esc(areaName(turf.area))}</strong><span class="muted">${doneN} ${esc(t('of'))} ${total} ${esc(t('done'))}</span></div></button>`);
      b.onclick = () => { S.turfId = turf.id; S.view = 'turf'; render(); scrollTo(0, 0); };
      return b;
    });
  }
  function houseList(turf) {
    const rows = [...turf.households, ...turf.extraDoors.map((d) => ({ household: d, name: d }))].map((h) => {
      const lr = lastResult(turf, h);
      const b = $(`<button class="house"><span class="who"><strong>${esc(h.name || '—')}</strong>${h.phoneEnd ? `<small>•••• ${esc(h.phoneEnd)}</small>` : ''}</span>${lr ? `<span class="chip ${lr.pending ? 'pending' : lr.result}">${esc(t(lr.result))}</span>` : ''}</button>`);
      b.onclick = () => { S.house = h; S.view = 'house'; render(); scrollTo(0, 0); };
      return b;
    });
    const add = $(`<form class="add"><input placeholder="${esc(t('addDoor'))}" aria-label="${esc(t('addDoor'))}"><button>${esc(t('add'))}</button></form>`);
    add.onsubmit = (e) => { e.preventDefault(); const v = add.querySelector('input').value.trim(); if (!v) return; S.house = { household: v, name: v }; S.view = 'house'; render(); };
    return [...rows, add];
  }
  function resultView(turf) {
    const h = S.house;
    const keys = ['supporter', 'undecided', 'not_interested', 'not_home', 'needs_help', ...(S.region === 'CA' ? ['wants_sign'] : [])];
    let chosen = null;
    const wrap = $(`<div><div class="card"><strong style="font-size:22px">${esc(h.name || h.household)}</strong>${h.phoneEnd ? `<div class="muted">•••• ${esc(h.phoneEnd)}</div>` : ''}</div>
      <div class="results">${keys.map((k) => `<button class="result ${k}" data-k="${k}" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>${esc(t(k))}</button>`).join('')}</div>
      <label>${esc(t('note'))}<textarea rows="2"></textarea></label><button class="primary" disabled>${esc(t('save'))}</button></div>`);
    wrap.querySelectorAll('.result').forEach((b) => b.onclick = () => { chosen = b.dataset.k; wrap.querySelectorAll('.result').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); wrap.querySelector('.primary').disabled = false; });
    wrap.querySelector('.primary').onclick = async () => {
      await queueAdd({ clientUuid: uuid(), turfId: turf.id, ...(h.contactId ? { contactId: h.contactId } : { household: h.household }), result: chosen, note: wrap.querySelector('textarea').value.trim() || undefined, visitedAt: new Date().toISOString() });
      S.queue = await queueAll(); S.view = 'turf'; render(); toast(t('saved')); sync();
    };
    return wrap;
  }
  function toast(msg) { const d = $(`<div class="toast" role="status">${esc(msg)}</div>`); document.body.append(d); setTimeout(() => d.remove(), 1600); }

  /** An eye button on each password box, to show or hide what was typed. */
  function addEyes(root) {
    const open = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const shut = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 20c-7 0-11-8-11-8a19.8 19.8 0 0 1 5.06-5.94M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a19.7 19.7 0 0 1-3.17 4.19M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="m1 1 22 22"/></svg>';
    root.querySelectorAll('input[type=password]').forEach((inp) => {
      const wrap = document.createElement('span'); wrap.className = 'pw';
      inp.replaceWith(wrap); wrap.append(inp);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pw-eye'; b.innerHTML = open;
      b.setAttribute('aria-label', t('showPw')); b.setAttribute('aria-pressed', 'false');
      b.onclick = () => { const on = inp.type === 'password'; inp.type = on ? 'text' : 'password'; b.innerHTML = on ? shut : open; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', t(on ? 'hidePw' : 'showPw')); };
      wrap.append(b);
    });
  }

  function loginView() {
    const m = document.createElement('main');
    m.append(langs());
    const change = S.loginStep === 'change';
    const c = $(`<form class="card"><h1 style="margin-top:0">${esc(t('title'))}</h1>${change
      ? `<p>${esc(t('chooseNew'))}</p><label>${esc(t('newPassword'))}<input type="password" autocomplete="new-password" minlength="10" required></label><button class="primary">${esc(t('signIn'))}</button>`
      : `<label>${esc(t('email'))}<input type="email" autocomplete="username" value="${esc(S.email)}" required></label><label>${esc(t('password'))}<input type="password" autocomplete="current-password" required></label><button class="primary">${esc(t('signIn'))}</button>`}
      ${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}</form>`);
    addEyes(c);
    c.onsubmit = async (e) => {
      e.preventDefault(); S.err = '';
      const inputs = c.querySelectorAll('input');
      try {
        let r;
        if (!change) {
          S.email = inputs[0].value.trim(); S.pw = inputs[1].value;
          r = await api('/auth/login', { body: { email: S.email, password: S.pw } });
          // A password someone else chose must be replaced first.
          if (r.mustChangePassword) { S.token = r.accessToken; S.loginStep = 'change'; render(); return; }
        } else {
          r = await api('/auth/change-password', { body: { currentPassword: S.pw, newPassword: inputs[0].value } });
        }
        S.pw = ''; S.loginStep = 'login';
        S.token = r.accessToken; S.refresh = r.refreshToken;
        localStorage.setItem('booth.token', S.token); localStorage.setItem('booth.refresh', S.refresh);
        const me = await api('/auth/me');
        const camp = me.campaigns.find((x) => x.role === 'field_worker') || me.campaigns[0];
        if (camp) { S.tenant = camp.tenant_id; S.region = camp.region; localStorage.setItem('booth.tenant', S.tenant); localStorage.setItem('booth.region', S.region); }
        await sync();
      } catch (x) { S.err = x.status === 401 ? t('badLogin') : x.message; }
      render();
    };
    m.append(c);
    return m;
  }

  (async () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/w/sw.js', { scope: '/w/' }).catch(() => {});
    S.turfs = (await kvGet('turfs')) || [];
    S.queue = await queueAll();
    render();
    sync();
  })();
})();
