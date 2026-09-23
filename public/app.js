const $ = id => document.getElementById(id);
const API = '';
let token = localStorage.getItem('mm.token') || null;
let me = null, users = {}, online = new Set(), cur = null, socket = null;
let curReads = {}; // partnerId -> lastReadTs (لمعرفة إن كانت رسائلي "مقروءة")
let chatsMeta = {}; // userId -> {lastMessage, unread, wallpaper}
let statusesData = []; // [{userId, items:[...]}]
let mr, mto, typingTimer, typingSendTimer, lastTypingSent = 0;
let pc, ls, peerId = null, incoming = null, pendIce = [];
let storyState = null; // {userId, items, idx, timer}

const COLORS = ['#0f766e','#2563eb','#7c3aed','#db2777','#ea580c','#ca8a04','#475569','#16a34a'];
const tm = t => new Date(t).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
const dayShort = t => {
  const d = new Date(t), n = new Date();
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return tm(t);
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'أمس';
  return d.toLocaleDateString('ar', { day: 'numeric', month: 'short' });
};
const relTime = t => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'الآن';
  if (s < 3600) return Math.floor(s / 60) + ' د';
  if (s < 86400) return Math.floor(s / 3600) + ' س';
  return Math.floor(s / 86400) + ' ي';
};
const chatId = (a, b) => [a, b].sort().join('_');
function el(t, c, x) { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
function av(u, sz) {
  const d = document.createElement('div'); d.className = 'av';
  d.style.background = u.color || COLORS[0];
  if (sz) d.style.cssText += `;width:${sz}px;height:${sz}px;font-size:${sz/2.3}px`;
  d.textContent = [...(u.name || '؟')][0];
  return d;
}
async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'حدث خطأ');
  return d;
}
function resizeImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const fr = new FileReader();
    fr.onload = () => { img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    }; img.onerror = reject; img.src = fr.result; };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}

// ---------- المصادقة ----------
let mode = 'login';
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); mode = b.dataset.t;
  $('go').textContent = mode === 'login' ? 'دخول' : 'إنشاء الحساب';
  $('err').textContent = '';
});
$('go').onclick = doAuth;
$('pw').onkeydown = e => { if (e.key === 'Enter') doAuth(); };

async function doAuth() {
  const name = $('nm').value.trim(), password = $('pw').value;
  $('err').textContent = '';
  if (name.length < 2 || password.length < 4) { $('err').textContent = 'الاسم حرفان على الأقل، وكلمة السر 4 أحرف على الأقل'; return; }
  try {
    const d = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: { name, password } });
    token = d.token; localStorage.setItem('mm.token', token);
    enter(d.user);
  } catch (e) { $('err').textContent = e.message; }
}
async function tryResume() {
  if (!token) return;
  try { const d = await api('/api/me'); enter(d.user); }
  catch (e) { token = null; localStorage.removeItem('mm.token'); }
}
function logout() {
  token = null; localStorage.removeItem('mm.token');
  socket && socket.disconnect();
  location.reload();
}
function enter(u) {
  me = u;
  $('auth').hidden = true; $('app').hidden = false;
  connectSocket();
  refreshUsers();
  loadChatsList();
  loadStatuses();
  renderMe();
}
async function refreshUsers() {
  try { const d = await api('/api/users'); users = {}; d.users.forEach(u => users[u.id] = u); renderChatsList(); }
  catch (e) {}
}
function renderMe() {
  const h = $('meh');
  h.replaceChildren(av(me), (() => { const t = el('div', 't'); t.append(el('b', 0, me.name), el('small', 0, me.status || 'أضف حالة')); return t; })());
  h.onclick = () => profile(me.id);
}

// ---------- تبويبات الدردشات / الحالات ----------
document.querySelectorAll('.ptab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.ptab').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('pane-chats').hidden = b.dataset.p !== 'chats';
  $('pane-status').hidden = b.dataset.p !== 'status';
});

