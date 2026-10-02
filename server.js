#!/usr/bin/env node
/* ============================================================
   Knowledge Base · 服务端 V1.0.0（零依赖 Node.js，可部署到公网）
   ------------------------------------------------------------
   【模块地图】（从上到下依次定义，维护时按区定位）
   ① 初始化目录   : L43  data/log 等目录自动创建（不存在即新建）
   ② 数据库读写   : L51  JSON 原子写入（loadXxx / saveXxx 成对使用）
   ③ 端口配置     : L94  data/server_config.json（-set port / -random port）
   ④ 运行统计     : L113 data/server_stats.json（流量 / 请求数 / 小时分布）
   ⑤ 账号与会话   : L162 data/accounts.json + data/sessions.json（tokens Map）
   ⑥ 收藏规范化   : L199 产品 / 知识 / 内容 三库收藏格式（兼容旧字符串）
   ⑦ 基础工具     : L254 sendJSON / sendError / authUser / CORS / gzip / ETag
   ⑧ 头像 / 背景  : L260 data/avatars/ + data/bg/
   ⑨ 校验与图片   : L355 产品名校验、分类标签校验、图片落盘
   ⑩ 售后知识库   : L439 data/knowledge.json + data/knowledge_images/
   ⑪ 内容查询库   : L502 data/talks.json + data/talk_images/
   ⑫ BUG 反馈    : L553 data/bugs.json + data/bug_images/
   ⑬ 日志系统     : L589 log/<日期>.log（按天生成）
   ⑭ HTTP 服务   : L616 全部 API 路由（新增接口按模块分区就近插入）
   ⑮ 命令交互     : L1734 -server / -set port / -random port / -restart server / -log
   ⑯ 主流程       : L1916 启动入口（命令模式，取消账号密码验证）
   ------------------------------------------------------------
   【数据文件对照】（不存在时自动创建空库，升级 / 迁移不影响既有数据）
   data/products.json   产品库      data/knowledge.json  售后知识库
   data/talks.json      内容库      data/accounts.json   账号 + 注册申请
   data/sessions.json   登录会话    data/bugs.json       反馈
   data/server_config.json 端口配置 data/server_stats.json 流量统计
   图片目录：data/picture/ avatars/ bg/ knowledge_images/ talk_images/ bug_images/
   ------------------------------------------------------------
   【维护规范】
   1. 每次更新必须修改 VERSION（本文件）与 index.html 的 about-ver / CHANGELOG
   2. 新增接口在 HTTP 服务区按「模块分区」就近插入，保持分区注释清晰
   3. 数据库一律走 loadXxx() + saveXxx() 原子读写，禁止绕过直接写文件
   4. 所有 JSON 响应走 sendJSON（自动 gzip + ETag 304 协商），禁止手写 res.end
   5. 图片静态服务统一加长缓存（Cache-Control: public, max-age=2592000）
   6. 前端为单文件 index.html；新增前端模块需同步补充其模块地图注释
   7. 数据文件与代码分离：升级只替换 server.js / index.html，data 目录原样保留
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const readline = require('readline');
const zlib = require('zlib');

// 版本号命名规范：V主版本号.子版本号.修正版本号
// 主版本号=重构整个项目；子版本号=新功能/数据/算法/内容；修正版本=小修饰/修正bug/前端优化
const VERSION = 'V1.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PIC_DIR = path.join(DATA_DIR, 'picture');
const DB_FILE = path.join(DATA_DIR, 'products.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const BG_DIR = path.join(DATA_DIR, 'bg');
const BUGS_FILE = path.join(DATA_DIR, 'bugs.json');
const BUG_IMG_DIR = path.join(DATA_DIR, 'bug_images');
const INDEX_FILE = path.join(ROOT, 'index.html');
const LOG_DIR = path.join(ROOT, 'log');
const ABOUT_DIR = path.join(ROOT, 'about');

// ---------- 初始化目录（没有就新建） ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PIC_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(BG_DIR, { recursive: true });
fs.mkdirSync(BUG_IMG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- 数据库读写（JSON，原子写入） ----------
// 产品数据规范化：兼容旧数据，缺失的分类补「未分类」，标签补空数组
function normalizeProduct(p) {
  if (!p.category || typeof p.category !== 'string' || !p.category.trim()) p.category = '未分类';
  if (!Array.isArray(p.tags)) p.tags = [];
  p.tags = p.tags.filter(t => typeof t === 'string' && t.trim());
  return p;
}
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return { products: [] };
    const raw = fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '');
    const db = JSON.parse(raw);
    if (db && Array.isArray(db.products)) { db.products = db.products.map(normalizeProduct); return db; }
    return { products: [] };
  } catch (e) {
    return { products: [] };
  }
}
// 内存缓存：文件未变化时直接复用解析结果，避免每次请求都读盘解析大文件
let _dbCache = null;
let _dbCacheSig = '';
function getDb() {
  try {
    const st = fs.statSync(DB_FILE);
    const sig = st.size + '-' + Math.floor(st.mtimeMs);
    if (_dbCache && _dbCacheSig === sig) return _dbCache;
    const db = loadDb();
    _dbCache = db;
    _dbCacheSig = sig;
    return db;
  } catch (e) {
    return loadDb();
  }
}
function saveDb(db) {
  _dbCache = null;
  _dbCacheSig = '';
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 端口配置（data/server_config.json，V2.0.11 起） ----------
// port: 数字 = 固定端口（每次启动使用该端口）；null = 随机端口（每次启动随机分配）
const PORT_CONFIG_FILE = path.join(DATA_DIR, 'server_config.json');
function loadPortConfig() {
  try {
    if (fs.existsSync(PORT_CONFIG_FILE)) {
      const raw = fs.readFileSync(PORT_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (j && typeof j.port === 'number' && j.port >= 1 && j.port <= 65535) return j.port;
    }
  } catch (e) { /* 配置损坏则视为随机端口 */ }
  return null;
}
function savePortConfig(port) {
  const tmp = PORT_CONFIG_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ port: port }, null, 2), 'utf8');
  fs.renameSync(tmp, PORT_CONFIG_FILE);
}

// ---------- 服务器运行统计（data/server_stats.json，V2.0.7 起记录） ----------
// 统计范围：今日累计传输量、今日最大每秒传输速率、今日各小时传输量、今日请求数
// 规则：跨天自动重置；进程每 60 秒落盘一次，退出时也落盘；旧版本无此数据，从本版本开始累计
const STATS_FILE = path.join(DATA_DIR, 'server_stats.json');
let serverStartTimeStr = nowStr();
function loadStats() {
  const today = nowStr().slice(0, 10);
  const st = { date: today, totalBytes: 0, maxBps: 0, maxBpsTime: '', requests: 0, hourly: {} };
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (j && j.date === today) {
        st.date = j.date; st.totalBytes = j.totalBytes || 0; st.maxBps = j.maxBps || 0;
        st.maxBpsTime = j.maxBpsTime || ''; st.requests = j.requests || 0; st.hourly = j.hourly || {};
      }
      // 日期不一致 = 跨天，直接重置
    }
  } catch (e) { /* 文件损坏则从零开始 */ }
  return st;
}
let stats = loadStats();
let _secMap = {}; // 秒级传输字节窗口，用于计算每秒最大速率
function recordTraffic(bytes) {
  if (!(bytes > 0)) return;
  stats.requests++;
  stats.totalBytes += bytes;
  const now = new Date();
  const h = now.getHours();
  stats.hourly[h] = (stats.hourly[h] || 0) + bytes;
  const key = Math.floor(now.getTime() / 1000);
  _secMap[key] = (_secMap[key] || 0) + bytes;
  if (_secMap[key] > stats.maxBps) {
    stats.maxBps = _secMap[key];
    stats.maxBpsTime = now.toTimeString().slice(0, 8);
  }
  const cutoff = key - 120;
  for (const k in _secMap) { if (Number(k) < cutoff) delete _secMap[k]; }
}
function saveStats() {
  try {
    const tmp = STATS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf8');
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) { /* 写失败忽略，内存统计继续生效 */ }
}
setInterval(saveStats, 60000);
process.on('exit', saveStats);

// ---------- 账号库与管理申请（data/accounts.json） ----------
const tokens = new Map(); // token -> username
// V2.12.1 会话持久化：登录 token 落盘 data/sessions.json，服务端重启后已登录用户无需重新登录
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
function saveSessions() {
  try {
    const arr = [];
    tokens.forEach((username, token) => arr.push({ token: token, username: username }));
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { /* 会话落盘失败不阻塞 */ }
}
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      if (x && x.token && x.username) tokens.set(x.token, x.username);
    });
  } catch (e) { /* 会话文件损坏时忽略，视为未登录 */ }
}
loadSessions();

