// 离线测试：只跑纯函数 + 用假 api 跑一遍登录/抓取链路，不碰网络。
//
// 跑法：node --test tests/
// 夹具在 tests/fixtures/，里面的课程/教师/教室全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __test } from '../skills/jsnu-schedule/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const TIMETABLE = read('timetable.html');
const LOGIN = read('login.html');

const {
  isTimetablePage, parseTimetable, weekOf, coursesOn, weekdayOf, toMin,
  SLOT_START, dueReminders, parseEntry, slotsOf
} = __test;

// ── 页面判据 ─────────────────────────────────────────────────────────
test('isTimetablePage：真课表页认得出', () => {
  assert.equal(isTimetablePage(TIMETABLE), true);
});

test('isTimetablePage：残页（够长但没有课表表格）不认', () => {
  const partial = `<html><head><title>学期理论课表</title></head><body>${'x'.repeat(3000)}</body></html>`;
  assert.equal(isTimetablePage(partial), false);
});

test('isTimetablePage：太短的页面直接不认', () => {
  assert.equal(isTimetablePage('<table id="timetable"></table>'), false);
});

// ── 课表解析 ─────────────────────────────────────────────────────────
test('parseTimetable：解析出夹具里的 6 门课', () => {
  const courses = parseTimetable(TIMETABLE);
  const names = courses.map((c) => c.name).sort();
  assert.deepEqual(names, ['体育', '大学物理', '大学英语', '线性代数', '物理实验', '高等数学'].sort());
});

test('parseTimetable：不会把课程清单表头当成课', () => {
  const courses = parseTimetable(TIMETABLE);
  const bad = courses.filter((c) => /课程名称|授课教师|上课班级|课程编号/.test(c.name));
  assert.deepEqual(bad, []);
});

test('parseTimetable：kbcontent1（简版）不会被重复算成另一门课', () => {
  const courses = parseTimetable(TIMETABLE);
  const math = courses.filter((c) => c.name === '高等数学');
  assert.equal(math.length, 1);
});

test('parseTimetable：星期、节次、教师、教室都对', () => {
  const courses = parseTimetable(TIMETABLE);
  const math = courses.find((c) => c.name === '高等数学');
  assert.equal(math.weekday, 1);              // 星期一
  assert.deepEqual(math.slots, [1, 2]);       // 第1小节那行 → 1-2 节
  assert.equal(math.teacher, '张三');
  assert.equal(math.room, 'A101');
});

test('parseTimetable：同一个单元格里用分隔线隔开的两门课都能解析出来', () => {
  const courses = parseTimetable(TIMETABLE);
  const physics = courses.find((c) => c.name === '大学物理');
  const lab = courses.find((c) => c.name === '物理实验');
  assert.ok(physics, '大学物理 没解析出来');
  assert.ok(lab, '物理实验 没解析出来');
  assert.equal(physics.weekday, 4);           // 星期四
  assert.equal(lab.weekday, 4);
});

test('parseTimetable：单周课只算单周', () => {
  const courses = parseTimetable(TIMETABLE);
  const pe = courses.find((c) => c.name === '体育');
  assert.ok(pe.weeks, '体育 应该有周次');
  assert.equal(pe.weeks.has(1), true);
  assert.equal(pe.weeks.has(2), false);
  assert.equal(pe.weeks.has(15), true);
  assert.equal(pe.weeks.has(16), false);
});

test('parseEntry：没有 title 标记的老页面按行顺序取值', () => {
  const entry = parseEntry(
    '操作系统<br>1-16周(1-2节)<br>钱九<br>F401',
    { weekday: 2, slots: [1, 2] }
  );
  assert.equal(entry.name, '操作系统');
  assert.equal(entry.teacher, '钱九');
  assert.equal(entry.room, 'F401');
  assert.deepEqual(entry.slots, [1, 2]);
  assert.equal(entry.weekday, 2);
});

test('parseEntry：表头行不会被当成课', () => {
  assert.equal(parseEntry('课程名称', { weekday: 1, slots: [1] }), null);
});

test('slotsOf：认得出「3-4节」和「第5节」', () => {
  assert.deepEqual(slotsOf('1-16周(3-4节)'), [3, 4]);
  assert.deepEqual(slotsOf('1-16周(5节)'), [5]);
  assert.equal(slotsOf('1-16周'), null);
});

// ── 周次与选课过滤 ───────────────────────────────────────────────────
test('weekOf：从「开学第一周的周一」算周次', () => {
  const s = { termStart: '2026-09-07' };
  assert.equal(weekOf(s, new Date(2026, 8, 7)), 1);
  assert.equal(weekOf(s, new Date(2026, 8, 13)), 1);   // 同一个周日的尾巴
  assert.equal(weekOf(s, new Date(2026, 8, 14)), 2);
  assert.equal(weekOf(s, new Date(2026, 8, 20)), 2);
});

test('weekOf：开学前返回 null（不按周次过滤）', () => {
  assert.equal(weekOf({ termStart: '2026-09-07' }, new Date(2026, 7, 1)), null);
});

test('weekOf：没填 termStart 返回 null', () => {
  assert.equal(weekOf({}, new Date(2026, 8, 7)), null);
  assert.equal(weekOf({ termStart: '2026/09/07' }, new Date(2026, 8, 7)), null);
});

test('weekdayOf：周一=1，周日=7', () => {
  assert.equal(weekdayOf(new Date(2026, 8, 7)), 1);    // 2026-09-07 是周一
  assert.equal(weekdayOf(new Date(2026, 8, 13)), 7);   // 2026-09-13 是周日
});

