# YouTube 字幕翻译 · Loon 插件

在 Loon 代理层直接拦住 YouTube 的字幕接口，把每条字幕用**你自己配置的翻译 API**翻成目标语言再塞回去。
YouTube App 完全无感：不用装第三方 App、不用改播放器，只要打开 CC 字幕，看到的就是译好的字幕。

```
YouTube-Subtitle-Translate.plugin      # 插件本体（参数 + 脚本挂载 + MITM）
YouTube-Subtitle-Translate.legacy.plugin  # 同上，仅给 Loon < 3.5.1(983) 的旧语法兼容版
scripts/yt-subtitle-translate.js       # 主脚本：解析字幕 → 调翻译 API → 回写字幕
scripts/yt-subtitle-config.js          # 配置助手：把 key/后端写进本地持久化配置
test/run.js                            # 本地自测（Node，模拟 Loon 运行时）
```

---

## 一、它拦了什么

| 接口 | 作用 | 处理方式 |
| --- | --- | --- |
| `www.youtube.com/api/timedtext` | 字幕文本本体 | 解析 `json3` / `srv3` / `vtt` / `ttml`，逐条翻译后原样回写，时间轴一字不动 |
| `youtubei/v1/get_transcript` | 新版转录面板 | 遍历 JSON 找到 `transcriptSegmentRenderer` 并翻译 |
| `youtubei/v1/player` | 播放器初始化 | ① 把 `captionTracks[].baseUrl` 的 `fmt` 改写成 `json3`，保证字幕是**可解析的文本**而不是 protobuf；② `字幕方式=google` 时再追加 `tlang=目标语言`，让 **YouTube 服务端自己翻译** |

译文回写只做两件事：**替换文本、保留结构**。因此「字幕对不上画面」「字幕消失」这类问题的根源基本都能排除在插件之外。

---

## 二、安装

### 0. 一条链接装完（推荐）

Loon →「插件」→ 右上角 `+` →「从 URL 安装」：

```
https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22.16/YouTube-Subtitle-Translate.plugin
```

或者直接在 Safari 打开：

```
loon://import?plugin=https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22.16/YouTube-Subtitle-Translate.plugin
```

> 上面是**固定版本**链接（`v2026.11.22.13`），装到的就是这个版本，raw 立刻生效。
> 想自动跟随最新提交，把路径里的 `v2026.11.22.13` 换成 `main`；但 GitHub raw 有约 5 分钟 CDN 缓存，
> 而且**移动同名 tag 后旧缓存还在**（同一个 tag 名会继续返回旧内容），所以每次发版都换一个新 tag。
> 刚推上去的一两分钟内可能会拿到旧文件，遇到「更新完还是老样子」等几分钟再更新一次即可。

装完填 `api_key`，再按下面第 3 步装证书即可。

> **国内网络提示**：插件里的脚本地址是 GitHub raw，连不上 raw 的环境（脚本拉不下来＝完全没反应）请改装
> `YouTube-Subtitle-Translate.cdn.plugin`，它只有脚本地址不同，走 jsDelivr CDN：
> `loon://import?plugin=https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22.16/YouTube-Subtitle-Translate.cdn.plugin`

> **版本要求**：主插件用 Loon 3.5.1 (983) 起的新版 Script 语法（`script("...", {${参数}})`），
> 参数表单、类型校验都靠它。如果你的 Loon 低于 983，改装
> `YouTube-Subtitle-Translate.legacy.plugin`（旧的 `script-path=` 写法，参数表单一样能编辑，只是数字都按字符串传）。

### 5. 确认真的在跑

装完不是"就完事了"，下面三件事同时为真才会生效，缺任何一项的表现都是**装了没反应**：

| 必查项 | 在哪看 |
| --- | --- |
| 插件开关是绿的 | Loon →「插件」→ 列表里 `YouTube 字幕翻译` 右侧开关 |
| 全局代理是开的 | Loon 首页那个大开关（关成直连时脚本不会执行） |
| MITM 开着且证书完全信任 | Loon →「设置」→「MitM」；iOS →「设置 → 通用 → 关于本机 → 证书信任设置」 |

再看 MITM 的主机名列表里是否有这四条（插件会自动加）：

```
www.youtube.com, m.youtube.com, youtubei.googleapis.com, music.youtube.com
```

验证方式：把参数里的 `debug` 打开 → 去 Loon 的「日志」页搜 `YT字幕`，出现 `已改写，长度 …` 说明脚本命中了；
同时视频里打开 CC，字幕应变成目标语言。调试完记得把 `debug` 关掉。

播放侧还有两个前提：视频得**有字幕轨**（人工或自动生成都行），并且在播放器里**选中那条字幕**——
没开 CC 时客户端根本不请求 `timedtext`，脚本没有可以改写的东西。

排错优先级最高的三条：

1. **QUIC/HTTP3**：YouTube 用 HTTP/3 时 Loon 看不到明文。在规则里加一条挡掉 UDP，或直接在 Loon 设置里关掉 QUIC；
2. **规则走了直连**：YouTube 命中直连规则时请求不经代理，脚本不执行；
3. **App 内缓存**：刚改完参数后把 YouTube App 从后台划掉重开，否则播放器还拿着旧的字幕地址。

本地开发才需要下面的放文件方式。

### 1. 放文件

把整个目录拷到 Loon 的插件目录（沙盒 App 内 `Documents/Plugins/`），保持 `scripts/` 与之同级：

```
Plugins/
├── YouTube-Subtitle-Translate.plugin
└── scripts/
    ├── yt-subtitle-translate.js
    └── yt-subtitle-config.js
```

