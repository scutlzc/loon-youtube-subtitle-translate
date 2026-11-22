/*
 * yt-subtitle-translate.js · Loon 脚本
 *
 * 作用：拦住 YouTube 的字幕接口，把每条字幕用「你自己配置的翻译 API」翻成目标语言，再塞回去。
 * 客户端（YouTube App / 移动版网页）完全无感，字幕直接变成目标语言。
 *
 * 拦截的三类接口：
 *   1) /api/timedtext?...              字幕文本本身，支持 json3 / srv3 / vtt / ttml
 *   2) /youtubei/v1/get_transcript     新版转录面板接口（JSON）
 *   3) /youtubei/v1/player             把 captionTracks[].baseUrl 的 fmt 改成 json3，保证可解析
 *
 * 翻译后端：
 *   openai  兼容 OpenAI / DeepSeek / Moonshot / 通义 / 智谱 / Ollama / one-api 等
 *   deepl   DeepL 官方 API（含 Free 版）
 *   google  translate.googleapis.com 免费接口（无 key，但有速率限制）
 *   custom  自定义 JSON 接口（自己写请求模板 + 响应取值路径）
 *
 * 配置来源优先级（后者覆盖前者）：
 *   脚本内置 DEFAULTS → $argument（Loon 插件参数）→ $persistentStore["ytst.config"]（JSON）
 *
 * 作者：YG
 */

/* ================================ 默认配置 ================================ */

var DEFAULTS = {
  // ---- 翻译后端 ----
  provider: 'openai',
  api_base_url: 'https://api.openai.com/v1/chat/completions',
  api_key: '',
  api_model: 'gpt-4o-mini',

  // ---- 语言 ----
  target_lang: 'zh-CN',
  source_lang: 'auto',

  // ---- 批量 / 限流 ----
  cues_per_request: 40,
  chars_per_request: 2500,
  max_cues: 500,
  timeout_ms: 95000,

  // ---- 行为开关 ----
  force_json3: true,
  cache: true,
  debug: false,

  // ---- 高级 ----
  system_prompt: '',
  custom_body: '{"texts": {{texts_json}}, "target": "{{target}}", "source": "{{source}}"}',
  custom_response_path: 'translations',
  custom_item_path: ''
};

var STORE_CONFIG = 'ytst.config';
var STORE_HINT = 'ytst.hint';
var STORE_STATS = 'ytst.stats';
var MAX_BODY_BYTES = 2000000; // 超过就不碰，避免内存/耗时爆炸
var CACHE_LIMIT = 400;        // 单个缓存文件最多保留多少条

/* ================================ 基础工具 ================================ */

function nowMs() {
  return Date.now();
}

