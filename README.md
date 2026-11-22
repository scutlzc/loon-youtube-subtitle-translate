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
| `youtubei/v1/player` | 播放器初始化 | 把 `captionTracks[].baseUrl` 的 `fmt` 改写成 `json3`，保证字幕是**可解析的文本**而不是 protobuf |

译文回写只做两件事：**替换文本、保留结构**。因此「字幕对不上画面」「字幕消失」这类问题的根源基本都能排除在插件之外。

---

## 二、安装

### 0. 一条链接装完（推荐）

Loon →「插件」→ 右上角 `+` →「从 URL 安装」：

```
https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22/YouTube-Subtitle-Translate.plugin
```

或者直接在 Safari 打开：

```
loon://import?plugin=https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22/YouTube-Subtitle-Translate.plugin
```

> 上面是**固定版本**链接（`v2026.11.22`），装的永远是这个版本，raw 没有缓存延迟。
> 想自动跟随最新提交，把路径里的 `v2026.11.22` 换成 `main`；但 GitHub raw 有约 5 分钟 CDN 缓存，
> 刚推上去的一两分钟内可能会拿到旧文件，遇到「更新完还是老样子」等几分钟再更新一次即可。

装完填 `api_key`，再按下面第 3 步装证书即可。

> **国内网络提示**：插件里的脚本地址是 GitHub raw，连不上 raw 的环境（脚本拉不下来＝完全没反应）请改装
> `YouTube-Subtitle-Translate.cdn.plugin`，它只有脚本地址不同，走 jsDelivr CDN：
> `loon://import?plugin=https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/v2026.11.22/YouTube-Subtitle-Translate.cdn.plugin`

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

## 三、参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `openai` | `openai` / `deepl` / `google` / `custom` |
| `api_base_url` | DeepSeek | 请求地址，默认 `https://api.deepseek.com/chat/completions`，见下方各家示例 |
| `api_key` | 空 | 翻译服务的 key；`google` 不需要 |
| `api_model` | `deepseek-flash` | 模型名，见「换哪个模型」；`deepl` / `google` 忽略 |
| `target_lang` | `zh-CN` | 目标语言，`zh-CN` / `zh-TW` / `ja` / `en` … |
| `source_lang` | `auto` | 源语言；`auto` 交给模型判断 |
| `cues_per_request` | `40` | 一次请求最多翻多少条字幕 |
| `chars_per_request` | `2500` | 一次请求的字符预算上限（到量就切下一片） |
| `max_cues` | `500` | 单次字幕最多翻多少条，超出部分保留原文（防长视频烧钱） |
| `timeout_ms` | `95000` | 脚本内部总预算，超时就把已翻好的先返回，其余保留原文 |
| `force_json3` | `true` | 改写 player 里的 `baseUrl` 为 `json3`，**绝大多数情况必须开** |
| `cache` | `true` | 按「视频 + 语言 + 后端 + 模型」缓存译文，重看不重复花钱 |
| `debug` | `false` | 打开后 Loon 日志有 `[YT字幕]` 输出，失败会弹通知 |
| `system_prompt` | 空 | 想改翻译风格（比如「译成粤语口语」）就整段覆盖提示词 |
| `custom_body` | 空 | 仅 `custom` 后端：自定义请求体模板，占位符 `{{texts_json}}` `{{target}}` `{{source}}` `{{model}}` `{{api_key}}`；留空用内置模板 |
| `custom_response_path` | `translations` | 仅 `custom` 后端：从响应里取译文数组的点号路径，如 `data.translations` |
| `custom_item_path` | 空 | 仅 `custom` 后端：译文数组元素是对象时，填文本字段名，如 `text` |

配置优先级：**内置默认 → 插件参数 `[Argument]` → `ytst.config` 本地配置**（后者覆盖前者）。
所以 key 可以只放在本地配置里，插件文件本身可以直接分享。

---

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

Gemini 走官方的 **OpenAI 兼容层**，所以 `provider` 保持 `openai`，只换地址和模型名：

```
provider     = openai
api_base_url = https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
api_model    = gemini-2.5-flash
api_key      = AIza...
```

key 在 **Google AI Studio** 拿，不需要信用卡：

1. 打开 https://aistudio.google.com/app/apikey （整个 AI Studio 都在 Google 墙内，国内需挂代理）；
2. 用 Google 账号登录，同意 Gemini API 条款；
3. 点 **Create API key** → 选 **Create API key in new Google Cloud project**（新项目最省事）；
4. 复制 `AIza` 开头的字符串填进 `api_key`。

