/*
 * yt-subtitle-config.js · Loon 配置助手
 *
 * 两种用法：
 *   A. 在 Loon「脚本」页面手动运行一次，把下面的 CONFIG 写进本地持久化配置；
 *   B. 挂成 cron 定时同步（不常用）。
 *
 * 优先级：$persistentStore["ytst.config"] 会覆盖插件参数 [Argument] 里的同名项。
 * 所以这里适合放 api_key 这种不想写在插件里的东西。
 *
 * 传参式调用（可选）：$argument.action = save | show | reset
 *   save  把 CONFIG 写入（默认）
 *   show  只弹出当前有效配置（key 打码）
 *   reset 清空持久化配置，回到插件参数
 */

var CONFIG = {
  // provider: openai | deepl | google | custom
  provider: 'openai',
  api_base_url: 'https://api.openai.com/v1/chat/completions',
  api_key: 'sk-在这里填你的 key',
  api_model: 'gpt-4o-mini',
  target_lang: 'zh-CN',
  source_lang: 'auto',

  // 可选：只想临时覆盖部分项时，把不需要的注释掉或删掉
  // cues_per_request: 40,
  // chars_per_request: 2500,
  // max_cues: 500,
  // force_json3: true,
  // cache: true,
  // debug: false
};

var STORE_CONFIG = 'ytst.config';

function mask(key) {
  var s = String(key || '');
  if (!s) return '(空)';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

function currentConfig() {
  var arg = (typeof $argument !== 'undefined' && $argument) ? $argument : {};
  var stored = {};
  var raw = $persistentStore.read(STORE_CONFIG);
  if (raw) {
    try {
      stored = JSON.parse(raw) || {};
    } catch (e) {
      stored = {};
    }
  }
  var merged = {};
  var k;
  for (k in arg) if (Object.prototype.hasOwnProperty.call(arg, k)) merged[k] = arg[k];
  for (k in stored) if (Object.prototype.hasOwnProperty.call(stored, k)) merged[k] = stored[k];
  return merged;
}

function show() {
  var cfg = currentConfig();
  var keys = ['provider', 'api_base_url', 'api_model', 'target_lang', 'source_lang', 'force_json3', 'cache'];
  var lines = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (cfg[k] !== undefined && cfg[k] !== '') lines.push(k + ' = ' + cfg[k]);
  }
  lines.push('api_key = ' + mask(cfg.api_key));
  $notification.post('YouTube 字幕翻译 · 当前配置', '', lines.join('\n'));
  $done({});
}

function save() {
  var out = {};
  var n = 0;
  for (var k in CONFIG) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG, k)) continue;
    if (CONFIG[k] === undefined || CONFIG[k] === null || CONFIG[k] === '') continue;
    out[k] = CONFIG[k];
    n++;
  }
  var ok = $persistentStore.write(JSON.stringify(out), STORE_CONFIG);
  $notification.post(
    'YouTube 字幕翻译 · 配置已写入',
    ok ? '共 ' + n + ' 项' : '写入失败',
    'provider = ' + out.provider + '\nmodel = ' + (out.api_model || '-') + '\napi_key = ' + mask(out.api_key)
  );
  $done({});
}

function reset() {
  $persistentStore.write('', STORE_CONFIG);
  $notification.post('YouTube 字幕翻译 · 已清空本地配置', '', '现在完全使用插件参数 [Argument]');
  $done({});
}

var action = (typeof $argument !== 'undefined' && $argument && $argument.action)
  ? String($argument.action).toLowerCase()
  : 'save';

if (action === 'show') show();
else if (action === 'reset') reset();
else save();
