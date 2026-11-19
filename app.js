/* SVA Maintenance v3 - page logic. Talks to the Apps Script JSON API (config.js > EXEC_URL). */
(function () {
'use strict';

var CFG = window.SVAM_CONFIG || {};
var OPEN = ['New', 'In progress', 'Waiting on parts'];
var AUTH_FNS = ['bootstrap', 'createRequest', 'findSimilar', 'updateRequest', 'cancelRequest', 'getPhoto', 'setMyBuildings', 'savePerson'];
var ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

/* Storage with fallbacks (private mode can block localStorage). */
var MEM = {};
var LS = {
  get: function (k) {
    var v = null;
    try { v = localStorage.getItem(k); } catch (e) {}
    if (v == null) { try { v = sessionStorage.getItem(k); } catch (e) {} }
    if (v == null && MEM[k] != null) v = MEM[k];
    return v;
  },
  set: function (k, v) {
    MEM[k] = v;
    try { localStorage.setItem(k, v); } catch (e) {}
    try { sessionStorage.setItem(k, v); } catch (e) {}
  },
  del: function (k) {
    delete MEM[k];
    try { localStorage.removeItem(k); } catch (e) {}
    try { sessionStorage.removeItem(k); } catch (e) {}
  }
};

var DRAFT_KEY = 'svam_draft';
var DRAFT_MAX_AGE = 24 * 3600 * 1000;

var S = {
  token: null, me: null, locations: [], categories: [], statuses: [], priorities: [],
  requests: [], people: [], assignees: [], tab: 'open', selId: null, photos: {},
  f: { q: '', status: 'open', building: '', assigned: '', priority: '' },
  filtersOpen: false, cancelArmed: null, nr: null, poll: null, lastLoad: 0,
  pendingLink: null, pendingRevoke: null, installEvt: null, simSeq: 0
};

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isStaff() { return S.me && (S.me.role === 'manager' || S.me.role === 'admin'); }
function firstName(n) { return String(n || '').split(' ')[0]; }

function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, isErr ? 5000 : 2800);
}

/* ------------------------------------------------------------- server */

/** Low-level call. text/plain avoids the browser's pre-check, which Apps Script cannot answer. */
function post(fn, args) {
  var body = { fn: fn, args: args || [], level: CFG.PAGE_LEVEL };
  if (AUTH_FNS.indexOf(fn) >= 0) body.token = S.token || '';
  return fetch(CFG.EXEC_URL, {
    method: 'POST', redirect: 'follow', credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) throw new Error('NET');
    return r.json();
  }, function () { throw new Error('NET'); });
}

/** call('bootstrap'), call('createRequest', data)... The session token is added automatically. */
function call(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  return post(fn, args).then(function (res) {
    if (!res || typeof res !== 'object') throw new Error('The portal sent an unexpected answer. Try again.');
    if (res.error === 'UPDATE' || (res.api && res.api < CFG.PAGE_LEVEL)) { showUpdating(); throw new Error('UPDATING'); }
    if (res.auth) {
      signedOut((S.me && readDraft()) ? 'Please sign in again. Your unsent request is saved.' : 'Please sign in again.');
      throw new Error('AUTH');
    }
    if (!res.ok) throw new Error(res.error || 'Something went wrong.');
    return res.data;
  }, function (e) {
    throw new Error(e && e.message === 'NET' ? 'Could not reach the portal. Check your connection and try again.' : (e && e.message) || 'Something went wrong.');
  });
}

function showUpdating() {
  clearInterval(S.poll);
  saveDraft();
  $('boot').hidden = true; $('auth').hidden = true; $('shell').hidden = true; $('modal').hidden = true;
  $('updating').hidden = false;
}

/* ------------------------------------------------------------- device label for the sign-in alert */
function deviceLabel() {
  var ua = navigator.userAgent || '';
  var b = /Edg\//.test(ua) ? 'Edge' : (navigator.brave ? 'Brave' : /CriOS/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser');
  var o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return b + (o ? ' on ' + o : '');
}

function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