test('coursesOn：按星期 + 周次过滤并按时段排序', () => {
  const courses = parseTimetable(TIMETABLE);
  const thu = coursesOn(courses, 4, 5);
  assert.deepEqual(thu.map((c) => c.name), ['大学物理']);
  const thuLate = coursesOn(courses, 4, 10);            // 第 10 周物理实验开始
  assert.deepEqual(thuLate.map((c) => c.name), ['物理实验']);
});

test('toMin：HH:MM 转分钟', () => {
  assert.equal(toMin('08:00'), 480);
  assert.equal(toMin('14:45'), 885);
  assert.ok(Number.isNaN(toMin('8点')));
});

test('SLOT_START：12 个小节的开始时间都在', () => {
  assert.equal(SLOT_START.get(1), '08:00');
  assert.equal(SLOT_START.get(12), '20:00');
  assert.equal(SLOT_START.size, 12);
});

// ── 到点提醒（纯函数）────────────────────────────────────────────────
test('dueReminders：提前 30 分钟该推的会推', () => {
  const courses = parseTimetable(TIMETABLE);
  // 周一 07:40 —— 08:00 的高等数学正好差 20 分钟
  const now = new Date(2026, 8, 7, 7, 40);
  const jobs = dueReminders(courses, { termStart: '2026-09-07', advanceMinutes: 30, pushTarget: 'private:0000000000' }, now);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text, /高等数学/);
  assert.match(jobs[0].text, /20 分钟/);
});

test('dueReminders：还没到提醒窗口不推', () => {
  const courses = parseTimetable(TIMETABLE);
  const now = new Date(2026, 8, 7, 7, 0);      // 距 08:00 还有 60 分钟
  const jobs = dueReminders(courses, { termStart: '2026-09-07', advanceMinutes: 30, pushTarget: 'private:0000000000' }, now);
  assert.equal(jobs.length, 0);
});

test('dueReminders：已经上课了不推', () => {
  const courses = parseTimetable(TIMETABLE);
  const now = new Date(2026, 8, 7, 8, 5);
  const jobs = dueReminders(courses, { termStart: '2026-09-07', advanceMinutes: 30, pushTarget: 'private:0000000000' }, now);
  assert.equal(jobs.length, 0);
});

// 这是当前实现的真实行为，不是期望行为：advance=0 时两个条件互斥，
// 永远不会命中。README 的「已知限制」里记了这条，没在这个仓库里改语义。
test('dueReminders：advanceMinutes=0 时当前实现不会触发', () => {
  const courses = parseTimetable(TIMETABLE);
  const at = new Date(2026, 8, 7, 8, 0);
  const s = { termStart: '2026-09-07', advanceMinutes: 0, pushTarget: 'private:0000000000' };
  assert.equal(dueReminders(courses, s, at).length, 0);       // nowMin >= startMin → 不推
  const before = new Date(2026, 8, 7, 7, 59);
  assert.equal(dueReminders(courses, s, before).length, 0);   // nowMin < startMin - 0 → 不推
});

test('dueReminders：同一天同一节课的 key 稳定（去重靠它）', () => {
  const courses = parseTimetable(TIMETABLE);
  const s = { termStart: '2026-09-07', advanceMinutes: 30, pushTarget: 'private:0000000000' };
  const a = dueReminders(courses, s, new Date(2026, 8, 7, 7, 40));
  const b = dueReminders(courses, s, new Date(2026, 8, 7, 7, 45));
  assert.equal(a[0].key, b[0].key);
});

// ── 登录链路（假 api，不联网）────────────────────────────────────────
test('login：统一认证流程能跑通（假 fetch）', async () => {
  const calls = [];
  const fakeApi = {
    warn: () => {},
    log: () => {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.endsWith('/')) return htmlResponse('<html><body>home</body></html>');
      if (u.includes('/cas/login') && (!init.method || init.method === 'GET')) {
        return htmlResponse(LOGIN);
      }
      if (u.includes('/cas/login') && init.method === 'POST') {
        // 统一认证接受后回一个 302，ticket 落在 location 里
        return redirectResponse('http://jsnujw.jsnu.edu.cn/sso.jsp?ticket=ST-1');
      }
      if (u.includes('/sso.jsp')) return redirectResponse('http://jsnujw.jsnu.edu.cn/jsxsd/xskb/xskb_list.do');
      if (u.includes('xskb_list.do')) return htmlResponse(TIMETABLE);
      return htmlResponse('');
    }
  };

  const homeHtml = await __test.login(fakeApi, {
    studentId: '0000000000',
    password: 'not-a-real-password',
    baseUrl: 'http://jsnujw.jsnu.edu.cn'
  });

  assert.ok(isTimetablePage(homeHtml), '登录后应该直接带回课表页');
  const post = calls.find((c) => c.init.method === 'POST' && String(c.url).includes('/cas/login'));
  assert.ok(post, '应该向统一认证 POST 过一次');
  assert.match(String(post.init.body), /username=0000000000/);
  // 密码不是明文提交：body 里不该出现原始密码
  assert.doesNotMatch(String(post.init.body), /not-a-real-password/);
});

test('login：没配学号/密码时给出可操作的报错', async () => {
  await assert.rejects(
    () => __test.login({ warn: () => {}, fetch: async () => htmlResponse('') }, {}),
    /还没配置学号\/密码/
  );
});

// ── 小工具 ───────────────────────────────────────────────────────────
function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => body
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'location' ? location : null),
      getSetCookie: () => []
    },
    text: async () => ''
  };
}