本地开发：把三条 `script("https://raw.githubusercontent.com/.../yt-subtitle-translate.js"...)` 里的
整条 raw 链接换成相对路径 `scripts/yt-subtitle-translate.js`，就能直接改本地文件调试。

### 2. 打开插件

Loon →「插件」→ 找到 `YouTube 字幕翻译` → 打开。

如果要分享给别的设备，用「插件 → 添加 → 从 URL 安装」。

### 3. 装证书（必须有）

MITM 才能看明文，否则脚本永远不会触发：

1. Loon →「设置」→「MitM」→ 生成/安装证书 → 去 iOS「设置 → 已下载描述文件」安装；
2. iOS「设置 → 通用 → 关于本机 → 证书信任设置」→ 打开 Loon 的完全信任；
3. 回到 Loon，确认 MITM 开关是开的。

插件已经写好 `[MITM] hostname`：

```
www.youtube.com, m.youtube.com, youtubei.googleapis.com, music.youtube.com
```

### 4. 填参数

Loon →「插件」→「YouTube 字幕翻译」→ 点进详情页，**参数区是一张可编辑的表单**（下拉 / 输入框 / 开关，共 17 项），
至少填 `api_key`，按需改 `api_model` / `target_lang`；改完点保存即生效，不用重装插件。

表单来自插件里的 `[Argument]` 段：每项声明成
`参数名 = 控件类型,默认值,type=值类型,tag=界面标题,desc=说明`，再在 `[Script]` 的
`script("...", {${参数名}, ...})` 里列出要传给脚本的参数名，脚本侧就拿到 `$argument` 对象。
**两处都写才会出现输入框**——只写 `[Argument]` 不写 `argument` 清单，Loon 不会渲染表单，这也是旧版插件「没有编辑选项」的典型原因。

---

### 怎么确认自己装的是哪一版

插件详情页最上面那栏 **「关于/版本」** 就写着当前版本号（例如 `v2026.11.22.14 · 当前版本`）——
这是插件参数表里的一项，不参与翻译逻辑，纯粹给你核对用。

另外每条通知的中间那行也会带版本号：

```
YT字幕 · 已翻译
43/43 条
v2026.11.22.14 · openai · 2130ms
```

两处都对得上，才算真的更新成功了（Loon 会缓存插件文件，只改参数不重装是没用的）。

## 三、参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `openai` | `openai` / `deepl` / `gemini` / `google` / `custom` |
| `api_base_url` | DeepSeek | 请求地址，默认 `https://api.deepseek.com/chat/completions`，见下方各家示例 |
| `api_key` | 空 | 翻译服务的 key；`google` 不需要 |
| `api_model` | `deepseek-flash` | 模型名，见「换哪个模型」；`deepl` / `google` 忽略 |
| `target_lang` | `zh-CN` | 目标语言，`zh-CN` / `zh-TW` / `ja` / `en` … |
| `subtitle_mode` | `menu` | `menu` = 解锁播放器「自动翻译」全语言，挑一次就记住（**推荐、最稳**）；`google` = 自动给字幕地址加 `tlang`，秒出但部分视频会被 YouTube 拒；`llm` = 用你自己配的模型逐条翻（质量最好，但有往返延迟） |
| `bilingual` | `false` | 双语字幕：每条显示两行，上一行原文、下一行译文 |
| `source_lang` | `auto` | 源语言；`auto` 交给模型判断 |
| `cues_per_request` | `50` | 一次请求最多翻多少条字幕。别调太小：字幕请求是**客户端阻塞等待**的，片多就慢 |
| `chars_per_request` | `2500` | 一次请求的字符预算上限（到量就切下一片） |
| `max_cues` | `500` | 单次字幕最多翻多少条，超出部分保留原文（防长视频烧钱） |
| `timeout_ms` | `20000` | 脚本内部总预算，超时就把已翻好的先返回、其余保留原文。**别调很大**，见「为什么不是流式」 |
| `soft_deadline_ms` | `9000` | **软截止**：到点立刻把「已翻好的译文 + 没翻完的原文」交回去。YouTube 客户端等不住十几秒，这才是「字幕加载失败」的真凶；调小更稳（6000~8000），调大译文更全但更容易被判超时 |
| `concurrency` | `4` | 同时发几个翻译请求（1~6）。越高首屏越快，也越容易撞上游 RPM |
| `retry_times` | `2` | 遇到 `429` / `503` / `high demand` / 超时这类临时错误时的重试次数。`gemini` 后端重试时会**沿模型链往下换**（`gemini-flash-lite-latest` → `gemini-3.5-flash-lite` → `gemini-3-flash`，改 `fallback_model` 可自定义逗号列表），`404 模型下线` 也走这条链；换完仍失败才真正报错 |
| `fallback_model` | `gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.8-flash` | 备用模型链（逗号分隔，按顺序换）。模型报 `404 已下线` 或过载时会依次尝试；只有 `gemini` 后端会换模型，其它后端只做原样重试 |
| `force_json3` | `true` | 改写 player 里的 `baseUrl` 为 `json3`，**绝大多数情况必须开** |
| `cache` | `true` | 按「视频 + 语言 + 后端 + 模型」缓存译文，重看不重复花钱 |
| `prefetch` | `true` | 在 `player` 阶段就把字幕预取并翻译好写缓存，等你开字幕时几乎秒出 |
| `debug` | `false` | 打开后 Loon 日志有 `[YT字幕]` 输出，失败会弹通知 |
| `system_prompt` | 空 | 想改翻译风格（比如「译成粤语口语」）就整段覆盖提示词 |
| `custom_body` | 空 | 仅 `custom` 后端：自定义请求体模板，占位符 `{{texts_json}}` `{{target}}` `{{source}}` `{{model}}` `{{api_key}}`；留空用内置模板 |
| `custom_response_path` | `translations` | 仅 `custom` 后端：从响应里取译文数组的点号路径，如 `data.translations` |
| `custom_item_path` | 空 | 仅 `custom` 后端：译文数组元素是对象时，填文本字段名，如 `text` |