function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  var s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function toInt(v, def, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = def;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

function readStore(key) {
  try {
    return $persistentStore.read(key);
  } catch (e) {
    return null;
  }
}

function writeStore(value, key) {
  try {
    $persistentStore.write(value, key);
    return true;
  } catch (e) {
    return false;
  }
}

function notify(title, subtitle, body) {
  try {
    $notification.post(title, subtitle || '', body || '');
  } catch (e) { /* 静默 */ }
}

// 同一类通知在 windowMs 内只弹一次，避免一次播放刷屏
function notifyThrottled(title, subtitle, body, windowMs) {
  var key = 'ytst.notice.' + title;
  var last = parseInt(readStore(key) || '0', 10);
  if (last && nowMs() - last < (windowMs || 600000)) return;
  writeStore(String(nowMs()), key);
  notify(title, subtitle, body);
}

// 轻量字符串哈希（FNV-1a + 乘法扰动），只用于缓存 key，不需要密码学强度
function hash(str) {
  var s = String(str);
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = ((h2 + c) * 2654435761) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function squash(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ');
}

/* ================================ 配置解析 ================================ */

function resolveConfig() {
  var cfg = {};
  var k;
  for (k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = DEFAULTS[k];
  }

  // 1) Loon 插件参数
  var arg = (typeof $argument !== 'undefined' && $argument) ? $argument : null;
  if (arg) {
    for (k in arg) {
      if (!Object.prototype.hasOwnProperty.call(arg, k)) continue;
      if (arg[k] === undefined || arg[k] === null || arg[k] === '') continue;
      cfg[k] = arg[k];
    }
  }

  // 2) 持久化配置（本地覆盖，适合放 key 或临时改后端）
  var raw = readStore(STORE_CONFIG);
  if (raw) {
    try {
      var overlay = JSON.parse(raw);
      for (k in overlay) {
        if (!Object.prototype.hasOwnProperty.call(overlay, k)) continue;
        if (overlay[k] === undefined || overlay[k] === null || overlay[k] === '') continue;
        cfg[k] = overlay[k];
      }
    } catch (e) { /* 配置坏了就退回默认 */ }
  }

  cfg.provider = String(cfg.provider || 'openai').toLowerCase().trim();
  cfg.api_base_url = String(cfg.api_base_url || DEFAULTS.api_base_url).trim();
  cfg.api_key = String(cfg.api_key || '').trim();
  cfg.api_model = String(cfg.api_model || DEFAULTS.api_model).trim();
  cfg.target_lang = String(cfg.target_lang || 'zh-CN').trim();
  cfg.source_lang = String(cfg.source_lang || 'auto').trim();
  cfg.system_prompt = String(cfg.system_prompt || '');
  cfg.custom_body = String(cfg.custom_body || DEFAULTS.custom_body);
  cfg.custom_response_path = String(cfg.custom_response_path || 'translations').trim();
  cfg.custom_item_path = String(cfg.custom_item_path || '').trim();

  cfg.cues_per_request = toInt(cfg.cues_per_request, 40, 1, 200);
  cfg.chars_per_request = toInt(cfg.chars_per_request, 2500, 200, 20000);
  cfg.max_cues = toInt(cfg.max_cues, 500, 1, 5000);
  cfg.timeout_ms = toInt(cfg.timeout_ms, 95000, 3000, 110000);

  cfg.force_json3 = toBool(cfg.force_json3, true);
  cfg.cache = toBool(cfg.cache, true);
  cfg.debug = toBool(cfg.debug, false);

  return cfg;
}

/* ================================ 入口分发 ================================ */

function main() {
  var cfg = resolveConfig();
  var url = ($request && $request.url) ? String($request.url) : '';
  var hasResponse = !!$response;
  var isPlayer = /\/youtubei\/v1\/player(\?|$)/.test(url);
  var isTranscript = /\/youtubei\/v1\/get_transcript(\?|$)/.test(url);
  var isTimedtext = /\/api\/timedtext(\?|$)/.test(url);

  if (!hasResponse) {
    // 请求阶段：目前只用于给 InnerTube 请求降级成 JSON（可选，默认不启用）
    return $done({});
  }

  if (isPlayer) return handlePlayer(cfg);
  if (isTranscript) return handleTranscript(cfg);
  if (isTimedtext) return handleTimedtext(cfg);

  return $done({});
}

/* ================================ 1. player：强制 json3 ================================ */

function setQueryParam(u, key, val) {
  var qIdx = u.indexOf('?');
  var base = qIdx >= 0 ? u.slice(0, qIdx) : u;
  var q = qIdx >= 0 ? u.slice(qIdx + 1) : '';
  var parts = q ? q.split('&') : [];
  var out = [];
  var found = false;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    var k = p.split('=')[0];
    if (k === key) {
      if (!found) {
        out.push(key + '=' + val);
        found = true;
      }
    } else {
      out.push(p);
    }
  }
  if (!found) out.push(key + '=' + val);
  return base + '?' + out.join('&');
}

function handlePlayer(cfg) {
  var body = $response && $response.body;
  if (!cfg.force_json3) return $done({});
  if (typeof body !== 'string' || !body || body.length > MAX_BODY_BYTES) return $done({});
  if (body.indexOf('timedtext') < 0) return $done({});

  var changed = false;

  var out = body.replace(/"baseUrl":"((?:[^"\\]|\\.)*)"/g, function (whole, raw) {
    if (raw.indexOf('timedtext') < 0) return whole;
    var hadEscapedAmp = raw.indexOf('\\u0026') >= 0;
    var plain = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    var fixed = setQueryParam(plain, 'fmt', 'json3');
    if (fixed === plain) return whole;
    changed = true;
    var encoded = hadEscapedAmp ? fixed.replace(/&/g, '\\u0026') : fixed;
    return '"baseUrl":"' + encoded + '"';
  });

  if (!changed) return $done({});
  return doneBody(cfg, out, 'player');
}