function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return { users: [], applications: [] };
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const a = JSON.parse(raw);
    return {
      users: Array.isArray(a.users) ? a.users : [],
      applications: Array.isArray(a.applications) ? a.applications : []
    };
  } catch (e) {
    return { users: [], applications: [] };
  }
}
// ---------- 收藏规范化（V3.8.0：三种查询库 product/knowledge/talk，兼容旧产品字符串收藏） ----------
function normFav(f) {
  if (typeof f === 'string') return { t: 'product', id: f };
  if (f && typeof f === 'object' && f.t && f.id !== undefined) return { t: String(f.t), id: String(f.id) };
  return null;
}
function userFavs(user) {
  return (Array.isArray(user.favorites) ? user.favorites.map(normFav) : []).filter(Boolean);
}
function saveAccounts(acc) {
  const tmp = ACCOUNTS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(acc, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
}
function ensureAdmin() {
  const acc = loadAccounts();
  if (!acc.users.some(u => u.username === 'admini')) {
    acc.users.push({ username: 'admini', password: 'admini', role: 'admin', createdAt: nowStr() });
    saveAccounts(acc);
  }
}
function validateUsername(name) {
  // V2.1.0 起：账号长度需大于 5 个字符、不能是中文、不能包含 Windows 文件不可重命名字符
  if (typeof name !== 'string' || !name.trim()) return '账号不能为空';
  if (name.trim().length <= 5) return '账号长度需大于 5 个字符';
  if (name.length > 30) return '账号不能超过 30 个字符';
  if (/\s/.test(name)) return '账号不能包含空格';
  if (/[\u4e00-\u9fff]/.test(name)) return '账号不能包含中文';
  if (/[\\/:*?"<>|]/.test(name)) return '账号不能包含 \\ / : * ? " < > | 等字符';
  if (/[.\s]$/.test(name)) return '账号不能以空格或句点结尾';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return '账号不能使用系统保留名称（CON、PRN、AUX、NUL、COM1~9、LPT1~9）';
  if (/[\x00-\x1f]/.test(name)) return '账号不能包含控制字符';
  return null;
}
function validatePassword(pass) {
  // V2.1.0 起：密码需英文+数字组合，长度大于 5
  if (typeof pass !== 'string' || !pass) return '密码不能为空';
  if (pass.length <= 5) return '密码长度需大于 5 个字符';
  if (pass.length > 64) return '密码不能超过 64 个字符';
  if (/\s/.test(pass)) return '密码不能包含空格';
  if (/[\u4e00-\u9fff]/.test(pass)) return '密码不能包含中文';
  if (!/[A-Za-z]/.test(pass) || !/[0-9]/.test(pass)) return '密码需为英文+数字的组合（至少包含一个字母和一个数字）';
  if (/[\\/:*?"<>|]/.test(pass)) return '密码不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  const username = tokens.get(t);
  if (!username) return null;
  const acc = loadAccounts();
  return acc.users.find(u => u.username === username) || null;
}

// ---------- 基础工具 ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match'
};
// ---------- 用户头像（V2.1.0） ----------
// 头像文件命名 = 账号（与注册限制一致，天然符合文件名规则）；data/avatars/{账号}.png
function avatarFile(username) { return username + '.png'; }
function avatarUrlPath(username, ver) {
  if (!username) return null;
  return '/avatars/' + encodeURIComponent(avatarFile(username)) + (ver ? '?v=' + ver : '');
}
function saveAvatar(username, base64) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(base64 || '');
  if (!m) return { err: '头像格式不支持，请上传 PNG / JPG / WEBP 图片' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return { err: '头像图片过大（超过 5MB）' };
  const fname = avatarFile(username);
  fs.writeFileSync(path.join(AVATAR_DIR, fname), buf);
  return { ok: true };
}
function deleteAvatar(username) {
  try { fs.unlinkSync(path.join(AVATAR_DIR, avatarFile(username))); } catch (e) { /* 忽略 */ }
}
// ---------- 用户主页背景（V3.7.0）：data/bg/{账号}.png ----------
function bgFile(username) { return username + '.png'; }
function bgUrlPath(username, ver) {
  if (!username) return null;
  return '/bg/' + encodeURIComponent(bgFile(username)) + (ver ? '?v=' + ver : '');
}
function saveBg(username, base64) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(base64 || '');
  if (!m) return { err: '背景图片格式不支持，请上传 PNG / JPG / WEBP 图片' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return { err: '背景图片过大（超过 8MB）' };
  fs.writeFileSync(path.join(BG_DIR, bgFile(username)), buf);
  return { ok: true };
}

// 是否支持 gzip：客户端声明 Accept-Encoding 时启用压缩，显著降低带宽
function acceptsGzip(req) {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  return ae.indexOf('gzip') >= 0;
}
function sendJSON(req, res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extraHeaders || {});
  // V4.0.0 通用 ETag 内容寻址缓存：GET 请求带 If-None-Match 且内容未变时返回 304（零传输）
  // 约定：extraHeaders 已提供 ETag（如知识库按文件 mtime 计算）时优先使用，否则按响应体内容计算
  const etag = headers['ETag'] || ('"' + crypto.createHash('sha1').update(body).digest('hex') + '"');
  headers['ETag'] = etag;
  if (req.method === 'GET' && req.headers['if-none-match'] === etag) {
    res.writeHead(304, Object.assign({ ETag: etag }, CORS));
    res.end();
    return;
  }
  if (acceptsGzip(req)) {
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    res.end(gz);
    recordTraffic(gz.length);
    return;
  }
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
  recordTraffic(Buffer.byteLength(body));
}
function sendError(req, res, status, message) {
  sendJSON(req, res, status, { error: message });
}
function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const raw = await readBody(req, 12 * 1024 * 1024);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw Object.assign(new Error('JSON 解析失败'), { status: 400 }); }
}
// 获取客户端 IP：优先 frp/反向代理透传的头部，回退到 socket 地址
function clientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const xr = req.headers['x-real-ip'];
  if (xr) return String(xr).trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// ---------- 产品名称校验 ----------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function validateProductName(name) {
  if (typeof name !== 'string') return '产品名称不能为空';
  const n = name.trim();
  if (!n) return '产品名称不能为空';
  if (n.length > 100) return '产品名称不能超过 100 个字符';
  if (n === '.' || n === '..') return '产品名称不合法';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return '产品名称不能包含 \\ / : * ? " < > | 等字符';
  if (/[.\s]$/.test(n)) return '产品名称不能以空格或句点结尾';
  if (RESERVED.test(n)) return '产品名称不能使用系统保留名称（CON、PRN、AUX、NUL、COM1~COM9、LPT1~LPT9）';
  return null;
}
function findProduct(db, id) { return db.products.find(p => p.id === id); }
function nameExists(db, name, excludeId) {
  const n = name.trim().toLowerCase();
  return db.products.some(p => p.id !== excludeId && p.name.trim().toLowerCase() === n);
}