/* ------------------------------------------------------------- dates */
function fmt(ms) {
  if (!ms) return '';
  var d = new Date(ms), n = new Date();
  if (d.toDateString() === n.toDateString()) return 'Today ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  var o = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== n.getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-US', o);
}
function fmtFull(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function ago(days) { return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'; }

/* ------------------------------------------------------------- badges */
function statusBadge(s) {
  var c = { 'New': 'b-new', 'In progress': 'b-prog', 'Waiting on parts': 'b-wait', 'Done': 'b-done', 'Canceled': 'b-cancel' }[s] || 'b-new';
  return '<span class="badge ' + c + '">' + esc(s) + '</span>';
}
function badges(r) {
  var open = OPEN.indexOf(r.status) >= 0;
  return '<span class="badges">' +
    (r.safety && open ? '<span class="badge b-safety">Safety</span>' : '') +
    (r.priority === 'Urgent' && open && !r.safety ? '<span class="badge b-urgent">Urgent</span>' : '') +
    statusBadge(r.status) + '</span>';
}

/* ------------------------------------------------------------- auth screens */
function showOnly(which) {
  $('boot').hidden = true;
  $('updating').hidden = true;
  $('auth').hidden = which !== 'auth';
  $('shell').hidden = which !== 'shell';
}

function authPanel(name) {
  ['authStep1', 'authStep2', 'authConfirm', 'authRevoke'].forEach(function (id) { $(id).hidden = id !== name; });
}

function showAuth(msg) {
  showOnly('auth');
  authPanel('authStep1');
  $('authEmail').value = LS.get('svam_email') || '';
  authError(msg || '');
}

function signedOut(msg) {
  S.token = null; S.me = null;
  LS.del('svam_token');
  clearInterval(S.poll);
  $('modal').hidden = true;
  showAuth(msg);
}

function authError(m) { var e = $('authErr'); e.textContent = m; e.hidden = !m; }

function sendLink() {
  var email = $('authEmail').value.trim();
  if (!email) { authError('Enter your school email address.'); return; }
  var b1 = $('sendLink'), b2 = $('resendLink');
  b1.disabled = true; b2.disabled = true; authError('');
  call('requestLink', email).then(function (r) {
    b1.disabled = false; b2.disabled = false;
    if (!r.ok) { authError(r.message); return; }
    LS.set('svam_email', email);
    authPanel('authStep2');
    $('authMsg').textContent = r.message;
  }).catch(function (e) { b1.disabled = false; b2.disabled = false; if (e.message !== 'UPDATING') authError(e.message); });
}

function confirmSignIn() {
  var link = S.pendingLink;
  if (!link) { showAuth(''); return; }
  var b = $('confirmSignIn'); b.disabled = true; authError('');
  call('redeemLink', link, deviceLabel()).then(function (r) {
    b.disabled = false;
    S.pendingLink = null;
    if (!r.ok) { authPanel('authStep1'); $('authEmail').value = LS.get('svam_email') || ''; authError(r.message); return; }
    S.token = r.token; LS.set('svam_token', r.token);
    setState(r.state);
    enterApp();
  }).catch(function (e) { b.disabled = false; if (e.message !== 'UPDATING') authError(e.message); });
}

function confirmRevoke() {
  var t = S.pendingRevoke;
  var b = $('confirmRevoke'); b.disabled = true; authError('');
  call('revokeAll', t).then(function (r) {
    S.pendingRevoke = null;
    S.token = null; S.me = null; LS.del('svam_token');
    showAuth('');
    if (r.ok) toast(r.message); else authError(r.message);
  }).catch(function (e) { b.disabled = false; if (e.message !== 'UPDATING') authError(e.message); });
}

/* Reads #signin=... or #revoke=... from the address, then removes it right away
   so a reload, a bookmark or a screenshot never carries it. */
function takeHash() {
  var h = location.hash || '';
  var m = /^#(signin|revoke)=([a-f0-9]{64})$/.exec(h);
  if (h) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
  return m ? { kind: m[1], token: m[2] } : null;
}

/* ------------------------------------------------------------- state */
function setState(st) {
  S.me = st.me; S.locations = st.locations; S.categories = st.categories;
  S.statuses = st.statuses; S.priorities = st.priorities; S.requests = st.requests;
  S.people = st.people || []; S.assignees = st.assignees || [];
  S.lastLoad = Date.now();
}

function enterApp() {
  showOnly('shell');
  S.tab = isStaff() ? 'req' : 'open';
  S.selId = null;
  S.f = { q: '', status: 'open', building: '', assigned: '', priority: '' };
  $('fab').innerHTML = ICON.plus;
  $('refreshBtn').innerHTML = ICON.refresh;
  render();
  clearInterval(S.poll);
  S.poll = setInterval(function () { if (!document.hidden && S.token) refresh(false); }, 90000);
  if (!S.me.building) openBuildings(true);
  else if (readDraft() && S.locations.length) openNewRequest();
}

function refresh(manual) {
  if (!S.token) return;
  var b = $('refreshBtn');
  if (manual) b.classList.add('spin');
  return call('bootstrap').then(function (st) {
    var prev = S.selId && S.requests.filter(function (r) { return r.id === S.selId; })[0];
    setState(st);
    var cur = S.selId && S.requests.filter(function (r) { return r.id === S.selId; })[0];
    if (isStaff() && S.tab === 'req') { renderTiles(); renderList(); }
    else if (!isStaff()) { renderSeg(); renderList(); }
    else if (S.tab === 'ppl') renderMain();
    if (cur && (!prev || prev.updated !== cur.updated) && manual) renderPane();
    b.classList.remove('spin');
    if (manual) toast('Up to date');
  }).catch(function (e) { b.classList.remove('spin'); if (manual && e.message !== 'AUTH' && e.message !== 'UPDATING') toast(e.message, true); });
}

/* ------------------------------------------------------------- rendering */
function render() {
  var initial = (S.me.name || '?').trim().charAt(0).toUpperCase();
  $('avatar').textContent = initial;
  $('menuWho').innerHTML = esc(S.me.name) + '<br>' + esc(S.me.email) + '<br>' + esc(S.me.role);
  renderMain();
}

function buildingChip() {
  var main = S.me.building || 'Choose your building';
  var n = S.me.also.length;
  return '<button class="chip" data-act="myBuildings">' + esc(main) + (n ? ' +' + n : '') + ' <span class="muted">Change</span></button>';
}

function renderMain() {
  var m = $('main');
  if (!isStaff()) {
    m.innerHTML =
      '<div class="head-row"><div><div class="eyebrow">Hi, ' + esc(firstName(S.me.name)) + '</div><h1>Your requests</h1></div>' + buildingChip() + '</div>' +
      '<div class="seg" id="seg"></div><div id="list"></div><aside class="pane" id="pane"></aside>';
    renderSeg(); renderList(); renderPane();
    return;
  }
  var tabs = [['req', 'Requests'], ['bld', 'By building']];
  if (S.me.role === 'admin') tabs.push(['ppl', 'People']);
  var seg = '<div class="seg">' + tabs.map(function (t) {
    return '<button data-act="tab" data-v="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
  }).join('') + '</div>';

  if (S.tab === 'req') {
    m.innerHTML =
      '<div class="head-row"><div><div class="eyebrow">Maintenance team</div><h1>Requests</h1></div>' + buildingChip() + '</div>' + seg +
      '<div class="tiles" id="tiles"></div>' +
      '<div class="toolbar"><input id="q" type="text" placeholder="Search requests" value="' + esc(S.f.q) + '">' +
      '<button class="btn ghost sm" data-act="toggleFilters">Filters</button></div>' +
      '<div id="filters"></div>' +
      '<div class="staff-wrap"><div id="list"></div><aside class="pane" id="pane"></aside></div>';
    renderTiles(); renderFilters(); renderList(); renderPane();
  } else if (S.tab === 'bld') {
    m.innerHTML = '<div class="head-row"><div><div class="eyebrow">Maintenance team</div><h1>By building</h1></div></div>' + seg + buildingsTable();
  } else {
    m.innerHTML = '<div class="head-row"><div><div class="eyebrow">Admin</div><h1>People</h1></div>' +
      '<button class="btn sm" data-act="addPerson">Add person</button></div>' + seg + peopleTable();
  }
}

function renderSeg() {
  var open = S.requests.filter(function (r) { return OPEN.indexOf(r.status) >= 0; }).length;
  var done = S.requests.length - open;
  $('seg').innerHTML =
    '<button data-act="tab" data-v="open" class="' + (S.tab === 'open' ? 'on' : '') + '">Open<span class="n">' + open + '</span></button>' +
    '<button data-act="tab" data-v="done" class="' + (S.tab === 'done' ? 'on' : '') + '">Done<span class="n">' + done + '</span></button>';
}

function renderTiles() {
  var el = $('tiles'); if (!el) return;
  var open = S.requests.filter(function (r) { return OPEN.indexOf(r.status) >= 0; });
  var c = function (fn) { return open.filter(fn).length; };
  var tiles = [
    ['New', c(function (r) { return r.status === 'New'; }), S.f.status === 'New'],
    ['In progress', c(function (r) { return r.status === 'In progress'; }), S.f.status === 'In progress'],
    ['Waiting on parts', c(function (r) { return r.status === 'Waiting on parts'; }), S.f.status === 'Waiting on parts'],
    ['Urgent', c(function (r) { return r.priority === 'Urgent'; }), S.f.priority === 'Urgent']
  ];
  el.innerHTML = tiles.map(function (t) {
    return '<button class="tile ' + (t[0] === 'Urgent' ? 'urgent ' : '') + (t[2] ? 'on' : '') + '" data-act="tile" data-v="' + t[0] + '">' +
      '<div class="k">' + t[0] + '</div><div class="v">' + t[1] + '</div></button>';
  }).join('');
}

function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label == null ? v : label) + '</option>'; }