/* ================================ 2. 字幕格式解析 ================================ */

function detectFormat(body) {
  var s = String(body).replace(/^\uFEFF/, '').replace(/^\s+/, '');
  if (!s) return null;
  if (s.charAt(0) === '{') return 'json3';
  if (/^WEBVTT/.test(s)) return 'vtt';
  var head = s.slice(0, 2000);
  if (/<tt[\s>]/.test(head)) return 'ttml';
  if (/<timedtext[\s>]/.test(head)) return 'srv3';
  if (/<p[\s>]/.test(head)) return 'srv3';
  return null; // protobuf 或未知
}

/* --- json3 --- */
function collectJson3(root) {
  var texts = [];
  var events = [];
  var list = root && root.events ? root.events : [];
  for (var i = 0; i < list.length; i++) {
    var ev = list[i];
    if (!ev || !ev.segs || !ev.segs.length) continue;
    var s = '';
    for (var k = 0; k < ev.segs.length; k++) {
      var seg = ev.segs[k] || {};
      s += (seg.utf8 !== undefined ? seg.utf8 : (seg.text !== undefined ? seg.text : ''));
    }
    var plain = squash(s);
    if (!plain) continue;
    texts.push(plain);
    events.push(ev);
  }
  return {
    texts: texts,
    build: function (tr) {
      for (var j = 0; j < events.length; j++) {
        var t = tr[j];
        if (t === undefined || t === null || t === '') continue;
        var ev = events[j];
        if (!ev.segs || !ev.segs.length) {
          ev.segs = [{ utf8: String(t) }];
          continue;
        }
        ev.segs[0].utf8 = String(t);
        delete ev.segs[0].text;
        for (var q = 1; q < ev.segs.length; q++) {
          ev.segs[q].utf8 = '';
          delete ev.segs[q].text;
        }
      }
      return JSON.stringify(root);
    }
  };
}

/* --- srv3 / ttml：统一按 <p ...>inner</p> 处理 --- */
function collectXml(body, kind) {
  var texts = [];
  var pieces = [];
  var lastIndex = 0;
  var re = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g;
  var m;
  while ((m = re.exec(body)) !== null) {
    var inner = m[2] || '';
    var plain = squash(decodeEntities(stripTags(inner)));
    if (!plain) continue;
    pieces.push(body.slice(lastIndex, m.index));
    pieces.push({
      open: '<p' + (m[1] || '') + '>',
      index: texts.length,
      plain: plain,
      srv3: kind === 'srv3'
    });
    lastIndex = m.index + m[0].length;
    texts.push(plain);
  }
  pieces.push(body.slice(lastIndex));

  return {
    texts: texts,
    build: function (tr) {
      var buf = [];
      for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        if (typeof p === 'string') {
          buf.push(p);
          continue;
        }
        var t = tr[p.index];
        var txt = (t === undefined || t === null || t === '') ? p.plain : String(t);
        var inner = p.srv3 ? '<s>' + escapeXml(txt) + '</s>' : escapeXml(txt);
        buf.push(p.open + inner + '</p>');
      }
      return buf.join('');
    }
  };
}

/* --- vtt --- */
function collectVtt(body) {
  var blocks = String(body).split(/\r?\n\r?\n/);
  var texts = [];
  var refs = [];
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].split(/\r?\n/);
    var tIdx = -1;
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('-->') >= 0) { tIdx = j; break; }
    }
    if (tIdx < 0 || tIdx >= lines.length - 1) continue;
    var plain = squash(decodeEntities(stripTags(lines.slice(tIdx + 1).join(' '))));
    if (!plain) continue;
    texts.push(plain);
    refs.push({ block: i, from: tIdx + 1 });
  }
  return {
    texts: texts,
    build: function (tr) {
      for (var k = 0; k < refs.length; k++) {
        var ref = refs[k];
        var lines = blocks[ref.block].split(/\r?\n/);
        var t = tr[k];
        var txt = (t === undefined || t === null || t === '') ? lines.slice(ref.from).join(' ') : String(t);
        blocks[ref.block] = lines.slice(0, ref.from).concat([txt]).join('\n');
      }
      return blocks.join('\n\n');
    }
  };
}

