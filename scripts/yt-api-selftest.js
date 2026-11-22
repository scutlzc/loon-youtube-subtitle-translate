/*
 * Loon 自检脚本：只测「这台手机能不能把 JSON POST 发出去并收到回复」。
 * 不碰 YouTube、不碰字幕、不碰插件逻辑，把变量压到最小。
 *
 * 触发方式：Safari 打开 http://loon.selftest
 * 参数：api_key / api_base_url / api_model（在 SelfTest.plugin 里填）
 *
 * 两条通知：
 *   ① GET  <状态> <耗时>ms      —— 无请求体，验证 DNS/TLS/链路
 *   ② POST <状态> <耗时>ms      —— 带 JSON 体，验证是否被 MTU/代理丢掉
 * 若 ①快 ②挂 → MTU/代理；若 ①也挂 → 整条链路；若 ②返回 401 → 只是 key
 */
var DEFAULTS = {
  api_base_url: 'https://api.deepseek.com/chat/completions',
  api_model: 'deepseek-flash',
  api_key: ''
};

function cleanKey(v) {
  var k = String(v == null ? '' : v);
  for (var i = 0; i < 4; i++) {
    k = k.replace(/[\r\n\t]/g, '').trim();
    k = k.replace(/^["'`]+|["'`]+$/g, '');
    k = k.replace(/^Bearer[\s:]+/i, '');
    k = k.replace(/\s+/g, '');
  }
  return k;
}

function cfg() {
  var arg = (typeof $argument !== 'undefined' && $argument) ? $argument : {};
  var out = {};
  for (var k in DEFAULTS) out[k] = DEFAULTS[k];
  for (var k2 in out) {
    if (Object.prototype.hasOwnProperty.call(arg, k2) && arg[k2] !== null && arg[k2] !== undefined && String(arg[k2]) !== '') {
      out[k2] = String(arg[k2]);
    }
  }
  out.api_key = cleanKey(out.api_key);
  if (out.api_base_url && !/^https?:\/\//i.test(out.api_base_url)) out.api_base_url = 'https://' + out.api_base_url;
  return out;
}

function hostOf(u) {
  var m = String(u || '').match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1] : String(u || '');
}

function notify(title, subtitle, body) {
  try {
    if (typeof $notification !== 'undefined' && $notification && $notification.post) {
      $notification.post(title, subtitle, body);
    }
  } catch (e) { /* 忽略 */ }
}

function t0() { return new Date().getTime(); }

var c = cfg();
var host = hostOf(c.api_base_url);
var started = t0();

// ① GET：不带请求体
$httpClient.get({
  url: 'https://' + host + '/',
  headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
}, function (err, resp, data) {
  var ms = t0() - started;
  notify('① GET ' + (err ? '失败' : ((resp && resp.status) || '无状态')),
    ms + 'ms · ' + host,
    err ? String(err).slice(0, 100) : '无请求体也能通 → DNS/TLS/链路正常');

  // ② POST：带 JSON 体
  var started2 = t0();
  var payload = {
    model: c.api_model,
    messages: [{ role: 'user', content: '只回两个字：收到' }]
  };
  var headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Encoding': 'identity',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  };
  if (c.api_key) headers['Authorization'] = 'Bearer ' + c.api_key;

  $httpClient.post({ url: c.api_base_url, headers: headers, body: JSON.stringify(payload) }, function (err2, resp2, data2) {
    var ms2 = t0() - started2;
    var st = (resp2 && resp2.status) || 0;
    var verdict;
    if (err2) verdict = '链路/代理问题：' + String(err2).slice(0, 80);
    else if (st === 200) verdict = '✅ 手机侧完全正常，问题在插件配置或字幕链路';
    else if (st === 401) verdict = 'key 被拒（401）：重新生成或重新粘贴 key';
    else if (st === 402) verdict = '余额不足（402）：去控制台充值';
    else if (st === 404) verdict = '地址或模型名不对（404）';
    else verdict = '返回 ' + st + '，看下面原始内容';
    notify('② POST ' + (err2 ? '失败' : st), ms2 + 'ms · ' + c.api_model,
      verdict + (data2 ? ' · ' + String(data2).slice(0, 90) : ''));
    $done({});
  });
});
