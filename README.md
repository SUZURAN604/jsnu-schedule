# 课表（江师大）

江苏师范大学教务管理系统（强智科技 jsxsd）的课表查询技能：查今天/本周/下一节课，并在上课前主动提醒。

这个仓库只包含一个技能（Skill），不含任何真实的学生信息、课表或凭据。`tests/fixtures/`
里的课程、教师、教室、学号全是编的。

## 它做什么

| 工具 | 什么时候用 | 说什么 |
| --- | --- | --- |
| `jsnu_today` | 主人问「今天有课吗」 | 今天几节课、几点、哪间教室 |
| `jsnu_week` | 主人问「这周课表」「明天上什么」 | 周一到周日按天列 |
| `jsnu_next` | 主人问「下节课是什么」「几点上课」 | 最近一节还没上的课 + 还有几分钟 |
| `jsnu_refresh` | 课表不对、查询报错 | 强制重新登录并抓一次，报告解析结果 |

外加一个定时器：每 60 秒检查一次，在每节课开始前 `advanceMinutes`（默认 30）分钟推一条
QQ 消息。提醒只在 6:00–23:00 之间发；夜里不查也不推，但如果启动时本地还没有课表缓存，
会补抓一次，免得半夜重启过的机器人第一次被问到时现登录。

## 安装

这是一个 **QQ Agent 风格的技能包**：一个目录 + 一份 `skill.json` + 一个 `index.js`。

```bash
git clone <this-repo>
cp -r jsnu-schedule/skills/jsnu-schedule "<QQ Agent 安装目录>/resources/app/skills/"
```

然后重启宿主，在「设置 → 技能 → 课表（江师大）」里填：

- **学号 / 密码** —— 教务系统账号。只写进本机 `data/jsnu-schedule/`，不进聊天记录。
- **开学第一周的周一**（可选，`2026-09-07` 这种格式）—— 填了才能按周次过滤（单双周、前后八周）。
  不填就把所有周次的课都算上。
- **提醒推送到**（可选）—— 会话 key，私聊 `private:<QQ号>`，群聊 `group:<群号>`。
  留空就只做被动查询、不推送。

> 只想自己写个脚本调用、不装宿主的话，`index.js` 也能单独 import 进来跑（见下面的「离线测试」）。
> 状态目录会走 `QQ_AGENT_DATA_DIR`，或者退回 `./data`。

## 配置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 关掉后模型看不到工具，也不再推送 |
| `studentId` | string | `""` | 学号 |
| `password` | string | `""` | 密码（`secret`，界面上打码） |
| `baseUrl` | string | `http://jsnujw.jsnu.edu.cn` | 教务系统地址 |
| `casUrl` | string | `https://sid.jsnu.edu.cn` | 统一身份认证地址 |
| `advanceMinutes` | number | `30` | 提前多少分钟提醒，钳在 0~180 |
| `termStart` | string | `""` | 开学第一周的周一，`YYYY-MM-DD` |
| `pushEnabled` | boolean | `true` | 是否主动提醒 |
| `pushTarget` | string | `""` | 提醒发到哪个会话 |

## 它是怎么工作的

登录这条路是这个技能里最麻烦的部分，因为它要横跨两个站：

```
sid.jsnu.edu.cn (统一身份认证 CAS)  ──ticket──▶  jsnujw.jsnu.edu.cn (教务 jsxsd)
```

1. **先敲一下教务首页**。不先访问一次，`bzb_njw` / `SERVERID` 这两个 cookie 不会被种下，
   后面带着 ticket 跳回来会丢会话。
2. **取统一认证登录页**，从里面读出 `login-croypto`（base64 的 AES-128 密钥）和
   `login-page-flowkey`（execution 值）。这两个都是页面里的纯文本节点，不是 input 的 value。
3. **密码加密提交**：`AES-128-ECB`，无 IV、无前缀。验证码页存在但不校验，传空串。
   （Wisedu 那套 CBC + 随机前缀在这里是错的，会稳定返回 401。）
4. **逐跳手动跟随重定向**。`fetch` 自动跟随会因为 cookie 还没落到自己的 jar 里而反复回到
   登录页，所以每一跳都手动取 `location` 再发下一跳，最多 10 跳。
5. **登录那次顺带抓到的课表页直接用掉**。教务会话大概只经得起 2~3 次已认证请求，之后会
   退化成 200 字节残页或登录页 —— 登录流程里最后那次 GET 往往是整次会话里唯一一份好页面，
   丢掉再打一次大概率就没了。

