// 课表（江苏师范大学 · 强智科技 jsxsd）
//
// 为什么做成 Skill 而不是 Plugin：教务系统的数据不在任何既有能力里，
// 必须变成一个能调的 function（只有 registerTool 才会进模型的工具列表）；
// 同时「到点主动提醒」需要自己起 timer，activate/deactivate 正好承接。
//
// 宿主的三个限制决定了本文件的形状：
//   1. api 里没有文件 IO、没有定时器、没有发送通道 —— 文件用 node:fs 自己来，
//      定时器放 activate，发送通道只能从工具 execute 的 ctx.sender 里拿。
//   2. hook（before-context 等）拿不到 sender，只有 execute 拿得到，所以
//      「先被调用一次 → 把 sender 缓存下来供之后任意时刻用」是唯一通道
//      （plugins/hot-trend-tracker 用的是同一套做法）。
//   3. src/sender.js 明令禁止插件绕过 sendTextBatch 直调 onebot.sendSegments，
//      所以缓存下来的必须是 ctx.sender 这个 SendQueue 实例本身。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 状态目录。装进宿主时用宿主自己的 DATA_DIR（<install>/src/config.js）；
// 单独跑（离线测试、别的宿主）时退回 QQ_AGENT_DATA_DIR 或 ./data，
// 这样这个文件不依赖宿主里的模块也能 import —— 仓库里没有 src/config.js。
let DATA_DIR = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
if (!DATA_DIR) {
  try {
    ({ DATA_DIR } = await import('../../src/config.js'));
  } catch {
    DATA_DIR = path.join(process.cwd(), 'data');
  }
}

const SKILL_ID = 'jsnu-schedule';
const STATE_DIR = path.join(DATA_DIR, SKILL_ID);
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
const CACHE_FILE = path.join(STATE_DIR, 'timetable.json');
const SENT_FILE = path.join(STATE_DIR, 'sent.json');
const DEBUG_HTML = path.join(STATE_DIR, 'last-kb.html');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 教务处《教学作息时间表》（2026-2027 学年）：5 个大节共 12 小节。
const SLOTS = [
  { no: 1, start: '08:00', end: '08:40' },
  { no: 2, start: '08:45', end: '09:25' },
  { no: 3, start: '09:45', end: '10:25' },
  { no: 4, start: '10:30', end: '11:10' },
  { no: 5, start: '11:15', end: '11:55' },
  { no: 6, start: '14:00', end: '14:40' },
  { no: 7, start: '14:45', end: '15:25' },
  { no: 8, start: '15:45', end: '16:25' },
  { no: 9, start: '16:30', end: '17:10' },
  { no: 10, start: '18:30', end: '19:10' },
  { no: 11, start: '19:15', end: '19:55' },
  { no: 12, start: '20:00', end: '20:40' }
];
const SLOT_START = new Map(SLOTS.map((s) => [s.no, s.start]));
const SLOT_END = new Map(SLOTS.map((s) => [s.no, s.end]));
const BIG_SECTION = { 一: [1, 2], 二: [3, 4, 5], 三: [6, 7], 四: [8, 9], 五: [10, 11, 12] };
const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

let currentApi = null;
let timer = null;
const senderCache = new Map();       // chatKey -> { sender, at }
let lastSender = null;               // 任意会话的 sender 都能往别处发（SendQueue 与会话无关）
let cookieJar = {};                  // host -> [[name, value], ...]（两个站必须分开存）
let mem = { courses: [], fetchedAt: 0, htmlBytes: 0 };
let sentJobs = new Set();
let loggedNoSender = 0;

// ── 小工具 ────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 落盘失败不该让一次查询报错 */ }
}

function b64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

function baseUrl(settings) {
  const raw = String(settings.baseUrl || '').trim() || 'http://jsnujw.jsnu.edu.cn';
  return raw.replace(/\/+$/, '');
}

function settings() {
  return (currentApi && currentApi.config()) || {};
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

function weekdayOf(date) {
  return ((date.getDay() + 6) % 7) + 1;   // 周一=1 … 周日=7
}

function clampAdvance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(180, Math.max(0, Math.round(n)));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ');
}

function clean(s) {
  return decodeEntities(stripTags(s)).replace(/[\s\u00a0]+/g, ' ').trim();
}

// ── 会话（cookie 自己管，Node fetch 不会替我们回填）──────────────────────
// 登录要横跨两个站：sid.jsnu.edu.cn（统一身份认证）和 jsnujw.jsnu.edu.cn（教务）。
// 合成一个 jar 会互相覆盖 —— CAS 的 SESSION 会把教务的 bzb_njw 顶掉，最后一跳
// 又被打回登录页。所以按 host 分开存。
function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

function jarOf(host) {
  return cookieJar[host] || [];
}

function absorbCookies(res, url) {
  const host = hostOf(url);
  if (!host) return;
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const jar = new Map(jarOf(host));
  for (const raw of list) {
    const kv = String(raw).split(';')[0];
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (!v || /^deleted$/i.test(v)) jar.delete(k);
    else jar.set(k, v);
  }
  cookieJar = { ...cookieJar, [host]: [...jar.entries()] };
}

function persistSession() {
  writeJson(SESSION_FILE, { jars: cookieJar, at: Date.now() });
}