/* ================================ 3. timedtext 处理 ================================ */

function handleTimedtext(cfg) {
  var body = $response && $response.body;
  if (typeof body !== 'string' || !body) return $done({});
  if (body.length > MAX_BODY_BYTES) return $done({});

  var fmt = detectFormat(body);
  if (!fmt) return hintUnsupported(cfg);

  var parsed;
  if (fmt === 'json3') {
    var root;
    try {
      root = JSON.parse(body);
    } catch (e) {
      return $done({});
    }
    parsed = collectJson3(root);
  } else if (fmt === 'vtt') {
    parsed = collectVtt(body);
  } else {
    parsed = collectXml(body, fmt);
  }

  if (!parsed.texts.length) return $done({});

  translateAll(parsed.texts, cfg, videoIdFromUrl(reqUrl()), function (tr) {
    var any = false;
    for (var i = 0; i < tr.length; i++) {
      if (typeof tr[i] === 'string' && tr[i] !== '') { any = true; break; }
    }
    if (!any) return $done({});
    return doneBody(cfg, parsed.build(tr), 'timedtext:' + fmt);
  });
}

/* ================================ 4. get_transcript 处理 ================================ */

function walkObject(node, visit, depth) {
  if (depth > 24 || node === null || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) walkObject(node[i], visit, depth + 1);
    return;
  }
  for (var k in node) {
    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
    walkObject(node[k], visit, depth + 1);
  }
}

function handleTranscript(cfg) {
  var body = $response && $response.body;
  if (typeof body !== 'string' || !body) return $done({});
  if (body.length > MAX_BODY_BYTES) return $done({});
  if (String(body).replace(/^\s+/, '').charAt(0) !== '{') return hintUnsupported(cfg);

  var root;
  try {
    root = JSON.parse(body);
  } catch (e) {
    return $done({});
  }

  var segs = [];
  walkObject(root, function (node) {
    if (!node || typeof node !== 'object' || !node.transcriptSegmentRenderer) return;
    var r = node.transcriptSegmentRenderer;
    var runs = r.snippet && r.snippet.runs;
    if (!runs || !runs.length) return;
    var text = '';
    for (var i = 0; i < runs.length; i++) text += (runs[i] && runs[i].text) ? runs[i].text : '';
    var plain = squash(text);
    if (!plain) return;
    segs.push({ runs: runs, text: plain });
  }, 0);

  if (!segs.length) return $done({});

  var texts = [];
  for (var i = 0; i < segs.length; i++) texts.push(segs[i].text);

  translateAll(texts, cfg, videoIdFromUrl(reqUrl()), function (tr) {
    var any = false;
    for (var j = 0; j < segs.length; j++) {
      var t = tr[j];
      if (t === undefined || t === null || t === '') continue;
      any = true;
      var runs = segs[j].runs;
      runs[0].text = String(t);
      for (var k = 1; k < runs.length; k++) runs[k].text = '';
    }
    if (!any) return $done({});
    return doneBody(cfg, JSON.stringify(root), 'get_transcript');
  });
}

/* ================================ 输出工具 ================================ */

function reqUrl() {
  return ($request && $request.url) ? String($request.url) : '';
}

function doneBody(cfg, body, tag) {
  if (cfg.debug) {
    try {
      console.log('[YT字幕] ' + tag + ' 已改写，长度 ' + body.length);
    } catch (e) { /* ignore */ }
  }
  return $done({ body: body });
}

function hintUnsupported(cfg) {
  var last = parseInt(readStore(STORE_HINT) || '0', 10);
  if (!last || nowMs() - last > 3600000) {
    writeStore(String(nowMs()), STORE_HINT);
    notify(
      'YouTube 字幕格式无法翻译',
      '收到的是 protobuf 或未知格式',
      '确认插件参数 force_json3=true；若仍无效，说明该客户端的 player 响应是二进制 protobuf。'
    );
  }
  return $done({});
}

/* ================================ 翻译调度 ================================ */

function videoIdFromUrl(url) {
  var m = /[?&]v=([A-Za-z0-9_\-]{6,})/.exec(url || '');
  if (m) return m[1];
  m = /\/embed\/([A-Za-z0-9_\-]{6,})/.exec(url || '');
  return m ? m[1] : 'na';
}

