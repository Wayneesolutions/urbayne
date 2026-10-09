/* Results reporter: poll-day turnout and counting-day numbers from a phone. Works offline: every number is saved on the phone with
   its own id and the time it was seen, then sent when there is signal. The server ignores repeats, so sending twice is always safe. */
(() => {
  const T = {
    pa: { title: 'ਨਤੀਜੇ ਭੇਜੋ', phone: 'ਮੋਬਾਈਲ ਨੰਬਰ', sendCode: 'ਕੋਡ ਭੇਜੋ', code: 'ਕੋਡ', signIn: 'ਅੰਦਰ ਜਾਓ', stations: 'ਮੇਰੇ ਬੂਥ', none: 'ਹਾਲੇ ਕੋਈ ਬੂਥ ਨਹੀਂ ਮਿਲਿਆ। ਆਪਣੇ ਕੋਆਰਡੀਨੇਟਰ ਨੂੰ ਪੁੱਛੋ।',
      electors: 'ਵੋਟਰ', last: 'ਆਖ਼ਰੀ ਗਿਣਤੀ', never: 'ਹਾਲੇ ਕੁਝ ਨਹੀਂ ਭੇਜਿਆ', votesNow: 'ਹੁਣ ਤੱਕ ਪਈਆਂ ਕੁੱਲ ਵੋਟਾਂ', send: 'ਭੇਜੋ', saved: 'ਸੰਭਾਲਿਆ', back: 'ਵਾਪਸ', pending: 'ਫ਼ੋਨ ਵਿੱਚ ਸੰਭਾਲੇ, ਭੇਜਣੇ ਬਾਕੀ', synced: 'ਸਭ ਭੇਜ ਦਿੱਤੇ', syncNow: 'ਹੁਣ ਭੇਜੋ',
      offline: 'ਨੈੱਟ ਨਹੀਂ ਹੈ — ਗਿਣਤੀ ਫ਼ੋਨ ਵਿੱਚ ਸੰਭਾਲੀ ਜਾਵੇਗੀ', signOut: 'ਬਾਹਰ ਜਾਓ', badCode: 'ਕੋਡ ਸਹੀ ਨਹੀਂ। ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।', counting: 'ਗਿਣਤੀ ਦੇ ਗੇੜ', round: 'ਗੇੜ ਨੰਬਰ', sendRound: 'ਗੇੜ ਭੇਜੋ',
      over: 'ਇਹ ਵੋਟਰਾਂ ਦੀ ਗਿਣਤੀ ਤੋਂ ਵੱਧ ਹੈ। ਫਿਰ ਵੀ ਭੇਜਣਾ ਹੈ?', lower: 'ਇਹ ਤੁਹਾਡੀ ਪਿਛਲੀ ਗਿਣਤੀ ਤੋਂ ਘੱਟ ਹੈ। ਫਿਰ ਵੀ ਭੇਜਣਾ ਹੈ?', closed: 'ਚੋਣ ਦੇ ਨਤੀਜੇ ਬੰਦ ਹੋ ਗਏ ਹਨ। ਹੋਰ ਕੁਝ ਨਹੀਂ ਭੇਜਿਆ ਜਾ ਸਕਦਾ।', rejected: 'ਇਹ ਨਹੀਂ ਭੇਜੇ ਜਾ ਸਕੇ', needNumber: 'ਗਿਣਤੀ ਲਿਖੋ', needAny: 'ਘੱਟੋ-ਘੱਟ ਇੱਕ ਉਮੀਦਵਾਰ ਦੀਆਂ ਵੋਟਾਂ ਲਿਖੋ', sms: 'ਨੈੱਟ ਨਹੀਂ? ਟੈਕਸਟ ਕਰੋ: VOTE ਕੋਡ ਗਿਣਤੀ' },
    hi: { title: 'नतीजे भेजें', phone: 'मोबाइल नंबर', sendCode: 'कोड भेजें', code: 'कोड', signIn: 'अंदर जाएँ', stations: 'मेरे बूथ', none: 'अभी कोई बूथ नहीं मिला। अपने कोऑर्डिनेटर से पूछें।',
      electors: 'मतदाता', last: 'आखिरी गिनती', never: 'अभी कुछ नहीं भेजा', votesNow: 'अब तक पड़े कुल वोट', send: 'भेजें', saved: 'सहेजा', back: 'वापस', pending: 'फ़ोन में सहेजे, भेजने बाकी', synced: 'सब भेज दिए', syncNow: 'अभी भेजें',
      offline: 'नेट नहीं है — गिनती फ़ोन में सहेजी जाएगी', signOut: 'बाहर जाएँ', badCode: 'कोड सही नहीं। फिर कोशिश करें।', counting: 'मतगणना के राउंड', round: 'राउंड नंबर', sendRound: 'राउंड भेजें',
      over: 'यह मतदाताओं की संख्या से ज़्यादा है। फिर भी भेजें?', lower: 'यह आपकी पिछली गिनती से कम है। फिर भी भेजें?', closed: 'चुनाव के नतीजे बंद हो गए हैं। अब कुछ नहीं भेजा जा सकता।', rejected: 'ये नहीं भेजे जा सके', needNumber: 'गिनती लिखें', needAny: 'कम से कम एक उम्मीदवार के वोट लिखें', sms: 'नेट नहीं? टेक्स्ट करें: VOTE कोड गिनती' },
    en: { title: 'Report results', phone: 'Mobile number', sendCode: 'Send code', code: 'Code', signIn: 'Sign in', stations: 'My stations', none: 'No station assigned yet. Ask your coordinator.',
      electors: 'electors', last: 'Last reported', never: 'Nothing sent yet', votesNow: 'Total votes polled so far', send: 'Send', saved: 'Saved', back: 'Back', pending: 'saved on this phone, waiting to send', synced: 'Everything sent', syncNow: 'Send now',
      offline: 'No signal: numbers are saved on this phone', signOut: 'Sign out', badCode: 'That code did not work. Try again.', counting: 'Counting rounds', round: 'Round number', sendRound: 'Send round',
      over: 'This is more than the electors at this station. Send anyway?', lower: 'This is lower than your earlier number. Send anyway?', closed: 'Results are closed for this election. Nothing more can be sent.', rejected: 'These could not be sent', needNumber: 'Enter the number', needAny: 'Enter votes for at least one candidate', sms: 'No data? Text: VOTE <station code> <votes>' },
  };

  // ---------- storage ----------
  const DB = new Promise((res, rej) => {
    const r = indexedDB.open('results', 1);
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
  const S = { lang: localStorage.getItem('results.lang') || 'pa', token: localStorage.getItem('results.token'), refresh: localStorage.getItem('results.refresh'), tenant: localStorage.getItem('results.tenant'),
    my: null, queue: [], rejected: [], notes: [], view: 'list', stationId: null, loginStep: 'login', email: '', pw: '', err: '', archived: false };
  const t = (k) => (T[S.lang] || T.en)[k] || (EXTRA[S.lang] || EXTRA.en)[k] || T.en[k] || EXTRA.en[k];
  const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

  async function api(path, opts = {}, retried) {
    const res = await fetch(`/api${path}`, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401 && !retried && S.refresh) {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: S.refresh }) });
      if (r.ok) { S.token = (await r.json()).accessToken; localStorage.setItem('results.token', S.token); return api(path, opts, true); }
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || body.error || 'error'), { status: res.status, code: body.error });
    return body;
  }

  // ---------- sync ----------
  const PERMANENT = new Set(['NOT_YOUR_STATION', 'STATION_NOT_FOUND', 'TIME_IN_THE_FUTURE', 'CANDIDATE_NOT_FOUND', 'UNIT_REQUIRED', 'NOT_YOUR_UNIT']);
  let syncing = false;
  async function sendBatch(path, items) {
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      const out = await api(`/t/${S.tenant}/results${path}`, { body: { reports: chunk.map((x) => x.payload) } });
      const done = [];
      out.results.forEach((r, k) => {
        const item = chunk[k];
        if (r.status === 'recorded' || r.status === 'duplicate') { done.push(item.clientUuid); if (r.flags && r.flags.length) S.notes.push({ label: item.label, flags: r.flags }); }
        else if (PERMANENT.has(r.error)) { done.push(item.clientUuid); S.rejected.push({ label: item.label, error: r.error }); }
      });
      await queueDel(done);
    }
  }
  async function sync() {
    if (syncing || !navigator.onLine || !S.tenant || !S.token) return;
    syncing = true;
    try {
      const q = await queueAll();
      if (q.length) {
        await sendBatch('/turnout/batch', q.filter((x) => x.type === 'turnout').sort((a, b) => a.payload.asOf.localeCompare(b.payload.asOf)));
        await sendBatch('/counts/batch', q.filter((x) => x.type === 'count'));
      }
      S.my = await api(`/t/${S.tenant}/results/my`); S.archived = S.my.archived; await kvSet('my', S.my);
    } catch (e) { if (e.status === 423) { S.archived = true; await queueDel((await queueAll()).map((x) => x.clientUuid)); } /* otherwise stay offline-first: try again later */ }
    finally { syncing = false; S.queue = await queueAll(); if (!typing()) render(); }
  }
  /** A background sync must never wipe a number someone is in the middle of typing. */
  const typing = () => S.view !== 'list' && [...document.querySelectorAll('#app input')].some((i) => i.value !== '' && !i.classList.contains('round'));
  addEventListener('online', sync);
  setInterval(sync, 20000);

  // ---------- views ----------
  const stationName = (s) => (S.lang === 'pa' && s.namePa) || (S.lang === 'hi' && s.nameHi) || s.name;
  const flagText = (f) => ({ CHANGED: 'replaced an earlier number', DECREASED: 'lower than before', BELOW_LATER: 'lower than a later number', OVER_ELECTORS: 'more than the electors', EXCEEDS_ELECTORS: 'adds up to more than the electors' }[f] || f);

  function render() {
    const app = document.getElementById('app');
    document.documentElement.lang = S.lang;
    if (!S.token) return app.replaceChildren(loginView());
    const st = S.my && S.my.stations.find((x) => x.areaId === S.stationId);
    const title = S.view === 'list' ? t('title') : S.view === 'count' ? t('counting') : st ? `${st.code ?? ''} ${stationName(st)}` : '';
    const head = $(`<div class="top"><button aria-label="${esc(t('back'))}" ${S.view === 'list' ? 'hidden' : ''}>‹</button><h1>${esc(title)}</h1><button aria-label="${esc(t('signOut'))}">⎋</button></div>`);
    head.children[0].onclick = () => { S.view = 'list'; render(); };
    head.children[2].onclick = () => { localStorage.clear(); location.reload(); };
    const main = document.createElement('main');
    if (S.archived) main.append($(`<div class="sync">${esc(t('closed'))}</div>`));
    if (S.view === 'list') main.append(langs(), ...stationList());
    if (S.view === 'station' && st) main.append(stationView(st));
    if (S.view === 'count') main.append(countView());
    app.replaceChildren(head, syncBanner(), main);
  }
  function langs() {
    const d = $(`<div class="langs"><button data-l="pa">ਪੰਜਾਬੀ</button><button data-l="hi">हिंदी</button><button data-l="en">English</button></div>`);
    d.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.l === S.lang)); b.onclick = () => { S.lang = b.dataset.l; localStorage.setItem('results.lang', S.lang); render(); }; });
    return d;
  }
  function syncBanner() {
    const n = S.queue.length;
    const box = document.createElement('div');
    if (!navigator.onLine) box.append($(`<div class="sync">${esc(t('offline'))}${n ? ` · ${n}` : ''}</div>`));
    else if (!n) box.append($(`<div class="sync ok">${esc(t('synced'))}</div>`));
    else { const d = $(`<div class="sync">${n} ${esc(t('pending'))}<button>${esc(t('syncNow'))}</button></div>`); d.querySelector('button').onclick = sync; box.append(d); }
    if (S.notes.length) { const d = $(`<div class="sync">${S.notes.slice(-3).map((x) => `${esc(x.label)}: ${esc(x.flags.map(flagText).join(', '))}`).join('<br>')}<button>OK</button></div>`); d.querySelector('button').onclick = () => { S.notes = []; render(); }; box.append(d); }
    if (S.rejected.length) { const d = $(`<div class="sync bad">${esc(t('rejected'))}: ${S.rejected.slice(-3).map((x) => `${esc(x.label)} (${esc(x.error)})`).join(', ')}<button>OK</button></div>`); d.querySelector('button').onclick = () => { S.rejected = []; render(); }; box.append(d); }
    return box;
  }
  /** What this phone last saw for a station: a number still waiting to be sent counts. */
  function lastFor(st) {
    const q = S.queue.filter((x) => x.type === 'turnout' && x.payload.areaId === st.areaId).sort((a, b) => b.payload.asOf.localeCompare(a.payload.asOf))[0];
    return q ? { votes: q.payload.votesCast, pending: true, at: q.payload.asOf } : st.lastVotes != null ? { votes: st.lastVotes, pending: false, at: st.lastAsOf } : null;
  }
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  function stationList() {
    const out = [];
    if (S.my && S.my.counting && S.my.candidates.length) {
      const b = $(`<button class="card turf"><strong>${esc(t('counting'))}</strong></button>`);
      b.onclick = () => { S.view = 'count'; render(); };
      out.push(b);
    }
    if (!S.my || !S.my.stations.length) { if (!out.length) out.push($(`<p class="muted">${esc(t('none'))}</p>`)); return out; }
    S.my.stations.forEach((st) => {
      const l = lastFor(st);
      const b = $(`<button class="card turf"><span><strong>${esc(st.code ?? '')} ${esc(stationName(st))}</strong><span class="muted">${st.electors != null ? `${esc(st.electors)} ${esc(t('electors'))}` : ''}${l ? ` · ${esc(t('last'))}: ${esc(l.votes)} (${esc(time(l.at))})${l.pending ? ' ⏳' : ''}` : ` · ${esc(t('never'))}`}</span></span></button>`);
      b.onclick = () => { S.stationId = st.areaId; S.view = 'station'; render(); };
      out.push(b);
    });
    out.push($(`<p class="muted">${esc(t('sms'))}</p>`));
    return out;
  }
  function stationView(st) {
    const l = lastFor(st);
    const w = $(`<div><div class="card"><div class="muted">${st.electors != null ? `${esc(st.electors)} ${esc(t('electors'))}` : ''}${l ? ` · ${esc(t('last'))}: ${esc(l.votes)} (${esc(time(l.at))})` : ''}</div>
      <label>${esc(t('votesNow'))}<input class="big" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off"></label><div class="muted pct" aria-live="polite">&nbsp;</div>
      <button class="primary" disabled>${esc(t('send'))}</button></div></div>`);
    const input = w.querySelector('input'), btn = w.querySelector('.primary'), pct = w.querySelector('.pct');
    input.oninput = () => {
      input.value = input.value.replace(/\D/g, '');
      const n = Number(input.value);
      btn.disabled = !input.value;
      pct.textContent = input.value && st.electors ? `${Math.round((n / st.electors) * 100)}% / ${st.electors}` : ' ';
    };
    btn.onclick = async () => {
      const n = Number(input.value);
      if (st.electors != null && n > st.electors && !confirm(t('over'))) return;
      if (l && n < l.votes && !confirm(t('lower'))) return;
      const id = uuid();
      await queueAdd({ clientUuid: id, type: 'turnout', label: `${st.code ?? ''} ${n}`, payload: { clientUuid: id, areaId: st.areaId, votesCast: n, asOf: new Date().toISOString() } });
      S.queue = await queueAll(); S.view = 'list'; render(); toast(t('saved')); sync();
    };
    return w;
  }

  function countView() {
    const rounds = (S.queue.filter((x) => x.type === 'count' && x.payload.kind === 'round').map((x) => x.payload.roundNo));
    const next = Math.max(0, ...rounds) + 1;
    const w = $(`<div><div class="card"><label>${esc(t('round'))}<input class="round" inputmode="numeric" maxlength="3" value="${next}"></label>
      ${S.my.candidates.map((c) => `<label>${esc(c.code)} · ${esc(c.name)}${c.isOurs ? ' ★' : ''}<input data-c="${esc(c.id)}" data-code="${esc(c.code)}" inputmode="numeric" maxlength="7" autocomplete="off"></label>`).join('')}
      <p class="err" role="alert" hidden></p><button class="primary">${esc(t('sendRound'))}</button></div></div>`);
    w.querySelectorAll('input').forEach((i) => i.oninput = () => { i.value = i.value.replace(/\D/g, ''); });
    w.querySelector('.primary').onclick = async () => {
      const round = Number(w.querySelector('.round').value);
      const filled = [...w.querySelectorAll('input[data-c]')].filter((i) => i.value !== '');
      const err = w.querySelector('.err');
      if (!round) { err.textContent = t('needNumber'); err.hidden = false; return; }
      if (!filled.length) { err.textContent = t('needAny'); err.hidden = false; return; }
      const asOf = new Date().toISOString();
      for (const i of filled) { const id = uuid(); await queueAdd({ clientUuid: id, type: 'count', label: `R${round} ${i.dataset.code} ${i.value}`, payload: { clientUuid: id, kind: 'round', roundNo: round, candidateId: i.dataset.c, votes: Number(i.value), asOf } }); }
      S.queue = await queueAll(); S.view = 'list'; render(); toast(t('saved')); sync();
    };
    return w;
  }
  function toast(msg) { const d = $(`<div class="toast" role="status">${esc(msg)}</div>`); document.body.append(d); setTimeout(() => d.remove(), 1600); }

  function loginView() {
    const m = document.createElement('main');
    m.append(langs());
    const change = S.loginStep === 'change';
    const c = $(`<form class="card"><h1 style="margin-top:0">${esc(t('title'))}</h1>${change
      ? `<p>${esc(t('chooseNew'))}</p><label>${esc(t('newPassword'))}<input type="password" autocomplete="new-password" minlength="10" required></label><button class="primary">${esc(t('signIn'))}</button>`
      : `<label>${esc(t('email'))}<input type="email" autocomplete="username" value="${esc(S.email)}" required></label><label>${esc(t('password'))}<input type="password" autocomplete="current-password" required></label><button class="primary">${esc(t('signIn'))}</button>`}
      ${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}</form>`);
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
        localStorage.setItem('results.token', S.token); localStorage.setItem('results.refresh', S.refresh);
        const me = await api('/auth/me');
        const camp = me.campaigns.find((x) => x.role === 'agent_reporter') || me.campaigns.find((x) => ['owner', 'manager', 'coordinator'].includes(x.role)) || me.campaigns[0];
        if (camp) { S.tenant = camp.tenant_id; localStorage.setItem('results.tenant', S.tenant); }
        await sync();
      } catch (x) { S.err = x.status === 401 ? t('badLogin') : x.message; }
      render();
    };
    m.append(c);
    return m;
  }

  (async () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/r/sw.js', { scope: '/r/' }).catch(() => {});
    S.my = (await kvGet('my')) || null;
    if (S.my) S.archived = Boolean(S.my.archived);
    S.queue = await queueAll();
    render();
    sync();
  })();
})();