// ---------- قائمة الدردشات ----------
async function loadChatsList() {
  try {
    const d = await api('/api/chats');
    chatsMeta = {}; d.chats.forEach(c => chatsMeta[c.userId] = c);
    renderChatsList();
  } catch (e) {}
}
function renderChatsList() {
  const q = $('q').value.trim().toLowerCase(), L = $('list');
  const rows = Object.keys(chatsMeta)
    .map(id => ({ id, u: users[id], meta: chatsMeta[id] }))
    .filter(r => r.u && (!q || r.u.name.toLowerCase().includes(q)))
    .sort((a, b) => b.meta.lastMessage.t - a.meta.lastMessage.t);
  if (!rows.length) {
    L.replaceChildren(el('div', 'empty', 'لا توجد محادثات بعد. اضغط ✏️ لبدء محادثة جديدة.'));
    return;
  }
  L.replaceChildren(...rows.map(({ id, u, meta }) => {
    const d = el('div', 'it' + (id === cur ? ' on' : ''));
    const t = el('div', 't');
    const nameRow = el('b', 0, u.name);
    const prev = el('div', 'prev');
    if (meta.lastMessage.from === me.id) {
      const tick = el('span', 'tick ' + (meta.unread === 0 || (curReads[id] && curReads[id] >= meta.lastMessage.t) ? 'read' : 'sent'), '✓✓');
      prev.append(tick);
    }
    prev.append(document.createTextNode(meta.lastMessage.type === 'v' ? '🎙️ رسالة صوتية' : (meta.lastMessage.text || '')));
    t.append(nameRow, prev);
    const metaCol = el('div', 'meta');
    metaCol.append(el('span', 'time', dayShort(meta.lastMessage.t)));
    if (meta.unread > 0) metaCol.append(el('span', 'badge', String(meta.unread)));
    d.append(av(u), t, metaCol);
    if (online.has(id)) d.style.position = 'relative';
    d.onclick = () => openChat(id);
    return d;
  }));
}
$('q').oninput = renderChatsList;

// ---------- بدء محادثة جديدة (جهات الاتصال) ----------
$('newChat').onclick = async () => {
  const d = $('dlg');
  const w = el('div'); w.append(el('h2', 0, 'بدء محادثة'));
  const list = el('div');
  try {
    const r = await api('/api/users');
    if (!r.users.length) list.append(el('div', 'empty', 'لا يوجد مشتركون آخرون بعد.'));
    r.users.forEach(u => {
      const row = el('div', 'contactrow');
      const t = el('div', 't'); t.append(el('b', 0, u.name), el('small', 0, u.status || ''));
      row.append(av(u), t);
      row.onclick = () => { d.close(); document.querySelector('.ptab[data-p="chats"]').click(); openChat(u.id); };
      list.append(row);
    });
  } catch (e) { list.append(el('div', 'empty', 'تعذر تحميل القائمة')); }
  w.append(list);
  const close = el('button', 0, 'إغلاق'); close.style.marginTop = '10px'; close.onclick = () => d.close();
  w.append(close);
  d.replaceChildren(w); d.showModal();
};

// ---------- Socket.io ----------
function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('presence', d => { online = new Set(d.online); renderChatsList(); if (cur) renderChatHeader(); });
  socket.on('user:update', u => { users[u.id] = u; renderChatsList(); if (cur === u.id) renderChatHeader(); if (u.id === me.id) { me = u; renderMe(); } });

  socket.on('message:new', m => {
    const partner = m.from === me.id ? m.to : m.from;
    chatsMeta[partner] = chatsMeta[partner] || { userId: partner, unread: 0, wallpaper: null };
    chatsMeta[partner].lastMessage = { type: m.type, text: m.text, dur: m.dur, from: m.from, t: m.t };
    if (cur === partner) {
      appendBubble(m, true);
      if (m.from !== me.id) socket.emit('message:read', { withUserId: partner });
    } else if (m.from !== me.id) {
      chatsMeta[partner].unread = (chatsMeta[partner].unread || 0) + 1;
    }
    renderChatsList();
  });

  socket.on('message:seen', ({ chatId: cid, reader, at }) => {
    if (reader === me.id) return; // إشعار قراءتي أنا لنفسي، لا حاجة
    if (cur && chatId(me.id, cur) === cid) {
      curReads[reader] = at;
      document.querySelectorAll('.b.me').forEach(b => {
        if (Number(b.dataset.t) <= at) { const tk = b.querySelector('.tick'); if (tk) tk.classList.add('read'); }
      });
    }
    for (const uid of Object.keys(chatsMeta)) {
      if (chatId(me.id, uid) === cid) { curReads[uid] = at; }
    }
    renderChatsList();
  });

  socket.on('typing', ({ from }) => {
    if (cur !== from) return;
    $('cti').querySelector('small').textContent = 'يكتب…';
    $('cti').querySelector('small').classList.add('typing');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { renderChatHeader(); }, 2500);
  });

  socket.on('wallpaper:update', ({ chatId: cid, wallpaper }) => {
    for (const uid of Object.keys(users)) {
      if (chatId(me.id, uid) === cid) {
        if (chatsMeta[uid]) chatsMeta[uid].wallpaper = wallpaper;
        if (cur === uid) applyWallpaper(wallpaper);
      }
    }
  });

  socket.on('status:new', ({ userId }) => { loadStatuses(); });
  socket.on('status:viewed', ({ statusId, viewer, at }) => {
    const grp = statusesData.find(s => s.userId === me.id);
    if (grp) { const it = grp.items.find(i => i.id === statusId); if (it) it.viewerCount = (it.viewerCount || 0) + 1; }
    if (storyState && storyState.userId === me.id) renderStoryViewersBtn();
  });

  socket.on('call:offer', d => {
    if (pc || incoming) { socket.emit('call:end', { to: d.from }); return; }
    incoming = d; pendIce = [];
    $('rt').textContent = (users[d.from] ? users[d.from].name : 'شخص') + (d.video ? ' يتصل بك فيديو 🎥' : ' يتصل بك 📞');
    $('ring').hidden = false;
  });
  socket.on('call:answer', async d => {
    if (!pc || d.from !== peerId) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    pendIce.forEach(c => pc.addIceCandidate(c).catch(() => {})); pendIce = [];
  });
  socket.on('call:ice', d => {
    if (pc && pc.remoteDescription) pc.addIceCandidate(d.candidate).catch(() => {});
    else pendIce.push(d.candidate);
  });
  socket.on('call:end', d => { if (d.from === peerId || (incoming && incoming.from === d.from)) endCall(false); });
}