function renderFilters() {
  var el = $('filters'); if (!el) return;
  if (!S.filtersOpen) { el.innerHTML = ''; return; }
  var f = S.f;
  el.innerHTML = '<div class="filters">' +
    '<label class="field"><span>Status</span><select data-f="status">' + opt('open', 'Open (all)', f.status === 'open') +
      S.statuses.map(function (s) { return opt(s, s, f.status === s); }).join('') + opt('all', 'Everything', f.status === 'all') + '</select></label>' +
    '<label class="field"><span>Priority</span><select data-f="priority">' + opt('', 'Any', !f.priority) +
      S.priorities.map(function (s) { return opt(s, s, f.priority === s); }).join('') + '</select></label>' +
    '<label class="field"><span>Building</span><select data-f="building">' + opt('', 'All buildings', !f.building) +
      S.locations.map(function (l) { return opt(l.name, l.name, f.building === l.name); }).join('') + '</select></label>' +
    '<label class="field"><span>Assigned to</span><select data-f="assigned">' + opt('', 'Anyone', !f.assigned) + opt('__none', 'Not assigned', f.assigned === '__none') +
      S.assignees.map(function (a) { return opt(a, a, f.assigned === a); }).join('') + '</select></label>' +
    '<div class="full"><button class="btn ghost sm" data-act="clearFilters">Clear filters</button>' +
    '<button class="btn ghost sm" data-act="copyRows">Copy rows for a spreadsheet</button></div></div>';
}

function filtered() {
  var f = S.f;
  if (!isStaff()) {
    return S.requests.filter(function (r) {
      var open = OPEN.indexOf(r.status) >= 0;
      return S.tab === 'open' ? open : !open;
    });
  }
  var q = f.q.trim().toLowerCase();
  var list = S.requests.filter(function (r) {
    if (f.status === 'open') { if (OPEN.indexOf(r.status) < 0) return false; }
    else if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.building && r.building !== f.building) return false;
    if (f.assigned === '__none') { if (r.assigned) return false; }
    else if (f.assigned && r.assigned !== f.assigned) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (q) {
      var hay = (r.id + ' ' + r.name + ' ' + r.building + ' ' + r.spot + ' ' + r.category + ' ' + r.desc + ' ' + r.assigned).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  var rank = function (r) {
    var open = OPEN.indexOf(r.status) >= 0;
    return (r.safety && open) ? 0 : (r.priority === 'Urgent' && open) ? 1 : 2;
  };
  return list.map(function (r, i) { return [r, i]; })
    .sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; })
    .map(function (x) { return x[0]; });
}

function cardHtml(r) {
  var where = r.building + (r.spot ? ' / ' + r.spot : '');
  return '<button class="card ' + (S.selId === r.id ? 'sel' : '') + '" data-act="open" data-id="' + esc(r.id) + '">' +
    '<div class="row1"><span class="mono caption">' + esc(r.id) + '</span>' + badges(r) + '</div>' +
    '<div class="title">' + esc(r.category) + ' <span class="muted">at</span> ' + esc(where) + '</div>' +
    '<div class="desc">' + esc(r.desc) + '</div>' +
    '<div class="meta">' + (isStaff() ? '<span>' + esc(r.name) + '</span>' : '') + '<span class="mono">' + esc(fmt(r.created)) + '</span>' +
    (isStaff() && r.assigned ? '<span>Assigned: ' + esc(r.assigned) + '</span>' : '') +
    (isStaff() && r.entryOk && OPEN.indexOf(r.status) >= 0 ? '<span>OK to enter</span>' : '') + '</div></button>';
}