配置优先级：**内置默认 → 插件参数 `[Argument]` → `ytst.config` 本地配置**（后者覆盖前者）。
所以 key 可以只放在本地配置里，插件文件本身可以直接分享。

---

### 三种字幕方式怎么选

| | `menu`（默认，推荐） | `google` | `llm` |
| --- | --- | --- | --- |
| 谁在翻 | YouTube 机器翻译，翻成**你在播放器里选的语言** | YouTube 机器翻译，翻成 `目标语言` | 你配的后端（DeepSeek / Gemini …） |
| 字幕地址 | **一个字都不改** | 追加 `tlang=...`，有被 YouTube 拒掉的风险 | 只改 `fmt=json3` |
| 你要做什么 | 开一次「字幕 → 自动翻译 → 简体中文」，之后客户端记住 | 什么都不用做 | 填好 API Key 与模型 |
| 延迟 | 毫秒级 | 毫秒级（能用的时候） | 一次模型往返（3~10 秒） |
| 成本 | 0 | 0 | 每 10 分钟视频约 ¥0.03（flash 档） |
| 需要 key | 不需要 | 不需要 | 需要 |

**为什么默认不是 `google`**：`google` 模式要往字幕地址里塞 `tlang`，而客户端自己也可能带一个 `tlang`（你曾在播放器里选过自动翻译），
两条 `tlang` 撞在一起 YouTube 直接报错；还有些视频（尤其自动生成字幕）对该语言就是不返回内容。
`menu` 模式完全不动字幕地址，翻译仍由 YouTube 在服务端完成，所以**既零延迟又不会「字幕加载失败」**——DualSubs 走的就是这条路。

`menu` 模式具体做的事：把 `player` 响应里 `translationLanguages` 换成**全量 129 种语言**，并把每条轨道的 `isTranslatable` 强制打成 `true`。
客户端「自动翻译」里原本只有一小撮语言（甚至整项灰着不能点），解锁后你选什么，客户端就带着 `tlang=<你选的语言>` 去请求，脚本照旧透传。
配合 `双语字幕` 开关，原文那一行会自动补上。

## 四、各家 API 怎么填

### OpenAI

```
provider     = openai
api_base_url = https://api.openai.com/v1/chat/completions
api_model    = gpt-5-mini
api_key      = sk-...
```

### DeepSeek（推荐）

```
api_base_url = https://api.deepseek.com/chat/completions
api_model    = deepseek-flash
```

`deepseek-flash` 现在由 DeepSeek-V4.1-Flash 提供服务，中文口语自然、严格返回 JSON、国内直连不用挂代理。
旧名 `deepseek-v4-flash` 仍可调用（按 Flash 计费）；`deepseek-chat` / `deepseek-reasoner` 官方已宣布逐步弃用。
V4-Pro 质量更高但更贵也更慢，字幕用 Flash 就够。

### Google Gemini

Gemini 有两种接法，**先看你手上的 key 是什么样**：

| key 形态 | 该选哪个 `provider` | 说明 |
| --- | --- | --- |
| `AQ.` 开头（2026 年起新建的 key 基本都是） | `gemini` | 走 Google 原生 Interactions API，脚本已内置 |
| `AIza` 开头（老 key） | `gemini` 或 `openai` | 两种都行，`gemini` 更稳 |

**接法一：原生 Interactions API（推荐）**

```
provider     = gemini
api_base_url = （留空即可，自动用 https://generativelanguage.googleapis.com/v1beta/interactions）
api_model    = gemini-3.7-flash
api_key      = AQ....
```

脚本用 `x-goog-api-key` 头传 key（新版 `AQ.` key 只能用这种方式，走 `Authorization: Bearer` 会认证失败），
请求体只发 `{ model, input }`，把提示词和待翻译数组一起放进 `input`，不依赖会变的字段名。
返回值依次从 `output_text` → `outputs[].content[].text` → `steps[]` 里取，形状变了也能解析。

**接法二：OpenAI 兼容层**

```
provider     = openai
api_base_url = https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
api_model    = gemini-3.7-flash
api_key      = AQ... 或 AIza...
```

注意别把 `https://generativelanguage.googleapis.com/v1beta/interactions` 填给 `openai` 后端：那是格式完全不同的原生接口，
返回里没有 `choices[0].message.content`，填错会一直拿不到译文。

### Gemini 可用模型 id 对照（2026-11 实测核对）

| 你现在填的 | 还能用吗 | 说明 |
|---|---|---|
| `gemini-2.5-flash` | ❌ 404 | 新 key 直接 `no longer available to new users`；2026-12-01 起请求自动转到 `gemini-3.5-flash-lite` |
| `gemini-3-flash` | ❌ 404 | **这个 id 根本不存在**，库里只有 `gemini-3-flash-preview` |
| `gemini-3.7-flash` | ⚠️ 能跑但已排期下线 | Google 标注停用 2027-01-28，之后请求自动转到 `gemini-3.8-flash`；月内会一直报 `high demand`（容量紧张） |
| `gemini-4-hydrogen` | ✅ 存在但**不适合**字幕 | 这个是 4 代非 Flash 档（贵、慢，字幕 3k 字要好几秒），你那次的 `high demand` 就是它 |
| `gemini-flash-lite-latest` | ✅ **首选** | 别名，Google 每次发新版 Flash-Lite 都热切换到最新，**永不 404** |
| `gemini-3.5-flash-lite` | ✅ 稳 | 2026-07-21 发布的稳定 Lite 档，最便宜 |
| `gemini-3.8-flash` | ✅ 质量档 | `$1.50/$7.50`，字幕质量明显好于 Lite |
| `gemini-3.6-flash` / `gemini-3.5-flash` | ✅ 能用 | 老 Flash，已被 3.8 替代，不必特意用 |
| `gemini-4-argon` | ✅ 顶级 | 2026-10-13 发布，质量最高也最贵，字幕场景没必要 |

