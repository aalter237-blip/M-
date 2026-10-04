const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { read, write } = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-please-' + crypto.randomBytes(8).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  لم يتم ضبط JWT_SECRET في متغيرات البيئة. جلسات الدخول ستُلغى كل مرة يُعاد فيها تشغيل الخادم. اضبط JWT_SECRET في إعدادات Render.');
}
const COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#475569', '#16a34a'];
const STATUS_TTL = 24 * 60 * 60 * 1000; // 24 ساعة، مثل حالات واتساب

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // يسمح بإرسال تسجيلات صوتية وصور بترميز base64
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 15 * 1024 * 1024 });

// ---------- شكل قاعدة البيانات ----------
function ensureShape(data) {
  data.users = data.users || {};
  data.messages = data.messages || {};
  data.reads = data.reads || {};     // chatId -> { userId: lastReadTs }
  data.chats = data.chats || {};     // chatId -> { wallpaper }
  data.statuses = data.statuses || {}; // userId -> [ {id, type, text, bg, image, ts, viewers:{uid:ts}} ]
  return data;
}

// ---------- أدوات مساعدة ----------
function sign(user) {
  return jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '90d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مسجل الدخول' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'الجلسة منتهية، سجّل الدخول مجددًا' });
  }
}
function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}
function chatId(a, b) { return [a, b].sort().join('_'); }
function activeStatuses(list) {
  const now = Date.now();
  return (list || []).filter(s => s.ts + STATUS_TTL > now);
}

// ---------- المصادقة ----------
app.post('/api/register', (req, res) => {
  const name = (req.body.name || '').trim();
  const password = req.body.password || '';
  if (name.length < 2 || name.length > 24) return res.status(400).json({ error: 'الاسم يجب أن يكون بين حرفين و24 حرفًا' });
  if (password.length < 4) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 4 أحرف على الأقل' });

  const data = ensureShape(read());
  const key = name.toLowerCase();
  const exists = Object.values(data.users).find(u => u.name.toLowerCase() === key);
  if (exists) return res.status(409).json({ error: 'هذا الاسم مستخدم بالفعل، جرّب اسمًا آخر' });

  const id = crypto.randomBytes(9).toString('hex');
  const user = {
    id, name, password: bcrypt.hashSync(password, 10),
    status: 'مرحبًا! أنا أستخدم M&M', bio: '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now()
  };
  data.users[id] = user;
  write(data);
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  const password = req.body.password || '';
  const data = ensureShape(read());
  const user = Object.values(data.users).find(u => u.name.toLowerCase() === name);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'الاسم أو كلمة السر غير صحيحة' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const data = ensureShape(read());
  const user = data.users[req.user.id];
  if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
  res.json({ user: publicUser(user) });
});

app.post('/api/profile', auth, (req, res) => {
  const data = ensureShape(read());
  const user = data.users[req.user.id];
  if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
  const { status, bio, color } = req.body;
  if (typeof status === 'string') user.status = status.slice(0, 100);
  if (typeof bio === 'string') user.bio = bio.slice(0, 300);
  if (typeof color === 'string' && COLORS.includes(color)) user.color = color;
  write(data);
  broadcastUser(user);
  res.json({ user: publicUser(user) });
});

// ---------- المستخدمون ----------
app.get('/api/users', auth, (req, res) => {
  const data = ensureShape(read());
  const list = Object.values(data.users).filter(u => u.id !== req.user.id).map(publicUser);
  res.json({ users: list });
});

// ---------- قائمة الدردشات (محادثاتي المرتبة مع آخر رسالة وعدد غير المقروء) ----------
app.get('/api/chats', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id;
  const out = [];
  for (const cid of Object.keys(data.messages)) {
    const parts = cid.split('_');
    if (!parts.includes(uid)) continue;
    const otherId = parts.find(p => p !== uid);
    const msgs = data.messages[cid] || [];
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const myReadAt = (data.reads[cid] && data.reads[cid][uid]) || 0;
    const unread = msgs.filter(m => m.to === uid && m.t > myReadAt).length;
    out.push({
      userId: otherId,
      lastMessage: { type: last.type, text: last.text, dur: last.dur, from: last.from, t: last.t },
      unread,
      wallpaper: (data.chats[cid] && data.chats[cid].wallpaper) || null
    });
  }
  out.sort((a, b) => b.lastMessage.t - a.lastMessage.t);
  res.json({ chats: out });
});

