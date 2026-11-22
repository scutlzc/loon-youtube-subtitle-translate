# YouTube 字幕翻译 · Loon 插件

在 Loon 代理层直接拦住 YouTube 的字幕接口，把每条字幕用**你自己配置的翻译 API**翻成目标语言再塞回去。
YouTube App 完全无感：不用装第三方 App、不用改播放器，只要打开 CC 字幕，看到的就是译好的字幕。

```
YouTube-Subtitle-Translate.plugin      # 插件本体（参数 + 脚本挂载 + MITM）
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
https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/main/YouTube-Subtitle-Translate.plugin
```

或者直接在 Safari 打开：

```
loon://import?plugin=https://raw.githubusercontent.com/scutlzc/loon-youtube-subtitle-translate/main/YouTube-Subtitle-Translate.plugin
```

装完填 `api_key`，再按下面第 3 步装证书即可。仓库里的 `.plugin` 已经全部指向 raw 链接，改完脚本推上去，手机上重新更新插件就生效。

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

> 也可以把两个 js 传到自己的 GitHub 仓库，然后把 `.plugin` 里所有
> `script-path=scripts/xxx.js` 换成 raw 链接，插件就能用 URL 安装、多设备同步。

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

Loon →「插件」→「YouTube 字幕翻译」→ 参数区，至少填 `api_key`，按需改 `api_model` / `target_lang`。

---

## 三、参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `openai` | `openai` / `deepl` / `google` / `custom` |
| `api_base_url` | OpenAI 官方 | 请求地址，见下方各家示例 |
| `api_key` | 空 | 翻译服务的 key；`google` 不需要 |
| `api_model` | `gpt-4o-mini` | 模型名；`deepl` / `google` 忽略 |
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

配置优先级：**内置默认 → 插件参数 `[Argument]` → `ytst.config` 本地配置**（后者覆盖前者）。
所以 key 可以只放在本地配置里，插件文件本身可以直接分享。

---

## 四、各家 API 怎么填

### OpenAI

```
provider     = openai
api_base_url = https://api.openai.com/v1/chat/completions
api_model    = gpt-4o-mini
api_key      = sk-...
```

### DeepSeek

```
api_base_url = https://api.deepseek.com/chat/completions
api_model    = deepseek-chat
```

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

## 五、工作原理（为什么这么设计）

1. **为什么改 `fmt`**：YouTube 客户端默认可能取 `fmt=pb`（protobuf），JS 里没法安全地解析和回写。所以在 `player` 响应里把 `baseUrl` 的 `fmt` 统一改成 `json3`——这是 YouTube 官方格式，客户端原生支持，改完既能解析又不破坏播放。
2. **为什么按片翻译**：字幕动辄几百条，一次性塞给模型会超时、也更容易串行错位。脚本按「40 条 / 2500 字符」切片，**串行**发请求，保证顺序不乱；总预算 95 秒，到点就把已翻好的先返回。
3. **为什么能省钱**：缓存按「视频 ID + 目标语言 + 源语言 + 后端 + 模型」落到一个 key 里，键是单条原文的哈希。重看同一个视频、切清晰度、拖进度条都直接命中，零请求。每个视频最多留 400 条，超了淘汰最旧的。
4. **失败了会怎样**：任何一片失败、超时、模型返回条数不对，**那部分保留原文字幕**，结构不动；全片失败就整包原样放行。宁可看原文，也不让字幕消失或串位。

---

## 六、排错清单

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

按 10 分钟视频、约 200 条字幕估算：输入约 3k token、输出约 3k token。用 `gpt-4o-mini` 级别模型单次不到一分钱，且同一视频只付一次（有缓存）。

---

## 七、本地自测

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
- HTTP 500 与「模型返回条数不足」的降级行为。

当前 15/15 通过。

---

## 八、卸载

Loon 里关掉插件即可，YouTube 立刻恢复原生行为。想连缓存一起清掉，跑一次：

```js
// Loon 脚本编辑器里执行
$persistentStore.write('', 'ytst.config');
$done({});
```

每条视频的译文缓存 key 形如 `ytst.<hash>`，不清理也只是占几十 KB。

---

仅供个人学习与自用；翻译内容与费用由你配置的 API 提供方承担。
