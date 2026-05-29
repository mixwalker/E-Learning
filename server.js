'use strict';
const http    = require('http');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app     = express();
const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json());

// ── DB helpers ────────────────────────────────────────────────────────────────
function readDB()    { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function uid()       { return crypto.randomUUID(); }

// ── Password hashing (scrypt) ───────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = crypto.scryptSync(String(password), salt, 64);
  return hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf);
}

function addActivity(db, classId, text, color = '#5DCAA5') {
  if (!db.activities[classId]) db.activities[classId] = [];
  db.activities[classId].unshift({ id: uid(), text, color, time: new Date().toISOString() });
  db.activities[classId] = db.activities[classId].slice(0, 20);
}
function emptyColumns() {
  return { assigned: [], in_progress: [], review: [], done: [] };
}

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

function getSessionToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'cf_session') return decodeURIComponent(v || '');
  }
  return null;
}

function getSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess || sess.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return sess;
}

function requireAuth(req, res, next) {
  req.user = getSession(req);
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

function requireTeacher(req, res, next) {
  req.user = getSession(req);
  if (!req.user || req.user.role !== 'teacher') return res.status(403).json({ error: 'forbidden' });
  next();
}

// Authenticated + (for students) restricted to their own class
function requireClassAccess(req, res, next) {
  req.user = getSession(req);
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.role === 'student' && req.user.classId !== req.params.classId)
    return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  const db   = readDB();
  const user = (db.users || []).find(u => u.username === username);
  if (!user || !verifyPassword(password, user.password))
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  const token = crypto.randomBytes(32).toString('hex');
  const sess  = {
    token, userId: user.id, role: user.role, name: user.name,
    classId: user.classId || null, studentRef: user.studentRef || null,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  };
  sessions.set(token, sess);
  res.setHeader('Set-Cookie', `cf_session=${token}; Path=/; HttpOnly; Max-Age=28800; SameSite=Lax`);
  res.json({ role: user.role, name: user.name, classId: user.classId || null });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'cf_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ role: sess.role, name: sess.name, classId: sess.classId, studentRef: sess.studentRef });
});

// ── HTML route protection ─────────────────────────────────────────────────────
app.get('/', (req, res, next) => {
  const sess = getSession(req);
  if (!sess)                      return res.redirect('/login.html');
  if (sess.role === 'student')    return res.redirect('/student.html');
  next();
});

app.get('/index.html', (req, res, next) => {
  const sess = getSession(req);
  if (!sess)                      return res.redirect('/login.html');
  if (sess.role === 'student')    return res.redirect('/student.html');
  next();
});

app.get('/student.html', (req, res, next) => {
  const sess = getSession(req);
  if (!sess)                      return res.redirect('/login.html');
  if (sess.role === 'teacher')    return res.redirect('/');
  next();
});

// ── Static files (after route guards) ────────────────────────────────────────
app.use(express.static(__dirname));

// ── Classes ───────────────────────────────────────────────────────────────────
app.get('/api/classes', requireAuth, (req, res) => res.json(readDB().classes));

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/tasks', requireClassAccess, (req, res) => {
  const db = readDB();
  res.json(db.tasks[req.params.classId] || emptyColumns());
});

app.post('/api/classes/:classId/tasks', requireTeacher, (req, res) => {
  const { classId } = req.params;
  const { title, type, dueDate, points, status = 'assigned' } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const db = readDB();
  if (!db.tasks[classId]) db.tasks[classId] = emptyColumns();
  const task = { id: uid(), classId, title, type: type || 'exercise',
    dueDate: dueDate || '', points: Number(points) || 10, status,
    progress: 0, students: [], createdAt: new Date().toISOString() };
  db.tasks[classId][status].push(task);
  addActivity(db, classId, `เพิ่มงาน "${title}"`, '#5DCAA5');
  writeDB(db);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const COL_NAMES = { assigned:'มอบหมายแล้ว', in_progress:'กำลังทำ', review:'รอตรวจ', done:'ตรวจแล้ว' };
  for (const [classId, ct] of Object.entries(db.tasks)) {
    for (const col of Object.values(ct)) {
      const idx = col.findIndex(t => t.id === id);
      if (idx === -1) continue;
      const task = col[idx];
      const { status: newStatus, ...updates } = req.body;
      Object.assign(task, updates);
      if (newStatus && newStatus !== task.status) {
        col.splice(idx, 1);
        task.status = newStatus;
        db.tasks[classId][newStatus].push(task);
        addActivity(db, classId, `ย้าย "${task.title}" → ${COL_NAMES[newStatus]}`, '#378ADD');
      }
      writeDB(db);
      return res.json(task);
    }
  }
  res.status(404).json({ error: 'not found' });
});

app.delete('/api/tasks/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  for (const [classId, ct] of Object.entries(db.tasks)) {
    for (const col of Object.values(ct)) {
      const idx = col.findIndex(t => t.id === id);
      if (idx === -1) continue;
      const [task] = col.splice(idx, 1);
      addActivity(db, classId, `ลบงาน "${task.title}"`, '#E05A3A');
      writeDB(db);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'not found' });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/stats', requireClassAccess, (req, res) => {
  const { classId } = req.params;
  const db  = readDB();
  const ct  = db.tasks[classId] || emptyColumns();
  const all = Object.values(ct).flat();
  const cl  = db.classes.find(c => c.id === classId) || {};
  res.json({
    studentCount: cl.studentCount || 0,
    totalTasks:   all.length,
    lateTasks:    all.filter(t => t.late).length,
    doneTasks:    ct.done.length,
    ontimeRate:   all.length ? Math.round(((ct.done.length + ct.review.length) / all.length) * 100) : 0,
  });
});