// ---------- الرسائل ----------
app.get('/api/messages/:otherId', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id;
  const otherId = req.params.otherId;
  const cid = chatId(uid, otherId);
  const list = (data.messages[cid] || []).slice(-300);
  const reads = data.reads[cid] || {};
  res.json({
    messages: list,
    reads, // { userId: lastReadTs }
    wallpaper: (data.chats[cid] && data.chats[cid].wallpaper) || null
  });
});

// ---------- خلفية المحادثة (مشتركة بين الطرفين) ----------
app.post('/api/chat/:otherId/wallpaper', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id, otherId = req.params.otherId;
  if (!data.users[otherId]) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const cid = chatId(uid, otherId);
  const { type, value } = req.body;
  if (!['color', 'gradient', 'image', 'none'].includes(type)) return res.status(400).json({ error: 'نوع خلفية غير صحيح' });
  if (typeof value === 'string' && value.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'الصورة كبيرة جدًا' });
  data.chats[cid] = data.chats[cid] || {};
  data.chats[cid].wallpaper = type === 'none' ? null : { type, value };
  write(data);
  const wp = data.chats[cid].wallpaper;
  io.to('user:' + uid).to('user:' + otherId).emit('wallpaper:update', { chatId: cid, wallpaper: wp });
  res.json({ wallpaper: wp });
});

// ---------- الحالات (Status / Stories) ----------
app.get('/api/statuses', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id;
  const result = [];
  for (const ownerId of Object.keys(data.statuses)) {
    const items = activeStatuses(data.statuses[ownerId]);
    if (!items.length) continue;
    if (ownerId !== uid && !data.users[ownerId]) continue;
    result.push({
      userId: ownerId,
      items: items.map(s => ({
        id: s.id, type: s.type, text: s.text, bg: s.bg, image: s.image, ts: s.ts,
        viewed: !!(s.viewers && s.viewers[uid]),
        viewerCount: ownerId === uid ? Object.keys(s.viewers || {}).length : undefined
      }))
    });
  }
  result.sort((a, b) => (b.items[b.items.length - 1].ts) - (a.items[a.items.length - 1].ts));
  res.json({ statuses: result });
});

app.post('/api/status', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id;
  const { type, text, bg, image } = req.body;
  if (!['text', 'image'].includes(type)) return res.status(400).json({ error: 'نوع الحالة غير صحيح' });
  if (type === 'text' && !String(text || '').trim()) return res.status(400).json({ error: 'اكتب نص الحالة' });
  if (type === 'image' && !image) return res.status(400).json({ error: 'أرفق صورة' });
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    text: type === 'text' ? String(text).slice(0, 300) : (text ? String(text).slice(0, 200) : ''),
    bg: bg || '#0f766e',
    image: type === 'image' ? String(image).slice(0, 6 * 1024 * 1024) : undefined,
    ts: Date.now(),
    viewers: {}
  };
  data.statuses[uid] = data.statuses[uid] || [];
  data.statuses[uid].push(item);
  data.statuses[uid] = activeStatuses(data.statuses[uid]);
  write(data);
  io.emit('status:new', { userId: uid });
  res.json({ item: { ...item, viewers: undefined } });
});

app.delete('/api/status/:id', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id;
  const arr = data.statuses[uid] || [];
  const idx = arr.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'غير موجود' });
  arr.splice(idx, 1);
  write(data);
  io.emit('status:new', { userId: uid });
  res.json({ ok: true });
});

