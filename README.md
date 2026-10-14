# dsh-sticker-pack

给 DSH 用的表情包插件：订阅任意多个**远端 `pack.json` 素材源**（GitHub 仓库、CDN、
自己的服务器都行），把它们变成 agent 能用的图册，agent 在回复正文里直接把图贴出来
（`![sticker](C:\...\x.gif)`），不走微信、不发文件、不需要前端改动。

素材**只从配置的远端源来**：图片用到才下载，镜像到
`~/Pictures/dsh-sticker-pack/remotes/<源名>/`（**不放 `~/.dsh`**：GUI 拒绝渲染它自己配置目录里的
图片，只会显示「无法预览」），之后离线也能贴。谁都能给你加图——
往那个仓库里丢一张图、在清单里加一行，你这边什么都不用改。

配置怎么写见「配置」一节。

## v0.6.2 变更（2026-10-15）

- **熔断时间（等待上限）交给用户。** 之前写死的 15 秒现在由设置决定：DSH 设置面板的「表情包」
  一节与独立设置页 `/sticker-pack/settings.html` 都多了同一组控件——**5–30 秒滑杆**（默认 15 秒，
  另有 5/10/15/30 快捷键）+ **一个无上限的秒数输入框**（`min=1`、**没有 `max`**，填 90 就是 90 秒）。
  值存 `~/.dsh/sticker-pack/settings.json` 的 `deadlineMs`，**保存即生效，不用重启**。
  理由：这 15 秒是这台机器网络的属性，不是插件的属性——CDN 连不上的那台机器上，等多久合适只有用户知道。
- **取值规则**：正数即可，**无上限**；`0`/负数/非数字被拒（HTTP 400，文件不动），缺省回落到 15 秒。
  优先级 `settings.json` > profile 配置的 `deadlineMs` > 默认 `DEFAULT_DEADLINE_MS = 15000`
  （快照里同时给出 `deadlineSource` 与 `defaultDeadlineMs`）。
- **`GET` 也能写**：`/sticker-pack/settings?deadlineMs=90000` 与 `?probability=` 同级，可一起送
  （理由同下：万一插件路由只转发 GET/HEAD，设置页至少还能写）。
- 自检 **90 条断言全过**（v0.6.1 是 70），新增 20 条覆盖等待上限：默认值、字符串入参、
  **超过滑杆范围不被夹紧**（120000 ms 原样保留）、0/负数回落、GET 写、POST 写、非法值 400 且文件不动、
  设置页两处控件、客户端面板两处控件——其中面板那条断言的正是**数字框没有 `max`**，
  因为「无上限」本身就是需求。
- 仍未真机验证：面板控件只在桩 React 下渲染断言过，没有在真实 GUI 里点过；要等重启 dsh 后才算数。

## v0.6.1 变更（2026-10-15）

- **微信会话改成发文件，并且不再发动图。** v0.6.0 的做法是「让模型用 `send_to_wechat` 把图发出去」，
  实测仍然看不到：dsh-wechat-plugin 按**文件名**决定上传类型（它自己的 `lib/media-kind.js`：
  图片扩展名走图片消息，其余走普通文件），而**以图片消息发出去的那条在对方手机上不会出现** ——
  它只会在 `~/.dsh/wechat/boot.log` 留下一行 `outbound: shy.png ... (图片)`，然后手机上什么都没有。
  现在微信会话里 `sticker_pick` 会把选中的图**复制成一个 `.wechat` 结尾的副本**
  （`shy.png` → `shy.png.wechat`，放在素材缓存同级的 `wechat-out/`），通道于是按**文件**上传
  （日志里是 `(文件)`）；真扩展名留在中间，收件人看得出下载的到底是什么。
- **微信会话的候选池排除 gif。** 动图在那个通道同样是发出去不显示；池子里一张静态图都不剩时，
  才回退到全部候选（宁可有图可选，也不空手）。
- **`sticker_pick` 在微信会话里不返回 markdown**（返回空串 + 一句说明），模型手里没有可直接粘贴的
  链接，`send_to_wechat` 就成了唯一出路。
- **桌面会话一个字节没改**：同样的 `sticker_pick` 仍然返回 `![sticker](C:\...\x.jpg)`。
- 自检 **70 条断言全过**，新增 2 条覆盖「动图识别」与「`.wechat` 副本让通道按文件发送」。
- 仍需真机验证：这条链路我只在代码与日志层面确认过，没有真正发到手机上看过。

## v0.6.0 变更（2026-10-15）

- **出图形式不再需要手配端口。** 新增 `linkStyle`（默认 `auto`）：插件自己去问 web server
  要监听端口（`webServer.port`，`0` 端口由系统分配也能拿到），拿到就优先返回
  `http://127.0.0.1:<port>/sticker-pack/i/<id>` —— 这种形式**边写边出现**，不用等消息落定。
  拿不到端口（路由没起来、profile 里没有 web server）就退回本地路径，那条永远能用，只是
  慢一拍。`linkStyle: 'file'` 可以强制只用本地路径。
- **微信会话走另一条路。** dsh-wechat-plugin 把回复正文**原样当文本**发给微信，所以
  `![](C:\...\a.gif)` 到了手机上就是那串字符——手机读不到这台电脑的磁盘（`~/.dsh/wechat/boot.log`
  里能看到它作为 `outbound text` 发出）。插件现在把微信会话认出来（会话 `cwd` 落在
  `wechatChannel.workspace` 里），提示词与 `sticker_pick` 的返回值都会改说「用
  `send_to_wechat` 把这个文件发出去」。桌面会话的文案一个字没变。
- **GIF 出现得更勤。** `gifBias`（默认 2）：同分候选里动图的权重是静图的 2 倍。只影响
  同分随机那一层，指名 `id` 或 `tag` 时照旧。
- 工具入口的硬上限 **9 秒 → 15 秒**（当时叫 `TOOL_DEADLINE_MS`，现名 `DEFAULT_DEADLINE_MS`；
  v0.6.2 起这个数字只是**默认值**，真正的上限由设置里的「等待上限」决定）。

## v0.5.1 变更（2026-10-15）