function requestHeaders(url, extra = {}) {
  const head = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
  };
  const jar = jarOf(hostOf(url));
  if (jar.length) head.cookie = jar.map(([k, v]) => `${k}=${v}`).join('; ');
  return { ...head, ...extra };
}

async function request(api, url, init = {}) {
  const res = await api.fetch(url, {
    ...init,
    headers: requestHeaders(url, init.headers),
    redirect: init.redirect || 'manual',
    signal: AbortSignal.timeout(20000)
  });
  absorbCookies(res, url);
  return res;
}

// 课表页的判据：必须真的带课表表格。教务站偶尔回 200 + 半截 <head>，
// 用「不是登录页」当成功判据会把残页当成空课表。
function isTimetablePage(html) {
  const t = String(html || '');
  if (t.length < 2000) return false;
  return /id=["']timetable["']/i.test(t) || /class=["']kbcontent/i.test(t);
}

function isLoginPage(html) {
  const t = String(html || '');
  return /id="loginForm"/i.test(t)
    || /用户没有登录/.test(t)
    || /<title>\s*登录\s*<\/title>/i.test(t);
}

// 失败提示只认登录页里那个 <font id="showMsg"> 的内容。
// 不能去扫页面里的 alert(...) —— 登录页内嵌了各学校（汕头大学等）的提示脚本，
// 会把「请登录 pay.stu.edu.cn 缴费」这种无关文案当成我们的错误原因报出去。
function loginFailText(html) {
  const t = String(html || '');
  const box = /<font[^>]*id=["']showMsg["'][^>]*>([\s\S]{0,300}?)<\/font>/i.exec(t);
  const msg = box ? clean(box[1]) : '';
  return msg || (isLoginPage(t) ? '仍然返回登录页（没有给出原因）' : '');
}

// ── 统一身份认证（爱师大 i-Star CAS）──────────────────────────────────
// 教务自己的 /Logon.do 已经关掉了：账号密码要交给 sid.jsnu.edu.cn 认证，
// 认证完再带 ticket 跳回教务换 jsxsd 会话。
function casBase(s) {
  return String(s.casUrl || '').trim().replace(/\/+$/, '') || 'https://sid.jsnu.edu.cn';
}

// 密码不是明文提交：key 是登录页里 id="login-croypto" 的 base64 文本，
// 算法是 AES-128-ECB 无 IV 无前缀（Wisedu 那套 CBC+随机前缀在这里是错的，
// 会稳定返回 401）。验证码页存在但不校验，传空串即可。
function encryptPassword(password, croypto) {
  const key = Buffer.from(String(croypto || ''), 'base64');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]).toString('base64');
}

function fieldValue(html, id) {
  const re = new RegExp(`id=["']${id}["'][^>]*>([^<]*)<`, 'i');
  const m = re.exec(String(html || ''));
  return m ? m[1].trim() : '';
}

async function loginCas(api, base, cas, sid, pwd) {
  const service = `${base}/sso.jsp`;
  const casUrl = `${cas}/cas/login?service=${encodeURIComponent(service)}`;

  // 教务首页要先访问一次，bzb_njw / SERVERID 才会被种下；不 prime 后面跳回教务会丢会话。
  try { await request(api, `${base}/`); } catch { /* 拿不到首页也照试 */ }

  const page = await request(api, casUrl);
  const html = await page.text();
  const croypto = fieldValue(html, 'login-croypto');
  const flowkey = fieldValue(html, 'login-page-flowkey');
  if (!croypto || !flowkey) {
    return { ok: false, msg: '统一认证登录页没给出 login-croypto / login-page-flowkey（页面可能改版）' };
  }

  const body = new URLSearchParams({
    username: sid,
    password: encryptPassword(pwd, croypto),
    captcha: '',
    croypto,
    execution: flowkey,
    _eventId: 'submit',
    type: 'UsernamePassword'
  });
  const res = await request(api, casUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: casUrl },
    body: body.toString()
  });

  const landed = await res.text();
  let next = res.headers.get('location') || '';
  if (!next && /id=["']showMsg["']/i.test(landed)) {
    return { ok: false, msg: clean(landed.slice(0, 400)) || '统一认证拒绝了这次登录' };
  }
  if (!next) return { ok: false, msg: '统一认证没有返回跳转地址（账号或密码可能不对）' };

  // 逐跳手动跟随：ticket 会在 /sso.jsp 被吃掉并换成 bzb_njw，
  // 自动 redirect 会因为 cookie 还没落到 jar 里而反复回到登录页。
  for (let hop = 0; hop < 10 && next; hop++) {
    const url = next.startsWith('http') ? next : `${base}${next}`;
    const r = await request(api, url);
    await r.text();
    const loc = r.headers.get('location');
    if (!loc) break;
    next = loc.startsWith('http') ? loc : `${base}${loc}`;
  }

  const home = await request(api, `${base}/jsxsd/xskb/xskb_list.do`);
  const homeHtml = await home.text();
  if (isLoginPage(homeHtml)) return { ok: false, msg: '认证通过了，但教务没有接受这个会话（bzb_njw 没建立）' };
  // 这一次 GET 是会话里最好的一次响应（教务登录后大约只经得起 2~3 次已认证请求，
  // 之后会退化成 200 字节残页或登录页），所以把它带出去给 fetchTimetable 直接用，
  // 而不是丢掉再打一次。
  return { ok: true, homeHtml };
}