// ---------- الدردشة ----------
function openChat(id) {
  emojiOpen = false; $('emojiPanel').hidden = true;
  cur = id; $('app').classList.add('chat');
  $('chh').hidden = $('cmp').hidden = false;
  if (chatsMeta[id]) chatsMeta[id].unread = 0;
  renderChatHeader(); renderChatsList();
  loadMessages(id);
}
function renderChatHeader() {
  const u = users[cur]; if (!u) return;
  $('cav').replaceChildren(av(u, 38));
  $('cti').replaceChildren(el('b', 0, u.name), el('small', 0, online.has(cur) ? 'متصل الآن' : (u.status || '')));
  $('cti').onclick = () => profile(cur);
}
async function loadMessages(id) {
  const cid = chatId(me.id, id);
  $('msgs').replaceChildren(el('div', 'empty', 'جارٍ التحميل…'));
  try {
    const d = await api('/api/messages/' + id);
    curReads = d.reads || {};
    applyWallpaper(d.wallpaper);
    const M = $('msgs'); M.replaceChildren();
    if (!d.messages.length) M.replaceChildren(el('div', 'empty', 'ابدأ المحادثة 👋'));
    d.messages.forEach(m => appendBubble(m, false));
    M.scrollTop = M.scrollHeight;
    socket.emit('message:read', { withUserId: id });
  } catch (e) { $('msgs').replaceChildren(el('div', 'empty', 'تعذر تحميل الرسائل')); }
}
function appendBubble(m, scroll) {
  if (!cur || chatId(me.id, cur) !== chatId(m.from, m.to)) return;
  const M = $('msgs');
  const empty = M.querySelector('.empty'); if (empty) empty.remove();
  const b = el('div', 'b ' + (m.from === me.id ? 'me' : 'o'));
  b.dataset.t = m.t; b.dataset.from = m.from;
  if (m.type === 'v' && m.audio) { const a = document.createElement('audio'); a.controls = true; a.src = m.audio; b.append(a); }
  else b.append(document.createTextNode(m.text || ''));
  const small = el('small');
  small.append(document.createTextNode(tm(m.t) + (m.type === 'v' ? ' · ' + m.dur + 'ث ' : ' ')));
  if (m.from === me.id) {
    const isRead = curReads[cur] && curReads[cur] >= m.t;
    small.append(el('span', 'tick ' + (isRead ? 'read' : 'sent'), '✓✓'));
  }
  b.append(small);
  M.append(b);
  if (scroll || M.scrollHeight - M.scrollTop - M.clientHeight < 150) M.scrollTop = M.scrollHeight;
}
function sendText() {
  const v = $('tx').value.trim(); if (!v || !cur) return;
  $('tx').value = '';
  socket.emit('message:send', { to: cur, type: 't', text: v }, ack => { if (ack && ack.error) alert(ack.error); });
}
$('sd').onclick = sendText;
$('tx').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
$('tx').oninput = () => {
  if (!cur) return;
  const now = Date.now();
  if (now - lastTypingSent > 1500) { socket.emit('typing', { to: cur }); lastTypingSent = now; }
};
$('bk').onclick = () => { $('app').classList.remove('chat'); cur = null; renderChatsList(); };