function cacheKeyOf(cfg, videoId) {
  return 'ytst.' + hash([
    videoId || 'na',
    cfg.target_lang,
    cfg.source_lang,
    cfg.provider,
    cfg.api_model
  ].join('|'));
}

function loadCache(key) {
  if (!key) return {};
  var raw = readStore(key);
  if (!raw) return {};
  try {
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function saveCache(key, map) {
  if (!key) return;
  var keys = [];
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) keys.push(k);
  }
  if (keys.length > CACHE_LIMIT) {
    var drop = keys.length - CACHE_LIMIT;
    for (var i = 0; i < drop; i++) delete map[keys[i]];
  }
  try {
    writeStore(JSON.stringify(map), key);
  } catch (e) { /* 缓存写失败不影响结果 */ }
}

/*
 * translateAll(texts, cfg, videoId, finish)
 * 统一处理：缓存命中 → 分片 → 串行请求 → 超时保护 → 回写缓存
 * finish(results) 中未被翻译的位置为 undefined，调用方保留原文
 */
function translateAll(texts, cfg, videoId, finish) {
  var t0 = nowMs();
  var deadline = nowMs() + cfg.timeout_ms;
  var results = new Array(texts.length);
  var ck = cfg.cache ? cacheKeyOf(cfg, videoId) : null;
  var cacheMap = loadCache(ck);
  var pending = [];
  var i;

  for (i = 0; i < texts.length; i++) {
    var h = hash(texts[i]);
    if (cacheMap[h] !== undefined) results[i] = cacheMap[h];
    else pending.push(i);
  }

  function finishDebug() {
    if (cfg.debug) {
      var done = 0;
      for (var z = 0; z < results.length; z++) if (results[z] !== undefined) done++;
      notifyThrottled('YT字幕 · 已翻译',
        done + '/' + results.length + ' 条',
        cfg.provider + ' · ' + (nowMs() - t0) + 'ms' + (failures ? ' · 失败 ' + failures + ' 片' : ''),
        5000);
    }
    return finish(results);
  }

  if (!pending.length) return finishDebug();
  if (pending.length > cfg.max_cues) pending = pending.slice(0, cfg.max_cues);

  // 按条数与字符预算切片
  var chunks = [];
  var cur = [];
  var curChars = 0;
  for (i = 0; i < pending.length; i++) {
    var idx = pending[i];
    var len = texts[idx].length;
    if (cur.length && (cur.length >= cfg.cues_per_request || curChars + len > cfg.chars_per_request)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(idx);
    curChars += len;
  }
  if (cur.length) chunks.push(cur);

  var ci = 0;
  var failures = 0;

  function step() {
    if (ci >= chunks.length) {
      saveCache(ck, cacheMap);
      return finishDebug();
    }
    if (nowMs() > deadline) {
      if (cfg.debug) console.log('[YT字幕] 超时，剩余 ' + (chunks.length - ci) + ' 片未翻译');
      saveCache(ck, cacheMap);
      return finishDebug();
    }

    var chunk = chunks[ci++];
    var input = [];
    for (var q = 0; q < chunk.length; q++) input.push(texts[chunk[q]]);

    callProvider(input, cfg, function (err, out) {
      if (!err && out && out.length === input.length) {
        for (var w = 0; w < chunk.length; w++) {
          var val = out[w];
          if (val === undefined || val === null) continue;
          results[chunk[w]] = String(val);
          cacheMap[hash(texts[chunk[w]])] = String(val);
        }
      } else {
        failures++;
        if (failures <= 2) {
          notifyThrottled('字幕翻译失败',
            String(err || '返回条数不一致').slice(0, 90),
            (out ? 'got ' + out.length + '/' + input.length + ' 条 · ' : '') + '检查 api_key / api_model / 接口地址',
            180000);
        }
      }
      step();
    });
  }

  step();
}

function callProvider(texts, cfg, cb) {
  var p = cfg.provider;
  if (p === 'deepl') return callDeepL(texts, cfg, cb);
  if (p === 'google' || p === 'googlefree' || p === 'gtx') return callGoogle(texts, cfg, cb);
  if (p === 'custom') return callCustom(texts, cfg, cb);
  return callOpenAI(texts, cfg, cb);
}

/* ================================ 后端：OpenAI 兼容 ================================ */

function buildSystemPrompt(cfg) {
  if (cfg.system_prompt) return cfg.system_prompt;
  var src = (cfg.source_lang && cfg.source_lang !== 'auto') ? cfg.source_lang : '原文语言';
  var parts = [];
  parts.push('你是专业的影视字幕翻译。把每条字幕从 ' + src + ' 翻译成 ' + cfg.target_lang + '。');
  parts.push('要求：');
  parts.push('1. 保持口语自然、简洁，符合屏幕字幕的阅读节奏，不要书面腔。');
  parts.push('2. 严格保持条数与顺序：不合并、不拆分、不增删，第 N 条对应第 N 条。');
  parts.push('3. 纯音乐、音效、符号、人名占位等没有可译内容的条目，原样返回。');
  parts.push('4. 不要输出解释、注释、代码块，只返回一个 JSON 字符串数组，长度与输入相同。');
  if (cfg.source_lang === 'auto') parts.push('5. 源语言未知，按内容自动判断，不要在同一批里混用多种目标语言。');
  return parts.join('\n');
}

function parseJsonArray(text) {
  var s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  var start = s.indexOf('[');
  var end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    var arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

function callOpenAI(texts, cfg, cb) {
  var payload = {
    model: cfg.api_model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSystemPrompt(cfg) },
      { role: 'user', content: '共 ' + texts.length + ' 条：\n' + JSON.stringify(texts) }
    ]
  };
  var headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;

  $httpClient.post({
    url: cfg.api_base_url,
    headers: headers,
    body: JSON.stringify(payload)
  }, function (err, resp, data) {
    if (err) return cb(String(err));
    var status = resp && resp.status ? parseInt(resp.status, 10) : 0;
    if (status && (status < 200 || status >= 300)) {
      return cb('HTTP ' + status + ' ' + String(data || '').slice(0, 160));
    }
    var content = '';
    try {
      var j = JSON.parse(data);
      content = j && j.choices && j.choices[0] && j.choices[0].message
        ? j.choices[0].message.content
        : '';
    } catch (e) {
      return cb('响应非 JSON：' + String(data || '').slice(0, 120));
    }
    if (!content) return cb('响应缺少 choices[0].message.content');

    var arr = parseJsonArray(content);
    if (!arr) return cb('模型未返回 JSON 数组');
    if (arr.length === texts.length) {
      var exact = [];
      for (var i = 0; i < arr.length; i++) exact.push(arr[i] === null || arr[i] === undefined ? '' : String(arr[i]));
      return cb(null, exact);
    }
    // 条数不一致时尽量对齐，缺的留空（调用方回退原文）
    var loose = [];
    for (var k = 0; k < texts.length; k++) {
      loose.push(k < arr.length && arr[k] !== null && arr[k] !== undefined ? String(arr[k]) : '');
    }
    if (cfg.debug) console.log('[YT字幕] 条数不一致 ' + arr.length + '/' + texts.length + '，已按序对齐');
    return cb(null, loose);
  });
}