来源：[Gemini API Models](https://aistudio.google.com/docs/models) · [`@google/genai` Interactions `Model` 枚举](https://googleapis.github.io/js-genai/release_docs/types/gaos_models_interactions_model.Model.html) · [Firebase 模型生命周期表](https://firebase.google.cn/docs/ai-logic/models)

**模型怎么选**（`gemini` 后端）：`gemini-flash-lite-latest`（别名，永远指向当前 Flash-Lite 档）最便宜也最不容易 404；要质量用 `gemini-3.8-flash`（$1.50/$7.50）或 `gemini-4-argon`。

> ⚠️ **`gemini-3-flash` 这个 id 不存在**（库里只有 `gemini-3-flash-preview`），填了就是 404。同理 `gemini-2.5-flash` 对新 key 已 404。下面表格里的 id 全部取自 `@google/genai` v3.6.1 的 Interactions `Model` 枚举，照抄即可。
⚠️ `gemini-2.5-flash` 已下线——**2026-11 起新 key 直接 404「no longer available」**，12 月 1 日起请求会自动转去 `gemini-3.5-flash-lite`。别再用它。
`gemini-4-hydrogen` 是给编码/Agent 场景的旗舰，默认思考等级 high，翻字幕**又慢又贵**，不建议。

**key 从哪来**：<https://aistudio.google.com/app/apikey>，无需信用卡，免费层只有 Flash 档模型（RPM 约 10~15）。
注意 **额度按项目算，不按 key 算**；给项目绑定结算账号就自动转付费层，免费额度随之消失。
另外插件跑在 Loon 里，`generativelanguage.googleapis.com` 与 `aistudio.google.com` 必须走代理。

### Moonshot / Kimi

```
api_base_url = https://api.moonshot.cn/v1/chat/completions
api_model    = moonshot-v1-8k
```

### 通义千问（兼容模式）

```
api_base_url = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
api_model    = qwen-plus
```

### 智谱 GLM

```
api_base_url = https://open.bigmodel.cn/api/paas/v4/chat/completions
api_model    = glm-4-flash
```

### one-api / new-api 自建网关

```
api_base_url = https://你的网关/v1/chat/completions
api_model    = 网关里配置的模型名
```

### Ollama（本机或局域网）

```
api_base_url = http://192.168.x.x:11434/v1/chat/completions
api_model    = qwen2.5:7b
api_key      = ollama          # 随便填，脚本会原样带上
```

> 脚本跑在手机上，`127.0.0.1` 指的是手机自己，所以本地模型要写 Mac 的局域网 IP，
> 并且让这条地址在 Loon 规则里走直连。

### DeepL

```
provider     = deepl
api_base_url = https://api-free.deepl.com/v2/translate    # 付费版去掉 -free
api_key      = xxxx:fx
```

### Google 免费接口（不推荐长期用）

```
provider = google
```

无需 key，走 `translate.googleapis.com` 单条查询、并发 3、单次最多 120 条。速度快、零成本，但会被限流，长视频容易只翻一半。

### 自定义后端（provider = custom）

```json
{
  "provider": "custom",
  "api_base_url": "https://api.example.com/translate",
  "custom_body": "{\"q\": {{texts_json}}, \"to\": \"{{target}}\"}",
  "custom_response_path": "data.result",
  "custom_item_path": "text"
}
```

- `custom_body`：请求体模板，占位符 `{{texts_json}}` `{{target}}` `{{source}}` `{{model}}` `{{api_key}}`；
- `custom_response_path`：响应里**字符串数组**的取值路径（点号分隔，支持数字下标）；
- `custom_item_path`：数组元素是对象时，取哪个字段当译文（`""` 表示元素本身就是字符串）。

---

## 五、换哪个模型（选型建议）

> 这一章只对 `字幕方式=llm` 生效。默认的 `google` 模式不调用任何模型。

字幕翻译和「写代码」的偏好完全相反：要**快、便宜、严格按条数返回 JSON**，不需要长推理。所以规律只有一条——**选 Flash / mini / nano 这一档，别选思考模型**。

| 需求 | 推荐 | 理由 |
| --- | --- | --- |
| 默认（中文最自然、国内直连） | DeepSeek `deepseek-flash` | 口语化好、JSON 守规矩、不用额外挂代理；插件默认值就是它 |
| 更高质量的日/韩翻中、俚语多 | Gemini `gemini-3.8-flash` | 多语种理解强，Flash 档延迟仍低 |
| 极低成本跑长视频 | Gemini `gemini-flash-lite-latest`（别名，指向当前 Lite 档） | 便宜到几乎无感，质量对字幕足够，且不会因模型下线变 404 |
| 已有 OpenAI key | `gpt-5-mini` / `gpt-5-nano` | 稳定，nano 更快更便宜 |
| 零成本试水 | `provider=google` 免费接口 | 不用 key，但会限流，长视频可能只翻一半 |

**不建议**：`deepseek-v4-pro` 的思考模式、`gemini-*-think`、`o` 系列这类推理模型。它们会在 JSON 数组外面额外解释一句「以下是翻译」，插件解析失败就整片保留原文，白花钱还更慢。

配套参数：

- Flash / nano 档：把 `cues_per_request` 调到 60、`chars_per_request` 到 4000，往返次数少一半，首屏更快；
- 大模型或小上下文模型：保持默认 40 / 2500；
- 想固定风格就在 `system_prompt` 里补一句，例如「人名、片名、品牌、专业术语保留原文，其余口语化翻译，不要解释」。

## 六、工作原理（为什么这么设计）

1. **为什么改 `fmt`**：YouTube 客户端默认可能取 `fmt=pb`（protobuf），JS 里没法安全地解析和回写。所以在 `player` 响应里把 `baseUrl` 的 `fmt` 统一改成 `json3`——这是 YouTube 官方格式，客户端原生支持，改完既能解析又不破坏播放。
2. **为什么能在播放器里挑语言**（`menu` 模式）：客户端「字幕 → 自动翻译」的候选语言不是写死的，来自 `player` 响应里的
   `playerCaptionsTracklistRenderer.translationLanguages`，而这项能不能点取决于轨道的 `isTranslatable`。
   所以 `menu` 模式做两件事：把 `translationLanguages` 整段替换成全量列表（自写括号配对，能安全处理嵌套），
   再把 `"isTranslatable":false` 全改成 `true`。严格说这是「解锁客户端本来就有、只是没开放给你的能力」，
   翻译仍然发生在 Google 那边，脚本不参与。
3. **`google` 模式做了什么**（参考 DualSubs 的做法）：YouTube 的 `timedtext` 接口本身就接受 `tlang=` 参数，
   传进去它就返回**已经翻成目标语言**的字幕（`zh-CN` 要写成 `tlang=zh-Hans`，繁体是 `zh-Hant`）。
   所以插件只改一处：`player` 响应里给**标记了 `isTranslatable:true`** 的轨道追加 `tlang`，
   之后客户端请求到的字幕本身就是中文，脚本直接透传、一次模型都不调——这是把延迟压到最低的做法。
   双语则是再拉一次「剥掉 `tlang` 的原文」，把两条按条对齐合成 `原文\n译文`。
   轨道没有 `isTranslatable` 标记（`tlang` 会返回空）时脚本会弹一次提示，让你改走 `llm`。
4. **为什么按片翻译**：字幕动辄几百条，一次性塞给模型会超时、也更容易串行错位。脚本按「40 条 / 2500 字符」切片，**串行**发请求，保证顺序不乱；总预算 95 秒，到点就把已翻好的先返回。
5. **为什么能省钱**：缓存按「视频 ID + 目标语言 + 源语言 + 后端 + 模型」落到一个 key 里，键是单条原文的哈希。重看同一个视频、切清晰度、拖进度条都直接命中，零请求。每个视频最多留 400 条，超了淘汰最旧的。
6. **目标语言那条是空的怎么办**：YouTube 对某些视频的 `tlang` 会返回空内容，或者客户端自己也带了
   `tlang` 导致同一请求里出现两条 `tlang`（服务端直接 400）。脚本在 `timedtext` 阶段做两级自救：
   先**去重整成一条 `tlang`** 再拉一次（多半就能拿到译文），不行才**剥掉 `tlang` 拉原文**。
   最差的结果是「显示原文字幕 + 弹一次提示」，绝不会是「字幕加载出错」。
7. **失败了会怎样**：任何一片失败、超时、模型返回条数不对，**那部分保留原文字幕**，结构不动；全片失败就整包原样放行。宁可看原文，也不让字幕消失或串位。

---

## 七、为什么不是流式翻译（延迟是硬约束）

> 补充（v2026.11.22.13）：除了总预算 `timeout_ms`，还有一个更早的**软截止** `soft_deadline_ms`（默认 9000ms）。到点不等上游，直接把「已翻好的 + 原文」交回去——同一部片子第二次打开会命中缓存补全译文。宁可先给半份中文，也别让客户端报「字幕加载失败」。

Loon 的 `response` 脚本是**一次性改写整个响应体**：拿到完整的 `timedtext` 响应 → 翻译 → `$done({body})`。
它没有 SSE/流式回传的接口，所以「先出一句、再出一句」做不到——客户端等你这一条响应，等太久就自己放弃，
表现就是**Loon 弹了「已翻译」，YouTube 却报「字幕加载失败」**（YouTube 侧对字幕请求有超时）。

**根治手段是把翻译搬到服务端**：`字幕方式=google` 时翻译由 YouTube 自己完成，脚本只改一个 URL 参数，
延迟等于没有（见上一章第 2 点）。`llm` 模式则只能靠下面三个手段把延迟压进客户端耐心之内：

1. **并发分片**：`concurrency=3`，200 条字幕切成 2~3 片一次发出，总耗时约等于最慢那一片，而不是相加；
2. **短预算 + 快速降级**：`timeout_ms=20000`。到点立刻返回「已翻好的 + 剩余原文」，结构完整、能正常显示，
   绝不为了等第 5 片让整条字幕流失败；
3. **预取预热**（`prefetch`）：`player` 响应里本来就有字幕地址，脚本在返回播放器数据后**先把字幕拉下来翻好写缓存**。
   等你真正开启字幕时，`timedtext` 请求直接命中缓存，毫秒级返回。

明白了这点，参数就有取向：**宁可少翻几条、也要快**。长视频（>500 条）宁可让 `max_cues` 截断，
也不要让 `timeout_ms` 顶到 90 秒——那 90 秒里客户端早就报错了。

---

## 八、排错

> 从 v2026.11.22.13 起，每条通知都带版本号（`v2026.11.22.13 · openai · 8001ms`）。
> **先看这个版本号**：如果显示的不是最新版，说明插件没更新到（Loon 会缓存插件文件），
> 那后面所有参数调整都不会生效——这是「怎么改都还是超时」最常见的原因。清单

### 弹「503 / high demand / model is currently experiencing high demand」

这是**上游模型服务过载**，不是插件的问题。三种解法，从省事到彻底：

1. 什么都不做——插件默认 `retry_times=2`，会自动重试；`gemini` 后端还会沿模型链换（`gemini-flash-lite-latest` → `gemini-3.5-flash-lite` → `gemini-3-flash`）兜底；
2. 把 `模型名` 换成不会下线的档：`gemini-flash-lite-latest`（别名）或 `gemini-3.8-flash`，或干脆换 `deepseek-flash`（最省心，不受 Google 下线节奏影响）；
3. 干脆把 `字幕方式` 改成 `google` 或 `menu`——这条路完全不经过模型，不可能 503。

### 通知「授权失败(401)」/「余额不足(402)」

v15 起把 HTTP 状态码翻译成了结论，通知里直接写着该改什么：

| 通知 | 含义 | 处理 |
|---|---|---|
| `授权失败(401)：key 不对、已失效或带了多余空格` | DeepSeek 侧拒绝了这个 key | ① key 重新复制一次（别带 `Bearer ` 前缀——插件会自动剥掉，但前后空格、换行、引号以前会让它失效；v15 起也会自动清洗）；② 确认这个 key 属于 `platform.deepseek.com` 而不是别家中转；③ 用 curl 在电脑上验一次（见下） |
| `余额不足(402)` | 账户没余额 | 充值后再试；DeepSeek 新用户赠金用完就是这个 |
| `无权限(403)` | key 有但模型无权限/被风控 | 换 `deepseek-flash` 再试，或换 key |
| `地址或模型不存在(404)` | 接口地址或模型名填错 | 地址填 `https://api.deepseek.com/chat/completions`，模型填 `deepseek-flash` |

在电脑上验 key（能返回 JSON 就是 key 没问题，问题在手机侧配置）：

```bash
KEY=sk-你的key
curl -sS -m 20 https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"只回两个字：收到"}]}' \
  -w '\n--- %{http_code} %{time_total}s\n'
```

- `200` + 正常 JSON → key 好的，问题在插件参数（尤其 `API Key` 里是否混了不可见字符）
- `401` → key 本身不行，去控制台重新生成
- `402` → 没余额

### 通知「接口 3 秒无响应」而浏览器能打开同一个域名

**这是 v2026.11.22.13 及更早版本的已知坑，v13 已修**：插件之前只发 `Content-Type` + `Authorization`，
没有 `User-Agent` / `Accept`。部分网关（含 DeepSeek 的 governor）对这类「裸请求」不返回 403，
而是**直接把连接挂住**，表现和「网络不通」完全一致；Safari 能打开是因为浏览器自带全套请求头。

v13 起统一带：

```
User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 ...) Safari/604.1
Accept: application/json
Accept-Encoding: identity
```

如果升级后仍然挂住，再做这两步（顺序别反）：

1. 配置 → 规则：`DOMAIN,api.deepseek.com,PROXY`（换成你的策略组），别让它走 DIRECT；
2. 若走的是海外节点而出问题，把该域名设为走国内直连/落地，或换成 `deepseek` 官方域名直连试试。

### 通知「接口 3 秒无响应」/「GET 能通、POST 挂住」/「整条链路不通」

这三条是 v2026.11.22.13 起的新探针，专门区分**请求根本没回来**和**模型慢**：

| 通知 | 含义 | 处理 |
|---|---|---|
| `GET 能通、POST 挂住 · api.deepseek.com`（v16 起会附带状态码，且 401/403 会单独报「链路正常 · 鉴权被拒」） | 链路是通的（浏览器能打开），但 **POST 一直挂着不返回**。最常见的两个原因：**IPv6 半通**、**MTU 太小导致大 POST 被丢包** | ① Loon 设置里**关掉 IPv6**；② 若家里是 PPPoE（MTU 1480），把 Loon 的 `tun-mtu` 调到 1400 试；③ 给 `api.deepseek.com` 加一条走代理节点的规则（别走 DIRECT） |
| `整条链路不通` | GET 也挂住 → 规则 REJECT 了该域名，或节点/DNS 有问题 | 给该域名加一条走代理的规则；换节点再试 |
| 没有上面任何一条，但有 `已翻译 0/N 条` | 有响应，是接口层面拒绝 | 看紧随其后的失败详情（401/404/格式） |

> **为什么 Safari 能打开、插件却挂住**：浏览器有 IPv4/IPv6 双栈竞速（Happy Eyeballs），v6 不通会几毫秒内退回 v4；
> Loon 的 `$httpClient` 只按一次解析结果发，拿到一个不通的 AAAA 就会一直等到超时。
> 家里 IPv6「PD 下发但 LAN 侧无路由」时，表现就是「浏览器正常、插件必超时」。

### 换成 openai 后端（DeepSeek key）还是超时

先看**通知里的毫秒数**，它一定在跑：

| 通知长这样 | 含义 | 怎么办 |
|---|---|---|
| `已翻译 0/120 条 · 8001ms` | 软截止先兜了，一片都没回来 → 接口根本没通 | 看是否紧跟一条「接口不通」；检查 `接口地址`（只填 `https://api.deepseek.com` 也能用，v9 起会自动补 `/chat/completions`） |
| `已翻译 40/120 条 · 8001ms` | 单片就超过 8 秒 → 模型档太大或网络慢 | `模型名` 用 `deepseek-flash`；`每次条数` 降到 30；`并发` 4 |
| `已翻译 120/120 条 · 12000ms` | 全翻完了但整体超过客户端阈值 | 打开 `prefetch`（llm 模式会在播放器响应时就预热缓存），第二次打开同一视频就是毫秒级 |

**关键点**：`llm` 模式下第一次打开字幕，客户端必须等整包返回，物理上快不过 YouTube 的耐心；
真正能做到「打开即中文」的方法只有两种——

1. `字幕方式 = menu`：让 YouTube 自己翻（官方机翻，零延迟，质量一般）；
2. `字幕方式 = llm` + `prefetch = 开`：**先播两秒再开字幕**，播放器响应时插件已经在后台把那部片的字幕全翻好写进缓存了，打开时命中即毫秒返回（v9 起预取有自己的长预算，不会再被 9 秒截断）。

### 通知「字幕翻译失败 · 模型未返回 JSON 数组」

模型回了东西，但不是一个干净的 JSON 字符串数组。常见三种原因，脚本现在都能救回来（剥 ```json 代码块、去掉前后寒暄、尾逗号修复、一行一条）：

1. **模型档位不对**：`gemini-4-hydrogen`、`gemini-3.7-flash`、`deepseek-v4-pro` 这类默认带思考/会啰嗦的档，容易在数组外多说一句。字幕场景请用 Flash·Lite 档：`gemini-flash-lite-latest`、`gemini-3.8-flash`、`deepseek-flash`。
2. **`temperature` 太高**：用 `custom` 后端时自己传 `temperature: 0`。
3. **单次条数太多**：一片 100+ 条时模型容易越界或漏条。把 `每条字幕` 降到 40~60。

顺带看一眼**耗时**：通知里 `gemini · 17744ms` 这种，说明就算翻译成功，客户端也早就放弃了——把 `model` 换 Lite 档、`concurrency` 提到 4、`soft_deadline_ms` 降到 8000。

### 弹「404 / model is no longer available」

模型被 Google 下线了（`gemini-2.5-flash` 从 2026-11 起对新 key 就是 404）。插件会自动沿模型链换到下一个可用模型，
但**你手填的 `模型名` 值得改成不会下线的**：`gemini-flash-lite-latest`（别名）或 `gemini-3.8-flash`；
也可以直接换 `deepseek-flash`，这条路不受 Google 下线节奏影响。

### 通知「YT字幕 · 已翻译 0/N 条」，字幕没动

说明字幕拿到了、但**翻译请求全部失败**。插件此时会自动再做一次自检（用 `Hello` 试一句），看第二条通知：

- 「**接口正常 · api.deepseek.com**」→ 接口是通的，问题在字幕侧：条数太多、模型没按 JSON 返回，或超时；
  把 `每次条数` 降到 40、`模型名` 换成 flash 档再试；
- 「**接口不通 · ...**」→ 状态码会直接写在通知里。`401/403` 是 key 不对（Gemini 的 `AQ.` key 必须配 `后端=gemini`），
  `404` 是接口地址或模型名错，`429/503` 是限流/过载（换模型即可）。

### 弹「字幕加载出错」/ 字幕一直是原文

**先换 `字幕方式=menu`**——它不改字幕地址，能出字幕是必然的（出来的是你在播放器里选的那个语言）。

如果你坚持用 `google` 模式：插件已内置自救（去重 `tlang` → 回退原文 → 都不行时返回一个合法空字幕，保证客户端只显示「没有字幕」而不是「加载失败」）。
看到「已回退原文字幕」提示就说明这个视频**真的没有该语言的机器翻译**，改用 `menu` 挑一个存在的语言，或用 `llm` 让模型翻。


**字幕没翻译？按这个顺序查（前一条排除掉再往下走）**

1. **脚本有没有被加载**
   插件里的脚本地址是 GitHub raw。国内常连不上 raw，插件本体装上了、脚本却拉不下来，表现就是完全没反应。
   去 Safari 打开下面这个地址，打不开就说明是这个问题：

   ```
   https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/main/scripts/yt-subtitle-translate.js
   ```

   打不开 → 改装 `YouTube-Subtitle-Translate.cdn.plugin`（同一份配置，脚本改走 jsDelivr），并确保 `cdn.jsdelivr.net` 在 Loon 里走代理。
2. **脚本有没有被触发**
   把 `debug` 打开，播放视频，然后看手机通知或 Loon 的「日志」页搜 `YT字幕`。
   - 一条都没有 → 请求没经过 MITM/脚本：查 MITM 开关、证书信任、`youtubei.googleapis.com` 与 `www.youtube.com` 是否走代理、是否被 QUIC 绕过；
   - 有 `已改写` → 脚本命中了，往下看第 3 条。
3. **接口有没有在报错**
   现在**翻译失败会直接弹通知**（不用开 `debug`），内容形如 `字幕翻译失败 · HTTP 401`。
   常见原因：`api_key` 没填或填错、`api_model` 名不对（比如 DeepSeek 写成了 `gpt-4o-mini`）、余额不足、`api_base_url` 少了 `/chat/completions`。
4. **有没有别的 YouTube 脚本抢同一个响应**
   去广告、SponsorBlock、封面替换这类插件也会改写 `/youtubei/v1/player`。两个脚本处理同一个响应时，后写的会覆盖前写的——
   一旦 `force_json3` 的改写被覆盖，字幕回来就是 protobuf，翻译不出来。临时关掉其他 YouTube 相关插件验证。
5. **客户端缓存**
   改完参数把 YouTube App 从后台划掉重开；网页版强制刷新。

**插件详情页里看不到参数表单 / 没有可编辑项**

- 插件版本太老：本仓库 2026-11-22 之前的版本把 `[Argument]` 写成了 `key=value`，那不是 Loon 认的声明格式，所以整段被忽略。重新从 URL 更新插件即可；
- Loon 低于 3.5.1 (983)：主插件用的是新版 Script 语法，改装 `YouTube-Subtitle-Translate.legacy.plugin`；
- 自己改的插件：`[Argument]` 只负责「声明」，还要在每条 `[Script]` 的 `script(...)` 第二个参数里列出参数名（旧语法是 `argument=[{参数名}]`）。两处缺一处，表单和 `$argument` 都会缺席。

**字幕完全没变化**

- MITM 没开 / 证书没信任 → 先去 Loon 的「MitM」页确认有流量记录；
- YouTube 自己没开字幕（CC）：插件只在客户端**请求字幕时**才生效；
- 命中不到接口：在 Loon 日志里搜 `timedtext`，没有就是规则/MITM 问题；
- 走了 QUIC：加一条 `AND,((PROTOCOL,UDP),(DEST-PORT,443)),REJECT` 逼它回落 TCP（会略微影响别的 UDP 443 应用，按需开）。

**Loon 弹了「已翻译 N 条」，但 YouTube 显示「字幕加载失败」**

翻译本身成功了，是**整条响应回去太慢**，YouTube 等不及（原因见「为什么不是流式翻译」）。按顺序做：

- `timeout_ms` 设到 20000 以内（默认就是 20 秒）；`cues_per_request` 别低于 60；
- `concurrency` 设 3~4，让分片并行而不是串行；
- 用 `gemini-4-hydrogen`、`deepseek-v4-pro` 这类默认高思考的模型会慢好几倍，换 Flash 档；
- 把 `prefetch` 打开，第二次开字幕基本是秒出。

**填了 key 和模型但好像完全没用上**

多半是 `翻译后端` 选成了 `google`。那是**免 key 的免费接口**（`translate.googleapis.com`），脚本走它时不读
`接口地址` / `API Key` / `模型名` 这三项——填了也白填。要用自己的 key，后端必须是 `openai` 或 `gemini`。

**弹了「字幕格式无法翻译」**

说明拿到的是 protobuf。确认 `force_json3=true`；仍不行就把 `debug` 打开看日志里是哪类请求，多半是某个客户端版本绕过了 `player` 接口。

**字幕出现但没翻译 / 只有前一半**

- `max_cues` 挡住了（默认 500 条），调大即可；
- `timeout_ms` 到了：调大，或把 `cues_per_request` 调小、换更快的模型；
- key 无效 / 额度用尽：`debug=true` 会弹通知告诉你 HTTP 状态。

**字幕消失了**

基本只会发生在一件事上：`force_json3` 让客户端拿不到它想要的格式。把它关掉重试，插件会自动退回「XML/VTT 能翻就翻，protobuf 放行」。

**翻译很慢**

首帧字幕要等第一片返回。把 `cues_per_request` 调到 60~80、`chars_per_request` 调到 4000，能显著减少往返次数；代价是首屏延迟略增。

**成本**

按 10 分钟视频、约 200 条字幕估算：输入约 3k token、输出约 3k token（Flash 档模型单条视频大约 **1~3 分钱**，视模型而定，见下表）。同一视频只付一次，第二次走缓存。

| 后端 / 模型 | 参考单价（输入 / 输出，每 1M token） | 单条 10 分钟视频 |
| --- | --- | --- |
| `google` 免费接口 | 0 | 0（会限流） |
| DeepSeek `deepseek-flash` | 约 ¥3 / ¥6 | 约 ¥0.03 |
| Gemini `gemini-flash-lite-latest` | 与当前 Lite 档同价（约 $0.15 / $0.60） | 约 $0.002 |
| Gemini `gemini-3.7-flash` | $0.75 / $3.75 | 约 $0.014 |
| OpenAI `gpt-5-mini` | $0.25 / $2.00 | 约 $0.007 |

价格随官方调整，以上按 2026-11 公开报价估算，只用于判断量级。

---

## 九、本地自测

```bash
node test/run.js
```

`test/run.js` 用 `node:vm` 伪造了 Loon 的运行时（`$request` / `$response` / `$done` / `$httpClient` / `$persistentStore` / `$notification`），直接跑主脚本，覆盖：

- `json3` / `srv3` / `vtt` / `ttml` 四种格式的翻译与结构保真；
- `get_transcript` 的递归改写；
- `player` 的 `fmt` 改写（含 `\u0026` 编码保持）；
- protobuf 与空响应的放行、一次性提示；
- 缓存命中、`cache=false` 不落盘；
- DeepL（表单编码 + 语言映射）、custom（模板 + 取值路径）；
- HTTP 500 与「模型返回条数不足」的降级行为；
- 插件参数按新语法传 Number / Boolean 时照常生效（切片、`force_json3=false` 放行）。

当前 17/17 通过。

---

## 十、卸载

Loon 里关掉插件即可，YouTube 立刻恢复原生行为。想连缓存一起清掉，跑一次：

```js
// Loon 脚本编辑器里执行
$persistentStore.write('', 'ytst.config');
$done({});
```

每条视频的译文缓存 key 形如 `ytst.<hash>`，不清理也只是占几十 KB。

---

仅供个人学习与自用；翻译内容与费用由你配置的 API 提供方承担。