// ---------- 产品分类 / 标签校验 ----------
function validateCategory(c) {
  if (typeof c !== 'string') return '产品分类不能为空';
  const n = c.trim();
  if (!n) return '产品分类不能为空';
  if (n.length > 30) return '产品分类不能超过 30 个字符';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return '产品分类不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
// 三级分类通用校验（部门分类 / 类型分类 / 平台分类，V2.4.0 起）
function validateCls(v, label) {
  if (typeof v !== 'string') return label + '不能为空';
  const n = v.trim();
  if (!n) return label + '不能为空';
  if (n.length > 30) return label + '不能超过 30 个字符';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return label + '不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
function validateTag(t) {
  if (typeof t !== 'string') return '标签不能为空';
  const n = t.trim();
  if (!n) return '标签不能为空';
  if (n.length > 20) return '标签不能超过 20 个字符';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return '标签不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
// 解析标签数组：校验、去空格、去重，最多 10 个；返回 { ok, tags, error }
function parseTags(raw) {
  if (raw === undefined) return { ok: true, tags: [] };
  if (!Array.isArray(raw)) return { ok: false, error: '标签格式不正确' };
  const tags = [];
  const seen = new Set();
  for (const t of raw) {
    const s = String(t).trim();
    const err = validateTag(s);
    if (err) return { ok: false, error: err };
    const key = s.toLowerCase();
    if (!seen.has(key)) { seen.add(key); tags.push(s); }
  }
  if (tags.length > 10) return { ok: false, error: '标签不能超过 10 个' };
  return { ok: true, tags };
}

// ---------- 图片处理（base64 -> data/picture/产品名.扩展名） ----------
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function saveImage(base64, productName) {
  if (!base64) return null;
  let b64 = base64, ext = 'png';
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/s.exec(base64);
  if (m) {
    ext = MIME_EXT['image/' + m[1].toLowerCase()] || 'png';
    b64 = m[2];
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('图片文件不能超过 8MB'), { status: 400 });
  const fname = productName + '.' + ext;
  fs.writeFileSync(path.join(PIC_DIR, fname), buf);
  return fname;
}
function deleteImageFile(fname) {
  if (!fname) return;
  try { fs.unlinkSync(path.join(PIC_DIR, path.basename(fname))); } catch (e) { /* 忽略 */ }
}

// ---------- 售后知识库（V3.0.0：data/knowledge.json + data/knowledge_images/） ----------
// 结构：{ id, title, desc, image, imgv, visible, createdAt, updatedAt, solutions: [{ id, title, content, images: [] }] }
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
const KNOWLEDGE_IMG_DIR = path.join(DATA_DIR, 'knowledge_images');
fs.mkdirSync(KNOWLEDGE_IMG_DIR, { recursive: true });
function loadKnowledge() {
  try {
    if (!fs.existsSync(KNOWLEDGE_FILE)) return [];
    const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveKnowledge(kb) {
  const tmp = KNOWLEDGE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb, null, 2), 'utf8');
  fs.renameSync(tmp, KNOWLEDGE_FILE);
}
function findKnowledge(kb, id) { return kb.find(k => k.id === id) || null; }
function validateKbTitle(t) {
  if (!t) return '知识标题不能为空';
  if (t.length > 60) return '知识标题不能超过 60 个字符';
  if (/[\\/:*?"<>|]/.test(t)) return '知识标题不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
// 保存知识图片（随机文件名，不依赖标题，避免非法字符与重名）
function saveKnowledgeImage(base64) {
  if (!base64) return null;
  let b64 = base64, ext = 'png';
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/s.exec(base64);
  if (m) {
    ext = MIME_EXT['image/' + m[1].toLowerCase()] || 'png';
    b64 = m[2];
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('图片文件不能超过 8MB'), { status: 400 });
  const fname = 'k_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(KNOWLEDGE_IMG_DIR, fname), buf);
  return fname;
}
function deleteKnowledgeImage(fname) {
  if (!fname) return;
  try { fs.unlinkSync(path.join(KNOWLEDGE_IMG_DIR, path.basename(fname))); } catch (e) { /* 忽略 */ }
}
// 删除知识相关的全部图片文件（封面 + 各方案内容图）
function deleteKnowledgeImages(k) {
  if (!k) return;
  if (k.image) deleteKnowledgeImage(k.image);
  (k.solutions || []).forEach(sol => {
    (sol.images || []).forEach(f => deleteKnowledgeImage(f));
  });
}
// 规范化解决方案：标题必填，内容与图片数组兜底
function normalizeSolution(sol) {
  return {
    id: sol.id || genId('s'),
    title: String(sol.title || '').trim() || '未命名方案',
    content: String(sol.content || ''),
    images: Array.isArray(sol.images) ? sol.images.filter(Boolean) : []
  };
}

// ---------- 内容查询库（V3.5.0：data/talks.json + data/talk_images/） ----------
// 结构：{ id, name, image, imgv, dept, type, platform, tags: [], desc, visible, createdAt, updatedAt, talks: ["内容文本", ...] }
const TALKS_FILE = path.join(DATA_DIR, 'talks.json');
const TALKS_IMG_DIR = path.join(DATA_DIR, 'talk_images');
fs.mkdirSync(TALKS_IMG_DIR, { recursive: true });
function loadTalks() {
  try {
    if (!fs.existsSync(TALKS_FILE)) return [];
    const raw = fs.readFileSync(TALKS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveTalks(list) {
  const tmp = TALKS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, TALKS_FILE);
}
function findTalk(list, id) { return list.find(t => t.id === id) || null; }
function validateTalkName(t) {
  if (!t) return '内容名称不能为空';
  if (t.length > 60) return '内容名称不能超过 60 个字符';
  if (/[\\/:*?"<>|]/.test(t)) return '内容名称不能包含 \\ / : * ? " < > | 等字符';
  return null;
}
// 保存内容图片（随机文件名，不依赖标题，避免非法字符与重名）
function saveTalkImage(base64) {
  if (!base64) return null;
  let b64 = base64, ext = 'png';
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/s.exec(base64);
  if (m) {
    ext = MIME_EXT['image/' + m[1].toLowerCase()] || 'png';
    b64 = m[2];
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('图片文件不能超过 8MB'), { status: 400 });
  const fname = 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(TALKS_IMG_DIR, fname), buf);
  return fname;
}
function deleteTalkImage(fname) {
  if (!fname) return;
  try { fs.unlinkSync(path.join(TALKS_IMG_DIR, path.basename(fname))); } catch (e) { /* 忽略 */ }
}
// 规范化内容条目：每条内容为纯文本（无名称），空条目剔除
function normalizeTalks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || '').trim()).filter(x => x.length > 0).slice(0, 200);
}

// ---------- BUG 反馈（V2.5.0：data/bugs.json + data/bug_images/） ----------
const BUG_TYPES = ['页面bug', '优化建议', '参数错误', '其他'];
const BUG_STATUS = { pending: '待修复', fixing: '修复中', fixed: '已修复' };
function loadBugs() {
  try {
    if (!fs.existsSync(BUGS_FILE)) return [];
    const raw = fs.readFileSync(BUGS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveBugs(bugs) {
  const tmp = BUGS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bugs, null, 2), 'utf8');
  fs.renameSync(tmp, BUGS_FILE);
}
function saveBugImage(base64, bugId, idx) {
  if (!base64) return null;
  let b64 = base64, ext = 'png';
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/s.exec(base64);
  if (m) {
    ext = MIME_EXT['image/' + m[1].toLowerCase()] || 'png';
    b64 = m[2];
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('图片文件不能超过 8MB'), { status: 400 });
  const fname = bugId + '_' + idx + '.' + ext;
  fs.writeFileSync(path.join(BUG_IMG_DIR, fname), buf);
  return fname;
}
function deleteBugImage(fname) {
  if (!fname) return;
  try { fs.unlinkSync(path.join(BUG_IMG_DIR, path.basename(fname))); } catch (e) { /* 忽略 */ }
}

// ---------- 日志系统（log/<日期>.log，按天生成） ----------
let rl = null;            // 命令行 readline 实例
let logStreamMode = false; // -log 持续输出模式
function logTs(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function logFileToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}
// 写一条日志：格式 [年/月/日 时:分:秒] 内容，同时打印到控制台
function log(content) {
  const line = '[' + logTs(new Date()) + '] ' + content;
  try { fs.appendFileSync(logFileToday(), line + '\n', 'utf8'); } catch (e) { /* 日志写入失败不阻塞主流程 */ }
  outputLogLine(line);
}
function outputLogLine(line) {
  if (logStreamMode) {
    process.stdout.write(line + '\n');
    return;
  }
  // 命令模式下：先清除当前输入行再打印日志，避免与输入提示混叠
  process.stdout.write('\x1b[2K\r' + line + '\n');
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = url.pathname; }
    const method = req.method;

    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    // 首页
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!fs.existsSync(INDEX_FILE)) { sendError(req, res, 500, '缺少 index.html'); return; }
      let html = fs.readFileSync(INDEX_FILE, 'utf8');
      html = html.replace(/__API_BASE__/g, '');
      const hHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS };
      if (acceptsGzip(req)) {
        const gz = zlib.gzipSync(Buffer.from(html, 'utf8'));
        hHeaders['Content-Encoding'] = 'gzip';
        hHeaders['Content-Length'] = gz.length;
        hHeaders['Vary'] = 'Accept-Encoding';
        res.writeHead(200, hHeaders);
        res.end(gz);
        recordTraffic(gz.length);
      } else {
        hHeaders['Content-Length'] = Buffer.byteLength(html);
        res.writeHead(200, hHeaders);
        res.end(html);
        recordTraffic(Buffer.byteLength(html));
      }
      return;
    }
    // 关于页静态资源（about/）
    if (method === 'GET' && pathname.startsWith('/about/')) {
      const file = path.basename(pathname.slice('/about/'.length));
      const full = path.join(ABOUT_DIR, file);
      if (file && fs.existsSync(full)) {
        const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp' };
        const fbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(fbuf);
        recordTraffic(fbuf.length);
        return;
      }
      sendError(req, res, 404, '文件不存在');
      return;
    }
    // 用户头像静态服务（V2.1.0：data/avatars/，长缓存）
    if (method === 'GET' && pathname.startsWith('/avatars/')) {
      const file = path.basename(pathname.slice('/avatars/'.length));
      const full = path.join(AVATAR_DIR, file);
      if (file && fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const abuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(abuf);
        recordTraffic(abuf.length);
        return;
      }
      sendError(req, res, 404, '文件不存在');
      return;
    }
    // 用户主页背景静态服务（V3.7.0：data/bg/，长缓存）
    if (method === 'GET' && pathname.startsWith('/bg/')) {
      const file = path.basename(pathname.slice('/bg/'.length));
      const full = path.join(BG_DIR, file);
      if (file && fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const bbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(bbuf);
        recordTraffic(bbuf.length);
        return;
      }
      sendError(req, res, 404, '文件不存在');
      return;
    }
    // 产品图片静态服务（长缓存，配合前端版本参数实现增量更新）
    if (method === 'GET' && pathname.startsWith('/picture/')) {
      const file = path.basename(pathname.slice('/picture/'.length));
      const full = path.join(PIC_DIR, file);
      if (fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const pbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(pbuf);
        recordTraffic(pbuf.length);
        return;
      }
      sendError(req, res, 404, '图片不存在');
      return;
    }
    // 售后知识图片静态服务（V3.0.0：data/knowledge_images/）
    if (method === 'GET' && pathname.startsWith('/knowledgeimg/')) {
      const file = path.basename(pathname.slice('/knowledgeimg/'.length));
      const full = path.join(KNOWLEDGE_IMG_DIR, file);
      if (fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const kbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(kbuf);
        recordTraffic(kbuf.length);
        return;
      }
      sendError(req, res, 404, '图片不存在');
      return;
    }
    // 内容图片静态服务（V3.5.0：data/talk_images/）
    if (method === 'GET' && pathname.startsWith('/talkimg/')) {
      const file = path.basename(pathname.slice('/talkimg/'.length));
      const full = path.join(TALKS_IMG_DIR, file);
      if (fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const tbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(tbuf);
        recordTraffic(tbuf.length);
        return;
      }
      sendError(req, res, 404, '图片不存在');
      return;
    }
    // BUG 反馈图片静态服务（V2.5.0：data/bug_images/）
    if (method === 'GET' && pathname.startsWith('/bugimage/')) {
      const file = path.basename(pathname.slice('/bugimage/'.length));
      const full = path.join(BUG_IMG_DIR, file);
      if (fs.existsSync(full)) {
        const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const bbuf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': map[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000', ...CORS });
        res.end(bbuf);
        recordTraffic(bbuf.length);
        return;
      }
      sendError(req, res, 404, '图片不存在');
      return;
    }

    const db = getDb();

    // ---------- 账号登录 / 注册申请 ----------
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJSON(req);
      const username = (body.username || '').trim();
      const password = (body.password || '');
      const acc = loadAccounts();
      const user = acc.users.find(u => u.username === username && u.password === password);
      if (!user) return sendError(req, res, 401, '账号或密码错误');
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, user.username);
      saveSessions();
      log('用户登录，账号：' + user.username + '，密码：' + password + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { token, username: user.username, role: user.role, nickname: user.nickname || user.username, avatar: user.avatar || null, background: user.background || null });
      return;
    }
    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readJSON(req);
      const username = (body.username || '').trim();
      const password = (body.password || '');
      const err = validateUsername(username);
      if (err) return sendError(req, res, 400, err);
      const errP = validatePassword(password);
      if (errP) return sendError(req, res, 400, errP);
      const acc = loadAccounts();
      if (acc.users.some(u => u.username === username)) return sendError(req, res, 400, '该账号已存在，请直接登录');
      if (acc.applications.some(a => a.username === username)) return sendError(req, res, 400, '该账号已提交注册申请，请等待管理员审核');
      // V3.3.0：注册改回审批制——提交申请（含账号密码），管理员同意后加入账号库
      acc.applications.push({ id: genId('a'), username, password, createdAt: nowStr() });
      saveAccounts(acc);
      log('新用户提交注册申请，账号：' + username + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true, message: '注册申请已提交，请等待管理员审核' });
      return;
    }
    // ---------- 个人中心（V2.1.0）：资料 / 改密码 / 头像 / 收藏 ----------
    if (pathname === '/api/me' && method === 'GET') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      sendJSON(req, res, 200, {
        user: {
          username: me.username,
          nickname: me.nickname || me.username,
          avatar: me.avatar || null,
          background: me.background || null,
          role: me.role,
          createdAt: me.createdAt,
          favorites: userFavs(me)
        }
      });
      return;
    }
    // 修改显示名（用户名可重复，未修改默认=账号）
    if (pathname === '/api/me/profile' && method === 'PUT') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const nn = (body.nickname === undefined ? me.nickname : String(body.nickname)).trim();
      if (!nn) return sendError(req, res, 400, '用户名不能为空');
      if (nn.length > 30) return sendError(req, res, 400, '用户名不能超过 30 个字符');
      if (/[\\/:*?"<>|]/.test(nn)) return sendError(req, res, 400, '用户名不能包含 \\ / : * ? " < > | 等字符');
      if (nn !== (me.nickname || me.username)) {
        const acc = loadAccounts();
        const u = acc.users.find(x => x.username === me.username);
        if (u) u.nickname = nn;
        saveAccounts(acc);
        log('用户修改显示名，账号：' + me.username + '，新用户名：' + nn + '，IP：' + clientIP(req));
      }
      sendJSON(req, res, 200, { ok: true, nickname: nn });
      return;
    }
    // 修改密码：验证原密码 → 新密码校验
    if (pathname === '/api/me/password' && method === 'PUT') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const oldP = (body.oldPassword || '');
      const newP = (body.newPassword || '');
      if (oldP !== me.password) return sendError(req, res, 400, '原密码不正确');
      const errP = validatePassword(newP);
      if (errP) return sendError(req, res, 400, errP);
      const acc = loadAccounts();
      const u = acc.users.find(x => x.username === me.username);
      if (u) u.password = newP;
      saveAccounts(acc);
      log('用户修改密码，账号：' + me.username + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true, message: '密码修改成功' });
      return;
    }
    // 上传/更换头像（base64 → data/avatars/{账号}.png）
    if (pathname === '/api/me/avatar' && method === 'POST') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const r = saveAvatar(me.username, body.imageBase64);
      if (r.err) return sendError(req, res, 400, r.err);
      const acc = loadAccounts();
      const u = acc.users.find(x => x.username === me.username);
      const ver = (u.avatar && u.avatar.imgv ? u.avatar.imgv : 0) + 1;
      if (u) u.avatar = { file: avatarFile(me.username), imgv: ver };
      saveAccounts(acc);
      log('用户上传头像，账号：' + me.username + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true, avatar: u.avatar, avatarUrl: avatarUrlPath(me.username, ver), message: '头像已更新' });
      return;
    }
    // 上传/更换主页背景（V3.7.0：base64 → data/bg/{账号}.png）
    if (pathname === '/api/me/background' && method === 'POST') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const r = saveBg(me.username, body.imageBase64);
      if (r.err) return sendError(req, res, 400, r.err);
      const acc = loadAccounts();
      const u = acc.users.find(x => x.username === me.username);
      const ver = (u.background && u.background.imgv ? u.background.imgv : 0) + 1;
      if (u) u.background = { file: bgFile(me.username), imgv: ver };
      saveAccounts(acc);
      log('用户上传主页背景，账号：' + me.username + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true, background: u.background, backgroundUrl: bgUrlPath(me.username, ver), message: '主页背景已更新' });
      return;
    }
    // 收藏 / 取消收藏（V3.8.0：product / knowledge / talk 三种查询库）
    const FAV_TYPES = ['product', 'knowledge', 'talk'];
    function favExists(u, t, id) {
      return userFavs(u).some(function (n) { return n.t === t && n.id === String(id); });
    }
    function findFavTarget(t, id) {
      if (t === 'product') return !!findProduct(db, id);
      if (t === 'knowledge') return !!findKnowledge(loadKnowledge(), id);
      if (t === 'talk') return !!findTalk(loadTalks(), id);
      return false;
    }
    function handleFav(me, t, id, m) {
      if (FAV_TYPES.indexOf(t) < 0) return sendError(req, res, 400, '无效的收藏类型');
      if (!findFavTarget(t, id)) return sendError(req, res, 404, '收藏对象不存在');
      const acc = loadAccounts();
      const u = acc.users.find(x => x.username === me.username);
      if (!u) return sendError(req, res, 404, '用户不存在');
      if (m === 'POST') {
        if (!Array.isArray(u.favorites)) u.favorites = [];
        if (!favExists(u, t, id)) u.favorites.push({ t: t, id: String(id) });
        saveAccounts(acc);
        sendJSON(req, res, 200, { ok: true, favorited: true });
      } else {
        if (Array.isArray(u.favorites)) {
          u.favorites = u.favorites.filter(function (f) {
            const n = normFav(f);
            return !(n && n.t === t && n.id === String(id));
          });
        }
        saveAccounts(acc);
        sendJSON(req, res, 200, { ok: true, favorited: false });
      }
    }
    const mFav = pathname.match(/^\/api\/me\/fav\/([^/]+)\/([^/]+)$/);
    if (mFav) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (method !== 'POST' && method !== 'DELETE') return sendError(req, res, 405, '方法不允许');
      handleFav(me, mFav[1], decodeURIComponent(mFav[2]), method);
      return;
    }
    // 旧版产品收藏接口（兼容历史前端）
    const mFavOld = pathname.match(/^\/api\/me\/favorites\/([^/]+)$/);
    if (mFavOld) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (method !== 'POST' && method !== 'DELETE') return sendError(req, res, 405, '方法不允许');
      handleFav(me, 'product', decodeURIComponent(mFavOld[1]), method);
      return;
    }
    // 我的反馈（V3.8.0：按时间新→旧，仅自己提交的，已删除的不显示）
    if (pathname === '/api/me/feedback' && method === 'GET') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const bugs = loadBugs().filter(function (b) { return b.user === me.username; })
        .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      sendJSON(req, res, 200, { bugs: bugs });
      return;
    }
    // 注销账号（V3.8.0：删除账号、会话、头像、背景、该账号提交的全部反馈及图片）
    if (pathname === '/api/me/delete-account' && method === 'POST') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const acc = loadAccounts();
      acc.users = acc.users.filter(function (u) { return u.username !== me.username; });
      saveAccounts(acc);
      // 清空该账号全部会话
      tokens.forEach(function (uname, tk) { if (uname === me.username) tokens.delete(tk); });
      saveSessions();
      // 删除头像与背景文件
      try { fs.unlinkSync(path.join(AVATAR_DIR, avatarFile(me.username))); } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(path.join(BG_DIR, bgFile(me.username))); } catch (e) { /* 忽略 */ }
      // 删除该账号提交的全部反馈及图片
      const bugs = loadBugs();
      const mine = bugs.filter(function (b) { return b.user === me.username; });
      mine.forEach(function (b) {
        (Array.isArray(b.images) ? b.images : []).forEach(function (im) { deleteBugImage(im); });
      });
      saveBugs(bugs.filter(function (b) { return b.user !== me.username; }));
      log('用户注销账号：' + me.username + '，删除反馈 ' + mine.length + ' 条，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true, message: '账号已注销，所有数据已删除' });
      return;
    }

    // ---------- 账号管理（仅管理员）：查看全部账号 / 删除账号 ----------
    const mUsers = pathname.match(/^\/api\/admin\/users(?:\/([^/]+))?$/);
    if (mUsers) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (me.role !== 'admin') return sendError(req, res, 403, '仅管理员可操作');
      const acc = loadAccounts();
      if (method === 'GET' && !mUsers[1]) {
        sendJSON(req, res, 200, { users: acc.users });
        return;
      }
      if (method === 'PUT' && mUsers[1]) {
        // V2.1.0：编辑用户资料（显示名/密码/管理员权限）
        const target = acc.users.find(u => u.username === mUsers[1]);
        if (!target) return sendError(req, res, 404, '账号不存在');
        const body = await readJSON(req);
        if (body.nickname !== undefined) {
          const nn = (body.nickname || '').trim();
          if (!nn) return sendError(req, res, 400, '用户名不能为空');
          if (nn.length > 30) return sendError(req, res, 400, '用户名不能超过 30 个字符');
          if (/[\\/:*?"<>|]/.test(nn)) return sendError(req, res, 400, '用户名不能包含 \\ / : * ? " < > | 等字符');
          target.nickname = nn;
        }
        if (body.password !== undefined && body.password !== '') {
          const errP = validatePassword(body.password);
          if (errP) return sendError(req, res, 400, errP);
          target.password = body.password;
        }
        if (body.role !== undefined) {
          if (body.role === 'admin') {
            target.role = 'admin';
          } else if (body.role === 'user') {
            // 移除管理员：不能移除最后一个管理员
            if (target.role === 'admin' && acc.users.filter(u => u.role === 'admin').length <= 1)
              return sendError(req, res, 400, '不能移除最后一个管理员账号');
            target.role = 'user';
          } else {
            return sendError(req, res, 400, '角色取值仅支持 admin / user');
          }
        }
        saveAccounts(acc);
        log('管理员编辑账号，账号：' + target.username + '，操作管理员：' + me.username + '，IP：' + clientIP(req));
        sendJSON(req, res, 200, { ok: true, user: target, message: '账号资料已更新' });
        return;
      }
      if (method === 'DELETE' && mUsers[1]) {
        const username = mUsers[1];
        const idx = acc.users.findIndex(u => u.username === username);
        if (idx < 0) return sendError(req, res, 404, '账号不存在');
        if (username === me.username) return sendError(req, res, 400, '不能删除当前登录的账号');
        const target = acc.users[idx];
        if (target.role === 'admin' && acc.users.filter(u => u.role === 'admin').length <= 1)
          return sendError(req, res, 400, '不能删除最后一个管理员账号');
        acc.users.splice(idx, 1);
        // 同步清理该账号的待审核申请与登录令牌
        acc.applications = acc.applications.filter(a => a.username !== username);
        for (const [t, uname] of tokens) { if (uname === username) tokens.delete(t); }
        saveSessions();
        saveAccounts(acc);
        log('管理员删除账号，账号：' + username + '，操作管理员：' + me.username + '，IP：' + clientIP(req));
        sendJSON(req, res, 200, { ok: true, message: '账号已删除' });
        return;
      }
    }

    // ---------- 申请审核（仅管理员） ----------
    const mApp = pathname.match(/^\/api\/admin\/applications(?:\/([^/]+)\/(approve|reject))?$/);
    if (mApp) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (me.role !== 'admin') return sendError(req, res, 403, '仅管理员可操作');
      const acc = loadAccounts();
      if (method === 'GET' && !mApp[1]) {
        sendJSON(req, res, 200, { applications: acc.applications });
        return;
      }
      if (method === 'POST' && mApp[2]) {
        const idx = acc.applications.findIndex(a => a.id === mApp[1]);
        if (idx < 0) return sendError(req, res, 404, '申请不存在');
        const app = acc.applications[idx];
        if (mApp[2] === 'approve') {
          acc.applications.splice(idx, 1);
          // V3.3.0：账号注册审批——同意则创建普通用户；账号已存在或数据不完整则仅删除申请
          const exists = acc.users.some(u => u.username === app.username);
          if (!exists && app.password) {
            acc.users.push({ username: app.username, password: app.password, role: 'user', createdAt: nowStr(), nickname: app.username, avatar: null, favorites: [] });
            saveAccounts(acc);
            log('管理员同意账号注册申请，账号：' + app.username + '，管理员IP：' + clientIP(req));
            sendJSON(req, res, 200, { ok: true, message: '已同意，账号已加入账号库' });
          } else {
            saveAccounts(acc);
            log('同意注册申请失败：' + (exists ? '账号已存在' : '申请缺少密码') + '，账号：' + app.username + '，管理员IP：' + clientIP(req));
            sendJSON(req, res, 200, { ok: true, message: exists ? '该账号已存在，已删除该申请' : '申请数据不完整，已删除该申请' });
          }
        } else {
          acc.applications.splice(idx, 1);
          saveAccounts(acc);
          sendJSON(req, res, 200, { ok: true, message: '已拒绝并删除该申请' });
        }
        return;
      }
    }

    // ---------- 服务器运行时间（公开，无需登录，关于页底部显示，V2.8.0） ----------
    if (method === 'GET' && pathname === '/api/uptime') {
      sendJSON(req, res, 200, { uptimeSec: Math.floor(process.uptime()), startTime: serverStartTimeStr });
      return;
    }

    // ---------- 售后知识库 API（V3.0.0） ----------
    // 查询全部知识（匿名可查，ETag 协商缓存；仅返回可见知识）
    if (method === 'GET' && pathname === '/api/knowledge') {
      let etag = null;
      try {
        const st = fs.statSync(KNOWLEDGE_FILE);
        etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
      } catch (e) { /* 无数据文件时不启用 ETag */ }
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, Object.assign({ ETag: etag }, CORS));
        res.end();
        return;
      }
      const all = loadKnowledge();
      const visible = all.filter(k => k.visible !== 0);
      const who1 = authUser(req);
      log('用户查询售后知识库，账号：' + (who1 ? who1.username : '游客') + '，可见知识：' + visible.length + ' 条，IP：' + clientIP(req));
      const payload = { knowledge: visible };
      if (etag) {
        payload.etag = etag;
        sendJSON(req, res, 200, payload, { ETag: etag });
      } else {
        sendJSON(req, res, 200, payload);
      }
      return;
    }
    // 查询单条知识（匿名可查）
    const mKbGet = pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (mKbGet && method === 'GET') {
      const k = findKnowledge(loadKnowledge(), decodeURIComponent(mKbGet[1]));
      if (!k || k.visible === 0) return sendError(req, res, 404, '知识不存在');
      const who2 = authUser(req);
      log('用户查看售后知识，账号：' + (who2 ? who2.username : '游客') + '，标题：' + k.title + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { knowledge: k });
      return;
    }
    // 管理后台：全量知识列表（登录用户，含不可见，V3.2.5）
    if (method === 'GET' && pathname === '/api/admin/knowledge/all') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const all = loadKnowledge();
      log('管理后台查询全量售后知识，账号：' + me.username + '，共 ' + all.length + ' 条');
      sendJSON(req, res, 200, { knowledge: all });
      return;
    }
    // 新增知识（登录用户）
    if (method === 'POST' && pathname === '/api/admin/knowledge') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const title = (body.title || '').trim();
      const err = validateKbTitle(title);
      if (err) return sendError(req, res, 400, err);
      const desc = (body.desc === undefined ? '' : String(body.desc)).trim();
      let image = body.image || null;
      if (body.imageBase64) image = saveKnowledgeImage(body.imageBase64);
      const solutions = Array.isArray(body.solutions) ? body.solutions.map(normalizeSolution) : [];
      const kb = {
        id: genId('k'), title, desc, image, imgv: image ? 1 : 0,
        visible: body.visible === 0 ? 0 : 1,
        createdAt: nowStr(), updatedAt: nowStr(), solutions
      };
      const all = loadKnowledge();
      all.push(kb);
      saveKnowledge(all);
      log('新增售后知识，账号：' + me.username + '，标题：' + title + '，方案数：' + solutions.length);
      sendJSON(req, res, 200, { knowledge: kb });
      return;
    }
    // 知识图片上传（登录用户，返回文件名）
    if (method === 'POST' && pathname === '/api/admin/knowledge/image') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const fname = saveKnowledgeImage(body.imageBase64 || body.base64);
      if (!fname) return sendError(req, res, 400, '图片数据无效');
      log('上传售后知识图片，账号：' + me.username + '，文件：' + fname);
      sendJSON(req, res, 200, { file: fname });
      return;
    }


    // 编辑 / 删除知识
    const mKb = pathname.match(/^\/api\/admin\/knowledge\/([^/]+)$/);
    if (mKb) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const all = loadKnowledge();
      const kb = findKnowledge(all, decodeURIComponent(mKb[1]));
      if (!kb) return sendError(req, res, 404, '知识不存在');
      if (method === 'PUT') {
        const body = await readJSON(req);
        if (body.title !== undefined) {
          const t = (body.title || '').trim();
          const e = validateKbTitle(t);
          if (e) return sendError(req, res, 400, e);
          kb.title = t;
        }
        if (body.desc !== undefined) kb.desc = String(body.desc).trim();
        // 封面：传 imageBase64 则新上传；传 image=null 且无 imageBase64 则清空封面
        if (body.imageBase64) {
          const nf = saveKnowledgeImage(body.imageBase64);
          if (nf) {
            if (kb.image && kb.image !== nf) deleteKnowledgeImage(kb.image);
            kb.image = nf;
            kb.imgv = (kb.imgv || 0) + 1;
          }
        } else if (body.image !== undefined) {
          if (kb.image && kb.image !== body.image) deleteKnowledgeImage(kb.image);
          kb.image = body.image || null;
          kb.imgv = (kb.imgv || 0) + 1;
        }
        if (body.visible !== undefined) kb.visible = body.visible === 0 ? 0 : 1;
        // 解决方案整体替换；删除旧方案中已不再引用的图片
        if (Array.isArray(body.solutions)) {
          const oldImgs = [];
          (kb.solutions || []).forEach(sol => (sol.images || []).forEach(f => oldImgs.push(f)));
          kb.solutions = body.solutions.map(normalizeSolution);
          const newImgs = [];
          kb.solutions.forEach(sol => (sol.images || []).forEach(f => newImgs.push(f)));
          oldImgs.forEach(f => { if (newImgs.indexOf(f) < 0) deleteKnowledgeImage(f); });
        }
        kb.updatedAt = nowStr();
        saveKnowledge(all);
        log('编辑售后知识，账号：' + me.username + '，标题：' + kb.title);
        sendJSON(req, res, 200, { knowledge: kb });
        return;
      }
      if (method === 'DELETE') {
        deleteKnowledgeImages(kb);
        const idx = all.indexOf(kb);
        if (idx >= 0) all.splice(idx, 1);
        saveKnowledge(all);
        log('删除售后知识，账号：' + me.username + '，标题：' + kb.title);
        sendJSON(req, res, 200, { ok: true });
        return;
      }
    }
    // ---------- 内容查询库 API（V3.5.0） ----------
    // 查询全部内容（匿名可查，ETag 协商缓存；仅返回可见内容）
    if (method === 'GET' && pathname === '/api/talks') {
      let etag = null;
      try {
        const st = fs.statSync(TALKS_FILE);
        etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
      } catch (e) { /* 无数据文件时不启用 ETag */ }
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, Object.assign({ ETag: etag }, CORS));
        res.end();
        return;
      }
      const all = loadTalks();
      const visible = all.filter(t => t.visible !== 0);
      const who1 = authUser(req);
      log('用户查询内容库，账号：' + (who1 ? who1.username : '游客') + '，可见内容：' + visible.length + ' 条，IP：' + clientIP(req));
      const payload = { talks: visible };
      if (etag) {
        payload.etag = etag;
        sendJSON(req, res, 200, payload, { ETag: etag });
      } else {
        sendJSON(req, res, 200, payload);
      }
      return;
    }
    // 查询单条内容（匿名可查）
    const mTalkGet = pathname.match(/^\/api\/talks\/([^/]+)$/);
    if (mTalkGet && method === 'GET') {
      const t = findTalk(loadTalks(), decodeURIComponent(mTalkGet[1]));
      if (!t || t.visible === 0) return sendError(req, res, 404, '内容不存在');
      const who2 = authUser(req);
      log('用户查看内容，账号：' + (who2 ? who2.username : '游客') + '，名称：' + t.name + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { talk: t });
      return;
    }
    // 管理后台：全量内容列表（登录用户，含不可见）
    if (method === 'GET' && pathname === '/api/admin/talks/all') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const all = loadTalks();
      log('管理后台查询全量内容，账号：' + me.username + '，共 ' + all.length + ' 条');
      sendJSON(req, res, 200, { talks: all });
      return;
    }
    // 新增内容（登录用户）
    if (method === 'POST' && pathname === '/api/admin/talks') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const name = (body.name || '').trim();
      const err = validateTalkName(name);
      if (err) return sendError(req, res, 400, err);
      const dept = (body.dept || '').trim();
      const type = (body.type || '').trim();
      const platform = (body.platform || '').trim();
      if (!dept || !type || !platform) return sendError(req, res, 400, '部门分类、类型分类、平台分类均为必填');
      const desc = (body.desc === undefined ? '' : String(body.desc)).trim();
      let image = body.image || null;
      if (body.imageBase64) image = saveTalkImage(body.imageBase64);
      const talks = normalizeTalks(body.talks);
      const talk = {
        id: genId('t'), name, dept, type, platform,
        tags: Array.isArray(body.tags) ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 10) : [],
        desc, image, imgv: image ? 1 : 0,
        visible: body.visible === 0 ? 0 : 1,
        createdAt: nowStr(), updatedAt: nowStr(), talks
      };
      const all = loadTalks();
      all.push(talk);
      saveTalks(all);
      log('新增内容，账号：' + me.username + '，名称：' + name + '，内容条数：' + talks.length);
      sendJSON(req, res, 200, { talk });
      return;
    }
    // 内容图片上传（登录用户，返回文件名）
    if (method === 'POST' && pathname === '/api/admin/talks/image') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const fname = saveTalkImage(body.imageBase64 || body.base64);
      if (!fname) return sendError(req, res, 400, '图片数据无效');
      log('上传内容图片，账号：' + me.username + '，文件：' + fname);
      sendJSON(req, res, 200, { file: fname });
      return;
    }
    // 编辑 / 删除内容
    const mTalk = pathname.match(/^\/api\/admin\/talks\/([^/]+)$/);
    if (mTalk) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const all = loadTalks();
      const talk = findTalk(all, decodeURIComponent(mTalk[1]));
      if (!talk) return sendError(req, res, 404, '内容不存在');
      if (method === 'PUT') {
        const body = await readJSON(req);
        if (body.name !== undefined) {
          const n = (body.name || '').trim();
          const e = validateTalkName(n);
          if (e) return sendError(req, res, 400, e);
          talk.name = n;
        }
        if (body.dept !== undefined) talk.dept = String(body.dept || '').trim();
        if (body.type !== undefined) talk.type = String(body.type || '').trim();
        if (body.platform !== undefined) talk.platform = String(body.platform || '').trim();
        if (body.tags !== undefined) talk.tags = Array.isArray(body.tags) ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 10) : [];
        if (body.desc !== undefined) talk.desc = String(body.desc).trim();
        if (body.imageBase64) {
          const nf = saveTalkImage(body.imageBase64);
          if (nf) {
            if (talk.image && talk.image !== nf) deleteTalkImage(talk.image);
            talk.image = nf;
            talk.imgv = (talk.imgv || 0) + 1;
          }
        } else if (body.image !== undefined) {
          if (talk.image && talk.image !== body.image) deleteTalkImage(talk.image);
          talk.image = body.image || null;
          talk.imgv = (talk.imgv || 0) + 1;
        }
        if (body.visible !== undefined) talk.visible = body.visible === 0 ? 0 : 1;
        if (body.talks !== undefined) talk.talks = normalizeTalks(body.talks);
        talk.updatedAt = nowStr();
        saveTalks(all);
        log('编辑内容，账号：' + me.username + '，名称：' + talk.name + '，内容条数：' + talk.talks.length);
        sendJSON(req, res, 200, { talk });
        return;
      }
      if (method === 'DELETE') {
        if (talk.image) deleteTalkImage(talk.image);
        const idx = all.indexOf(talk);
        if (idx >= 0) all.splice(idx, 1);
        saveTalks(all);
        log('删除内容，账号：' + me.username + '，名称：' + talk.name);
        sendJSON(req, res, 200, { ok: true });
        return;
      }
    }

    // ---------- 服务器控制台统计（仅管理员，V2.0.7 起） ----------
    if (method === 'GET' && pathname === '/api/admin/server/stats') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (me.role !== 'admin') return sendError(req, res, 403, '仅管理员可查看');
      const mem = process.memoryUsage();
      const cpus = os.cpus();
      const ifs = os.networkInterfaces();
      let lanIP = '';
      for (const k in ifs) {
        for (const i of (ifs[k] || [])) {
          if (i.family === 'IPv4' && !i.internal) { lanIP = i.address; break; }
        }
        if (lanIP) break;
      }
      const port = server.address() ? server.address().port : 0;
      const hourly = [];
      for (let i = 0; i < 24; i++) hourly.push(stats.hourly[i] || 0);
      saveStats(); // 查看控制台时顺带落盘，保证统计不丢
      sendJSON(req, res, 200, {
        stats: {
          date: stats.date,
          totalBytes: stats.totalBytes,
          maxBps: stats.maxBps,
          maxBpsTime: stats.maxBpsTime,
          requests: stats.requests,
          hourly: hourly
        },
        server: {
          version: VERSION,
          hostname: os.hostname(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpuModel: cpus.length ? cpus[0].model : '未知',
          cpuCount: cpus.length,
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSec: Math.floor(process.uptime()),
          startTime: serverStartTimeStr,
          port: port,
          localUrl: 'http://127.0.0.1:' + port,
          lanUrl: lanIP ? 'http://' + lanIP + ':' + port : ''
        }
      });
      return;
    }

    // ---------- 服务端日志（仅管理员，V2.12.0 起） ----------
    if (method === 'GET' && pathname === '/api/admin/server/logs') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (me.role !== 'admin') return sendError(req, res, 403, '仅管理员可查看');
      const qLines = url.searchParams.get('lines') || '300';
      const want = Math.max(1, Math.min(1000, parseInt(qLines, 10) || 300));
      const today = logFileToday();
      let lines = [], total = 0, mtime = null;
      try {
        if (fs.existsSync(today)) {
          const raw = fs.readFileSync(today, 'utf8');
          const all = raw.split(/\r?\n/).filter(Boolean);
          total = all.length;
          mtime = fs.statSync(today).mtime;
          lines = all.slice(Math.max(0, all.length - want));
        }
      } catch (e) { /* 日志读取失败不阻塞 */ }
      sendJSON(req, res, 200, {
        file: path.basename(today),
        lines: lines,
        total: total,
        mtime: mtime ? mtime.getTime() : null
      });
      return;
    }

    // ---------- 查询日志上报（查询库搜索时由前端调用） ----------
    if (method === 'POST' && pathname === '/api/log/search') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const kw = (body.keyword === undefined ? '' : String(body.keyword)).trim();
      if (kw) log('用户查询，账号：' + me.username + '，查询内容：' + kw + '，IP：' + clientIP(req));
      sendJSON(req, res, 200, { ok: true });
      return;
    }

    // ---------- BUG 反馈 API（V2.5.0） ----------
    // GET /api/bugs  全部反馈（需登录，所有人可见）
    if (method === 'GET' && pathname === '/api/bugs') {
      if (!authUser(req)) return sendError(req, res, 401, '请先登录');
      const bugs = loadBugs().slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      sendJSON(req, res, 200, { bugs });
      return;
    }
    // POST /api/bugs  提交反馈（需登录；图片最多 3 张）
    if (method === 'POST' && pathname === '/api/bugs') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const type = (body.type || '').trim();
      const position = (body.position || '').trim();
      const desc = (body.desc || '').trim();
      const suggestion = (body.suggestion || '').trim();
      if (BUG_TYPES.indexOf(type) < 0) return sendError(req, res, 400, '请选择有效的 BUG 类型');
      if (!position) return sendError(req, res, 400, '请填写反馈位置');
      if (position.length > 100) return sendError(req, res, 400, '反馈位置不能超过 100 个字符');
      if (!desc) return sendError(req, res, 400, '请填写反馈描述');
      if (desc.length > 2000) return sendError(req, res, 400, '反馈描述不能超过 2000 个字符');
      if (suggestion.length > 2000) return sendError(req, res, 400, '修改建议不能超过 2000 个字符');
      const imgs = Array.isArray(body.images) ? body.images : [];
      if (imgs.length > 3) return sendError(req, res, 400, '最多上传 3 张图片');
      const bug = { id: genId('b'), type, position, desc, suggestion, images: [], status: 'pending', user: me.username, createdAt: nowStr() };
      for (let i = 0; i < imgs.length; i++) {
        const f = saveBugImage(imgs[i], bug.id, i);
        if (f) bug.images.push(f);
      }
      const bugs = loadBugs();
      bugs.push(bug);
      saveBugs(bugs);
      log('用户提交 BUG 反馈，账号：' + me.username + '，类型：' + type + '，位置：' + position + '，图片：' + bug.images.length + ' 张');
      sendJSON(req, res, 200, { bug });
      return;
    }
    // PUT /api/bugs/:id  修改修复状态（仅管理员）
    // DELETE /api/bugs/:id  删除反馈（仅管理员）
    const mBug = pathname.match(/^\/api\/bugs\/([^/]+)$/);
    if (mBug) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      if (me.role !== 'admin') return sendError(req, res, 403, '仅管理员可操作');
      const bugs = loadBugs();
      const bug = bugs.find(b => b.id === mBug[1]);
      if (!bug) return sendError(req, res, 404, '反馈不存在');
      if (method === 'PUT') {
        const body = await readJSON(req);
        const st = (body.status || '').trim();
        if (!(st in BUG_STATUS)) return sendError(req, res, 400, '无效的修复状态');
        bug.status = st;
        saveBugs(bugs);
        log('管理员修改反馈状态，账号：' + me.username + '，反馈：' + bug.id + '，状态：' + BUG_STATUS[st]);
        sendJSON(req, res, 200, { bug });
        return;
      }
      if (method === 'DELETE') {
        (bug.images || []).forEach(deleteBugImage);
        const idx = bugs.indexOf(bug);
        if (idx >= 0) bugs.splice(idx, 1);
        saveBugs(bugs);
        log('管理员删除反馈，账号：' + me.username + '，反馈：' + bug.id);
        sendJSON(req, res, 200, { ok: true });
        return;
      }
    }

    // GET /api/products  全部产品（含配置，游客与登录用户均可查询，V2.10.0）
    // ETag 协商缓存：数据未变化时返回 304，配合前端本地缓存实现近零带宽刷新
    if (method === 'GET' && pathname === '/api/products') {
      let etag = null;
      try {
        const st = fs.statSync(DB_FILE);
        etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
      } catch (e) { /* 无数据文件时不启用 ETag */ }
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, Object.assign({ ETag: etag }, CORS));
        res.end();
        return;
      }
      const payload = { products: db.products };
      if (etag) {
        payload.etag = etag;
        sendJSON(req, res, 200, payload, { ETag: etag });
      } else {
        sendJSON(req, res, 200, payload);
      }
      return;
    }

    // POST /api/products  添加产品
    if (method === 'POST' && pathname === '/api/products') {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const body = await readJSON(req);
      const name = (body.name || '').trim();
      const err = validateProductName(name);
      if (err) return sendError(req, res, 400, err);
      if (nameExists(db, name)) return sendError(req, res, 400, '产品名称已存在，请更换名称');
      const dept = (body.dept === undefined ? '' : String(body.dept)).trim();
      const type = (body.type === undefined ? '' : String(body.type)).trim();
      const platform = (body.platform === undefined ? '' : String(body.platform)).trim();
      const errD = validateCls(dept, '部门分类');
      if (errD) return sendError(req, res, 400, errD);
      const errT = validateCls(type, '类型分类');
      if (errT) return sendError(req, res, 400, errT);
      const errP = validateCls(platform, '平台分类');
      if (errP) return sendError(req, res, 400, errP);
      const tagRes = parseTags(body.tags);
      if (!tagRes.ok) return sendError(req, res, 400, tagRes.error);
      let image = null;
      if (body.imageBase64) image = saveImage(body.imageBase64, name);
      const product = { id: genId('p'), name, dept, type, platform, category: type, tags: tagRes.tags, createdAt: nowStr(), image, imgv: image ? 1 : 0, configs: [], visible: 1 }; // 新增产品默认可见（V2.4.3）
      db.products.push(product);
      saveDb(db);
      log('用户添加产品，账号：' + me.username + '，产品名称：' + name + '，部门：' + dept + '，类型：' + type + '，平台：' + platform + (tagRes.tags.length ? '，标签：' + tagRes.tags.join('、') : ''));
      sendJSON(req, res, 200, { product });
      return;
    }

    // /api/products/:id
    const mP = pathname.match(/^\/api\/products\/([^/]+)$/);
    // /api/products/:id/configs
    const mAddC = pathname.match(/^\/api\/products\/([^/]+)\/configs$/);
    // /api/products/:id/configs/:cid
    const mC = pathname.match(/^\/api\/products\/([^/]+)\/configs\/([^/]+)$/);

    if (mP) {
      const id = mP[1];
      if (method === 'GET' || method === 'PUT' || method === 'DELETE') {
        if (!authUser(req)) return sendError(req, res, 401, '请先登录');
      }
      const product = findProduct(db, id);
      if (!product) return sendError(req, res, 404, '产品不存在');

      if (method === 'GET') { sendJSON(req, res, 200, { product }); return; }

      if (method === 'PUT') {
        const me = authUser(req);
        const body = await readJSON(req);
        let newName = product.name;
        let nameChanged = false;
        if (body.name !== undefined) {
          newName = (body.name || '').trim();
          const err = validateProductName(newName);
          if (err) return sendError(req, res, 400, err);
          if (nameExists(db, newName, id)) return sendError(req, res, 400, '产品名称已存在，请更换名称');
          nameChanged = newName !== product.name;
        }
        // 三级分类更新（V2.4.0）：部门 / 类型 / 平台
        let dept = product.dept, type = product.type, platform = product.platform;
        if (body.dept !== undefined) {
          const v = String(body.dept).trim();
          const e = validateCls(v, '部门分类');
          if (e) return sendError(req, res, 400, e);
          dept = v;
        }
        if (body.type !== undefined) {
          const v = String(body.type).trim();
          const e = validateCls(v, '类型分类');
          if (e) return sendError(req, res, 400, e);
          type = v;
        }
        if (body.platform !== undefined) {
          const v = String(body.platform).trim();
          const e = validateCls(v, '平台分类');
          if (e) return sendError(req, res, 400, e);
          platform = v;
        }
        // 分类 / 标签更新（category 兼容保留 = type）
        let category = product.category;
        if (body.category !== undefined) {
          category = String(body.category).trim();
          const errC = validateCategory(category);
          if (errC) return sendError(req, res, 400, errC);
        }
        let tags = product.tags || [];
        if (body.tags !== undefined) {
          const tagRes = parseTags(body.tags);
          if (!tagRes.ok) return sendError(req, res, 400, tagRes.error);
          tags = tagRes.tags;
        }
        // 图片处理：移除 / 替换 / 仅改名时重命名文件
        let image = product.image;
        let imgv = product.imgv || 0;
        if (body.removeImage === true && image) { deleteImageFile(image); image = null; imgv = 0; }
        if (body.imageBase64) { if (image) deleteImageFile(image); image = saveImage(body.imageBase64, newName); imgv = (product.imgv || 0) + 1; }
        if (nameChanged && image && image === product.image) {
          const ext = path.extname(image) || '.png';
          const newFile = newName + ext;
          try { fs.renameSync(path.join(PIC_DIR, image), path.join(PIC_DIR, newFile)); image = newFile; }
          catch (e) { image = null; imgv = 0; }
        }
        if (nameChanged) {
          log('用户修改产品名称，账号：' + me.username + '，由「' + product.name + '」修改为「' + newName + '」');
        }
        if (category !== product.category) {
          log('用户修改产品分类，账号：' + me.username + '，产品名称：' + newName + '，由「' + (product.category || '未分类') + '」修改为「' + category + '」');
        }
        const oldTags = product.tags || [];
        if (tags.join('\u0001') !== oldTags.join('\u0001')) {
          log('用户修改产品标签，账号：' + me.username + '，产品名称：' + newName + '，由「' + (oldTags.join('、') || '无') + '」修改为「' + (tags.join('、') || '无') + '」');
        }
        product.name = newName;
        product.dept = dept;
        product.type = type;
        product.platform = platform;
        product.category = category; // 兼容字段：未显式传时保持原值
        if (body.type !== undefined) product.category = type; // 类型变化时同步兼容字段
        product.tags = tags;
        product.image = image;
        product.imgv = imgv;
        // 可见性切换（V2.0.14 起）：visible=0 时产品仅管理后台可见，普通查询列表不显示
        if (body.visible !== undefined) {
          const v = body.visible ? 1 : 0;
          if (v !== product.visible) {
            log('用户切换产品可见性，账号：' + me.username + '，产品名称：' + newName + '，状态：' + (v ? '可见' : '不可见'));
          }
          product.visible = v;
        }
        saveDb(db);
        sendJSON(req, res, 200, { product });
        return;
      }

      if (method === 'DELETE') {
        const me = authUser(req);
        const cfgStr = product.configs.map(c => c.name + '：' + (c.value || '（空）')).join('；');
        log('用户删除产品，账号：' + me.username + '，产品名称：' + product.name + '，配置：' + (cfgStr || '（无配置）'));
        deleteImageFile(product.image);
        db.products = db.products.filter(p => p.id !== id);
        saveDb(db);
        sendJSON(req, res, 200, { ok: true });
        return;
      }
    }

    if (mAddC) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const product = findProduct(db, mAddC[1]);
      if (!product) return sendError(req, res, 404, '产品不存在');
      if (method === 'POST') {
        const body = await readJSON(req);
        const cname = (body.name === undefined ? '' : String(body.name)).trim();
        const cval = (body.value === undefined ? '' : String(body.value)).trim();
        if (!cname) return sendError(req, res, 400, '配置名称不能为空');
        if (cname.length > 60) return sendError(req, res, 400, '配置名称不能超过 60 个字符');
        if (product.configs.some(c => c.name.trim().toLowerCase() === cname.toLowerCase()))
          return sendError(req, res, 400, '该配置已存在，请更换配置名称');
        const cfg = { id: genId('c'), name: cname, value: cval };
        product.configs.push(cfg);
        saveDb(db);
        log('用户添加配置，账号：' + me.username + '，产品名称：' + product.name + '，配置名称：' + cname + '，配置内容：' + (cval || '（空）'));
        sendJSON(req, res, 200, { config: cfg });
        return;
      }
    }

    if (mC) {
      const me = authUser(req);
      if (!me) return sendError(req, res, 401, '请先登录');
      const product = findProduct(db, mC[1]);
      if (!product) return sendError(req, res, 404, '产品不存在');
      const cfg = product.configs.find(c => c.id === mC[2]);
      if (!cfg) return sendError(req, res, 404, '配置不存在');

      if (method === 'PUT') {
        const body = await readJSON(req);
        const cname = (body.name === undefined ? cfg.name : String(body.name)).trim();
        const cval = (body.value === undefined ? cfg.value : String(body.value)).trim();
        if (!cname) return sendError(req, res, 400, '配置名称不能为空');
        if (cname.length > 60) return sendError(req, res, 400, '配置名称不能超过 60 个字符');
        if (product.configs.some(c => c.id !== cfg.id && c.name.trim().toLowerCase() === cname.toLowerCase()))
          return sendError(req, res, 400, '该配置已存在，请更换配置名称');
        log('用户编辑配置，账号：' + me.username + '，产品名称：' + product.name + '，配置由「' + cfg.name + '：' + (cfg.value || '（空）') + '」修改为「' + cname + '：' + (cval || '（空）') + '」');
        cfg.name = cname;
        cfg.value = cval;
        saveDb(db);
        sendJSON(req, res, 200, { config: cfg });
        return;
      }

      if (method === 'DELETE') {
        log('用户删除配置，账号：' + me.username + '，产品名称：' + product.name + '，配置名称：' + cfg.name + '，配置内容：' + (cfg.value || '（空）'));
        product.configs = product.configs.filter(c => c.id !== cfg.id);
        saveDb(db);
        sendJSON(req, res, 200, { ok: true });
        return;
      }
    }

    sendError(req, res, 404, '接口不存在');
  } catch (e) {
    sendError(req, res, e.status || 500, e.message || '服务器内部错误');
  }
});

