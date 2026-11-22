/*
 * 本地自测：在 Node 里用 vm 模拟 Loon 运行时（$request/$response/$done/$httpClient/$persistentStore），
 * 直接跑 scripts/yt-subtitle-translate.js，验证四种字幕格式、pass-through、player 改写和缓存。
 *
 * 运行：node test/run.js
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'yt-subtitle-translate.js'), 'utf8');

function extractUserTexts(bodyString) {
  const req = JSON.parse(bodyString);
  const content = req.messages[1].content;
  const a = content.indexOf('[');
  const b = content.lastIndexOf(']');
  return JSON.parse(content.slice(a, b + 1));
}

function run(opts) {
  const store = opts.store || {};
  const notes = [];
  const calls = [];
  const done = [];
  const arg = Object.assign({ provider: 'openai', api_key: 'sk-test', cache: 'true' }, opts.argument || {});

  const translator = opts.translate || function (o, cb) {
    const texts = extractUserTexts(o.body);
    const out = texts.map(function (t) { return '译:' + t; });
    cb(null, { status: 200 }, JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  };

  const sandbox = {
    console: { log: function () {} },
    JSON, Date, Math, Object, Array, String, Number, RegExp, Boolean, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    $request: { url: opts.url, headers: {} },
    $response: { body: opts.body, status: 200, headers: {} },
    $argument: arg,
    $done: function (o) { done.push(o === undefined ? {} : o); },
    $notification: { post: function (t, s, b) { notes.push([t, s, b]); } },
    $persistentStore: {
      read: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      write: function (v, k) { store[k] = v; return true; }
    },
    $httpClient: {
      post: function (o, cb) { calls.push(o); return translator(o, cb); },
      get: function (o, cb) { calls.push(o); return translator(o, cb); }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'yt-subtitle-translate.js' });
  return { done: done, calls: calls, notes: notes, store: store };
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' :: ' + e.message]);
  }
}

const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3';

/* ---------------------------------------------------------------- 1. json3 */
test('json3：翻译并保留时间轴', function () {
  const body = JSON.stringify({
    wireMagic: 'pb3',
    events: [
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 1200, dDurationMs: 900, segs: [{ utf8: '   ' }] },
      { tStartMs: 2100, dDurationMs: 1000, segs: [{ utf8: 'Bye' }] }
    ]
  });
  const r = run({ url: TIMEDTEXT, body: body });
  assert.strictEqual(r.done.length, 1, '应只调用一次 $done');
  const out = JSON.parse(r.done[0].body);
  assert.strictEqual(out.events[0].segs[0].utf8, '译:Hello world');
  assert.strictEqual(out.events[0].segs[1].utf8, '');
  assert.strictEqual(out.events[0].tStartMs, 0);
  assert.strictEqual(out.events[0].dDurationMs, 1200);
  assert.strictEqual(out.events[1].segs[0].utf8, '   ', '空白事件不应被改写');
  assert.strictEqual(out.events[2].segs[0].utf8, '译:Bye');
  assert.strictEqual(out.events[2].tStartMs, 2100);
  assert.strictEqual(r.calls.length, 1, '应只发一次翻译请求');
});

/* ---------------------------------------------------------------- 2. srv3 */
test('srv3：翻译 <p> 内文本，保留属性与转义', function () {
  const body = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>'
    + '<p t="0" d="1200"><s>Hello</s><s> world</s></p>'
    + '<p t="1200" d="900">Bye &amp; ok</p>'
    + '</body></timedtext>';
  const r = run({ url: TIMEDTEXT, body: body });
  const out = r.done[0].body;
  assert.ok(out.indexOf('<p t="0" d="1200"><s>译:Hello world</s></p>') >= 0, '第一段未正确改写:\n' + out);
  assert.ok(out.indexOf('<p t="1200" d="900"><s>译:Bye &amp; ok</s></p>') >= 0, '第二段未正确改写或转义错误:\n' + out);
  assert.ok(out.indexOf('<timedtext format="3">') >= 0, '外层结构被破坏');
});

/* ---------------------------------------------------------------- 3. vtt */
test('vtt：翻译 cue 文本，保留时间行', function () {
  const body = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nHello\nworld\n\n00:00:01.200 --> 00:00:02.100\nBye\n';
  const r = run({ url: TIMEDTEXT, body: body });
  const out = r.done[0].body;
  assert.ok(out.indexOf('00:00:00.000 --> 00:00:01.200') >= 0, '时间行丢失');
  assert.ok(out.indexOf('译:Hello world') >= 0, '第一条未翻译:\n' + out);
  assert.ok(out.indexOf('译:Bye') >= 0, '第二条未翻译:\n' + out);
  assert.ok(/^WEBVTT/.test(out), 'WEBVTT 头丢失');
});