- **网络再慢也拖不住回复。** 工具入口给整次远端同步加了 **9 秒硬上限**（当时叫 `TOOL_DEADLINE_MS`，v0.6.0 起放宽到 15 秒，
  v0.6.2 起改为用户可在设置里调的「等待上限」，默认仍是 15 秒，`lib/index.js`）：超时就用本机已有的镜像回答，并把原因写进 `notice`，而不是继续等。
- **失败熔断。** 某个源拉取失败后 **10 分钟内不再重试**（拉清单时的 `fresh` 强制刷新可绕过）；
  期间有镜像就沿用镜像。以前每一轮回复都会从头把超时和重试再付一遍。
- 默认单源超时 **15 秒 → 6 秒**，重试 **3 次 → 2 次**（`lib/remote.js` 的 `DEFAULT_TIMEOUT_MS`
  与 `DEFAULT_ATTEMPTS`）。
- 来历：别人装完出现「agent 一直在思考、不回复」。他那边连不上 CDN，每轮回复都在等约
  47 秒的超时与重试——v0.5.0 加默认远端源时没给这条路径设上限，是这次的锅。

## v0.5.0 变更（2026-10-14）

- **素材库只剩一个来源：远端。** v0.4.0 的「本地多文件夹 + 远端源」收敛成**纯远端**：
  `directory` / `directories` 配置项、桌面 `大肥鱼` 默认目录、`PACK` 种子图册全部删除，
  插件不再读任何手写的本地素材文件夹。理由：一套图册多人维护时，「谁手里那份才是新的」
  比多一个本地入口重要得多——仓库里的那份永远是对的。
- **`sticker_add` 工具删除。** 登记素材现在是**往仓库里写文件**：图片 + `pack.json` 一行，
  `git push`，别人拉到的就是同一份。`ctx.tools` 上只剩 `sticker_pick` 与 `sticker_catalog`。
- **缓存在 `~/Pictures/dsh-sticker-pack/`**，**不放 `~/.dsh`**（GUI 拒绝渲染它自己配置目录里的
  图片，贴出来只会显示「无法预览」）。每个源一个文件夹（`remotes/<源名>/`），里面有
  `pack.json`（清单）、`images.json`（每张图从哪来）、`source.json`（上次拉取时间）与
  **已经下载过的图片**。整个目录随时可删，下次用到会重新拉。
- **本地文件名由 id 派生，绝不用清单里写的文件名**：清单是不可信输入，`lib/remote.js`
  里有 id 正则、扩展名白名单、单清单 2 MiB / 单图 16 MiB / 最多 16 源 / 每源 2000 条的上限。
- 迁移：profile patch 里的 `directory` / `directories` 删掉，换成 `remotes`；
  旧 `settings.json` 里的未知键会被忽略，不用手改。

## 装给朋友用（v0.5.0）

插件就是磁盘上的一份目录，DSH 靠 profile 的 `package.json` 认它。四步：

**1. 把代码放到对方的机器上**，例如 `D:\Plugins\dsh-sticker-pack`（整个目录，含 `lib/`）。
没有 git 就直接发压缩包解压；图片不用跟着传，他会从你的仓库拉。