// ---------- تسجيل صوتي ----------
async function rec() {
  if (mr && mr.state === 'recording') { mr.stop(); return; }
  if (!cur) return;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ch = []; const t0 = Date.now();
    mr = new MediaRecorder(st, { audioBitsPerSecond: 16000 });
    mr.ondataavailable = e => ch.push(e.data);
    mr.onstop = async () => {
      clearTimeout(mto); st.getTracks().forEach(t => t.stop()); $('mic').classList.remove('on');
      const url = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(new Blob(ch, { type: mr.mimeType })); });
      const dur = Math.round((Date.now() - t0) / 1000);
      socket.emit('message:send', { to: cur, type: 'v', audio: url, dur }, ack => { if (ack && ack.error) alert(ack.error); });
    };
    mr.start(); $('mic').classList.add('on');
    mto = setTimeout(() => mr.stop(), 60000);
  } catch (e) { alert('تعذر الوصول إلى الميكروفون'); }
}
$('mic').onclick = rec;

// ---------- لوحة الإيموجي ----------
const EMOJI_DATA = [
  { icon: '🆕', name: 'حديثة', list: '🫠 🫡 🫢 🫣 🫤 🫥 🫨 🫩 🥹 🫶 🫰 🫱 🫲 🫳 🫴 🫵 🩷 🩵 🩶 🫦 🫀 🫁 🪸 🪷 🪹 🪺 🫧 🪽 🪼 🫎 🫏 🪿 🦣 🪲 🪳 🪰 🪱 🪴 🫐 🫒 🫓 🫔 🫕 🫖 🧋 🫗 🛝 🪭 🪩 🪫 🪪 🛜 🪬 🫙 🎗️ 🪘 🪇 🪈 🩱 🩲 🩳 🦺'.split(' ') },
  { icon: '😀', name: 'وجوه', list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 🤖'.split(' ') },
  { icon: '👋', name: 'إيماءات', list: '👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🫀 🫁 👀 👁️ 👅 👄'.split(' ') },
  { icon: '❤️', name: 'قلوب', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 💌 💋 😻 😍 🥰 💑 💏 👩‍❤️‍👨 👨‍❤️‍👨 👩‍❤️‍👩'.split(' ') },
  { icon: '🐶', name: 'حيوانات', list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🪳 🦟 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦀 🐠 🐟 🐡 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦣 🦏 🦛 🐪 🐫 🦒 🐃 🐂 🐄 🐎 🐖 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦤 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿️ 🦔'.split(' ') },
  { icon: '🍎', name: 'طعام', list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🫑 🥒 🌶️ 🫒 🌽 🥕 🫓 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫔 🌮 🌯 🫕 🥗 🍿 🧂 🥫 🍱 🍘 🍙 🍚 🍛 🍜 🍝 🍠 🍢 🍣 🍤 🍥 🥮 🍡 🥟 🥠 🥡 🦀 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 🍭 🍮 🍯 🍼 🥛 ☕ 🫖 🍵 🍶 🍾 🍷 🍸 🍹 🍺 🍻 🥂 🥃'.split(' ') },
  { icon: '⚽', name: 'أنشطة', list: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🎸 🪕 🎻'.split(' ') },
  { icon: '✈️', name: 'سفر', list: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🛺 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🕌 🕍 ⛩️ 🕋'.split(' ') },
  { icon: '💡', name: 'أشياء', list: '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🪫 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 🪪 💎 ⚖️ 🪜 🧰 🪛 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🖼️ 🪞 🪟 🛍️ 🛒 🎁 🎈 🎏 🎀 🪄 🪅 🎊 🎉 🪧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 🪧 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'.split(' ') },
  { icon: '✅', name: 'رموز', list: '❤️ 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✳️ ✴️ ❇️ ‼️ ⁉️ ❓ ❔ ❕ ❗ 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢'.split(' ') }
];
let emojiOpen = false;
function buildEmojiPanel() {
  const tabs = $('emojiTabs'), grid = $('emojiGrid');
  tabs.replaceChildren(...EMOJI_DATA.map((cat, i) => {
    const b = el('button', i === 0 ? 'on' : '', cat.icon);
    b.onclick = () => { [...tabs.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); fillGrid(i); };
    return b;
  }));
  fillGrid(0);
  function fillGrid(i) {
    grid.replaceChildren(...EMOJI_DATA[i].list.map(e => {
      const b = el('button', 0, e);
      b.onclick = () => insertEmoji(e);
      return b;
    }));
  }
}
function insertEmoji(e) {
  const ta = $('tx');
  const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + e + ta.value.slice(end);
  const pos = start + e.length;
  ta.focus(); ta.setSelectionRange(pos, pos);
}
$('emojiBtn').onclick = (ev) => {
  ev.stopPropagation();
  emojiOpen = !emojiOpen;
  $('emojiPanel').hidden = !emojiOpen;
  if (emojiOpen) buildEmojiPanel();
};
document.addEventListener('click', (ev) => {
  if (emojiOpen && !$('emojiPanel').contains(ev.target) && ev.target !== $('emojiBtn')) {
    emojiOpen = false; $('emojiPanel').hidden = true;
  }
});

// ---------- خلفية المحادثة (مشتركة) ----------
const WP_PRESETS = [
  { type: 'color', value: '#0b1015' }, { type: 'color', value: '#0f766e' },
  { type: 'gradient', value: 'linear-gradient(135deg,#0f766e,#134e4a)' },
  { type: 'gradient', value: 'linear-gradient(135deg,#7c3aed,#1e1b4b)' },
  { type: 'gradient', value: 'linear-gradient(135deg,#db2777,#4a044e)' },
  { type: 'gradient', value: 'linear-gradient(135deg,#ea580c,#7c2d12)' },
  { type: 'color', value: '#f4f6f8' }, { type: 'none', value: null }
];
function applyWallpaper(wp) {
  const M = $('msgs');
  M.style.background = '';
  M.style.backgroundImage = '';
  if (!wp) return;
  if (wp.type === 'color' || wp.type === 'gradient') M.style.background = wp.value;
  else if (wp.type === 'image') { M.style.backgroundImage = `url(${wp.value})`; }
}
async function setWallpaper(type, value) {
  if (!cur) return;
  try {
    const d = await api('/api/chat/' + cur + '/wallpaper', { method: 'POST', body: { type, value } });
    applyWallpaper(d.wallpaper);
    if (chatsMeta[cur]) chatsMeta[cur].wallpaper = d.wallpaper;
  } catch (e) { alert('تعذر حفظ الخلفية'); }
}
$('wpBtn').onclick = () => {
  if (!cur) return;
  const d = $('dlg');
  const w = el('div'); w.append(el('h2', 0, '🖼️ خلفية المحادثة'));
  w.append(el('small', 0, 'تُطبَّق نفس الخلفية لدى الطرف الآخر تلقائيًا.'));
  const grid = el('div', 'wpgrid');
  WP_PRESETS.forEach(p => {
    const i = el('i');
    i.style.background = p.type === 'none' ? 'repeating-linear-gradient(45deg,#ccc,#ccc 4px,#fff 4px,#fff 8px)' : p.value;
    i.onclick = () => { setWallpaper(p.type, p.value); d.close(); };
    grid.append(i);
  });
  w.append(grid);
  const fileBtn = el('button', 'p', '📷 اختر صورة من جهازك'); fileBtn.style.marginTop = '10px';
  const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.hidden = true;
  fileIn.onchange = async () => {
    if (!fileIn.files[0]) return;
    try { const url = await resizeImage(fileIn.files[0], 900, 0.72); setWallpaper('image', url); d.close(); }
    catch (e) { alert('تعذر معالجة الصورة'); }
  };
  fileBtn.onclick = () => fileIn.click();
  const close = el('button', 0, 'إغلاق'); close.style.marginTop = '8px'; close.onclick = () => d.close();
  w.append(fileBtn, fileIn, close);
  d.replaceChildren(w); d.showModal();
};

// ---------- الملف الشخصي ----------
function profile(id) {
  const u = users[id] || me, own = id === me.id, d = $('dlg');
  const w = el('div'); w.style.cssText = 'display:grid;gap:12px';
  const top = el('div'); top.style.cssText = 'display:flex;gap:14px;align-items:center';
  const t = el('div'); t.append(el('b', 0, u.name), el('small', 0, own ? 'ملفي الشخصي' : (online.has(id) ? 'متصل الآن' : 'غير متصل')));
  top.append(av(u, 62), t); w.append(top);
  if (!own) {
    w.append(el('div', 0, u.status || ''), el('small', 0, u.bio || 'لا توجد نبذة'));
    const myStatus = statusesData.find(s => s.userId === id);
    if (myStatus && myStatus.items.length) {
      const sb = el('button', 'p', '👁 عرض الحالة'); sb.onclick = () => { d.close(); viewStory(id); };
      w.append(sb);
    }
    const c = el('button', 0, 'إغلاق'); c.onclick = () => d.close(); w.append(c);
  } else {
    const s = el('input'); s.value = u.status || ''; s.placeholder = 'الحالة'; s.maxLength = 100;
    const b = el('textarea'); b.value = u.bio || ''; b.placeholder = 'نبذة عنك'; b.rows = 3; b.maxLength = 300;
    let cl = u.color; const sw = el('div', 'sw');
    COLORS.forEach(c2 => { const x = el('i', c2 === cl ? 's' : ''); x.style.background = c2; x.onclick = () => { cl = c2; sw.querySelectorAll('i').forEach(y => y.classList.remove('s')); x.classList.add('s'); }; sw.append(x); });
    const r = el('div'); r.style.cssText = 'display:flex;gap:8px';
    const ok = el('button', 'p', 'حفظ'), no = el('button', 0, 'إلغاء');
    ok.onclick = async () => {
      try { const rr = await api('/api/profile', { method: 'POST', body: { status: s.value.trim(), bio: b.value.trim(), color: cl } }); me = rr.user; renderMe(); d.close(); }
      catch (e) { alert('تعذر الحفظ'); }
    };
    no.onclick = () => d.close();
    r.append(ok, no); w.append(s, b, sw, r);

    const myG = statusesData.find(g => g.userId === me.id);
    const sec = el('div'); sec.style.cssText = 'border-top:1px solid var(--bd);padding-top:10px;margin-top:4px';
    sec.append(el('b', 0, 'حالتي'));
    const row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
    if (myG && myG.items.length) {
      const vb = el('button', 0, '👁 عرض حالتي الحالية'); vb.onclick = () => { d.close(); viewStory(me.id); };
      row.append(vb);
    }
    const ab = el('button', 'p', '+ إضافة حالة جديدة'); ab.onclick = () => { d.close(); openComposer(); };
    row.append(ab); sec.append(row); w.append(sec);
  }
  d.replaceChildren(w); d.showModal();
}

// ---------- الحالات (Status / Stories) ----------
async function loadStatuses() {
  try { const d = await api('/api/statuses'); statusesData = d.statuses; renderStatusList(); }
  catch (e) {}
}
function renderStatusList() {
  const L = $('statusList');
  L.replaceChildren();
  const mine = statusesData.find(s => s.userId === me.id);
  const myRow = el('div', 'statusrow addstatus');
  const ringWrap = el('div', 'ring-wrap' + (mine ? '' : ''));
  ringWrap.append(av(me, 46));
  const plus = el('div', 0, '+'); plus.className = 'plus';
  const wrapBox = el('div'); wrapBox.style.position = 'relative'; wrapBox.append(ringWrap, plus);
  const t = el('div', 't'); t.append(el('b', 0, 'حالتي'), el('small', 0, mine && mine.items.length ? ('آخر تحديث: ' + relTime(mine.items[mine.items.length - 1].ts)) : 'اضغط لإضافة حالة'));
  myRow.append(wrapBox, t);
  myRow.onclick = () => { if (mine && mine.items.length) viewStory(me.id); else openComposer(); };
  plus.onclick = (ev) => { ev.stopPropagation(); openComposer(); };
  L.append(myRow);

  const others = statusesData.filter(s => s.userId !== me.id);
  if (others.length) {
    L.append(el('div', 'statussec', 'تحديثات جهات الاتصال'));
    others.forEach(g => {
      const u = users[g.userId]; if (!u) return;
      const unseen = g.items.some(i => !i.viewed);
      const row = el('div', 'statusrow');
      const rw = el('div', 'ring-wrap' + (unseen ? ' unseen' : '')); rw.append(av(u, 46));
      const t2 = el('div', 't'); t2.append(el('b', 0, u.name), el('small', 0, relTime(g.items[g.items.length - 1].ts)));
      row.append(rw, t2);
      row.onclick = () => viewStory(g.userId);
      L.append(row);
    });
  } else if (!mine || !mine.items.length) {
    L.append(el('div', 'empty', 'لا توجد حالات بعد. أضف أول حالة لك 👆'));
  }
}

function openComposer() {
  const d = $('dlg');
  const w = el('div', 'statuscomposer'); w.append(el('h2', 0, 'إضافة حالة'));
  let bg = COLORS[0], mode = 'text', imgData = null;
  const preview = el('div', 'preview', 'اكتب نص حالتك هنا'); preview.style.background = bg;
  const ta = el('textarea'); ta.placeholder = 'اكتب نص الحالة…'; ta.maxLength = 300;
  ta.oninput = () => { preview.textContent = ta.value || 'اكتب نص حالتك هنا'; };
  const sw = el('div', 'swbg');
  COLORS.forEach(c => { const i = el('i', c === bg ? 's' : ''); i.style.background = c; i.onclick = () => { bg = c; preview.style.background = bg; sw.querySelectorAll('i').forEach(x => x.classList.remove('s')); i.classList.add('s'); }; sw.append(i); });

  const fileBtn = el('button', 0, '📷 إرفاق صورة بدلًا من النص');
  const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.hidden = true;
  fileIn.onchange = async () => {
    if (!fileIn.files[0]) return;
    try {
      imgData = await resizeImage(fileIn.files[0], 900, 0.75); mode = 'image';
      preview.replaceChildren(); const img = document.createElement('img'); img.src = imgData; img.style.maxHeight = '160px'; img.style.borderRadius = '10px';
      preview.append(img); ta.hidden = true; sw.hidden = true;
    } catch (e) { alert('تعذر معالجة الصورة'); }
  };
  fileBtn.onclick = () => fileIn.click();

  const row = el('div'); row.style.cssText = 'display:flex;gap:8px';
  const ok = el('button', 'p', 'نشر'), no = el('button', 0, 'إلغاء');
  ok.onclick = async () => {
    try {
      if (mode === 'image') await api('/api/status', { method: 'POST', body: { type: 'image', image: imgData, text: ta.value.trim() } });
      else {
        if (!ta.value.trim()) return alert('اكتب نص الحالة أو أرفق صورة');
        await api('/api/status', { method: 'POST', body: { type: 'text', text: ta.value.trim(), bg } });
      }
      d.close(); loadStatuses();
    } catch (e) { alert(e.message || 'تعذر النشر'); }
  };
  no.onclick = () => d.close();
  row.append(ok, no);
  w.append(preview, ta, sw, fileBtn, fileIn, row);
  d.replaceChildren(w); d.showModal();
}

function viewStory(userId) {
  const g = statusesData.find(s => s.userId === userId);
  if (!g || !g.items.length) return;
  storyState = { userId, items: g.items, idx: 0, timer: null };
  $('storyView').hidden = false;
  const u = users[userId] || me;
  $('storyav').replaceChildren(av(u, 32));
  $('storyname').textContent = u.name;
  buildStoryBars();
  showStorySlide(0);
}
function buildStoryBars() {
  const bars = $('storybars'); bars.replaceChildren();
  storyState.items.forEach(() => { const seg = el('div', 'seg'); seg.append(el('i')); bars.append(seg); });
}
function showStorySlide(i) {
  clearTimeout(storyState.timer);
  if (i < 0) return closeStory();
  if (i >= storyState.items.length) return closeStory();
  storyState.idx = i;
  const item = storyState.items[i];
  const segs = $('storybars').children;
  [...segs].forEach((seg, idx) => {
    seg.classList.toggle('done', idx < i);
    const bar = seg.querySelector('i');
    if (idx < i) bar.style.width = '100%';
    if (idx === i) { bar.style.transition = 'none'; bar.style.width = '0%'; }
    if (idx > i) bar.style.width = '0%';
  });
  $('storytime').textContent = relTime(item.ts);
  const body = $('storybody'); body.replaceChildren();
  if (item.type === 'image') { const img = document.createElement('img'); img.src = item.image; body.append(img); if (item.text) { const cap = el('div', 0, item.text); cap.style.cssText = 'position:absolute;bottom:70px;inset-inline:20px;background:#0008;padding:10px;border-radius:10px'; body.append(cap); } }
  else { body.style.background = item.bg || '#0f766e'; body.textContent = item.text; }
  renderStoryViewersBtn();

  if (storyState.userId !== me.id) {
    api('/api/status/' + storyState.userId + '/' + item.id + '/view', { method: 'POST' }).catch(() => {});
    item.viewed = true;
  }

  requestAnimationFrame(() => {
    const bar = segs[i].querySelector('i');
    bar.style.transition = (item.type === 'image' ? '6s' : '5s') + ' linear';
    requestAnimationFrame(() => { bar.style.width = '100%'; });
  });
  storyState.timer = setTimeout(() => showStorySlide(i + 1), item.type === 'image' ? 6000 : 5000);
}
function renderStoryViewersBtn() {
  const item = storyState.items[storyState.idx];
  const btn = $('storyViewers');
  if (storyState.userId === me.id) {
    btn.hidden = false; $('viewerCount').textContent = item.viewerCount || 0;
  } else btn.hidden = true;
}
$('storyViewers').onclick = async () => {
  const item = storyState.items[storyState.idx];
  clearTimeout(storyState.timer);
  try {
    const r = await api('/api/status/' + me.id + '/' + item.id + '/viewers');
    const d = $('dlg'); const w = el('div'); w.append(el('h2', 0, 'شاهدوا حالتك'));
    if (!r.viewers.length) w.append(el('div', 'empty', 'لا أحد شاهدها بعد'));
    r.viewers.forEach(v => { const row = el('div', 'viewerrow'); row.append(av(v.user, 34), el('b', 0, v.user.name), el('small', 0, relTime(v.at))); w.append(row); });
    const close = el('button', 'p', 'إغلاق'); close.style.marginTop = '10px'; close.onclick = () => { d.close(); showStorySlide(storyState.idx); };
    w.append(close); d.replaceChildren(w); d.showModal();
  } catch (e) {}
};
function closeStory() { clearTimeout(storyState && storyState.timer); storyState = null; $('storyView').hidden = true; renderStatusList(); }
$('storyClose').onclick = closeStory;
$('storyPrev').onclick = () => storyState && showStorySlide(storyState.idx - 1);
$('storyNext').onclick = () => storyState && showStorySlide(storyState.idx + 1);

// ---------- الإعدادات ----------
$('setBtn').onclick = () => {
  const d = $('dlg');
  const w = el('div'); w.style.cssText = 'display:grid;gap:6px';
  w.append(el('h2', 0, '⚙️ الإعدادات'));

  const themeRow = el('div', 'settings-row');
  themeRow.append(el('span', 0, 'مظهر التطبيق'));
  const themeSel = document.createElement('select'); themeSel.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--pn);color:var(--tx)';
  [['system','تلقائي'],['light','فاتح'],['dark','داكن']].forEach(([v,l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; themeSel.append(o); });
  themeSel.value = localStorage.getItem('mm.theme') || 'system';
  themeSel.onchange = () => { const v = themeSel.value; localStorage.setItem('mm.theme', v); applyTheme(v); };
  themeRow.append(themeSel); w.append(themeRow);

  const out = el('div', 'settings-row');
  const lb = el('button', 'p', 'تسجيل الخروج'); lb.onclick = logout;
  out.append(el('span', 0, me ? me.name : ''), lb); w.append(out);

  const credits = el('div', 'credits');
  credits.innerHTML = `
    M&amp;M — Message<br>
    تطوير: <b>shargawe237</b><br>
    <a class="wa" href="https://wa.me/249962006146" target="_blank" rel="noopener">📱 تواصل عبر واتساب</a>
  `;
  w.append(credits);

  const close = el('button', 0, 'إغلاق'); close.onclick = () => d.close(); close.style.marginTop = '6px';
  w.append(close);
  d.replaceChildren(w); d.showModal();
};
function applyTheme(v) {
  if (v === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}
applyTheme(localStorage.getItem('mm.theme') || 'system');

// ---------- المكالمات (WebRTC) ----------
// خوادم STUN من Google + خادم TURN مجاني من Open Relay (يضمن نجاح المكالمة
// حتى خلف شبكات صارمة أو جدران حماية). إن أردت لاحقًا خادم TURN خاص وأكثر
// ثباتًا، استبدل بيانات هذا الخادم ببيانات خدمة مدفوعة مثل Twilio أو Metered.
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};
async function media(video) {
  ls = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false });
  $('lv').srcObject = ls; $('lv').hidden = !video;
}
function mkPc() {
  pc = new RTCPeerConnection(ICE);
  ls.getTracks().forEach(t => pc.addTrack(t, ls));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('call:ice', { to: peerId, candidate: e.candidate.toJSON() }); };
  pc.ontrack = e => { $('rv').srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') $('cn').textContent = users[peerId] ? users[peerId].name : '';
    if (['failed', 'closed'].includes(pc.connectionState)) endCall(false);
  };
}
async function call(video) {
  if (!cur || pc || incoming) return;
  peerId = cur;
  try { await media(video); } catch (e) { peerId = null; return alert('تعذر الوصول إلى الكاميرا أو الميكروفون'); }
  mkPc(); $('call').hidden = false;
  $('cn').textContent = 'جارٍ الاتصال بـ ' + (users[peerId] ? users[peerId].name : '') + '…';
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  socket.emit('call:offer', { to: peerId, sdp: offer.sdp, video });
  setTimeout(() => { if (pc && pc.connectionState !== 'connected') endCall(true); }, 45000);
}
async function accept() {
  const d = incoming; incoming = null; $('ring').hidden = true; peerId = d.from;
  try { await media(d.video); } catch (e) { socket.emit('call:end', { to: peerId }); peerId = null; return alert('تعذر الوصول إلى الميكروفون'); }
  mkPc(); $('call').hidden = false; $('cn').textContent = 'جارٍ الاتصال…';
  await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
  pendIce.forEach(c => pc.addIceCandidate(c).catch(() => {})); pendIce = [];
  const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
  socket.emit('call:answer', { to: peerId, sdp: ans.sdp });
}
function endCall(sendEnd) {
  if (sendEnd) { const to = peerId || (incoming && incoming.from); if (to) socket.emit('call:end', { to }); }
  if (pc) { const p = pc; pc = null; p.close(); }
  ls && ls.getTracks().forEach(t => t.stop()); ls = null;
  peerId = null; incoming = null; pendIce = [];
  $('ring').hidden = $('call').hidden = true; $('rv').srcObject = null;
}
$('ca').onclick = () => call(false);
$('cv').onclick = () => call(true);
$('acb').onclick = accept;
$('rj').onclick = () => endCall(true);
$('hg').onclick = () => endCall(true);
$('mu').onclick = () => { if (!ls) return; const t = ls.getAudioTracks()[0]; t.enabled = !t.enabled; $('mu').textContent = t.enabled ? '🎤' : '🔇'; };

tryResume();