/* ================================ 后端：DeepL ================================ */

function deeplTarget(lang) {
  var s = String(lang || '').toLowerCase();
  if (s === 'zh' || s === 'zh-cn' || s === 'zh-hans') return 'ZH-HANS';
  if (s === 'zh-tw' || s === 'zh-hant' || s === 'zh-hk') return 'ZH-HANT';
  return String(lang || 'EN').split('-')[0].toUpperCase();
}

function callDeepL(texts, cfg, cb) {
  var url = cfg.api_base_url && /deepl\.com/.test(cfg.api_base_url)
    ? cfg.api_base_url
    : 'https://api-free.deepl.com/v2/translate';

  var pieces = [];
  for (var i = 0; i < texts.length; i++) pieces.push('text=' + encodeURIComponent(texts[i]));
  pieces.push('target_lang=' + encodeURIComponent(deeplTarget(cfg.target_lang)));
  if (cfg.source_lang && cfg.source_lang !== 'auto') {
    pieces.push('source_lang=' + encodeURIComponent(cfg.source_lang.split('-')[0].toUpperCase()));
  }

  $httpClient.post({
    url: url,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'DeepL-Auth-Key ' + cfg.api_key
    },
    body: pieces.join('&')
  }, function (err, resp, data) {
    if (err) return cb(String(err));
    var status = resp && resp.status ? parseInt(resp.status, 10) : 0;
    if (status && (status < 200 || status >= 300)) {
      return cb('HTTP ' + status + ' ' + String(data || '').slice(0, 160));
    }
    try {
      var j = JSON.parse(data);
      if (!j || !j.translations) return cb('响应缺少 translations');
      var out = [];
      for (var k = 0; k < j.translations.length; k++) out.push(j.translations[k].text);
      if (out.length !== texts.length) return cb('条数不一致 ' + out.length + '/' + texts.length);
      return cb(null, out);
    } catch (e) {
      return cb('响应解析失败');
    }
  });
}