function renderList() {
  var el = $('list'); if (!el) return;
  var list = filtered();
  if (!list.length) {
    el.innerHTML = '<div class="empty">' + (isStaff()
      ? 'No requests match these filters.'
      : (S.tab === 'open' ? 'You have no open requests. Tap + to report a problem.' : 'Nothing finished yet.')) + '</div>';
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
}

/* ------------------------------------------------------------- detail pane */
function renderPane() {
  var pane = $('pane'); if (!pane) return;
  var r = S.selId && S.requests.filter(function (x) { return x.id === S.selId; })[0];
  if (!r) {
    pane.classList.remove('open');
    pane.innerHTML = isStaff() ? '<div class="empty">Select a request to see the details.</div>' : '';
    return;
  }
  pane.classList.add('open');
  var staff = isStaff();
  var h = '<div class="sheet"><div class="sheet-top"><div>' +
    '<div class="eyebrow mono">' + esc(r.id) + '</div><h2>' + esc(r.category) + '</h2><div style="margin-top:8px">' + badges(r) + '</div></div>' +
    '<button class="icon-btn ' + (staff ? 'close-only-mobile' : '') + '" data-act="closePane" aria-label="Close">' + ICON.x + '</button></div>' +
    (r.safety ? '<div class="notice danger">The requester marked this as urgent or a safety problem.</div>' : '') +
    '<dl class="kv"><dt>Building</dt><dd>' + esc(r.building) + '</dd>' +
    (r.spot ? '<dt>Spot</dt><dd>' + esc(r.spot) + '</dd>' : '') +
    (staff ? '<dt>From</dt><dd>' + esc(r.name) + '<br><span class="muted small">' + esc(r.email) + '</span></dd>' : '') +
    '<dt>Entry</dt><dd>' + (r.entryOk ? 'OK to enter if nobody is there' : 'Check with the requester before entering') + '</dd>' +
    '<dt>Created</dt><dd class="mono">' + esc(fmtFull(r.created)) + '</dd>' +
    '<dt>Updated</dt><dd class="mono">' + esc(fmtFull(r.updated)) + '</dd>' +
    (r.assigned ? '<dt>Assigned</dt><dd>' + esc(r.assigned) + '</dd>' : '') + '</dl>' +
    '<div class="block-text">' + esc(r.desc) + '</div>' +
    (r.hasPhoto ? '<div class="photo" id="photoBox"><div class="empty" style="border:0">Loading photo...</div></div>' : '');

  if (staff) {
    h += quickHtml(r) + '<div class="controls">' +
      '<label class="field"><span>Status</span><select id="cStatus">' + S.statuses.map(function (s) { return opt(s, s, r.status === s); }).join('') + '</select></label>' +
      '<label class="field"><span>Priority</span><select id="cPriority">' + S.priorities.map(function (s) { return opt(s, s, r.priority === s); }).join('') + '</select></label>' +
      '<label class="field"><span>Assigned to</span><input id="cAssigned" type="text" list="assignList" value="' + esc(r.assigned) + '" placeholder="Name">' +
        '<datalist id="assignList">' + S.assignees.map(function (a) { return '<option value="' + esc(a) + '">'; }).join('') + '</datalist></label>' +
      '<label class="field"><span>Internal notes (only the team sees these)</span><textarea id="cNotes">' + esc(r.notes) + '</textarea></label>' +
      '<div id="cErr" class="notice danger" hidden></div>' +
      '<div class="row-actions"><button class="btn" id="saveBtn" data-act="saveReq" data-id="' + esc(r.id) + '">Save changes</button></div></div>';
  } else if (r.status === 'New') {
    var armed = S.cancelArmed === r.id;
    h += '<div class="row-actions"><button class="btn danger" data-act="cancelReq" data-id="' + esc(r.id) + '">' +
      (armed ? 'Tap again to cancel this request' : 'Cancel request') + '</button></div>';
  } else if (OPEN.indexOf(r.status) >= 0) {
    h += '<p class="caption" style="margin-top:14px">This request is being handled. To change it, call the maintenance office.</p>';
  }
  pane.innerHTML = h + '</div>';
  if (r.hasPhoto) loadPhoto(r.id);
  if (!staff) pane.scrollTop = 0;
}

function quickHtml(r) {
  var steps = {
    'New': [['In progress', 'Start work', true], ['Waiting on parts', 'Waiting on parts']],
    'In progress': [['Done', 'Mark done', true], ['Waiting on parts', 'Waiting on parts']],
    'Waiting on parts': [['In progress', 'Resume work', true], ['Done', 'Mark done']],
    'Done': [['In progress', 'Reopen']],
    'Canceled': [['New', 'Reopen']]
  }[r.status] || [];
  if (!steps.length) return '';
  return '<div class="controls"><div class="eyebrow" style="margin-top:12px">Next step</div><div class="row-actions" style="margin-top:0">' +
    steps.map(function (s) {
      return '<button class="btn ' + (s[2] ? '' : 'ghost') + '" data-act="quick" data-id="' + esc(r.id) + '" data-v="' + esc(s[0]) + '">' + esc(s[1]) + '</button>';
    }).join('') + '</div><p class="caption" style="margin:8px 0 0">The requester gets an email when the status changes.</p></div>';
}

function loadPhoto(id) {
  var show = function (url) {
    var box = $('photoBox');
    if (!box || S.selId !== id) return;
    if (url && /^data:image\/(jpeg|png);base64,/.test(url)) {
      box.innerHTML = '';
      var img = document.createElement('img');
      img.alt = 'Photo of the problem'; img.src = url;
      box.appendChild(img);
    } else box.innerHTML = '<div class="empty" style="border:0">No photo.</div>';
  };
  if (S.photos[id]) { show(S.photos[id]); return; }
  call('getPhoto', id).then(function (url) { S.photos[id] = url; show(url); })
    .catch(function () { var b = $('photoBox'); if (b) b.innerHTML = '<div class="empty" style="border:0">The photo could not be loaded.</div>'; });
}

function replaceRequest(obj) {
  var i = -1;
  S.requests.forEach(function (r, k) { if (r.id === obj.id) i = k; });
  if (i >= 0) S.requests[i] = obj; else S.requests.unshift(obj);
  if (isStaff()) {
    var seen = {}; S.assignees.forEach(function (a) { seen[a.toLowerCase()] = 1; });
    if (obj.assigned && !seen[obj.assigned.toLowerCase()]) { S.assignees.push(obj.assigned); S.assignees.sort(); }
  }
}

/* ------------------------------------------------------------- by building / people */
function buildingsTable() {
  var rows = S.locations.map(function (l) {
    var mine = S.requests.filter(function (r) { return r.building === l.name; });
    var open = mine.filter(function (r) { return OPEN.indexOf(r.status) >= 0; });
    var urgent = open.filter(function (r) { return r.priority === 'Urgent'; });
    return '<tr data-act="bldFilter" data-v="' + esc(l.name) + '"><td>' + esc(l.name) + '</td><td class="num">' + open.length +
      '</td><td class="num">' + (urgent.length ? '<span class="badge b-urgent">' + urgent.length + '</span>' : '0') + '</td><td class="num">' + mine.length + '</td></tr>';
  }).join('');
  return '<div class="scroll-x"><table class="tbl"><thead><tr><th>Building</th><th class="num">Open</th><th class="num">Urgent</th><th class="num">All time</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function peopleTable() {
  var rows = S.people.map(function (p) {
    return '<tr data-act="editPerson" data-email="' + esc(p.email) + '"><td>' + esc(p.name) + '<div class="caption mono">' + esc(p.email) + '</div></td>' +
      '<td>' + esc(p.role) + '</td><td>' + esc(p.building || '-') + (p.room ? '<div class="caption">' + esc(p.room) + '</div>' : '') + (p.also.length ? ' <span class="muted">+' + p.also.length + '</span>' : '') + '</td>' +
      '<td>' + (p.active ? '<span class="badge b-done">Active</span>' : '<span class="badge b-cancel">Off</span>') + '</td></tr>';
  }).join('');
  return '<div class="scroll-x"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Building / room</th><th>Access</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ------------------------------------------------------------- modals */
function openModal(html) {
  var m = $('modal');
  m.innerHTML = '<div class="modal">' + html + '</div>';
  m.hidden = false;
  m.scrollTop = 0;
}
function closeModal() { $('modal').hidden = true; $('modal').innerHTML = ''; S.nr = null; }

function modalTop(title, forced) {
  return '<div class="sheet-top"><h2>' + esc(title) + '</h2>' +
    (forced ? '' : '<button class="icon-btn" data-act="closeModal" aria-label="Close">' + ICON.x + '</button>') + '</div>';
}

function checksHtml(name, exclude, selected) {
  return '<div class="checks">' + S.locations.filter(function (l) { return l.name !== exclude; }).map(function (l) {
    return '<label><input type="checkbox" data-chk="' + name + '" value="' + esc(l.name) + '"' + (selected.indexOf(l.name) >= 0 ? ' checked' : '') + '> ' + esc(l.name) + '</label>';
  }).join('') + '</div>';
}

function getChecks(name) {
  return Array.prototype.slice.call(document.querySelectorAll('input[data-chk="' + name + '"]:checked')).map(function (x) { return x.value; });
}

function roomControl(id, building, current) {
  var loc = S.locations.filter(function (l) { return l.name === building; })[0];
  if (!building || !loc) return '<input id="' + id + '" type="text" disabled placeholder="Choose a building first">';
  if (loc.rooms.length) {
    return '<select id="' + id + '">' + opt('', 'No fixed room', !current || loc.rooms.indexOf(current) < 0) +
      loc.rooms.map(function (r) { return opt(r, r, r === current); }).join('') + '</select>';
  }
  return '<input id="' + id + '" type="text" maxlength="80" value="' + esc(current || '') + '" placeholder="Optional, for example your classroom or office">';
}

/* my buildings */
function openBuildings(forced) {
  var main = S.me.building;
  openModal(modalTop(forced ? 'Where do you work?' : 'My buildings', forced) +
    '<p class="muted">Pick your main building and your room. New requests start there, so the form takes two taps.</p>' +
    '<label class="field"><span>Main building</span><select id="mbMain">' + (main ? '' : opt('', 'Choose...', true)) +
    S.locations.map(function (l) { return opt(l.name, l.name, l.name === main); }).join('') + '</select></label>' +
    '<label class="field"><span>My room (optional)</span><span id="mbRoomWrap" style="display:block;font:inherit;letter-spacing:0;text-transform:none;margin:0">' + roomControl('mbRoom', main, S.me.room) + '</span></label>' +
    '<div class="field"><span>I also work in (optional)</span><div id="mbAlso">' + checksHtml('mbAlso', main, S.me.also) + '</div></div>' +
    '<div id="mbErr" class="notice danger" hidden></div>' +
    '<button class="btn block" data-act="saveBuildings">Save</button>');
}

function saveBuildings() {
  var main = $('mbMain').value, err = $('mbErr');
  if (!main) { err.textContent = 'Choose your main building.'; err.hidden = false; return; }
  call('setMyBuildings', main, getChecks('mbAlso'), $('mbRoom').value).then(function (me) {
    S.me = me; closeModal(); render(); toast('Saved');
    if (readDraft() && S.locations.length) openNewRequest();
  }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
}

/* install help */
function openInstall() {
  if (S.installEvt) {
    var ev = S.installEvt; S.installEvt = null;
    ev.prompt();
    return;
  }
  var body = isIOS()
    ? '<ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>' +
      '<p class="caption">On iPhone the icon opens the portal in Safari, so your sign-in stays saved.</p>'
    : '<ol><li>Open this page in <b>Chrome</b>.</li><li>Tap the <b>three dots</b> menu.</li><li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li></ol>';
  openModal(modalTop('Add to home screen') + body + '<button class="btn block" data-act="closeModal">Done</button>');
}

/* new request */
function myBuildingList() { return [S.me.building].concat(S.me.also).filter(Boolean); }

function readDraft() {
  if (!S.me) return null;
  try {
    var d = JSON.parse(LS.get(DRAFT_KEY) || 'null');
    if (!d || d.email !== S.me.email || !d.ts || Date.now() - d.ts > DRAFT_MAX_AGE) return null;
    if (!d.description && !d.category) return null;
    return d;
  } catch (e) { return null; }
}

function saveDraft() {
  if (!S.nr || !S.me || !$('nrDesc')) return;
  var desc = $('nrDesc').value;
  if (!desc.trim() && !S.nr.category) { LS.del(DRAFT_KEY); return; }
  LS.set(DRAFT_KEY, JSON.stringify({
    email: S.me.email, building: S.nr.building, category: S.nr.category,
    spot: $('nrSpot') ? $('nrSpot').value : '', description: desc,
    safety: !!($('nrSafety') && $('nrSafety').checked), entryOk: !!($('nrEntry') && $('nrEntry').checked), ts: Date.now()
  }));
}

function clearDraft() { LS.del(DRAFT_KEY); }

function restoreDraft(d) {
  var sp = $('nrSpot');
  if (sp && d.spot) sp.value = d.spot;
  if (d.description) $('nrDesc').value = d.description;
  if (d.safety) $('nrSafety').checked = true;
  if (d.entryOk) $('nrEntry').checked = true;
  if (d.category) {
    Array.prototype.forEach.call(document.querySelectorAll('#nrCats .pick'), function (b) {
      if (b.getAttribute('data-v') === d.category) pickCat(b);
    });
  }
  toast('Your unsent request was restored. Add the photo again if you had one.');
}

function openNewRequest() {
  var d = readDraft();
  var mine = myBuildingList();
  var rest = S.locations.map(function (l) { return l.name; }).filter(function (n) { return mine.indexOf(n) < 0; });
  var all = mine.concat(rest);
  S.nr = { building: (d && all.indexOf(d.building) >= 0) ? d.building : (mine[0] || S.locations[0].name), category: '', photo: '' };
  var sel = '<select id="nrBuilding">' + mine.map(function (n) { return opt(n, n, n === S.nr.building); }).join('') +
    (rest.length ? '<optgroup label="Other buildings">' + rest.map(function (n) { return opt(n, n, n === S.nr.building); }).join('') + '</optgroup>' : '') + '</select>';
  openModal(modalTop('New request') +
    '<label class="field"><span>Building</span>' + sel + '</label>' +
    '<label class="field" id="nrSpotWrap"></label>' +
    '<div class="field"><span>What kind of problem?</span><div class="chips" id="nrCats">' +
      S.categories.map(function (c) { return '<button type="button" class="pick" data-act="pickCat" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div></div>' +
    '<div id="nrSimilar"></div>' +
    '<label class="field"><span>What is wrong?</span><textarea id="nrDesc" maxlength="1000" placeholder="Example: The dishwasher is leaking onto the floor."></textarea></label>' +
    '<label class="tick danger-tick"><input type="checkbox" id="nrSafety"><span><b>Urgent or a safety problem</b>' +
      '<span class="caption">Water leak, no heat, a broken lock, exposed wires, something that could hurt someone.</span></span></label>' +
    '<label class="tick"><input type="checkbox" id="nrEntry"><span><b>OK to enter if I am not there</b>' +
      '<span class="caption">Maintenance can go in and fix it without waiting for you.</span></span></label>' +
    '<div class="field"><span>Photo (optional)</span><div class="photo-pick"><button type="button" class="btn ghost sm" data-act="pickPhoto">Add a photo</button>' +
      '<img id="nrThumb" alt="" hidden><button type="button" class="btn ghost sm" id="nrRm" data-act="removePhoto" hidden>Remove</button></div>' +
      '<input id="nrFile" type="file" accept="image/*" hidden></div>' +
    '<div id="nrNote" class="caption"></div>' +
    '<div id="nrErr" class="notice danger" hidden></div>' +
    '<button class="btn block" id="nrSubmit" data-act="submitReq">Send request</button>');
  updateSpot();
  if (d) restoreDraft(d);
}

function updateSpot() {
  var name = $('nrBuilding').value;
  S.nr.building = name;
  var loc = S.locations.filter(function (l) { return l.name === name; })[0] || { rooms: [], urgent: false };
  var def = (name === S.me.building && S.me.room) ? S.me.room : '';
  $('nrSpotWrap').innerHTML = '<span>' + (name === 'Vehicles' ? 'Which vehicle?' : 'Room or spot (optional)') + '</span>' + (loc.rooms.length
    ? '<select id="nrSpot">' + opt('', name === 'Vehicles' ? 'Choose the vehicle' : 'Not sure / whole building', !def || loc.rooms.indexOf(def) < 0) + loc.rooms.map(function (r) { return opt(r, r, r === def); }).join('') + '</select>'
    : '<input id="nrSpot" type="text" maxlength="80" value="' + esc(def) + '" placeholder="Example: kitchen, room 12, back door">');
  $('nrNote').textContent = loc.urgent ? 'Requests from this building are marked urgent automatically.' : '';
  checkSimilar();
}

/* Shows open requests that look like the same problem, so people do not report it twice. */
function checkSimilar() {
  var box = $('nrSimilar'); if (!box || !S.nr) return;
  if (!S.nr.category) { box.innerHTML = ''; return; }
  var seq = ++S.simSeq;
  var spot = $('nrSpot') ? $('nrSpot').value : '';
  call('findSimilar', S.nr.building, S.nr.category, spot).then(function (list) {
    if (seq !== S.simSeq || !$('nrSimilar')) return;
    if (!list || !list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="similar"><div class="eyebrow">Already reported here</div><ul>' + list.map(function (x) {
      return '<li><span class="mono">' + esc(x.id) + '</span> · ' + esc(x.status) + ' · ' + esc(ago(x.days)) +
        (x.spot ? ' · ' + esc(x.spot) : '') + '<br><span class="muted">' + esc(x.desc) + '</span></li>';
    }).join('') + '</ul><div class="caption" style="margin-top:6px">If it is the same problem you do not need to send another one. If it is different, go ahead.</div></div>';
  }).catch(function () { if (seq === S.simSeq && $('nrSimilar')) box.innerHTML = ''; });
}

function pickCat(btn) {
  S.nr.category = btn.getAttribute('data-v');
  Array.prototype.forEach.call(document.querySelectorAll('#nrCats .pick'), function (b) {
    b.classList.toggle('on', b === btn);
  });
  saveDraft();
  checkSimilar();
}

function handlePhotoFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      var max = 1280, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      S.nr.photo = c.toDataURL('image/jpeg', 0.72);
      var t = $('nrThumb'); t.src = S.nr.photo; t.hidden = false; $('nrRm').hidden = false;
    };
    img.onerror = function () { toast('That photo could not be read.', true); };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function submitReq() {
  var err = $('nrErr'); err.hidden = true;
  var data = {
    building: S.nr.building, category: S.nr.category,
    description: $('nrDesc').value.trim(), spot: ($('nrSpot') || { value: '' }).value, photo: S.nr.photo,
    safety: $('nrSafety').checked === true, entryOk: $('nrEntry').checked === true
  };
  if (!data.category) { err.textContent = 'Pick the kind of problem.'; err.hidden = false; return; }
  if (data.description.length < 3) { err.textContent = 'Describe the problem in a few words.'; err.hidden = false; return; }
  saveDraft();
  var b = $('nrSubmit'); b.disabled = true; b.textContent = 'Sending...';
  call('createRequest', data).then(function (obj) {
    clearDraft();
    replaceRequest(obj); closeModal();
    if (!isStaff()) { S.tab = 'open'; }
    S.selId = null;
    if (isStaff()) { renderTiles(); renderList(); renderPane(); } else { renderSeg(); renderList(); renderPane(); }
    toast('Request ' + obj.id + ' sent');
  }).catch(function (e) {
    b.disabled = false; b.textContent = 'Send request';
    if (e.message !== 'AUTH' && e.message !== 'UPDATING') { err.textContent = e.message; err.hidden = false; }
  });
}

/* people */
function openPerson(email) {
  var p = S.people.filter(function (x) { return x.email === email; })[0] ||
    { name: '', email: '', role: 'requester', building: '', room: '', also: [], active: true };
  var isNew = !p.email;
  openModal(modalTop(isNew ? 'Add person' : 'Edit person') +
    '<label class="field"><span>Name</span><input id="pName" type="text" value="' + esc(p.name) + '"></label>' +
    '<label class="field"><span>School email</span><input id="pEmail" type="email" value="' + esc(p.email) + '"' + (isNew ? '' : ' disabled') + '></label>' +
    '<label class="field"><span>Role</span><select id="pRole">' + ['requester', 'manager', 'admin'].map(function (r) { return opt(r, r, p.role === r); }).join('') + '</select></label>' +
    '<label class="field"><span>Main building</span><select id="pBuilding">' + opt('', 'Not set (they will be asked)', !p.building) +
      S.locations.map(function (l) { return opt(l.name, l.name, l.name === p.building); }).join('') + '</select></label>' +
    '<label class="field"><span>Room</span><span id="pRoomWrap" style="display:block;font:inherit;letter-spacing:0;text-transform:none;margin:0">' + roomControl('pRoom', p.building, p.room) + '</span></label>' +
    '<div class="field"><span>Also works in</span>' + checksHtml('pAlso', p.building, p.also) + '</div>' +
    '<label class="field"><span>Access</span><select id="pActive">' + opt('1', 'Active', p.active) + opt('0', 'Off (cannot sign in)', !p.active) + '</select></label>' +
    '<div id="pErr" class="notice danger" hidden></div>' +
    '<button class="btn block" data-act="savePerson">Save</button>');
}

function savePerson() {
  var err = $('pErr'); err.hidden = true;
  var data = {
    name: $('pName').value, email: $('pEmail').value, role: $('pRole').value, building: $('pBuilding').value,
    room: $('pRoom').value, also: getChecks('pAlso'), active: $('pActive').value === '1'
  };
  call('savePerson', data).then(function (people) {
    S.people = people; closeModal(); renderMain(); toast('Saved');
  }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
}

/* copy rows */
function copyRows() {
  var list = filtered();
  var head = ['ID', 'Created', 'Building', 'Spot', 'Category', 'Priority', 'Safety', 'OK to enter', 'Status', 'Assigned', 'From', 'Description'];
  var clean = function (s) { return String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' '); };
  var rows = [head.join('\t')].concat(list.map(function (r) {
    return [r.id, fmtFull(r.created), r.building, r.spot, r.category, r.priority, r.safety ? 'Yes' : '', r.entryOk ? 'Yes' : '', r.status, r.assigned, r.name, r.desc].map(clean).join('\t');
  }));
  openModal(modalTop('Copy rows') +
    '<p class="muted">' + list.length + ' request(s) with the current filters. Copy, then paste into Excel or Google Sheets.</p>' +
    '<textarea id="copyArea" readonly style="min-height:200px;font-family:var(--mono);font-size:12px">' + esc(rows.join('\n')) + '</textarea>' +
    '<button class="btn block" data-act="doCopy">Copy</button>');
  var ta = $('copyArea'); ta.focus(); ta.select();
}

/* ------------------------------------------------------------- actions */
var ACT = {
  refresh: function () { refresh(true); },
  userMenu: function () { $('userMenu').hidden = !$('userMenu').hidden; },
  myBuildings: function () { $('userMenu').hidden = true; openBuildings(false); },
  install: function () { $('userMenu').hidden = true; openInstall(); },
  signout: function () {
    $('userMenu').hidden = true;
    call('signOut', S.token).catch(function () {});
    signedOut('');
  },
  newReq: function () { if (!S.locations.length) { toast('No buildings are set up yet.', true); return; } openNewRequest(); },
  closeModal: function () { if (S.nr) clearDraft(); closeModal(); },
  tab: function (b) {
    S.tab = b.getAttribute('data-v'); S.selId = null;
    if (isStaff()) renderMain(); else { renderSeg(); renderList(); renderPane(); }
  },
  open: function (b) {
    S.selId = b.getAttribute('data-id'); S.cancelArmed = null;
    renderList(); renderPane();
  },
  closePane: function () { S.selId = null; S.cancelArmed = null; renderList(); renderPane(); },
  tile: function (b) {
    var v = b.getAttribute('data-v');
    if (v === 'Urgent') { S.f.priority = S.f.priority === 'Urgent' ? '' : 'Urgent'; S.f.status = 'open'; }
    else { S.f.status = S.f.status === v ? 'open' : v; S.f.priority = ''; }
    renderTiles(); renderFilters(); renderList();
  },
  toggleFilters: function () { S.filtersOpen = !S.filtersOpen; renderFilters(); },
  clearFilters: function () { S.f = { q: '', status: 'open', building: '', assigned: '', priority: '' }; $('q').value = ''; renderTiles(); renderFilters(); renderList(); },
  bldFilter: function (b) {
    S.f = { q: '', status: 'open', building: b.getAttribute('data-v'), assigned: '', priority: '' };
    S.tab = 'req'; S.filtersOpen = true; renderMain();
  },
  saveBuildings: saveBuildings,
  pickCat: pickCat,
  pickPhoto: function () { $('nrFile').click(); },
  removePhoto: function () { S.nr.photo = ''; $('nrThumb').hidden = true; $('nrRm').hidden = true; $('nrFile').value = ''; },
  submitReq: submitReq,
  saveReq: function (b) {
    var id = b.getAttribute('data-id'), err = $('cErr'); err.hidden = true;
    b.disabled = true; b.textContent = 'Saving...';
    call('updateRequest', id, {
      status: $('cStatus').value, priority: $('cPriority').value, assigned: $('cAssigned').value, notes: $('cNotes').value
    }).then(function (obj) {
      replaceRequest(obj); renderTiles(); renderList(); renderPane(); toast('Saved');
    }).catch(function (e) { b.disabled = false; b.textContent = 'Save changes'; err.textContent = e.message; err.hidden = false; });
  },
  quick: function (b) {
    var id = b.getAttribute('data-id'), to = b.getAttribute('data-v'), err = $('cErr');
    err.hidden = true;
    var btns = Array.prototype.slice.call(document.querySelectorAll('[data-act="quick"]'));
    btns.forEach(function (x) { x.disabled = true; });
    var assigned = $('cAssigned').value;
    if (to === 'In progress' && !assigned.trim()) assigned = S.me.name;
    call('updateRequest', id, {
      status: to, priority: $('cPriority').value, assigned: assigned, notes: $('cNotes').value
    }).then(function (obj) {
      replaceRequest(obj); renderTiles(); renderList(); renderPane();
      toast('Now: ' + obj.status + '. The requester was emailed.');
    }).catch(function (e) {
      btns.forEach(function (x) { x.disabled = false; });
      err.textContent = e.message; err.hidden = false;
    });
  },
  cancelReq: function (b) {
    var id = b.getAttribute('data-id');
    if (S.cancelArmed !== id) { S.cancelArmed = id; renderPane(); return; }
    call('cancelRequest', id).then(function (obj) {
      replaceRequest(obj); S.cancelArmed = null; S.selId = null; renderSeg(); renderList(); renderPane(); toast('Request canceled');
    }).catch(function (e) { toast(e.message, true); });
  },
  addPerson: function () { openPerson(''); },
  editPerson: function (b) { openPerson(b.getAttribute('data-email')); },
  savePerson: savePerson,
  copyRows: copyRows,
  doCopy: function () {
    var ta = $('copyArea'); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    toast(ok ? 'Copied' : 'Press Ctrl+C (or Cmd+C) to copy the selected text.');
  }
};

document.addEventListener('click', function (e) {
  var menu = $('userMenu');
  if (menu && !menu.hidden && !e.target.closest('.menu-wrap')) menu.hidden = true;
  var t = e.target.closest('[data-act]');
  if (!t) return;
  var fn = ACT[t.getAttribute('data-act')];
  if (fn) fn(t, e);
});

document.addEventListener('input', function (e) {
  if (e.target.id === 'q') { S.f.q = e.target.value; renderList(); }
  else if (e.target.id === 'nrDesc' || e.target.id === 'nrSpot') { saveDraft(); }
});

document.addEventListener('change', function (e) {
  var t = e.target;
  if (t.getAttribute && t.getAttribute('data-f')) {
    S.f[t.getAttribute('data-f')] = t.value; renderTiles(); renderList();
  } else if (t.id === 'nrBuilding') { updateSpot(); saveDraft(); }
  else if (t.id === 'nrSpot') { saveDraft(); checkSimilar(); }
  else if (t.id === 'nrSafety' || t.id === 'nrEntry') { saveDraft(); }
  else if (t.id === 'nrFile') { handlePhotoFile(t.files && t.files[0]); }
  else if (t.id === 'mbMain') {
    var keep = getChecks('mbAlso');
    $('mbAlso').innerHTML = checksHtml('mbAlso', t.value, keep);
    $('mbRoomWrap').innerHTML = roomControl('mbRoom', t.value, '');
  } else if (t.id === 'pBuilding') {
    $('pRoomWrap').innerHTML = roomControl('pRoom', t.value, '');
  }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.id === 'authEmail') sendLink();
});

document.addEventListener('visibilitychange', function () {
  if (!document.hidden && S.token && Date.now() - S.lastLoad > 30000) refresh(false);
});

window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); S.installEvt = e; });