/* ---------------------------------------------------------------- 4. ttml */
test('ttml：翻译 <p> 内文本', function () {
  const body = '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
    + '<p begin="00:00:00.000" end="00:00:01.200">Hello there</p></div></body></tt>';
  const r = run({ url: TIMEDTEXT, body: body });
  const out = r.done[0].body;
  assert.ok(out.indexOf('<p begin="00:00:00.000" end="00:00:01.200">译:Hello there</p>') >= 0, 'ttml 未改写:\n' + out);
});

/* -------------------------------------------------- 5. get_transcript JSON */
test('get_transcript：翻译 transcriptSegmentRenderer', function () {
  const body = JSON.stringify({
    actions: [{
      updateEngagementPanelAction: {
        content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: {
          body: { transcriptSegmentListRenderer: {
            initialSegments: [
              { transcriptSegmentRenderer: { startMs: '0', endMs: '1200', snippet: { runs: [{ text: 'Hi ' }, { text: 'there' }] } } },
              { transcriptSegmentRenderer: { startMs: '1200', endMs: '2100', snippet: { runs: [{ text: 'Bye' }] } } }
            ]
          } }
        } } } }
      }
    }]
  });
  const r = run({ url: 'https://www.youtube.com/youtubei/v1/get_transcript?key=x', body: body });
  const out = JSON.parse(r.done[0].body);
  const segs = out.actions[0].updateEngagementPanelAction.content.transcriptRenderer
    .content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments;
  assert.strictEqual(segs[0].transcriptSegmentRenderer.snippet.runs[0].text, '译:Hi there');
  assert.strictEqual(segs[0].transcriptSegmentRenderer.snippet.runs[1].text, '');
  assert.strictEqual(segs[1].transcriptSegmentRenderer.snippet.runs[0].text, '译:Bye');
  assert.strictEqual(segs[0].transcriptSegmentRenderer.startMs, '0', '时间字段被破坏');
});

/* ---------------------------------------------------------- 6. player 改写 */
test('player：baseUrl 的 fmt 改成 json3 且保留 \\u0026 编码', function () {
  const body = '{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":'
    + '[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc123\\u0026lang=en\\u0026fmt=pb",'
    + '"name":{"simpleText":"English"}}]}}}';
  const r = run({
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    body: body,
    argument: { prefetch: false }   // 单独测改写，关掉预热
  });
  const out = r.done[0].body;
  assert.ok(out.indexOf('fmt=json3') >= 0, 'fmt 未改成 json3:\n' + out);
  assert.ok(out.indexOf('fmt=pb') < 0, '仍存在 fmt=pb');
  assert.strictEqual((out.match(/\\u0026/g) || []).length, 2, '\\u0026 编码数量不对:\n' + out);
  assert.strictEqual(r.calls.length, 0, 'player 改写不应调用翻译 API');
});

test('player：prefetch 预热字幕并写缓存，后续 timedtext 直接命中', function () {
  const playerBody = '{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":'
    + '[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc123\\u0026lang=en\\u0026fmt=pb",'
    + '"name":{"simpleText":"English"}}]}}}';
  const store = {};
  let timedtextFetch = 0;
  const r = run({
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    body: playerBody,
    store: store,
    argument: { prefetch: true, cache: true },
    translate: function (o, cb) {
      if (/\/api\/timedtext/.test(o.url)) {
        timedtextFetch++;
        assert.ok(/fmt=json3/.test(o.url), '预热应请求 json3：' + o.url);
        return cb(null, { status: 200 }, JSON.stringify({ events: [
          { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }
        ] }));
      }
      const texts = extractUserTexts(o.body);
      cb(null, { status: 200 }, JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(function (t) { return '译:' + t; })) } }] }));
    }
  });
  assert.strictEqual(timedtextFetch, 1, '应预取一次字幕');
  const keys = Object.keys(store).filter(function (k) { return k.indexOf('ytst.') === 0; });
  assert.ok(keys.length >= 1, '预热后应有缓存 key，实际：' + JSON.stringify(Object.keys(store)));
  assert.ok(JSON.stringify(store[keys[0]]).indexOf('译:Hi') >= 0, '缓存里应有译文');

  // 第二次真正请求字幕：应完全命中缓存，不再调用翻译 API
  const r2 = run({
    url: 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3',
    body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }),
    store: store,
    argument: { prefetch: false, cache: true },
    translate: function (o, cb) { assert.fail('命中缓存后不应再请求翻译 API'); }
  });
  const out2 = JSON.parse(r2.done[0].body);
  assert.strictEqual(out2.events[0].segs[0].utf8, '译:Hi');
});