/* ================================ 后端：Google 免费接口 ================================ */

function callGoogle(texts, cfg, cb) {
  var limit = Math.min(texts.length, 120); // 免费接口别打太狠
  var out = new Array(texts.length);
  var next = 0;
  var active = 0;
  var finished = 0;
  var started = 0;

  function pump() {
    if (finished >= limit) return cb(null, out);
    while (active < 3 && next < limit) {
      var idx = next++;
      active++;
      started++;
      (function (i) {
        var url = 'https://translate.googleapis.com/translate_a/single'
          + '?client=gtx&dt=t'
          + '&sl=' + encodeURIComponent(cfg.source_lang === 'auto' ? 'auto' : cfg.source_lang)
          + '&tl=' + encodeURIComponent(cfg.target_lang)
          + '&q=' + encodeURIComponent(texts[i]);
        $httpClient.get({ url: url, headers: { 'User-Agent': 'Mozilla/5.0' } }, function (err, resp, data) {
          active--;
          finished++;
          if (!err && data) {
            try {
              var j = JSON.parse(data);
              if (j && j[0] && j[0].length) {
                var s = '';
                for (var k = 0; k < j[0].length; k++) {
                  if (j[0][k] && j[0][k][0]) s += j[0][k][0];
                }
                if (s) out[i] = s;
              }
            } catch (e) { /* 单条失败不影响其它 */ }
          }
          pump();
        });
      })(idx);
    }
  }

  pump();
}

/* ================================ 后端：自定义 JSON 接口 ================================ */

function getPath(obj, path) {
  if (!path) return obj;
  var parts = String(path).split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    var key = parts[i];
    if (key === '') continue;
    if (Array.isArray(cur) && /^\d+$/.test(key)) {
      cur = cur[parseInt(key, 10)];
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

function callCustom(texts, cfg, cb) {
  var body = cfg.custom_body
    .replace(/\{\{\s*texts_json\s*\}\}/g, JSON.stringify(texts))
    .replace(/\{\{\s*target\s*\}\}/g, cfg.target_lang)
    .replace(/\{\{\s*source\s*\}\}/g, cfg.source_lang)
    .replace(/\{\{\s*model\s*\}\}/g, cfg.api_model)
    .replace(/\{\{\s*api_key\s*\}\}/g, cfg.api_key);

  var headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;

  $httpClient.post({ url: cfg.api_base_url, headers: headers, body: body }, function (err, resp, data) {
    if (err) return cb(String(err));
    var status = resp && resp.status ? parseInt(resp.status, 10) : 0;
    if (status && (status < 200 || status >= 300)) {
      return cb('HTTP ' + status + ' ' + String(data || '').slice(0, 160));
    }
    var j;
    try {
      j = JSON.parse(data);
    } catch (e) {
      return cb('响应非 JSON');
    }
    var node = getPath(j, cfg.custom_response_path);
    if (!Array.isArray(node)) return cb('custom_response_path 未取到数组');
    var out = [];
    for (var i = 0; i < node.length; i++) {
      var item = node[i];
      if (typeof item === 'string') out.push(item);
      else out.push(getPath(item, cfg.custom_item_path));
    }
    if (out.length !== texts.length) return cb('条数不一致 ' + out.length + '/' + texts.length);
    return cb(null, out);
  });
}

/* ================================ 启动 ================================ */

main();