// 新版（强智 NJW）：POST /Logon.do?method=logon&flag=sess 拿 "scode#sxh"，再提交混淆后的 encoded。
async function loginNew(api, base, sid, pwd) {
  const sess = await request(api, `${base}/Logon.do?method=logon&flag=sess`, {
    method: 'POST',
    headers: { referer: `${base}/` }
  });
  const raw = (await sess.text()).trim();
  const [scode, sxh] = raw.split('#');
  if (!scode || !sxh) return { ok: false, msg: '新版登录页没给出会话参数（可能是维护中）' };

  const encoded = obfuscate(`${sid}%%%${pwd}`, scode, sxh);
  if (!encoded) return { ok: false, msg: '新版登录参数异常' };

  const body = new URLSearchParams({ userAccount: sid, userPassword: '', encoded });
  const res = await request(api, `${base}/Logon.do?method=logon`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/` },
    body: body.toString()
  });
  const html = await res.text();
  const why = loginFailText(html);
  if (why) return { ok: false, msg: why };

  const home = await request(api, `${base}/jsxsd/xskb/xskb_list.do`);
  const homeHtml = await home.text();
  if (isLoginPage(homeHtml)) return { ok: false, msg: '提交后课表页仍要求登录（cookie 没建立）' };
  return { ok: true, homeHtml };
}

// 旧版（jsxsd）：POST /jsxsd/xk/LoginToXk，encoded = base64(学号) + "%%%" + base64(密码)。
async function loginLegacy(api, base, sid, pwd) {
  try { await request(api, `${base}/jsxsd/`); } catch { /* 拿不到登录页也照试 */ }
  const body = new URLSearchParams({
    loginMethod: 'LoginToXk',
    userAccount: sid,
    userPassword: pwd,
    encoded: `${b64(sid)}%%%${b64(pwd)}`,
    captcha: ''
  });
  const res = await request(api, `${base}/jsxsd/xk/LoginToXk`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/jsxsd/` },
    body: body.toString()
  });
  const html = await res.text();
  const why = loginFailText(html);
  if (why) return { ok: false, msg: why };

  const home = await request(api, `${base}/jsxsd/xskb/xskb_list.do`);
  const homeHtml = await home.text();
  if (isLoginPage(homeHtml)) return { ok: false, msg: '提交后课表页仍要求登录（cookie 没建立）' };
  return { ok: true, homeHtml };
}

// 先走统一认证（现在唯一还能用的路），失败再退回教务自带的两个老入口。
async function login(api, s) {
  const base = baseUrl(s);
  const sid = String(s.studentId || '').trim();
  const pwd = String(s.password || '');
  if (!sid || !pwd) throw new Error('还没配置学号/密码：设置 → 技能 → 课表（江师大）');

  cookieJar = {};
  const reasons = [];
  const attempts = [
    ['统一认证', (b) => loginCas(api, b, casBase(s), sid, pwd)],
    ['教务新版', (b) => loginNew(api, b, sid, pwd)],
    ['教务旧版', (b) => loginLegacy(api, b, sid, pwd)]
  ];
  for (const [label, run] of attempts) {
    let r;
    try {
      r = await run(base);
    } catch (e) {
      r = { ok: false, msg: `${label}请求失败（${e && e.message ? e.message : e}）` };
    }
    // 把登录那一次拿到的课表页透传出去：它往往就是本次会话唯一一份好页面。
    if (r.ok) { persistSession(); return r.homeHtml || ''; }
    reasons.push(`${label}：${r.msg}`);
    cookieJar = {};
  }
  throw new Error(`登录失败 —— ${reasons.join('；')}。学号或密码不对，也可能系统正在维护。改完密码请到「设置 → 技能 → 课表（江师大）」更新；不要连续重试，连续失败会被锁。`);
}