test('player：force_json3=false 时不动响应', function () {
  const body = '{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&fmt=pb"}]}';
  const r = run({
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    body: body,
    argument: { force_json3: 'false' }
  });
  assert.strictEqual(JSON.stringify(r.done), "[{}]");
});

/* ------------------------------------------------------- 7. protobuf 放行 */
test('protobuf/未知格式：原样放行并只提示一次', function () {
  const store = {};
  const body = '\n\u0012\u0008hello\u0001\u0002';
  const r1 = run({ url: TIMEDTEXT, body: body, store: store });
  assert.strictEqual(JSON.stringify(r1.done), "[{}]", '不应改写');
  assert.strictEqual(r1.notes.length, 1, '应提示一次');
  const r2 = run({ url: TIMEDTEXT, body: body, store: store });
  assert.strictEqual(r2.notes.length, 0, '一小时内不应重复提示');
});

test('空响应不崩溃', function () {
  const r = run({ url: TIMEDTEXT, body: '' });
  assert.strictEqual(JSON.stringify(r.done), "[{}]");
});

/* --------------------------------------------------------------- 8. 缓存 */
test('缓存：同视频第二次不再请求翻译 API', function () {
  const store = {};
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }] });
  const r1 = run({ url: TIMEDTEXT, body: body, store: store });
  assert.strictEqual(r1.calls.length, 1);
  const r2 = run({ url: TIMEDTEXT, body: body, store: store });
  assert.strictEqual(r2.calls.length, 0, '第二次应全部命中缓存');
  assert.strictEqual(JSON.parse(r2.done[0].body).events[0].segs[0].utf8, '译:Hello');
});

test('cache=false 时不写缓存', function () {
  const store = {};
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }] });
  run({ url: TIMEDTEXT, body: body, store: store, argument: { cache: 'false' } });
  const keys = Object.keys(store).filter(function (k) { return k.indexOf('ytst.') === 0 && k !== 'ytst.hint'; });
  assert.deepStrictEqual(keys, []);
});

/* ----------------------------------------------------- 9. 后端适配器分支 */
test('deepl：表单编码与响应解析', function () {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: { provider: 'deepl', api_key: 'k', source_lang: 'en', target_lang: 'zh-CN' },
    translate: function (o, cb) {
      assert.ok(/target_lang=ZH-HANS/.test(o.body), 'target_lang 映射错误: ' + o.body);
      assert.ok(/source_lang=EN/.test(o.body), 'source_lang 未映射');
      assert.ok(/Authorization/.test(JSON.stringify(o.headers)));
      cb(null, { status: 200 }, JSON.stringify({ translations: [{ text: '译:Hi' }] }));
    }
  });
  assert.strictEqual(JSON.parse(r.done[0].body).events[0].segs[0].utf8, '译:Hi');
});

test('custom：模板替换 + 取值路径', function () {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: {
      provider: 'custom',
      api_base_url: 'https://api.example.com/translate',
      custom_body: '{"q": {{texts_json}}, "to": "{{target}}"}',
      custom_response_path: 'data.result',
      custom_item_path: 'text'
    },
    translate: function (o, cb) {
      const sent = JSON.parse(o.body);
      assert.deepStrictEqual(sent.q, ['Hi']);
      assert.strictEqual(sent.to, 'zh-CN');
      cb(null, { status: 200 }, JSON.stringify({ data: { result: [{ text: '译:Hi' }] } }));
    }
  });
  assert.strictEqual(JSON.parse(r.done[0].body).events[0].segs[0].utf8, '译:Hi');
});

test('HTTP 500：保留原文字幕不破坏结构', function () {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    translate: function (o, cb) { cb(null, { status: 500 }, 'boom'); }
  });
  assert.strictEqual(JSON.stringify(r.done), "[{}]", '全部失败时应原样放行');
});