`cookieJar` 按 host 分开存。合成一个 jar 会互相覆盖：CAS 的 `SESSION` 会把教务的 `bzb_njw`
顶掉，最后一跳又被打回登录页。

课表页解析的几个坑（都在代码注释里标了）：

- 真课表在 `id="timetable"` 那张表里，同页还有 `dataTables`（课程清单）和 `dataTables2`（实践课），
  不切开就会把「课程名称 / 授课教师」这些表头当成课。
- 每个课程单元格里有隐藏的 `kbcontent1`（简版）和可见的 `kbcontent`（详版），两份都解析会让
  每门课变成两条，所以先把 `kbcontent1` 整段剪掉。
- 详版里每行是 `<font title='教师'>` 这种带标题的写法，按标题取值比按位置取值稳 ——
  有的课没有教师行，按位置会把周次当成教师。
- 跨两行的课（`rowspan=2`）会在两行各出现一次，用 `名称|星期|节次|教室|教师|周次` 去重。
- 教务偶尔回 200 + 只有 `<head>` 的残页（实测 231 字节），标题还写着「学期理论课表」。
  所以「是不是课表页」的判据是**页面里真的带课表表格**，而不是「不是登录页」。

## 教学作息时间表

代码里写死了教务处《教学作息时间表》（2026-2027 学年）的 12 个小节，5 个大节：

| 大节 | 小节 | 时间 |
| --- | --- | --- |
| 一 | 1 | 08:00–08:40 |
| 一 | 2 | 08:45–09:25 |
| 二 | 3 | 09:45–10:25 |
| 二 | 4 | 10:30–11:10 |
| 二 | 5 | 11:15–11:55 |
| 三 | 6 | 14:00–14:40 |
| 三 | 7 | 14:45–15:25 |
| 四 | 8 | 15:45–16:25 |
| 四 | 9 | 16:30–17:10 |
| 五 | 10 | 18:30–19:10 |
| 五 | 11 | 19:15–19:55 |
| 五 | 12 | 20:00–20:40 |

学校改作息的话，改 `skills/jsnu-schedule/index.js` 顶部的 `SLOTS` 就行。

## 离线测试

不联网、不需要账号，用两份假页面跑纯函数和登录链路：

```bash
node tests/parser.test.js     # 直接跑，任何环境都行
npm test                      # 同上，走 node --test
```

26 个用例，覆盖：页面判据、课表解析（含重复单元格、单双周、跨行去重）、周次计算、
选课过滤、到点提醒的时间窗口与去重 key，以及一条用假 `fetch` 走完的统一认证登录链路
（顺带断言密码不是明文提交）。

CI 在 Node 18 / 20 / 22 上跑同一套用例（`.github/workflows/test.yml`）。

## 隐私

这个仓库刻意不含：

- 任何真实学号、密码、cookie、会话
- 任何真实课表、课程名、教师名、教室号
- 任何 QQ 号、群号、推送目标

`skill.json` 里 `studentId` / `password` / `pushTarget` 的默认值都是空字符串，
`enabledByDefault` 也是 `false` —— 装上去不会自己跑起来，得先填账号。
运行时状态（`session.json` / `timetable.json` / `runtime.json`）只写在本机 `data/jsnu-schedule/`，
`.gitignore` 已经把 `data/` 和这些文件挡掉了。

如果你 fork 之后要提交自己的改动，提交前建议跑一遍：

```bash
git diff --cached | grep -nE '[0-9]{8,}|password|SESSION|ticket=' || echo clean
```

## 已知限制

- **`advanceMinutes = 0` 不会触发提醒。** `dueReminders()` 的条件是
  `nowMin >= startMin || nowMin < startMin - advance` 就跳过；advance 为 0 时两个条件互斥，
  永远命中跳过。当前实现保持原样（测试里记录的是真实行为），想要「正好到点提醒」需要改这个判断。
- **单双周只在周次文本里带「单/双」时才生效**，教务系统某些页面的写法认不出来。
- **周次依赖 `termStart`**。不填就没有「当前第几周」，所有周次的课都会算进来。
- **会话只能撑 2~3 次请求**，所以缓存了 6 小时，`jsnu_refresh` 是唯一的强制刷新入口。
- **强智科技改版会让解析失效**。解析失败时原始 HTML 会存到 `data/jsnu-schedule/last-kb.html`，
  对着它改 `parseTimetable()`。
- 只针对江苏师范大学这一套（统一认证 + jsxsd）。别的学校改 `baseUrl` / `casUrl` 不一定能用。

## 许可

MIT，见 [LICENSE](LICENSE)。