// ── 课表页解析（强智版 xskb_list.do）──────────────────────────────────
function parseRows(html) {
  const rows = [];
  const occupied = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let r = 0;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    let c = 0;
    const tdRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = tdRe.exec(m[1]))) {
      const attrs = cm[1] || '';
      const colspan = Number((/colspan\s*=\s*["']?(\d+)/i.exec(attrs) || [])[1] || 1);
      const rowspan = Number((/rowspan\s*=\s*["']?(\d+)/i.exec(attrs) || [])[1] || 1);
      while (occupied[r] && occupied[r][c]) c++;
      for (let dr = 0; dr < rowspan; dr++) {
        occupied[r + dr] = occupied[r + dr] || [];
        for (let dc = 0; dc < colspan; dc++) occupied[r + dr][c + dc] = true;
      }
      cells.push({ col: c, colspan, rowspan, text: clean(cm[2]), raw: cm[2] });
      c += colspan;
    }
    rows.push(cells);
    r++;
  }
  return rows;
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b && i <= 12; i++) out.push(i);
  return out;
}

function rowSlots(cells) {
  const first = cells.find((x) => x.col === 0) || cells[0];
  const text = first ? first.text : '';
  const span = /(\d{1,2})\s*[-~—至]\s*(\d{1,2})\s*小?节/.exec(text);
  if (span) return range(Number(span[1]), Number(span[2]));
  const big = /第([一二三四五])大节/.exec(text);
  if (big) return BIG_SECTION[big[1]] || null;
  const one = /第?\s*(\d{1,2})\s*小?节/.exec(text);
  if (one) return [Number(one[1])];
  return null;
}

function slotsOf(text) {
  const t = String(text || '');
  const span = /(\d{1,2}(?:\s*[-~—至]\s*\d{1,2})+)\s*小?节/.exec(t);
  if (span) {
    const nums = span[1].split(/[-~—至]/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (nums.length) return range(Math.min(...nums), Math.max(...nums));
  }
  const one = /\[?\s*(\d{1,2})\s*小?节/.exec(t);
  return one ? [Number(one[1])] : null;
}

function weeksOf(text) {
  const t = String(text || '');
  if (!/周/.test(t) || !/\d/.test(t)) return null;
  const odd = /单周|\(\s*单\s*\)|（单）/.test(t);
  const even = /双周|\(\s*双\s*\)|（双）/.test(t);
  const weeks = new Set();
  const re = /(\d{1,2})\s*(?:[-~—至]\s*(\d{1,2}))?\s*[（(]?\s*周/g;
  let m;
  while ((m = re.exec(t))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let w = a; w <= Math.min(b, 40); w++) {
      if (odd && w % 2 === 0) continue;
      if (even && w % 2 === 1) continue;
      weeks.add(w);
    }
  }
  return weeks.size ? weeks : null;
}

function weekdayOfName(ch) {
  if (ch === '天') return 7;
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7 }[ch] || 0;
}

function parseEntry(raw, ctx) {
  const html = String(raw || '');
  // 详版单元格里的每一行都是 <font title='教师'>、<font title='周次(节次)'> 这种带标题的，
  // 按标题取值比按位置取值稳 —— 有的课没有教师行，按位置会把周次当成教师。
  const fonts = [...html.matchAll(/<font\b([^>]*)>([\s\S]*?)<\/font>/gi)]
    .map((m) => {
      const attrs = m[1] || '';
      const t = /title\s*=\s*["']([^"']*)["']/i.exec(attrs);
      return { title: t ? t[1] : '', text: clean(m[2]) };
    })
    .filter((f) => f.text);

  const pick = (key) => {
    const hit = fonts.find((f) => f.title && f.title.includes(key));
    return hit ? hit.text : '';
  };

  const plain = String(html)
    .split(/<br\s*\/?>/i)
    .map((p) => clean(p))
    .filter(Boolean);

  let name = (fonts.find((f) => !f.title) || {}).text || '';
  if (!name) name = plain[0] || '';
  if (!name || name.length > 60) return null;
  if (/^(备注|上课班级|课程名称|课程编号|授课教师)/.test(name)) return null;

  let weeks = null;
  let slots = ctx.slots;
  const weekText = pick('周次');
  if (weekText) {
    weeks = weeksOf(weekText);
    const override = slotsOf(weekText);
    if (override) slots = override;
  }

  let teacher = pick('教师');
  let room = pick('教室');

  // 没有 title 标记的页面（老版本 / 测试夹具）退回按行顺序取值。
  if (!weekText) {
    const rest = [];
    for (const part of plain.slice(1)) {
      const w = weeksOf(part);
      if (w && !weeks) {
        weeks = w;
        const override = slotsOf(part);
        if (override) slots = override;
        continue;
      }
      rest.push(part);
    }
    if (!teacher) teacher = rest[0] || '';
    if (!room) room = rest[1] || '';
  }

  return {
    name,
    teacher,
    room,
    weeks,
    slots: slots || ctx.slots,
    weekday: ctx.weekday
  };
}

// 行首的「第X小节 / 第X大节」只是节次标签。表头没写 colspan 时它会落在
// 某个星期列上，被当成一门叫「第1小节」的课 —— 提前认出来跳过。
function isSlotLabel(text) {
  const t = String(text || '').trim();
  return /^第?\s*\d{1,2}\s*小?节$/.test(t) || /^第[一二三四五]大节$/.test(t);
}

// 真课表在 <table id="timetable"> 里；同一页还有 dataTables（课程清单）和
// dataTables2（实践课），不切开就会把「课程名称/授课教师」这些表头当成课。
function timetableRegion(html) {
  const s = String(html || '');
  const at = s.search(/<table\b[^>]*id=["']timetable["']/i);
  if (at < 0) return s;
  const end = s.indexOf('</table>', at);
  return end < 0 ? s.slice(at) : s.slice(at, end);
}

// 每个课程单元格里有两份内容：隐藏的 kbcontent1（简版：名称/周次/教室）
// 和可见的 kbcontent（详版：名称/教师/周次+节次/教室）。两份都解析会让每门课
// 变成两条，所以先把 kbcontent1 整段剪掉。
function stripSummaryDivs(raw) {
  const s = String(raw || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const mark = s.indexOf('class="kbcontent1"', i);
    if (mark < 0) { out.push(s.slice(i)); break; }
    const divStart = s.lastIndexOf('<div', mark);
    const detail = s.indexOf('class="kbcontent"', mark);
    if (divStart < i || detail < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, divStart));
    // 继续位置必须落在详版那个 div 的 <div 上；落在属性中间会把
    // class="kbcontent" 这段残片当成下一门课的名字。
    const next = s.lastIndexOf('<div', detail);
    i = next >= 0 ? next : detail;
  }
  return out.join('');
}

function parseTimetable(html) {
  const rows = parseRows(timetableRegion(html));
  const colWeekday = new Map();
  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    for (const cell of rows[i]) {
      const m = /星期\s*([一二三四五六日天])/.exec(cell.text);
      if (!m) continue;
      colWeekday.set(cell.col, weekdayOfName(m[1]));
      if (headerRow < 0) headerRow = i;
    }
    if (colWeekday.size >= 5) break;
  }

  const courses = [];
  const seen = new Set();
  const startRow = headerRow < 0 ? 0 : headerRow + 1;
  let cursor = 1;
  for (let i = startRow; i < rows.length; i++) {
    const cells = rows[i];
    const explicit = rowSlots(cells);
    const slots = explicit || [cursor];
    cursor = Math.max(...slots) + 1;
    for (const cell of cells) {
      if (isSlotLabel(cell.text)) continue;          // 「第1小节」「第一大节」是行首标签，不是课
      const weekday = colWeekday.get(cell.col) || (headerRow < 0 && cell.col >= 1 ? cell.col : 0);
      if (weekday < 1 || weekday > 7) continue;
      for (const block of stripSummaryDivs(cell.raw).split(/-{3,}|_{3,}/)) {
        const entry = parseEntry(block, { weekday, slots });
        if (!entry) continue;
        // 跨两行的课（rowspan=2）会在两行各出现一次，周次和节次完全相同 —— 去重。
        const key = entryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        courses.push(entry);
      }
    }
  }
  return courses;
}

function entryKey(e) {
  const weeks = e.weeks ? [...e.weeks].sort((a, b) => a - b).join(',') : '';
  return [e.name, e.weekday, (e.slots || []).join(','), e.room, e.teacher, weeks].join('|');
}

async function fetchTimetable(api, s, { saveHtml = false } = {}) {
  const base = baseUrl(s);
  // 登录后只有旧版 jsxsd 会话是活的：/jsxsd/xskb/xskb_list.do 才是真课表页，
  // 新版 /xskb/xskb_list.do 和 /framework/xsMainV.jsp 都还会回「用户没有登录」。
  const paths = [`${base}/jsxsd/xskb/xskb_list.do`, `${base}/xskb/xskb_list.do`, `${base}/framework/xsMainV.jsp`];

  const grab = async () => {
    let last = { html: '', where: '' };
    for (const url of paths) {
      const res = await request(api, url);
      const html = await res.text();
      // 教务服务器偶尔会在一次正常请求之后回一个只有 <head> 的残页（实测 231 字节，
      // 状态码仍是 200，标题仍是「学期理论课表」）。不认出来就会当成「这学期没课」，
      // 提醒一条都不会来 —— 所以必须要求页面里真的带课表表格。
      if (isTimetablePage(html)) return { html, where: url };
      if (isLoginPage(html)) { last = { html, where: url }; continue; }
      last = { html, where: url };
    }
    return { html: '', where: last.where, partial: last.html };
  };

  // 先用手上的会话试一次；不行就登录，并把登录那一次顺带抓到的课表页直接用掉。
  let got = await grab();
  if (!got.html) {
    const homeHtml = await login(api, s);
    if (isTimetablePage(homeHtml)) {
      got = { html: homeHtml, where: `${base}/jsxsd/xskb/xskb_list.do` };
    } else {
      got = await grab();
    }
  }
  if (!got.html) {
    const partial = String(got.partial || '').length;
    throw new Error(partial
      ? `课表页只回了 ${partial} 字节的残页（教务服务器抽风），这次先跳过`
      : '登录成功了，但课表页仍然要求登录（会话没保持住）');
  }
  const html = got.html;

  if (saveHtml) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(DEBUG_HTML, html, 'utf8');
    } catch { /* 调试副本写不进去不影响主流程 */ }
  }
  const courses = parseTimetable(html);
  return {
    courses,
    fetchedAt: Date.now(),
    htmlBytes: html.length,
    source: got.where,
    hint: courses.length ? '' : `课表页返回了 ${html.length} 字节，但没有解析出任何课程（页面结构可能变了，原始 HTML 已存到 ${DEBUG_HTML}）`
  };
}

function serializeCourses(courses) {
  return courses.map((c) => ({ ...c, weeks: c.weeks ? [...c.weeks] : null }));
}

function deserializeCourses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && c.name && Array.isArray(c.slots))
    .map((c) => ({ ...c, weeks: Array.isArray(c.weeks) ? new Set(c.weeks) : null }));
}