**2. 让 profile 认这个插件。** 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`：

```json
{
  "dependencies": {
    "dsh-sticker-pack": "link:D:/Plugins/dsh-sticker-pack"
  },
  "dsh": {
    "profile": {
      "bundles": ["……其它 bundles……", "dsh-sticker-pack"]
    }
  }
}
```

`link:` 后面是他机器上的实际路径（反斜杠写成 `/`，或用双反斜杠）。两处都要加：
`dependencies` 里声明、`bundles` 里装载，缺一个就是「装了但什么都没注册」。

**3. 装依赖并重启。** 在 profile 目录下跑一次 `pnpm install`，然后重启 DSH。
插件模块是进程启动时 import 的，不重启不生效。

**4. 告诉他素材库在哪儿。** 建 `%USERPROFILE%\.dsh\sticker-pack\settings.json`：

```json
{
  "probability": 0.6,
  "remotes": [
    {
      "url": "https://gcore.jsdelivr.net/gh/5V1A-afk/dsh-sticker-pack@main/dsh-sticker-pack/stickers/pack.json",
      "name": "大肥鱼"
    }
  ],
  "remoteTtlMs": 604800000
}
```

- 概率也能在 DSH 设置页里拉滑块改；`0` 和 `1` 两端是恒定指令，不破坏提示词缓存。
- **域名固定用 `gcore.jsdelivr.net`**：`cdn.` 与 `fastly.` 这两个节点在本机实测证书链不全，
  清单能取到、图片全失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。
- 图片缓存到 `%USERPROFILE%\Pictures\dsh-sticker-pack\`——**不要指向 `.dsh`**，
  GUI 不渲染它自己配置目录里的图片，贴出来只有「无法预览」。
- 想让别人也能给你加图，见「订阅别人的远端源」与「自己发布一个源」。

## v0.4.0 变更（2026-10-14）

- **贴图概率改由插件掷骰，不再是写给模型看的一句话**。v0.3.0 那段 system prompt 里写的是
  「有约 60% 的概率贴一张，随机决定即可」——掷骰的是模型，插件说什么都不算数。现在每轮
  由插件先掷一个骰子，再把**结果**当成硬指令写进那段文本：命中写「本轮要贴」，
  没命中写「本轮不贴」。模型只执行，不随机。`0%` 和 `100%` 两个端点直接退化成恒定文本。
- **代价写在明处**：那段文本每轮都会变，等于每轮让 system prompt 之后的前缀缓存失效。
  想要缓存稳定，就把概率设成 `0` 或 `1`（文本恒定），或者 `prompt: false` 关掉整段。
- **素材库支持多个本地文件夹**：`directories: [...]`。id 撞车时给后到的加文件夹名前缀，
  不再互相顶掉。
- **素材库支持远端源**：`remotes: [...]` 接受任何 HTTP(S) 上的 `pack.json`。图片**用到才下载**，
  镜像进 `~/Pictures/dsh-sticker-pack/remotes/<源名>/`；源连不上就继续用上次的镜像。
  别人要给你加图，只要往那个仓库里丢图片和 `pack.json`，你这边改一行配置。

## v0.3.0 变更（2026-10-14）

- 新增 `sticker_add` 工具 + `pack.json` 清单：加图/改标签不用再编辑 `library.js`、不用重启。
- `sticker_pick` 支持 `context`（按这条回复的语气/场景挑）与 `count`（多给几张候选）。
- 新增 system prompt 段落 `sticker-pack:usage`：贴图概率（默认 60%）、位置放回复末尾。
- 新增**设置页面**：DSH 设置面板里的一节「表情包」（靠新增的客户端半边 `client.js`），
  外加一个插件自带网页 `/sticker-pack/settings.html` 作回退；滑块改概率，保存即生效，不用重启；
  数据接口 `/sticker-pack/settings`（GET 读、POST 写），设置存 `~/.dsh/sticker-pack/settings.json`。
- 性能：单次 pick 7.48 ms → 0.22 ms，单次磁盘读取 18.13 MiB → 0 B（热），详见「性能」。
- 修掉一批只有自检才能发现的缺陷：缓存复用会让图册变空、清单写回丢字段、
  同一文件换 id 会留重复项、`sticker_add` 继承不到 `directory` 配置等。

## 它到底做了什么

回答正文里想让图片真的显示出来，条件很窄：markdown 图片的地址必须是**裸的绝对路径**
（如 `C:\dir\a.gif`）。写成 `file:`、`dsh-resource:`、`api/file?path=` 这些 URL 形式都会被
上游判掉，最后只剩一个点不开的链接。所以这个插件的核心职责就一件事：把「哪张图」
翻译成「那串刚好能被渲染的 markdown」。

- 素材库里的文件名是哈希串（`1791948782546.gif`），谁也记不住 → 仓库里的 `pack.json`
  给每张图配一个短 id 和含义标签，`pen`、`tea`、`glare` 这种名字才可用。
- agent 猜不出路径 → 工具直接把 markdown 原样返回，抄进回复即可。

## 工具

| 工具 | 作用 |
|---|---|
| `sticker_pick` | 挑一张图，返回可直接贴进回复的 markdown。参数：`context`（一句话说这条回复的语气/场景，**最准**）、`tag`（按含义挑，如 无语/害羞/生气/开心/盆/震惊/委屈）、`id`（精确指定）、`avoid`（本轮不想重复的 id）、`count`（要几张候选）。都不给就随机。 |
| `sticker_catalog` | 列出整个图册（id、标签、尺寸、含义），用于确认素材库里有什么。 |

两个工具注册在宿主半区的 `ctx.tools` 上；插件还会在 `ctx.webServer` 上挂这几条路由：

| 路由 | 作用 |
|---|---|
| `/sticker-pack/cat.json` | 图册的 JSON 视图（不暴露绝对路径） |
| `/sticker-pack/i/<id>` | 图片本体，带 ETag 与 `max-age` |
| `/sticker-pack/settings.html` | **设置页面**（见下）；`/sticker-pack/` 同页 |
| `/sticker-pack/settings` | 设置的读写接口（GET 读 / POST 写） |

路由是可选的：`webServer` 不存在或路径撞车时只记一条 warning，工具照常可用。

## 三件事，各由谁负责

需求是「按上下文挑图」「加素材要方便」「别把回复拖慢」「不用每条都贴」。这四条落在
三个不同的地方，搞混了就会做成没用的一半：

| 需求 | 落在哪 | 为什么不能换个地方 |
|---|---|---|
| 按上下文挑 | `sticker_pick` 的 `context` 参数 + `library.js` 的打分 | 打分是纯字符串匹配（含义/场景/标签/尺寸偏好），不看对话 |
| 加素材方便 | 远端源仓库 + `pack.json` 清单 | 图册硬编码在代码里改一次要重启，本地文件夹又只有你一个人能改 |
| 别拖慢回复 | 扫描缓存 + 尺寸缓存 + 内存版 ledger（见「性能」） | 原来的热路径每次砍 18.13 MiB 文件头 + 同步写盘 |
| 贴图频率 | **插件自己掷骰**，结果写进 system prompt 段落（见下） | 掷骰不能交给被掷的那一方：写在提示词里就等于模型自己决定 |

### system prompt 段落：把「掷骰」和「执行」分开

「这轮要不要贴」是个随机决定，而随机决定不该由被随机的那一方来做——v0.3.0 就是那样，
所以那 60% 说了等于没说。现在插件每轮先自己掷骰，再把**结果**当成硬指令写进
`ctx.systemPrompt` 的 `sticker-pack:usage` 段（`order: 9500`，第一方段落都远低于 9000）。

概率在 0 和 1 之间时，命中的那轮（默认 60%）是：

```
表情包（宿主判定，本轮要贴）：这条回复末尾务必贴一张。
要贴时先调 sticker_pick，context 写清这条回复在回应什么、什么语气（例：「他夸我了，不好意思」「又要重跑，摆烂」）。
把返回的 markdown 原样放进回复正文，位置放在整条回复的最后：本地路径的图要等消息落定才显示，放最后读者才不用等。
不要手写图片路径，不要连着两次贴同一张。
```

没命中的那轮只有一行：

```
表情包（宿主判定，本轮不贴）：这条回复不要贴表情包，也不要调用 sticker_pick。
```

文本是**函数**形式（`text: (context) => ...`），每次 assemble 现算，所以滑块一改，下一请求
就换措辞，不用重启。掷骰按「一个用户消息 = 一次」记账：同一轮里多次 assemble 拿到同一个
结果，`session/event` 的 `turn/start` 到了才重掷。subagent 的 prompt 里只会出现「本轮不贴」
——它们不直接回用户，省掉一次无用的工具调用和一张图。概率落在端点上时干脆不掷：
`0` 恒定「本轮不贴」，`1` 恒定「本轮要贴」。

代价与边界（都实测过）：

- 段落文本 **510 B（≈128 token）/ 请求**（命中版），每个 step 重新 assemble。
- **命中版和轮空版文本不同，于是每轮都会让 system prompt 之后的前缀缓存失效一次。**
  这就是「严格按概率」的价钱。想要缓存稳定就把概率设成 `0` 或 `1`（两版各自恒定），
  或者 `prompt: false` 关掉整段。真正省缓存的替代写法是把掷骰挪进 `sticker_pick` 内部、
  让模型每轮都调一次工具——那是拿一次多余的往返换缓存，本插件没选它。
- 注册是**全局**的，subagent 的 prompt 里也会有（一律显示「本轮不贴」）。
  只想要主 agent 就得注册到 `agent.ctx` 作用域——本插件没做这一步。
- 还有**第二道闸**：`sticker_pick` 会拿调用方（`exec.agent`）再问一次本轮的决定，问的是同一份
  记录。轮空的那一轮，模型就算调了工具也只会拿到「本轮不贴」，没有 markdown 可贴；
  subagent 一律按轮空处理。
- **贴图概率由插件掷骰，执行仍是模型的事**（见「已知边界」）：插件决定「该不该」，
  决定不了「模型听不听」。
- 不想要这段就配 `prompt: false`（工具描述里仍保留了完整用法）。
- 校验方式：`test/selftest.js` 直接调 `rollTurn` / `promptText`（两端点、命中、轮空四条路径），
  并用假 `ctx.inject` 记录注册到的 section 打印原文。

这一段还顺带把钱省回来了：工具描述从啰嗦版压到只讲用法，
每请求的模型可见文本 2684 B（v0.5.0 少了一个工具，只会更小）。

## 设置页面（v0.3.0 起）

有两种入口，改的是同一个 `settings.json`，任选一种：

**① DSH 设置面板里的原生一栏（首选）** —— 插件带了一个客户端半边 `client.js`，在宿主的
`settings.section` slot 里注册一节「表情包」，与内置设置项并列。两组控件：**贴图概率**
（滑块 + 0/30/60/100% 快捷键，松手即存）和**等待上限**（5–30 秒滑块 + 5/10/15/30 快捷键，
外加一个无上限的自定义秒数输入框，回车或失焦才写盘）。下面显示图册张数、几个远端源可用、
几张图是「用到才下载」。

**② 插件自带的独立网页（回退）** —— 地址就是它自己的路由（端口跟 dsh 的 Web GUI 一致）：

```
http://127.0.0.1:19387/sticker-pack/settings.html
```

页面上现在是两件事：**贴图概率**（0–100%，默认 60%）与**等待上限**（5–30 秒滑块 + 无上限的
自定义秒数输入框，v0.6.2 起）。滑块 + 快捷按钮，保存后立刻生效，并把新的措辞预览出来——命中的
那轮发什么、轮空的那轮发什么，以及 0% / 100% 各自恒定成哪一句。下面那张卡片显示当前取值
（概率与等待上限各自的来源）、远端源状态、图册里的 id 列表和设置文件路径。

| | |
|---|---|
| 读 | `GET /sticker-pack/settings` → `{ok, probability, source, defaultProbability, deadlineMs, deadlineSource, defaultDeadlineMs, file}` |
| 写 | `POST /sticker-pack/settings`，body `{"probability":0.85}` 或 `{"deadlineMs":90000}`（可同时送）；或 `GET /sticker-pack/settings?probability=0.85&deadlineMs=90000` |
| 存 | `~/.dsh/sticker-pack/settings.json` |
| 优先级 | `settings.json` > profile 的 `cordis.yml`/`cordis.patch.yml` 配置 > 默认（概率 0.6 / 等待上限 15000 ms） |

`GET ?probability=` 与 `GET ?deadlineMs=` 这两条回退路径是故意的：本进程看不到宿主的路由表，
万一插件路由只转发 GET/HEAD（`/api/*` 就是），设置页至少还能写。

要留意两点，都不算 bug 但得知道：

- 这些路由**不在 dsh 的 `/api` 认证栅栏内**（插件路由本来就在栅栏外），所以别把这个端口
  暴露到公网。风险面很小（只能改一个贴图概率），但确实没有鉴权。
- 换端口这个地址就变了。它不像正文里的图片路径那样有「本地路径」这种免配置形式。


### 客户端半边（`client.js`）：为什么能不加构建步骤

DSH 的客户端插件**不是 ES module，是一个脚本**：加载时调
`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于本包的 `name`，
`factory(require)` 返回 CJS 形式的三件事（这里就是 `apply` / `inject`）。宿主靠
`package.json` 的两处声明找到它：

```json
"exports": { "./client": "./client.js" },
"dsh": { "client": { "platform": "web" } }
```

`exports["./client"]` 缺了会在启动时**硬抛**（`declares dsh.client but exports no "./client" bundle`）；
`factory` 里 `require` 只能用平台 seed 词（本插件只用 `react`）或在 `dsh.client.external` 里声明过的包，
否则客户端会报 `require(...) missed the module table`。`apply` 里 `inject` **必须**声明用到的服务，
本插件是 `['slots']`——漏了会让这一行在 Cordis 里提前激活、`ctx.slots` 取不到、整条 entry 变 `failed`。

所以这个客户端半边是**手写产物**（12071 B，无 JSX、无 sourcemap、无打包器），改完文件即加载新内容；
本机也确实没有 esbuild/rollup/tsc（验证过：PATH 上一个都没有）。代价是这里没有 JSX/TS 的静态检查，
所以 `test/selftest.js` 会在一个假 `window` 里把 `client.js` 真跑一遍：
注册次数、id 是否等于包名、`inject` 是否含 `slots`、只 require 了 `react`、slot 规格是否合法、
组件在桩 React 下能不能渲染出元素。

#### 为什么没走 cordis 配置那条路（2026-10-14 的取舍）

宿主确实还有一条更「原生」的路：把概率放进插件自己的 cordis `Config` 并加 `.volatile()`，
客户端用 `ctx.configForms.get("<row-id>")` + `SettingsFormModel`/`settingsNumberField`/`SettingsValueField`
（`@deepseek-ai/dsh-client-ui-primitives`）画表单，值最终写进 profile 的 `cordis.patch.yml`
并由 `configEditor` 热生效。这条路的验收链更长、每一步都有新的失败面（volatile 标记、
`configForms` 服务、primitives 是否在客户端模块图内、row id / 包名 / client 模块 id 三对齐），
而收益主要是「值存进 profile patch」和「外观与内置设置项一致」。

本插件选了更小的一面：客户端只依赖 `slots`，值存在 `~/.dsh/sticker-pack/settings.json`，
面板读写的还是插件自己那两条 HTTP 路由。理由是这个面板坏掉时最多是「面板不可用」，
而 `settings.json` 用任意文本编辑器也能改、`GET ?probability=` 用浏览器也能写；
反过来，如果为了统一外观去接 volatile/form 那套，插件就从「只依赖 tools」变成
「依赖 tools + configForms + primitives」，出错时连贴图本身都可能一起 failed。

想换成原生那套的话，改动集中在：`lib/index.js` 的 Config 加 `.volatile()`、
`client.js` 的 `inject` 加 `configForms`、把 `Panel` 的 fetch 换成 `configForms` 表单。


## 图册

图册不是内置的：它等于**你订阅的每个远端源清单的并集**，再加上镜像目录里没登记过的图片
（自动 id `x01`、`x02`…，标签为空）。随时用 `sticker_catalog` 或 `/sticker-pack/cat.json`
看当前有什么、id 叫什么。

本机订阅的那份源里现在有这 10 张（换一份源就是另一套）：

| id | 图 | 适合 |
|---|---|---|
| `pen` | 头顶盆、草地摇头（动图，13.4 MB） | 摆烂、装死、无语 |
| `kettle` | 端盆撅嘴、委屈（动图，256 KB） | 委屈、抗议 |
| `bowl` | 女仆装室内站立（动图，4.4 MB） | 安静、待命 |
| `stand` | 全身女仆装站好（738 KB） | 正式、乖巧 |
| `glare` | 「瞪眼鱼」整张带字表情包 | 瞪人、不服 |
| `tea` | 喝茶＋「……」气泡 | 无语、沉默、看戏 |
| `wow` | 震惊气泡「!?」＋汗滴 | 震惊、疑惑 |
| `shy` | 低头脸红大头贴 | 害羞、被夸 |
| `fish` | 笑眯眯抱大肥鱼 | 开心、得意、交作业 |
| `angry` | 头顶青筋、抱臂 | 不满、傲娇 |

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-sticker-pack
  config:
    remotes:                                   # 远端 pack.json 源（可多个，最多 16 个）
      - https://gcore.jsdelivr.net/gh/you/stickers@main/pack.json   # 域见下
      - url: https://example.com/pack/pack.json
        name: 朋友的表情包
    remoteTtlMs: 600000                        # 清单复用窗口，0 = 每次用到都刷新
    remoteTimeoutMs: 6000                      # 单个源超时（默认 6 秒）
    linkStyle: auto                            # auto（默认）| http | file，见下
    gifBias: 2                                 # 动图在同分候选里的权重倍数，1 = 均匀
    largeFileBytes: 2097152                    # 超过这个大小就在工具输出里提醒“偏大”
    recentWindow: 3                            # 最近用过的几张排到后面，0 = 纯随机
    scanTtlMs: 1000                            # 目录扫描复用窗口，0 = 每次重扫
    probability: 0.6                           # 贴图概率，设置页可覆盖（0.6 = 60%）
    deadlineMs: 15000                          # 等待上限（v0.6.2），设置页可覆盖；正数即可，无上限
    prompt: true                               # false = 不注册那段贴图策略
    httpBaseUrl: http://127.0.0.1:19387        # 可选，见下
```

`remotes` 也可以直接写进 `~/.dsh/sticker-pack/settings.json`——设置页保存时会保留它不认识的
键，所以手编一个文件比改 profile 的 patch 层省事（同样，`remotes` 只在文件里没有这个键时
才读配置）。

`probability` 写在配置里就是「出厂值」：一旦设置页写过一次 `settings.json`，文件里的值
优先于配置，配置里的值只在文件里没有这个键时生效（删掉 `settings.json` 即回到配置值）。
`deadlineMs`（等待上限，v0.6.2）走同一条规则，所以「配置里写 20000、设置里改成 8 秒」
的结果是 8 秒；想让配置重新说了算，删掉 `settings.json` 里那一行即可。

### `linkStyle`：两种出图形式，各有取舍

| | 本地路径 | HTTP URL |
|---|---|---|
| 形态 | `![sticker](C:\...\x.jpg)` | `![sticker](http://127.0.0.1:19387/sticker-pack/i/x)` |
| 渲染时机 | **消息落定后**才出现 | 边写边出现 |
| 依赖端口 | 不依赖 | 端口变了就失效 |
| 依赖插件路由 | 不依赖 | 依赖 `/sticker-pack/i/<id>` 注册成功 |

`linkStyle` 选哪一种：

- `auto`（默认）—— **优先 HTTP**：先看 `httpBaseUrl` 有没有配，没配就用插件自己问到的
  监听端口。两者都拿不到就退回本地路径。
- `http` —— 同上；没有端口时也不会硬凑，仍然退回本地路径（没有第三种形式）。
- `file` —— 永远只用本地路径，即使端口已知。

以前这件事要你在 patch 里手写 `httpBaseUrl`（v0.3.0 起就有这个配置项），现在默认就会自己
找端口；`httpBaseUrl` 仍然优先，可以覆盖自动探测的结果。

原因（都已对着客户端源码确认）：本地路径图片被显式排除在流式渲染之外
（`const file = streaming ? void 0 : parseFileLink(destination)`），而正文里的绝对
`http(s)` URL 会直接进 `<img src>`。另外**根相对路径不行**：正文里写
`![](/sticker-pack/i/x)` 不会被当成请求打到本插件的路由，它会被当作本地文件路径
改写成 `<base>api/file?path=%2Fsticker-pack%2Fi%2Fx`。

## 加一张图（改仓库，不改这台机器）

1. 把图片（jpg / jpeg / png / gif / webp / bmp / avif）丢进仓库里放图的目录；
2. 在 `pack.json` 的 `stickers` 里加一行：

   ```json
   { "id": "bailan", "file": "images/bailan.gif", "label": "摆烂鱼", "tags": ["无语", "摆烂"], "when": "被安排了一堆活" }
   ```

3. `git push`。别人下次用到时会自动拉到——**不用碰配置、不用重启**。

`id` 只能用字母数字和 `_ $ . -`（1–32 字符），不合法的条目会被挡掉并在同步结果里说明；
`file` 相对 `pack.json` 自己的地址解析。没登记过的图片也会被自动收进来（id `x01`、`x02`…），
所以先丢图、后补清单不会漏。清单是唯一真相，本地不写任何东西。

## 素材库只有一个来源：远端（v0.5.0）

图册按 `remotes` 的书写顺序合并，**先到的先占 id**：后面撞上已用过的 id 时不是顶掉对方，
而是加上源名做前缀（`朋友的表情包-angry`），谁都不用改名。前缀会越缩越短，以保证作者给的 id
一个字符都不被截掉。

### 订阅别人的远端源

`remotes` 里每一项要么是直接指向 `pack.json` 的 HTTP(S) 地址，要么是 `{ url, name }`
（`name` 只影响镜像文件夹名和设置页上的显示）。清单格式就是本地 `pack.json` 的格式，
外加一个可选的 `url` 字段用于把图片放到别处（CDN）：

```json
{
  "name": "大肥鱼·联机版",
  "stickers": [
    { "id": "angry", "file": "4b5c4ff0155440dbcc6219faf1d39eb.jpg", "tags": ["不满"], "when": "被安排了活" },
    { "id": "cdn",   "url": "https://cdn.example.com/a.webp" }
  ]
}
```

- `file` 相对 `pack.json` 自己的地址解析，所以图片和清单一起丢进 GitHub 仓库（raw 链接）
  就能用；`url` 是绝对地址，图片不跟着仓库走。
- **图片用到才下载**：清单同步完，图册里就已经有这张图的名字和标签，但正文里那串地址
  必须是本地文件——所以只有它真的被挑中时才会拉下来，缓存进
  `~/Pictures/dsh-sticker-pack/remotes/<源名>/`。某次下载失败就换一张候选，并在工具输出里
  说明原因；没下载过的图在设置页算「用到时才下载」，不算丢失。
- **源挂了不清空图册**：同步失败继续用上一次的镜像（设置页显示「连不上，沿用上次」），
  只有连镜像都没有的源才真的什么都不贡献。
- **清单是不可信输入**：路径穿越的 id、非图片扩展名、重复 id 都会被挡掉并记在
  `skipped` 里；单个清单最多 2 MiB / 2000 条，单张图最多 16 MiB，最多 16 个源。

### 自己发布一个源

把图片和一份 `pack.json` 放进同一个仓库目录，push 到任何能直链的地方（GitHub + jsDelivr、
gist、静态站点），把那个 `pack.json` 的地址发给别人就行。不用另学格式——就是上面那份清单。

- **GitHub 用 jsDelivr 更稳，但域要挑**：`https://gcore.jsdelivr.net/gh/<user>/<repo>@main/pack.json`。
  `raw.githubusercontent.com` 在很多网络里连不上；注意 jsDelivr 对单文件有 20 MB 上限，
  较大的动图考虑压一下或改用 `url` 指到别处。
- **`cdn` / `fastly` 两个域取图可能握手失败**（2026-10-14 本机实测）：清单 `pack.json` 走
  `cdn.jsdelivr.net` 能 200，但同一域的**图片**请求，以及 `fastly.jsdelivr.net` 与
  `raw.githubusercontent.com` 的图片请求，都在 TLS 阶段抛
  `TypeError: fetch failed`（`cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE`，即证书链缺中间证书，
  Node 的 OpenSSL 不补链，而 PowerShell/.NET 会补所以看起来「网络是通的」）。
  症状是**清单同步成功、图全部下载失败**。`gcore.jsdelivr.net` 三个里只有它取图正常。
- **换图要能生效**：远端图缓存进本地后就不再校验，所以更新仓库里的图片时，**换个文件名**
  （或在 `pack.json` 里改 `file`）最省事；同名覆盖要等本地缓存被删掉才会看到。

## 性能（实测，2026-10-14，`test/perf-probe.js`）

| 指标 | v0.2.2 | v0.3.0 | 怎么做到的 |
|---|---|---|---|
| `sticker_pick` 单次调用（缓存热） | 7.48 ms | **0.22 ms** | 不再每次同步写 ledger |
| `sticker_pick` 单次调用（缓存冷，即新图刚进库） | — | 1.44 ms | 只读文件头 256 KB 而不是整图 |
| 单次 pick 的磁盘读取量 | 18.13 MiB | **0 B**（热）/ 1.14 MiB（冷，且只读文件头） | 扫描缓存 1 s TTL + 按 mtime 记忆尺寸 |
| 每请求模型可见文本 | 2819 B（~705 token） | **2684 B**（~671 token） | 精简工具描述，补偿了新增的策略段落 |
| 插件挂载 | — | 3.4 ms（一次） | 两条工具定义（+ 5 条路由注册） |

拆解（`perf-probe.js` 会打印）：热路径里 `loadLibrary` 0.09 ms + `pickSticker` 0.03 ms，
剩下的 7.4 ms 全是**每次 pick 同步写 `~/.dsh/sticker-pack/recent.json`**（写临时文件 +
`rename`）。ledger 只是「别连着贴同一张」的软提示，不值得让回复等它，所以改成
内存优先：内存里立刻生效，磁盘最多每 2 秒写一次，卸载时再补写一次。
崩溃最多丢最后 1 秒的「刚用过哪几张」——这个代价是刻意接受的。

## 自检

不需要起 harness：

```powershell
node test\selftest.js
node test\perf-probe.js "C:\some\folder"
```

`selftest.js` 先在一个临时目录里**搭一份远端源的镜像**（`pack.json` + `images.json` +
`source.json` + 几张 1×1 的图），再让插件只通过 `remotes` 去读它——所以自检不碰网络、
也不碰你机器上任何文件夹。它会打印：注册到的工具与路由、prompt 段落原文、扫描到的图册、
几张取图的 markdown、空目录/坏清单/未知 id 的降级行为、设置接口的读/写/越界拒绝（概率与等待上限
两套值都跑）、五条 HTTP
路由的状态码与 ETag/304 复用；另外**真起一个本地 HTTP 服务**走完「同步清单 → 落成镜像目录 →
懒下载图片 → 变回可用 → 关掉服务后沿用缓存」整条链路，最后把 `client.js` 放进假 `window`
里真跑一遍（见「客户端半边」）。

**全过则 exit 0，任一失败 exit 1**（条数看输出里 `ok` 行的数量）。断言失败会打印 `FAIL`
行与实测值——这一条是被咬过才加的：早先的版本只 `console.log`、从不失败，路由取错都能一路绿灯。

自检会把插件的运行期状态目录（`boot.log` / `recent.json` / `settings.json`）重定向到临时
目录（环境变量 `DSH_STICKER_PACK_HOME`），所以跑自检不会动正在运行的 dsh 的设置。

`perf-probe.js` 会打印：挂载耗时、热/冷两种 pick 的均值与 p95、真实磁盘读取量、以及每请求的
模型可见文本体积（两个工具 + 策略段落）。给它一个目录参数就统计那个目录，不给就用一个空目录
——数字说的是加载器本身，不是素材库从哪来。


## 最大的坑：服务必须写进 `inject`，否则插件「装载成功但什么都没注册」

第一版这个插件在宿主里完全看不见：工具没有、路由 404、日志里也没有任何报错。原因是
cordis 的上下文是个 Proxy，**只有插件在 `inject` 里声明过的服务，属性读取才会解析**，
否则 `ctx.tools` 不是 `undefined`，而是直接抛：

```
cannot get property "tools" without inject
```

（`@deepseek-ai/cordis` 的 `lib/index.js` 里这个字符串就是判据。）于是 `apply` 一进门
就撞异常，被 cordis 收走；插件行本身是合法的，于是「加载成功」和「一片空白」同时成立。

两条规则：

- **要用的服务，写进 `inject`**：`const inject = ['tools']` 并导出。声明过的服务若缺失，
  插件会停在 pending，而不是带着空 ctx 跑起来——这正是我们要的。
- **可选服务别写进 `inject`，用 `ctx.get(name)` 取**：`ctx.get` 绕过 inject 门槛，直接读
  服务表。`webServer` 就这么取的——没有 web server 的 profile 不该让整个插件 pending。

另外，`ctx.get('x')` 与 `ctx['x']` **不能写在同一个 `try` 里**：`ctx['x']` 抛出时若直接
`return undefined`，就会把一个活着的服务报成不存在（这正是本插件路由一度消失的原因）。
两次读取各自独立兜底，属性读取失败再落到 `ctx.get`。

## 第二个坑：装载顺序是竞态，路由要等 `webServer` 出现

即使写对了 `inject`，路由仍然全是 404 —— 而且 `apply` 里读到的 `webServer` 是
`undefined`，尽管服务器明明在监听端口。真实的启动日志：

```
apply entered — tools=object webServer=undefined keys=[fiber]
tool sticker_catalog: registered
tool sticker_pick: registered
apply finished
routes /sticker-pack/cat.json + /sticker-pack/i: registered   ← 391 ms 之后
```

原因有两层：

- `webserver` 那一行是 `@deepseek-ai/dsh-web-app` 贡献的，而这个 bundle 就排在
  `dsh-sticker-pack` **前面一位**；cordis 是**异步**逐行挂载的，所以 `apply` 完全可能
  跑在 web server 的 fiber 变成 ACTIVE 之前。
- `ctx.get(name)` 的 `strict` 默认是 `true`，只回答「提供者 fiber 已经 ACTIVE」的服务。
  没竞争到就是 `undefined`，不抛错、不留痕。

修法是 cordis 自己的运行时注入：**`ctx.inject(['webServer'], (inner) => { … })`** ——
回调在服务可用时才跑，提供者被替换时会先卸载再重跑。重跑意味着上一次注册的路由必须
先撤掉，否则会撞 web server 的 `duplicate exact route` 报错；这里用 `inner.effect()`
把 `register` 返回的 disposer 交给 fiber，随之卸载。

顺带一提：**同一个竞态在真实 desktop profile 里照样存在**（bundles 顺序同样是
dsh-base → dsh-web-app → dsh-sticker-pack），所以这不是探测环境的特例。

## 已知边界

- **素材只从远端源来（v0.5.0）**：没有 `directory` / `directories`，没有默认文件夹，也没有
  `sticker_add`。加图 = 改仓库里的 `pack.json` 并 push（见「加一张图」）。本机只留镜像缓存，
  删掉它会重新拉。
- **远端图按文件名缓存**：图片一旦下载就留在镜像目录里，内容变了而名字没变就不会重新下载——
  更新素材时请**换文件名**，或在清单里改 `file`。
- **桌面会话靠客户端渲染 markdown 图片的那条路径**；微信会话不走这条路，见下面两条。
- **裸路径形式的图只在消息落定后显示**（流式期间被显式跳过）。v0.6.0 起默认自己找端口、
  优先用 HTTP 形式（`linkStyle: auto`），所以默认就是边写边看见。贴图仍放回复末尾最自然。
- **微信会话贴的是文件，不是图片**（v0.6.1）：dsh-wechat-plugin 把回复原样当文本发给微信，
  `![](C:\...\x.gif)` 到了手机上只是那串字符；而**以图片消息发出去的附件在那边根本不出现**
  （它的 `boot.log` 只留下 `(图片)` 一行，手机上什么都没有）。所以微信会话里 `sticker_pick`
  会返回一个 `*.wechat` 副本的路径、并且**不返回 markdown**，逼模型走 `send_to_wechat`；
  动图也一并排除在候选池外。这套仍依赖**模型照做**——它要是照旧把路径贴进正文，微信端依旧
  什么都不显示。另外判定依据是会话 `cwd === wechatChannel.workspace`，那个插件换了
  workspace 位置就得同步。
- **`linkStyle: auto` 依赖 `webServer.port`**：路由没注册成功、或 profile 里没有 web server
  时自动退回本地路径；`httpBaseUrl` 配了就以它为准。
- **单个文件上限 20 MiB**：`/api/file` 的上限来自 `ctx.attachments.imageLimits.maxImageBytes`
  （默认 20971520），超了返回 413。库里最大的 `pen` 是 13.4 MB，在限内。
- **图片是块级元素**：单独一段 = 独占一行、最宽 100%；外面会自动套一个点击放大按钮
  （缩略图 ≤640×360）。markdown 层没有尺寸/居中/透明度的控制手段。
- **`/sticker-pack/*` 不在 `/api` 认证栅栏后**：这个路由走 `webServer`，不校验凭据
  （webServer 默认只绑 127.0.0.1）。它只按 id 回图片、不回目录、不回绝对路径；但
  `/sticker-pack/settings` 是**可写**的（改贴图概率），`/sticker-pack/settings.html` 也是
  无认证的同源页面——所以别把 webServer 绑到 `0.0.0.0`，也别把端口映射到公网。
- **动图偏大**：`pen` 13.4 MB、`bowl` 4.4 MB，加载慢。`sticker_pick` 会对超过
  `largeFileBytes` 的图在输出里提醒。
- **宿主半区 + 一个很小的客户端半区**：`lib/index.js` 是宿主插件；`client.js`（12071 B，手写、
  无构建）只在 DSH 设置面板里加一节「表情包」。客户端**无法替换 markdown 图片渲染器**
  （`MarkdownText` 没有 components/renderers 钩子），所以“喂什么 URL”仍是唯一的控制点。
  已核对 `@deepseek-ai/dsh-client-ui-primitives` / `-chat` 的导出表：`MarkdownText` 是导出的，
  但那是最外层组件，没有注入图片渲染器的入口（客户端插件能挂的 UI 扩展点是 slots，不是渲染器）。
- **贴图概率由插件掷骰，执行仍是模型的事**：插件决定「这轮该不该贴」并写成硬指令，但既
  拦不住模型不听话，也看不到对话、没法在事后补一张。要更强的保证就得改写 `llm/stream`
  的输出流去注入或剥离图片 markdown——本插件没做，那会绕过模型的正常排版。
- **`recentWindow` 只影响顺序**：用过的图排在后面（打分相同才轮到它），不是禁用；
  真的不想重复就显式传 `avoid`。
- **运行时验证状况**（分清楚哪些是真跑过、哪些只是离线自检）：
  - v0.6.2（等待上限交给用户）：自检 **90 条断言全过**，新增 20 条覆盖等待上限（默认值、字符串入参、
    超过滑杆范围不被夹紧、0/负数回落、GET 写、POST 写、非法值 400 且文件不动、设置页两处控件、
    客户端面板两处控件）。**尚未真机验证**：面板与设置页的控件都只在离线自检里断言过，
    没有在真实 GUI 里点过；`GET ?deadlineMs=` 这条回退路径也还没有被真实宿主路由转发过一次。
  - v0.6.1（微信改发文件 / 排除动图）：自检 **70 条断言全过**，新增 2 条覆盖「动图识别」与
    「`.wechat` 副本的文件名让通道按文件发送」。**2026-10-15 已在真机验证**：微信会话里贴图能
    正常收到，说明「按文件上传」这条路成立。
  - v0.6.0（`linkStyle` / 微信会话 / `gifBias`）：自检 68 条断言全过，新增 7 条覆盖「微信会话被
    要求用 send_to_wechat」「桌面文案一字未改」「三种会话判定（微信 / 桌面 / 没有该通道）」与
    「动图加权约 2 倍、不加权时仍是均匀」。其中 **`linkStyle: auto` 已在真机上确认生效**：
    `sticker_pick` 返回的是 `http://127.0.0.1:19387/sticker-pack/i/<id>`，端口是插件自己拿到的。
    微信实际出图由 v0.6.1 那条覆盖（v0.6.0 的纯 `send_to_wechat` 话术不够，图片消息发不出）。
  - v0.5.0（纯远端：本地文件夹与 `sticker_add` 已删）：`test/selftest.js` 全过——自检自己搭一份
    远端镜像喂给插件，覆盖多源解析与去重、清单消毒（路径穿越 id / 非图片扩展名 / 重复 id）、
    懒下载、TTL 复用、源 404 不抛错、源消失后沿用旧镜像、镜像目录里的 pending 条目，
    以及 id 撞车后的前缀去重。
  - v0.4.0（宿主掷骰）：`rollTurn` 的同轮稳定与 `turn/start` 重掷、子 agent 判定、四版提示词
    文本、两个端点恒定，都在自检里按断言跑过。
  - v0.5.0 的远端链路已在 2026-10-14 用**真的 GitHub 仓库**跑通：仓库
    `5V1A-afk/dsh-sticker-pack`（Public）的 `pack.json` 经
    `https://gcore.jsdelivr.net/gh/5V1A-afk/dsh-sticker-pack@main/dsh-sticker-pack/stickers/pack.json`
    同步回 `status=ok count=10`，10 张图（共 18.13 MiB）全部下载成功、失败 0。跑的是
    `remote.syncRemotes` + `remote.ensureFile` 本身，不是模拟。
  - **v0.5.0 还没在真实 DSH 进程里加载过**：`apply()` 的接线（`session/event` 收 `turn/start`、
    `ctx.inject` 的注册顺序、`text(context)` 真能拿到 `context.scope`）都只在假 ctx 上验证过。
    插件模块是进程启动时 import 的，改宿主半区必须重启 dsh 才生效。
  - v0.2.2 的工具注册与两条路由：曾在一个**完全隔离的 `DSH_HOME`** 里端到端跑通
    （新建 `stickerprobe` profile，bundles 取 web 模板 + 本插件，`--port 19477`）：
    `/sticker-pack/cat.json` → 200 JSON（10 张）、`/sticker-pack/i/glare` → 200 `image/jpeg`
    31288 B、`/sticker-pack/i/pen` → 200 `image/gif` 13439320 B、未知 id → 404、`/` → 401。
    那次用的 profile 已经删了，本机现在**没有**可直接复用的隔离 home（`dsh-probe` 里那份
    `_probe` profile 没有 `node_modules`，也没有 `dsh` 命令行入口），所以这一条**无法按需重跑**。
  - v0.3.0 新增的 `/sticker-pack/settings`、`settings.html`、`/sticker-pack/` 与那段 system
    prompt 段落：**只在离线自检里验证过**（`test/selftest.js` 32 条断言全过，含 GET 读、GET
    `?probability=` 写、POST 写、非法值 400、超 16 KiB 413、页面 7689 B 完整送达、段落文本跟着概率变；
    那时的页面大小已作废——见 v0.6.2 那条的 90 条断言）。
    真宿主里的表现要等下一次启动 dsh 才能在 `boot.log` 里看到。
  - 客户端半边 `client.js`：**没在真浏览器里看过**。离线自检把它放进假 `window`、用桩 React
    跑通了「注册 → apply → 渲染出一棵元素树」，但「DSH 设置里真的多出一节、点了真的存上」
    属于**未验证**，需要重启后在 GUI 里亲眼确认。它靠的契约（`settings.section` slot、
    `inject=['slots']`、id 等于包名、`exports["./client"]`）都对着 wechat 插件的真实产物核过。
  - 正文内联贴图：**已在 Web GUI 里由用户逐项确认**——静态图、动图（`kettle` 256 KB）、
    大动图（`pen` 12.8 MiB）都能显示、能动，README 早期版本里「还没眼睛看过」这一条已作废。