app.post('/api/status/:ownerId/:statusId/view', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id, ownerId = req.params.ownerId;
  const arr = data.statuses[ownerId] || [];
  const item = arr.find(s => s.id === req.params.statusId);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  if (ownerId !== uid && !(item.viewers && item.viewers[uid])) {
    item.viewers = item.viewers || {};
    item.viewers[uid] = Date.now();
    write(data);
    io.to('user:' + ownerId).emit('status:viewed', {
      statusId: item.id, ownerId,
      viewer: publicUser(data.users[uid]), at: item.viewers[uid]
    });
  }
  res.json({ ok: true });
});

app.get('/api/status/:ownerId/:statusId/viewers', auth, (req, res) => {
  const data = ensureShape(read());
  const uid = req.user.id, ownerId = req.params.ownerId;
  if (uid !== ownerId) return res.status(403).json({ error: 'غير مسموح' });
  const arr = data.statuses[ownerId] || [];
  const item = arr.find(s => s.id === req.params.statusId);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  const viewers = Object.entries(item.viewers || {})
    .map(([id, at]) => ({ user: publicUser(data.users[id]), at }))
    .filter(v => v.user)
    .sort((a, b) => b.at - a.at);
  res.json({ viewers });
});

// ---------- Socket.io: الحضور، الكتابة، الرسائل، القراءة، إشارات المكالمات ----------
const online = new Map(); // userId -> Set(socketId)

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    socket.userName = payload.name;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

function broadcastPresence() { io.emit('presence', { online: [...online.keys()] }); }
function broadcastUser(user) { io.emit('user:update', publicUser(user)); }

io.on('connection', (socket) => {
  const uid = socket.userId;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  socket.join('user:' + uid);
  broadcastPresence();

  socket.on('message:send', (msg, ack) => {
    try {
      const to = msg.to;
      const data = ensureShape(read());
      if (!data.users[to]) return ack && ack({ error: 'المستلم غير موجود' });
      const cid = chatId(uid, to);
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        from: uid, to, t: Date.now(),
        type: msg.type === 'v' ? 'v' : 't',
        text: msg.type === 'v' ? '' : String(msg.text || '').slice(0, 2000),
        audio: msg.type === 'v' ? String(msg.audio || '').slice(0, 12 * 1024 * 1024) : undefined,
        dur: msg.type === 'v' ? msg.dur : undefined
      };
      if (!data.messages[cid]) data.messages[cid] = [];
      data.messages[cid].push(record);
      if (data.messages[cid].length > 500) data.messages[cid].splice(0, data.messages[cid].length - 500);
      write(data);
      io.to('user:' + to).to('user:' + uid).emit('message:new', record);
      ack && ack({ ok: true, id: record.id });
    } catch (e) {
      ack && ack({ error: 'تعذر الإرسال' });
    }
  });

  // تمت المشاهدة: أعلن أنني قرأت رسائل هذه المحادثة حتى الآن
  socket.on('message:read', ({ withUserId }) => {
    if (!withUserId) return;
    const data = ensureShape(read());
    const cid = chatId(uid, withUserId);
    data.reads[cid] = data.reads[cid] || {};
    data.reads[cid][uid] = Date.now();
    write(data);
    io.to('user:' + withUserId).to('user:' + uid).emit('message:seen', { chatId: cid, reader: uid, at: data.reads[cid][uid] });
  });

  // جاري الكتابة…
  socket.on('typing', ({ to }) => {
    if (to) io.to('user:' + to).emit('typing', { from: uid });
  });

  // إشارات WebRTC (صوت/فيديو) — تُمرَّر فقط، لا تُخزَّن
  ['call:offer', 'call:answer', 'call:ice', 'call:end'].forEach(ev => {
    socket.on(ev, (payload) => {
      if (!payload || !payload.to) return;
      io.to('user:' + payload.to).emit(ev, { ...payload, from: uid });
    });
  });

  socket.on('disconnect', () => {
    const set = online.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) online.delete(uid);
    }
    broadcastPresence();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log('M&M Message يعمل على المنفذ ' + PORT));