注意三点：

- **额度按项目算，不按 key 算**；同一个项目建 5 把钥匙，额度还是那一份。
- 免费层只能用 Flash 档模型（`gemini-2.5-flash`、`gemini-2.5-flash-lite`），RPM 大约 10~15、还有每日上限；
  给项目**绑定结算账号就自动进付费层**，免费额度随之消失。想一直白嫖就别绑卡。
- 插件本体跑在 Loon 里，所以 Loon 的分流规则里 `generativelanguage.googleapis.com` 和 `aistudio.google.com`
  必须走代理节点，否则请求直接超时。长视频会切 5~10 次请求，免费档贴着 RPM 上限时把 `cues_per_request` 调小更稳。

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

字幕翻译和「写代码」的偏好完全相反：要**快、便宜、严格按条数返回 JSON**，不需要长推理。所以规律只有一条——**选 Flash / mini / nano 这一档，别选思考模型**。

| 需求 | 推荐 | 理由 |
| --- | --- | --- |
| 默认（中文最自然、国内直连） | DeepSeek `deepseek-flash` | 口语化好、JSON 守规矩、不用额外挂代理；插件默认值就是它 |
| 更高质量的日/韩翻中、俚语多 | Gemini `gemini-3.7-flash` 或 `gemini-3-flash` | 多语种理解强，Flash 档延迟仍低 |
| 极低成本跑长视频 | Gemini `gemini-2.5-flash`（$0.15 / $0.60） | 便宜到几乎无感，质量对字幕足够 |
| 已有 OpenAI key | `gpt-5-mini` / `gpt-5-nano` | 稳定，nano 更快更便宜 |
| 零成本试水 | `provider=google` 免费接口 | 不用 key，但会限流，长视频可能只翻一半 |

**不建议**：`deepseek-v4-pro` 的思考模式、`gemini-*-think`、`o` 系列这类推理模型。它们会在 JSON 数组外面额外解释一句「以下是翻译」，插件解析失败就整片保留原文，白花钱还更慢。

配套参数：

- Flash / nano 档：把 `cues_per_request` 调到 60、`chars_per_request` 到 4000，往返次数少一半，首屏更快；
- 大模型或小上下文模型：保持默认 40 / 2500；
- 想固定风格就在 `system_prompt` 里补一句，例如「人名、片名、品牌、专业术语保留原文，其余口语化翻译，不要解释」。

## 六、工作原理（为什么这么设计）

1. **为什么改 `fmt`**：YouTube 客户端默认可能取 `fmt=pb`（protobuf），JS 里没法安全地解析和回写。所以在 `player` 响应里把 `baseUrl` 的 `fmt` 统一改成 `json3`——这是 YouTube 官方格式，客户端原生支持，改完既能解析又不破坏播放。
2. **为什么按片翻译**：字幕动辄几百条，一次性塞给模型会超时、也更容易串行错位。脚本按「40 条 / 2500 字符」切片，**串行**发请求，保证顺序不乱；总预算 95 秒，到点就把已翻好的先返回。
3. **为什么能省钱**：缓存按「视频 ID + 目标语言 + 源语言 + 后端 + 模型」落到一个 key 里，键是单条原文的哈希。重看同一个视频、切清晰度、拖进度条都直接命中，零请求。每个视频最多留 400 条，超了淘汰最旧的。
4. **失败了会怎样**：任何一片失败、超时、模型返回条数不对，**那部分保留原文字幕**，结构不动；全片失败就整包原样放行。宁可看原文，也不让字幕消失或串位。

---

## 七、排错清单

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
| Gemini `gemini-2.5-flash` | $0.15 / $0.60 | 约 $0.002 |
| Gemini `gemini-3.7-flash` | $0.75 / $3.75 | 约 $0.014 |
| OpenAI `gpt-5-mini` | $0.25 / $2.00 | 约 $0.007 |

价格随官方调整，以上按 2026-11 公开报价估算，只用于判断量级。

---

## 八、本地自测

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

## 九、卸载

Loon 里关掉插件即可，YouTube 立刻恢复原生行为。想连缓存一起清掉，跑一次：

```js
// Loon 脚本编辑器里执行
$persistentStore.write('', 'ytst.config');
$done({});
```

每条视频的译文缓存 key 形如 `ytst.<hash>`，不清理也只是占几十 KB。

---

仅供个人学习与自用；翻译内容与费用由你配置的 API 提供方承担。