async function ensureCourses(api, s, { force = false } = {}) {
  const fresh = mem.courses.length && Date.now() - mem.fetchedAt < 6 * 3600 * 1000;
  if (!force && fresh) return mem;
  try {
    const data = await fetchTimetable(api, s, { saveHtml: force });
    mem = data;
    writeJson(CACHE_FILE, { fetchedAt: data.fetchedAt, htmlBytes: data.htmlBytes, courses: serializeCourses(data.courses) });
    return mem;
  } catch (error) {
    if (mem.courses.length) {
      api.warn('刷新课表失败，继续用缓存：%s', error?.message || error);
      return mem;
    }
    throw error;
  }
}

// ── 周次与选课过滤 ────────────────────────────────────────────────────
function weekOf(s, date = new Date()) {
  const raw = String(s.termStart || '').trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day - start) / 86400000);
  if (days < 0) return null;
  return Math.floor(days / 7) + 1;
}

function inWeek(course, week) {
  if (!week) return true;
  if (!course.weeks) return true;
  return course.weeks.has(week);
}

function coursesOn(courses, weekday, week) {
  return courses
    .filter((c) => c.weekday === weekday && inWeek(c, week))
    .sort((a, b) => (a.slots[0] || 0) - (b.slots[0] || 0));
}

