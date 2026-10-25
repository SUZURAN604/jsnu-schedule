// 工具层的用例：jsnu_week 的 offset 与 jsnu_next 的「按目标日期算周次」。
//
// 这两条是 1.1.0 修的东西，而且都是「周日」才会露头的 bug —— 平时跑不到，
// 一旦错了表现是「明天问课答了本周周一的课」。所以这里不联网，直接把
// setup(api) 挂上一个假 api，再用假 Date 把时间钉死到具体的周日。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setup } from '../skills/jsnu-schedule/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMETABLE = fs.readFileSync(path.join(HERE, 'fixtures', 'timetable.html'), 'utf8');

const RealDate = Date;

/** 在 fn 执行期间把「现在」钉到本地时间 y-m-d h:mi。 */
async function at(y, m, d, h, mi, fn) {
  const fixed = new RealDate(y, m - 1, d, h, mi).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FakeDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** 挂一个最小 api：课表直接给夹具页，不走登录。 */
async function mount() {
  const tools = new Map();
  const api = {
    config: () => ({
      enabled: true,
      termStart: '2026-09-07',
      advanceMinutes: 30,
      pushEnabled: false,
      pushTarget: '',
      studentId: '',
      password: '',
      baseUrl: 'http://jsnujw.jsnu.edu.cn'
    }),
    log: () => {},
    warn: () => {},
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => TIMETABLE
    }),
    registerTool: (tool) => tools.set(tool.id, tool)
  };
  await setup(api);
  return (id) => tools.get(id);
}

const ctx = { chatKey: 'private:0000000000' };

test('jsnu_week：offset=0/1/-1 落在正确的周次上', async () => {
  const tool = await mount();
  // 2026-10-25 是周日，属于第 7 周（termStart=2026-09-07）
  await at(2026, 10, 25, 20, 0, async () => {
    assert.match((await tool('jsnu_week').execute(ctx, {})).content, /^第 7 周课表/);
    assert.match((await tool('jsnu_week').execute(ctx, { offset: 1 })).content, /下一周（第 8 周）课表/);
    assert.match((await tool('jsnu_week').execute(ctx, { offset: -1 })).content, /上一周（第 6 周）课表/);
  });
});

test('jsnu_week：周日的 offset 不会多跳一周（锚点取该周周一）', async () => {
  const tool = await mount();
  // 2026-11-01 周日仍是第 8 周；若拿「今天 + 7 天」当锚点会算成第 9 周之后
  await at(2026, 11, 1, 20, 0, async () => {
    assert.match((await tool('jsnu_week').execute(ctx, {})).content, /^第 8 周课表/);
    assert.match((await tool('jsnu_week').execute(ctx, { offset: 1 })).content, /下一周（第 9 周）课表/);
  });
});

test('jsnu_next：周日问「明天」按下一周的周次查，不是本周', async () => {
  const tool = await mount();
  // 2026-10-25 周日（第 7 周）20:00 —— 明天 10-26 周一是第 8 周的高等数学。
  // 夹具里周一的课是 1-16 周，所以这条其实两种算法都能过；真正卡住的是
  // 「第 8 周周一」和「第 7 周周一」的区分靠的是 step 循环里的 weekOf(date)。
  await at(2026, 10, 25, 20, 0, async () => {
    const out = (await tool('jsnu_next').execute(ctx)).content;
    assert.match(out, /明天第一节是《高等数学》/);
  });
});

test('jsnu_next：今天还有课时报剩余分钟', async () => {
  const tool = await mount();
  // 2026-10-26 周一 07:50，高等数学 08:00 开始
  await at(2026, 10, 26, 7, 50, async () => {
    const out = (await tool('jsnu_next').execute(ctx)).content;
    assert.match(out, /下一节是《高等数学》/);
    assert.match(out, /还有 10 分钟/);
  });
});

test('jsnu_next：明天没课时说「后天」', async () => {
  const tool = await mount();
  // 2026-10-24 周六 20:00 —— 周日（第 7 周）没课，后天周一（第 8 周）有
  await at(2026, 10, 24, 20, 0, async () => {
    const out = (await tool('jsnu_next').execute(ctx)).content;
    assert.match(out, /后天第一节是《高等数学》/);
  });
});

test('jsnu_next：今天没课且后面都没课时说「接下来两周都没课」', async () => {
  const tool = await mount();
  // 第 17 周之后所有课都过期了（夹具里最长的周次是 16）
  await at(2026, 12, 28, 20, 0, async () => {
    const out = (await tool('jsnu_next').execute(ctx)).content;
    assert.match(out, /接下来两周都没课/);
  });
});