$('sendLink').addEventListener('click', sendLink);
$('resendLink').addEventListener('click', sendLink);
$('backEmail').addEventListener('click', function () { authPanel('authStep1'); authError(''); });
$('confirmSignIn').addEventListener('click', confirmSignIn);
$('confirmRevoke').addEventListener('click', confirmRevoke);
$('cancelRevoke').addEventListener('click', function () { S.pendingRevoke = null; start(); });
$('reloadBtn').addEventListener('click', function () { location.reload(); });

/* Installable app on Android; on iPhone no manifest, so the home-screen icon opens Safari and keeps the sign-in. */
if (!isIOS()) {
  var link = document.createElement('link');
  link.rel = 'manifest'; link.href = 'manifest.json';
  document.head.appendChild(link);
}

/* ------------------------------------------------------------- start */
function start() {
  var t = LS.get('svam_token');
  if (!t) { showAuth(''); return; }
  S.token = t;
  call('bootstrap').then(function (st) { setState(st); enterApp(); })
    .catch(function (e) { if (e.message !== 'AUTH' && e.message !== 'UPDATING') showAuth(e.message); });
}

/* Returns true when the address carried a sign-in or sign-out-everywhere link. */
function handleHash() {
  var h = takeHash();
  if (!h) return false;
  clearInterval(S.poll);
  $('modal').hidden = true;
  if (h.kind === 'signin') { S.pendingLink = h.token; showOnly('auth'); authPanel('authConfirm'); }
  else { S.pendingRevoke = h.token; showOnly('auth'); authPanel('authRevoke'); }
  $('confirmSignIn').disabled = false; $('confirmRevoke').disabled = false;
  authError('');
  return true;
}

/* The link can also arrive while the portal is already open in this tab. */
window.addEventListener('hashchange', function () { if (location.hash) handleHash(); });

(function boot() {
  if (!CFG.EXEC_URL || !CFG.PAGE_LEVEL) { showAuth('This page is missing its settings. Tell the administrator.'); return; }
  if (handleHash()) return;
  start();
})();

})();