function describe(course, { time = true } = {}) {
  const first = course.slots[0];
  const last = course.slots[course.slots.length - 1];
  const bits = [course.name];
  if (course.room) bits.push(course.room);
  if (course.teacher) bits.push(course.teacher);
  let text = bits.join(' · ');
  if (time && SLOT_START.has(first)) {
    text += `（${SLOT_START.get(first)}-${SLOT_END.get(last) || ''}，第${course.slots.join(',')}小节）`;
  }
  return text;
}

function weekNote(s, now = new Date()) {
  const week = weekOf(s, now);
  if (week) return `第 ${week} 周`;
  return '（设置里填「开学第一周的周一」后就能按周次过滤，现在会把所有周次的课都算上）';
}

// ── 发送通道 ──────────────────────────────────────────────────────────
function rememberSender(ctx) {
  const key = String(ctx?.chatKey || '');
  const sender = ctx?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') return;
  lastSender = { sender, at: Date.now() };
  if (!key) return;
  senderCache.set(key, lastSender);
  if (senderCache.size > 20) {
    const oldest = [...senderCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) senderCache.delete(oldest[0]);
  }
}

// 推送两条腿：
//   ① 优先用缓存下来的 ctx.sender（走 SendQueue：限频 / 去重 / 切分 / 留档都齐）；
//   ② 没有缓存时退回宿主自己的本地 HTTP 端点 POST /api/chats/<kind>_<id>/test-send。
//      没有②的话，用户装好技能却从没在 QQ 里调过工具，提醒永远发不出去 ——
//      「说好提前 30 分钟提醒，结果一条都没来」正是这么发生的。
async function pushViaLocalApi(api, chatKey, text) {
  const [kind, id] = String(chatKey).split(':');
  if (!kind || !id) return false;
  const port = Number(process.env.QQ_AGENT_PORT) || 3210;
  const res = await api.fetch(`http://127.0.0.1:${port}/api/chats/${kind}_${id}/test-send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`本地发送端点返回 ${res.status}：${body.slice(0, 120)}`);
  }
  return true;
}

async function push(api, s, text) {
  const chatKey = String(s.pushTarget || '').trim();
  if (!chatKey) {
    api.warn('没配置推送会话（pushTarget），跳过这次提醒');
    return false;
  }
  const entry = senderCache.get(chatKey) || lastSender;
  if (entry && typeof entry.sender?.sendTextBatch === 'function') {
    try {
      await entry.sender.sendTextBatch(chatKey, [text]);
      return true;
    } catch (error) {
      api.warn('走 SendQueue 推送失败，改用本地端点：%s', error?.message || error);
    }
  }
  try {
    await pushViaLocalApi(api, chatKey, text);
    return true;
  } catch (error) {
    const now = Date.now();
    if (now - loggedNoSender > 3600 * 1000) {
      loggedNoSender = now;
      api.warn('推送失败（本地端点也不通）：%s', error?.message || error);
    }
    return false;
  }
}

// ── 到点提醒 ──────────────────────────────────────────────────────────
function loadSent() {
  const raw = readJson(SENT_FILE, { keys: [] });
  const cutoff = Date.now() - 7 * 86400000;
  const keep = (Array.isArray(raw.keys) ? raw.keys : []).filter((k) => {
    const day = String(k).slice(0, 8);
    if (!/^\d{8}$/.test(day)) return false;
    const t = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))).getTime();
    return t >= cutoff;
  });
  sentJobs = new Set(keep);
}

function saveSent() {
  writeJson(SENT_FILE, { keys: [...sentJobs].slice(-500) });
}

function alreadySent(key) {
  return sentJobs.has(key);
}

function markSent(key) {
  sentJobs.add(key);
  saveSent();
}

async function tick({ warmup = false } = {}) {
  heartbeat({ lastTickAt: Date.now() });
  const api = currentApi;
  if (!api) return;
  const s = settings();
  if (s.enabled === false || s.pushEnabled === false) return;
  if (!String(s.studentId || '').trim() || !String(s.password || '').trim()) return;

  const now = new Date();
  const hour = now.getHours();
  // 夜里不查也不推。但启动时如果本地还没有任何课表缓存，仍然补抓一次 ——
  // 否则半夜重启过的机器人第一次被问「明天有课吗」要现登录现抓，慢得像卡住了。
  if (!warmup && (hour < 6 || hour >= 23)) return;

  let data;
  try {
    data = await ensureCourses(api, s);
  } catch (error) {
    heartbeat({ lastError: String(error?.message || error).slice(0, 200) });
    api.warn('取课表失败，这次不提醒：%s', error?.message || error);
    return;
  }
  heartbeat({ courses: data.courses.length, fetchedAt: data.fetchedAt, lastError: '' });
  if (warmup) return;

  for (const job of dueReminders(data.courses, s, now)) {
    if (alreadySent(job.key)) continue;
    if (await push(api, s, job.text)) markSent(job.key);
  }
}

/**
 * 算出「现在该推哪些提醒」—— 纯函数，不碰网络也不碰状态。
 * 抽出来是因为到点提醒是这个技能唯一的主动行为，逻辑错了就是
 * 「说好提前半小时提醒，结果一条都没来」，必须能离线确定性验证。
 */
function dueReminders(courses, s, now = new Date()) {
  const week = weekOf(s, now);
  const advance = clampAdvance(s.advanceMinutes);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out = [];
  for (const course of coursesOn(courses, weekdayOf(now), week)) {
    const first = course.slots[0];
    const startText = SLOT_START.get(first);
    const startMin = toMin(startText);
    if (!Number.isFinite(startMin)) continue;
    if (nowMin >= startMin || nowMin < startMin - advance) continue;
    const key = `${dayKey(now)}|${course.name}|${first}|${s.pushTarget}`;
    const left = startMin - nowMin;
    const head = advance > 0 ? `⏰ ${left} 分钟后` : '⏰ 现在';
    const text = `${head}上《${course.name}》${course.room ? `（${course.room}）` : ''}，${startText} 开始。`;
    out.push({ key, text, course });
  }
  return out;
}

// 心跳落盘：宿主没有「查看技能内部状态」的入口，定时器到底有没有在跑
// 只能靠技能自己留痕（runtime.json）。排查「说好的提醒没来」时先看这个文件。
function heartbeat(patch) {
  try {
    const file = path.join(STATE_DIR, 'runtime.json');
    writeJson(file, { ...readJson(file, {}), pid: process.pid, ...patch });
  } catch { /* 心跳失败不影响主流程 */ }
}

/** 启动定时器。app 启动与热重载后都会调用（enabledByDefault 的技能自动 activate）。 */
export function activate() {
  if (timer) return;
  if (!currentApi) return;
  const saved = readJson(SESSION_FILE, {});
  cookieJar = {};
  for (const [host, jar] of Object.entries(saved.jars || {})) {
    const list = (jar || []).filter((x) => Array.isArray(x) && x.length === 2);
    if (list.length) cookieJar[host] = list;
  }
  const cached = readJson(CACHE_FILE, null);
  if (cached) {
    mem = {
      courses: deserializeCourses(cached.courses),
      fetchedAt: Number(cached.fetchedAt) || 0,
      htmlBytes: Number(cached.htmlBytes) || 0
    };
  }
  loadSent();
  setTimeout(() => { tick({ warmup: !mem.courses.length }).catch(() => {}); }, 8000);
  timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
  const s0 = settings();
  heartbeat({
    activatedAt: Date.now(),
    courses: mem.courses.length,
    advanceMinutes: clampAdvance(s0.advanceMinutes),
    pushTarget: String(s0.pushTarget || ''),
    configured: Boolean(String(s0.studentId || '').trim() && String(s0.password || '').trim())
  });
  currentApi.log('已启动（%s 条缓存课程，提前 %s 分钟提醒，推送到 %s）', mem.courses.length, clampAdvance(s0.advanceMinutes), String(s0.pushTarget || '未配置'));
}

/** 停掉定时器。manager 在热重载/禁用时会先调它，否则重载会叠出多个 timer。 */
export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────
function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}

async function loadForTool(api, ctx, { force = false } = {}) {
  rememberSender(ctx);
  const s = settings();
  if (s.enabled === false) throw new Error('课表功能已在设置里关掉了（设置 → 技能 → 课表（江师大））');
  return { s, data: await ensureCourses(api, s, { force }) };
}

export async function setup(api) {
  currentApi = api;
  const on = () => settings().enabled !== false;

  api.registerTool({
    id: 'jsnu_today',
    name: '今天有课吗',
    description: '查询今天（江师大教务系统）的课表。主人问「今天有课吗」「今天什么课」「下午有课吗」时用。',
    category: 'query',
    icon: '📅',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const { s, data } = await loadForTool(api, ctx);
        const now = new Date();
        const week = weekOf(s, now);
        const today = coursesOn(data.courses, weekdayOf(now), week);
        if (!today.length) return ok(`今天（${WEEKDAY_CN[weekdayOf(now)]}）没课。${week ? '' : weekNote(s, now)}`);
        const lines = today.map((c) => `· ${describe(c)}`);
        return ok(`今天（${WEEKDAY_CN[weekdayOf(now)]}${week ? ` 第${week}周` : ''}）有 ${today.length} 节课：\n${lines.join('\n')}`);
      } catch (error) {
        return fail(error?.message || String(error));
      }
    }
  });

  api.registerTool({
    id: 'jsnu_week',
    name: '本周课表',
    description: '查询本周完整课表（周一到周日）。主人问「这周课表」「周几有课」时用。⚠️ 注意：周日问「明天的课」时明天属于下周，不要用本工具回答——改用 jsnu_next（它会按目标日期算周次）。',
    category: 'query',
    icon: '🗓️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: '周偏移：0=本周（默认），1=下周，-1=上周。主人问「下周课表」「上星期的课」时用。' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const { s, data } = await loadForTool(api, ctx);
        const offset = Math.max(-4, Math.min(4, Math.round(Number(args.offset) || 0)));
        // 锚定本周的周一：周次一律以「该周的周一」计算，避免周日（本周第7天）
        // 加 offset=1 时落到下下周的诡异结果。
        const now = new Date();
        const mondayThis = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekdayOf(now) - 1));
        const anchor = new Date(mondayThis.getFullYear(), mondayThis.getMonth(), mondayThis.getDate() + offset * 7);
        const week = weekOf(s, anchor);
        const label = offset === 0 ? (week ? `第 ${week} 周` : '本周')
          : offset > 0 ? (week ? `下${offset > 1 ? ` ${offset} ` : ''}一周（第 ${week} 周）` : `下${offset > 1 ? ` ${offset} ` : ''}一周`)
          : (week ? `上${offset < -1 ? ` ${-offset} ` : ''}一周（第 ${week} 周）` : `上${offset < -1 ? ` ${-offset} ` : ''}一周`);
        const blocks = [];
        for (let wd = 1; wd <= 7; wd++) {
          const list = coursesOn(data.courses, wd, week);
          if (!list.length) continue;
          blocks.push(`${WEEKDAY_CN[wd]}：\n${list.map((c) => `  · ${describe(c)}`).join('\n')}`);
        }
        if (!blocks.length) return ok(`${label}没有课。${weekNote(s, anchor)}`);
        return ok(`${label}课表：\n${blocks.join('\n')}`);
      } catch (error) {
        return fail(error?.message || String(error));
      }
    }
  });

  api.registerTool({
    id: 'jsnu_next',
    name: '下一节课',
    description: '看接下来要上的那节课（今天还没上的最近一节，今天没有了就看明天，可以一直往后看到下周）。主人问「下节课是什么」「几点上课」「马上要带什么书」「明天有什么课」时用。',
    category: 'query',
    icon: '⏭️',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const { s, data } = await loadForTool(api, ctx);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const todayWeek = weekOf(s, now);
        const todayLeft = coursesOn(data.courses, weekdayOf(now), todayWeek)
          .filter((c) => toMin(SLOT_START.get(c.slots[0])) > nowMin);
        if (todayLeft.length) {
          const c = todayLeft[0];
          const startText = SLOT_START.get(c.slots[0]);
          const left = toMin(startText) - nowMin;
          return ok(`下一节是《${c.name}》${c.room ? `，${c.room}` : ''}${c.teacher ? `，${c.teacher}` : ''}，${startText} 开始（还有 ${left} 分钟）。`);
        }
        // 从明天起往后找。⚠️ 周次必须按【目标日期】算，不能沿用今天的：
        // 周日问「明天」，明天已是下一周的周一 —— 用今天的周次去查下一周的课，
        // 单双周/隔周课会整体错一周（周日问明天的课，答成本周周一的课）。
        for (let step = 1; step <= 14; step++) {
          const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + step);
          const wd = weekdayOf(date);
          const week = weekOf(s, date);          // ← 关键修复：每个候选日各自算周次
          const list = coursesOn(data.courses, wd, week);
          if (!list.length) continue;
          const c = list[0];
          const when = step === 1 ? '明天'
            : step === 2 ? '后天'
            : `${WEEKDAY_CN[wd]}（${date.getMonth() + 1}月${date.getDate()}日${week ? `，第${week}周` : ''}）`;
          return ok(`今天没课了。${when}第一节是《${c.name}》${c.room ? `，${c.room}` : ''}，${SLOT_START.get(c.slots[0])} 开始。`);
        }
        return ok(`接下来两周都没课。${weekNote(s, now)}`);
      } catch (error) {
        return fail(error?.message || String(error));
      }
    }
  });

  api.registerTool({
    id: 'jsnu_refresh',
    name: '刷新课表/检查登录',
    description: '重新登录教务系统并强制刷新课表缓存，顺便报告登录是否正常、解析出多少节课。主人说「课表不对」「刷新一下课表」或课表查询报错时用。',
    category: 'system',
    icon: '🔄',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const { s, data } = await loadForTool(api, ctx, { force: true });
        const detail = data.courses.length
          ? `登录正常，解析出 ${data.courses.length} 节课（缓存到 ${new Date(data.fetchedAt).toLocaleString('zh-CN')}）。`
          : (data.hint || '刷新成功，但没解析出课程。');
        return ok(`${detail}\n学号：${s.studentId ? String(s.studentId).slice(0, 4) + '****' : '未配置'}；页面大小 ${data.htmlBytes} 字节。`);
      } catch (error) {
        return fail(error?.message || String(error));
      }
    }
  });
}

// 仅给离线测试用：宿主只认 setup/register/hooks/providers/activate，多导出一个不影响加载。
export const __test = { isTimetablePage, parseTimetable, weekOf, coursesOn, weekdayOf, toMin, SLOT_START, push, pushViaLocalApi, settings, dueReminders, login, fetchTimetable, ensureCourses, parseEntry, slotsOf };