// ---------- 命令交互 ----------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '0.0.0.0', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
// 输入行队列：全程挂载 line 监听收集输入，避免 question 挂载间隙丢行（管道/交互均适用）
const inputQueue = [];
const inputWaiters = [];
function onInputLine(l) {
  if (inputWaiters.length) inputWaiters.shift()(l);
  else inputQueue.push(l);
}
function nextLine() {
  if (inputQueue.length) return Promise.resolve(inputQueue.shift());
  return new Promise(resolve => inputWaiters.push(resolve));
}
function ask(q) {
  process.stdout.write(q);
  return nextLine();
}
// 读取管理员账号/密码：从输入行队列逐行读取（TTY 与管道均适用，行不丢失）
function readCreds() {
  return ask('请输入管理员账号: ').then(u => ask('请输入管理员密码: ').then(p => ({ u: u.trim(), p })));
}
// 打印启动横幅
function printBanner() {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │       Knowledge Base Server V1.0.0          │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
}
function printHelp() {
  console.log('──────────────────────────────────────────────');
  console.log('可用命令列表：');
  console.log('  -set password    修改管理员密码');
  console.log('  -version         查看当前服务端版本');
  console.log('  -server          启动服务端（旧命令 -open server 仍兼容）');
  console.log('  -set port:xxxxx  固定端口（范围 1-65535，每次启动使用该端口）');
  console.log('  -random port     改为随机端口（每次启动随机分配）');
  console.log('  -log             持续查看日志输出');
  console.log('  -restart server  重启服务端（自动关闭并重新启动，重启后免验证直接启动）');
  console.log('  -help            查看命令列表');
  console.log('──────────────────────────────────────────────');
}
async function cmdSetPassword() {
  while (true) {
    const p1 = await ask('请输入修改密码: ');
    const p2 = await ask('请再次输入确认: ');
    if (!p1) { console.log('密码不能为空，请重新输入'); continue; }
    if (p1 !== p2) { console.log('两次输入不一致，请重新输入'); continue; }
    const acc = loadAccounts();
    const admin = acc.users.find(u => u.role === 'admin');
    if (!admin) { console.log('未找到管理员账号，无法修改密码'); return; }
    admin.password = p1;
    saveAccounts(acc);
    console.log('密码修改成功');
    return;
  }
}
let serverStarting = false; // 服务端启动中标志，防止 listen 异步完成前被重复触发
async function cmdOpenServer() {
  if (server.listening) { console.log('服务端已在运行，端口：' + server.address().port); return; }
  if (serverStarting) { console.log('服务端正在启动中，请稍候'); return; }
  serverStarting = true;
  let port;
  const fixedPort = loadPortConfig();
  if (process.env.PORT) {
    // 外部环境变量优先级最高（部署工具显式指定时生效）
    port = parseInt(process.env.PORT, 10);
    if (!port || port < 1 || port > 65535) { console.log('PORT 环境变量无效'); serverStarting = false; return; }
  } else if (fixedPort) {
    // 固定端口模式：每次启动都使用配置的端口
    port = fixedPort;
    console.log('使用固定端口：' + port + '（输入 -random port 可改为随机端口）');
  } else {
    // 随机端口模式：每次启动随机分配
    port = await getFreePort();
  }
  server.listen(port, '0.0.0.0', () => {
    serverStarting = false;
    console.log('服务器已启动，端口：' + port);
    log('服务端首次启动，端口：' + port);
  });
  // 端口占用处理（V4.1.2）：不再无限重试刷屏，给出明确处理指引
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && !server.listening) {
      serverStarting = false;
      console.log('');
      console.log('【端口占用】端口 ' + port + ' 已被其他进程占用，服务端启动失败。');
      console.log('处理方式：');
      console.log('  1) 先关闭已运行的服务端进程后重新启动；');
      console.log('  2) 输入 -set port:新端口  更换固定端口（范围 1-65535）；');
      console.log('  3) 输入 -random port     改为随机端口模式。');
    } else {
      serverStarting = false;
    }
  });
}
// -log：进入日志持续输出模式，仅打印日志，无法再输入命令
function cmdLogMode() {
  const enter = () => {
    logStreamMode = true;
    rl.pause();
    console.log('已进入日志持续输出模式，按 Ctrl+C 停止');
  };
  if (!server.listening) {
    cmdOpenServer().then(() => {
      // 等 listen 完成后再进入
      setTimeout(enter, 100);
    });
    return;
  }
  enter();
}
async function runCommand(raw) {
  const cmd = String(raw || '').trim().toLowerCase();
  if (cmd === '-set password') { await cmdSetPassword(); return; }
  if (cmd === '-version') { console.log('当前版本：' + VERSION); return; }
  if (cmd === '-server' || cmd === '-open server') { await cmdOpenServer(); return; } // -server 为新命令（V2.10.2）
  if (cmd === '-log') { cmdLogMode(); return; }
  if (cmd === '-restart server') { cmdRestartServer(); return; }
  // 固定端口：-set port:xxxxx（端口范围 1-65535，非法值拒绝保存）
  const mSetPort = cmd.match(/^-set\s+port\s*:\s*(\d+)$/);
  if (mSetPort) {
    const p = parseInt(mSetPort[1], 10);
    if (!(p >= 1 && p <= 65535)) {
      console.log('端口无效：请输入 1-65535 之间的数字（当前输入：' + mSetPort[1] + '）');
      return;
    }
    savePortConfig(p);
    console.log('已固定端口：' + p + '（下次启动使用该端口，重启后生效；输入 -random port 可改回随机）');
    return;
  }
  // 随机端口：-random port（舍弃固定端口，每次启动随机分配）
  if (cmd === '-random port') {
    savePortConfig(null);
    console.log('已改为随机端口模式（每次启动随机分配端口，重启后生效）');
    return;
  }
  if (cmd === '-help') { printHelp(); return; }
  if (cmd) console.log('未知命令：' + raw.trim() + '（输入 -help 查看命令列表）');
}
// -restart server：重启服务端（V2.6.0）
// 写入重启标记文件，启动脚本（启动服务.bat）检测到标记后自动重新运行本服务；
// 重启后由启动脚本传入环境变量 KB_RESTART=1，服务端免账号密码验证并自动启动
function cmdRestartServer() {
  if (!server.listening) {
    console.log('服务端未运行，请先输入 -server 启动后再执行重启');
    return;
  }
  console.log('正在重启服务端…');
  try {
    fs.writeFileSync(path.join(DATA_DIR, '.restart'), String(Date.now()), 'utf8');
  } catch (e) {
    console.log('无法写入重启标记：' + e.message + '，请手动重新运行启动脚本');
    return;
  }
  console.log('服务端即将自动重启（无需重新验证账号密码）…');
  setTimeout(function () { process.exit(0); }, 500);
}
function startCommandLoop() {
  console.log('请输入命令（若不了解命令可输入 -help 查看命令）');
  (async function commandLoop() {
    while (!logStreamMode) {
      const line = await ask('> ');
      const cmd = String(line).trim();
      if (!cmd) continue;
      await runCommand(cmd);
    }
  })();
}

// ---------- 主流程：验证管理员 → 命令模式 ----------
async function main() {
  ensureAdmin();
  const acc = loadAccounts();
  const admin = acc.users.find(u => u.role === 'admin');
  if (!admin) {
    console.log('未找到管理员账号，请检查 data/accounts.json');
    process.exit(1);
  }
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', onInputLine);
  printBanner();
  // 重启模式（-restart server 触发）：自动启动服务端（V2.10.1 起已取消账号密码验证）
  const autoRestart = process.env.KB_RESTART === '1';
  console.log('══════════════════════════════════════════════════');
  console.log(autoRestart ? '  重启模式：自动启动服务端' : '  服务端账号密码验证已取消（V2.10.1），直接进入命令模式');
  console.log('══════════════════════════════════════════════════');
  startCommandLoop();
  if (autoRestart) {
    // 重启模式自动执行启动服务端命令（-server），无需手动输入；
    // 延迟 1.5s 等旧进程完全退出并释放端口后再启动，避免端口占用
    setTimeout(function () { cmdOpenServer(); }, 1500);
  }
}
process.on('SIGINT', () => {
  console.log('\n正在停止…');
  process.exit(0);
});
main().catch(e => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