test('模型返回条数不足：缺的位置保留原文', function () {
  const body = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'A' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'B' }] }
  ] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    translate: function (o, cb) {
      cb(null, { status: 200 }, JSON.stringify({ choices: [{ message: { content: '["译:A"]' } }] }));
    }
  });
  const out = JSON.parse(r.done[0].body);
  assert.strictEqual(out.events[0].segs[0].utf8, '译:A');
  assert.strictEqual(out.events[1].segs[0].utf8, 'B', '缺译位置应保留原文');
});

/* ------------------------------------------------- Gemini 原生后端（Interactions API） */
test('gemini 原生：x-goog-api-key + output_text 形状', function () {
  const body = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'A' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'B' }] }
  ] });
  let seen = null;
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: { provider: 'gemini', api_key: 'AQ.test', api_model: 'gemini-3.7-flash', cache: false },
    translate: function (o, cb) {
      seen = o;
      cb(null, { status: 200 }, JSON.stringify({ id: 'int_1', status: 'completed', output_text: '["译:A","译:B"]' }));
    }
  });
  assert.ok(/generativelanguage\.googleapis\.com\/v1beta\/interactions/.test(seen.url), '接口地址应自动指向 Interactions API');
  assert.strictEqual(seen.headers['x-goog-api-key'], 'AQ.test', '新版 key 必须走 x-goog-api-key');
  assert.strictEqual(seen.headers['Authorization'], undefined);
  const payload = JSON.parse(seen.body);
  assert.strictEqual(payload.model, 'gemini-3.7-flash');
  assert.ok(payload.input.indexOf('["A","B"]') >= 0, '待翻译数组应塞进 input');
  const out = JSON.parse(r.done[0].body);
  assert.strictEqual(out.events[0].segs[0].utf8, '译:A');
  assert.strictEqual(out.events[1].segs[0].utf8, '译:B');
});

test('gemini 原生：嵌套 outputs[].content[].text 形状也能解析', function () {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: { provider: 'gemini', api_key: 'AQ.test', cache: false },
    translate: function (o, cb) {
      cb(null, { status: 200 }, JSON.stringify({
        status: 'completed',
        outputs: [{ type: 'text', content: [{ type: 'text', text: '["译:Hi"]' }] }]
      }));
    }
  });
  const out = JSON.parse(r.done[0].body);
  assert.strictEqual(out.events[0].segs[0].utf8, '译:Hi');
});

test('gemini 原生：HTTP 401 通知里带状态码', function () {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] });
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: { provider: 'gemini', api_key: 'bad', cache: false },
    translate: function (o, cb) { cb(null, { status: 401 }, '{"error":{"message":"API key not valid"}}'); }
  });
  assert.strictEqual(JSON.stringify(r.done), "[{}]", '失败时原样放行');
  const joined = JSON.stringify(r.notes);
  assert.ok(/HTTP 401/.test(joined), '应弹出带状态码的失败通知');
});

/* ------------------------------------------------- 插件参数类型（新语法） */
test('插件参数对象：Number / Boolean 类型直接生效', function () {
  const body = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'A' }] },
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'B' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'C' }] }
  ] });
  // 新版 [Argument] 声明 type=number / switch 时，$argument 收到的是真正的 Number / Boolean
  const r = run({
    url: TIMEDTEXT,
    body: body,
    argument: { cues_per_request: 1, chars_per_request: 5000, max_cues: 10, timeout_ms: 90000, cache: true, force_json3: true, debug: false }
  });
  assert.strictEqual(r.calls.length, 3, 'cues_per_request=1 应切成三次请求');
  const out = JSON.parse(r.done[0].body);
  assert.strictEqual(out.events[0].segs[0].utf8, '译:A');
  assert.strictEqual(out.events[2].segs[0].utf8, '译:C');
});

test('插件参数对象：force_json3 为 Boolean false 时不改写 player', function () {
  const playerBody = JSON.stringify({
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=pb', languageCode: 'en' }
    ] } }
  });
  const r = run({
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    body: playerBody,
    argument: { force_json3: false }
  });
  assert.strictEqual(JSON.stringify(r.done), "[{}]", 'Boolean false 应走放行分支');
});

/* --------------------------------------------------------------- 输出 */
let failed = 0;
results.forEach(function (row) {
  if (row[0] === 'FAIL') failed++;
  console.log((row[0] === 'PASS' ? '  ok   ' : '  FAIL ') + row[1]);
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