// ── Students ──────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/students', requireClassAccess, (req, res) => {
  const db = readDB();
  res.json((db.students || []).filter(s => s.classId === req.params.classId).sort((a,b) => b.score - a.score));
});

app.post('/api/classes/:classId/students', requireTeacher, (req, res) => {
  const { classId } = req.params;
  const { name, initials, score, avatarClass } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const db = readDB();
  const AV = ['av-t','av-p','av-c','av-a','av-b'];
  const student = { id: uid(), classId, name, initials: initials || name.slice(0, 2),
    score: Number(score) || 0, avatarClass: avatarClass || AV[Math.floor(Math.random() * AV.length)] };
  db.students.push(student);
  writeDB(db);
  res.status(201).json(student);
});

app.patch('/api/students/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const s = db.students.find(s => s.id === id);
  if (!s) return res.status(404).json({ error: 'not found' });
  Object.assign(s, req.body);
  writeDB(db);
  res.json(s);
});

app.delete('/api/students/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const idx = db.students.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  db.students.splice(idx, 1);
  writeDB(db);
  res.json({ ok: true });
});

// ── Activities ────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/activities', requireClassAccess, (req, res) => {
  const db = readDB();
  res.json((db.activities[req.params.classId] || []).slice(0, 10));
});

// ── Materials ─────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/materials', requireClassAccess, (req, res) => {
  const db = readDB();
  res.json((db.materials || {})[req.params.classId] || []);
});

app.post('/api/classes/:classId/materials', requireTeacher, (req, res) => {
  const { classId } = req.params;
  const { title, subject, type, url, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const db = readDB();
  if (!db.materials) db.materials = {};
  if (!db.materials[classId]) db.materials[classId] = [];
  const m = { id: uid(), classId, title, subject: subject || '', type: type || 'doc',
    url: url || '', description: description || '', createdAt: new Date().toISOString() };
  db.materials[classId].push(m);
  addActivity(db, classId, `เพิ่มสื่อ "${title}"`, '#AFA9EC');
  writeDB(db);
  res.status(201).json(m);
});

app.delete('/api/materials/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  for (const [classId, items] of Object.entries(db.materials || {})) {
    const idx = items.findIndex(m => m.id === id);
    if (idx === -1) continue;
    const [m] = items.splice(idx, 1);
    addActivity(db, classId, `ลบสื่อ "${m.title}"`, '#E05A3A');
    writeDB(db);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'not found' });
});

// ── Videos ────────────────────────────────────────────────────────────────────
app.get('/api/classes/:classId/videos', requireClassAccess, (req, res) => {
  const db = readDB();
  res.json((db.videos || {})[req.params.classId] || []);
});

app.post('/api/classes/:classId/videos', requireTeacher, (req, res) => {
  const { classId } = req.params;
  const { title, url, description, duration } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });
  const db = readDB();
  if (!db.videos) db.videos = {};
  if (!db.videos[classId]) db.videos[classId] = [];
  const v = { id: uid(), classId, title, url, description: description || '',
    duration: duration || '', createdAt: new Date().toISOString() };
  db.videos[classId].push(v);
  addActivity(db, classId, `เพิ่มวิดีโอ "${title}"`, '#378ADD');
  writeDB(db);
  res.status(201).json(v);
});

app.delete('/api/videos/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  const db = readDB();
  for (const [classId, items] of Object.entries(db.videos || {})) {
    const idx = items.findIndex(v => v.id === id);
    if (idx === -1) continue;
    const [v] = items.splice(idx, 1);
    addActivity(db, classId, `ลบวิดีโอ "${v.title}"`, '#E05A3A');
    writeDB(db);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'not found' });
});

// ── Timetable ─────────────────────────────────────────────────────────────────
app.get('/api/timetable', requireAuth, (req, res) => res.json(readDB().timetable || []));
app.put('/api/timetable', requireTeacher, (req, res) => {
  const db = readDB(); db.timetable = req.body; writeDB(db); res.json({ ok: true });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireTeacher, (req, res) => res.json(readDB().notifications || []));
app.patch('/api/notifications/:id', requireTeacher, (req, res) => {
  const db = readDB();
  const n = (db.notifications || []).find(n => n.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  Object.assign(n, req.body); writeDB(db); res.json(n);
});
app.delete('/api/notifications/:id', requireTeacher, (req, res) => {
  const db = readDB();
  const idx = (db.notifications || []).findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  db.notifications.splice(idx, 1); writeDB(db); res.json({ ok: true });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', requireTeacher, (req, res) => res.json(readDB().settings || {}));
app.patch('/api/settings', requireTeacher, (req, res) => {
  const db = readDB();
  db.settings = { ...(db.settings || {}), ...req.body };
  writeDB(db); res.json(db.settings);
});

// ── Student dashboard ─────────────────────────────────────────────────────────
app.get('/api/student/dashboard', requireAuth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'forbidden' });
  const db         = readDB();
  const { classId, studentRef } = req.user;
  const classTasks = db.tasks[classId] || emptyColumns();
  const student    = (db.students || []).find(s => s.id === studentRef) || {};
  const classInfo  = (db.classes  || []).find(c => c.id === classId)    || {};
  const all        = Object.values(classTasks).flat();
  res.json({
    student, classInfo,
    tasks:     classTasks,
    materials: (db.materials || {})[classId] || [],
    videos:    (db.videos    || {})[classId] || [],
    stats: {
      total:     all.length,
      done:      classTasks.done.length,
      late:      all.filter(t => t.late).length,
      inProgress: classTasks.in_progress.length,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
http.createServer(app).listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   ClassFlow — Educational Platform       ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║   http://localhost:${PORT}                    ║`);
  console.log('  ║   Login: teacher/1234  |  s001/1234      ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
});
