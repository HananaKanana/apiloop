import { currentLocale, t } from '@/i18n';
/**
 * 测试集报告的 HTML 导出（第八轮第 1 节）。
 *
 * 生成**一个单独的 HTML 文件**：样式内联、不引外部资源，可以直接发给别人或者贴到工单里。
 * 所以这里全是拼字符串 —— 拼的时候**每一个插进去的值都要转义**：报告里会有接口返回的
 * 原文（对方的 JSON、HTML 错误页），不转义的话打开报告就等于执行对方的脚本。
 */

const STATUS_LABEL = {
  get passed() { return t('utils.repPassed'); },
  get failed() { return t('utils.repFailed'); },
  get stopped() { return t('utils.repStopped'); },
  get error() { return t('utils.repError'); }
};

const STATUS_COLOR = {
  passed: '#18a058',
  failed: '#d03050',
  stopped: '#f0a020',
  error: '#d03050'
};

export function escapeHtml(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 时间戳 → 「2026-10-04 09:12:33」 */
export function formatTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';

  const date = new Date(value);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function formatMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return Math.round(value) + ' ms';
  return (value / 1000).toFixed(2) + ' s';
}

export function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(2) + ' MB';
}

/** 一轮的数据行 → 「账号=a，id=1」（前几个字段，太长就截断） */
export function dataSummary(row) {
  if (!row) return '';
  const keys = Object.keys(row).slice(0, 4);
  const text = keys.map(function (key) { return key + '=' + row[key]; }).join('，');
  return keys.length < Object.keys(row).length ? text + ' …' : text;
}

function headerPairs(headers) {
  return (headers || []).map(function (pair) {
    return Array.isArray(pair) ? pair[0] + ': ' + pair[1] : '';
  }).filter(Boolean).join('\n');
}

function stepHtml(step, index) {
  const failed = step.ok === false;
  const tests = (step.tests || []).map(function (test) {
    return '<li class="' + (test.passed ? 'ok' : 'bad') + '">' +
      (test.passed ? '✓' : '✗') + ' ' + escapeHtml(test.name) +
      (test.message ? t('utils.repColon') + escapeHtml(test.message) : '') + '</li>';
  }).join('');

  const detail = failed && (step.request || step.response)
    ? '<details open><summary>' + escapeHtml(t('utils.repReqResp')) + '</summary>' +
        (step.request
          ? '<p class="k">' + escapeHtml(t('utils.repRequest')) + '</p><pre>' + escapeHtml(step.request.method + ' ' + step.request.url + '\n' +
              headerPairs(step.request.headers) + (step.request.bodyPreview ? '\n\n' + step.request.bodyPreview : '')) + '</pre>'
          : '') +
        (step.response
          ? '<p class="k">' + escapeHtml(t('utils.repResponse', { status: step.response.status })) + '</p><pre>' +
              escapeHtml(headerPairs(step.response.headers) + '\n\n' + (step.response.body || '')) + '</pre>'
          : '') +
      '</details>'
    : '';

  return '<div class="step ' + (failed ? 'failed' : '') + '">' +
    '<div class="step-head">' +
      '<span class="badge ' + (failed ? 'bad' : 'ok') + '">' + (failed ? '✗' : '✓') + '</span>' +
      '<span class="idx">' + (index + 1) + '</span>' +
      '<span class="method">' + escapeHtml(step.method || '') + '</span>' +
      '<span class="name">' + escapeHtml(step.name || '') + '</span>' +
      (step.skipped ? '<span class="tag">' + escapeHtml(t('utils.repSkipped')) + '</span>' : '') +
      '<span class="right">' +
        (step.status ? 'HTTP ' + escapeHtml(step.status) : '') +
        ' · ' + escapeHtml(formatMs(step.timeMs)) +
        ' · ' + escapeHtml(formatBytes(step.size)) +
      '</span>' +
    '</div>' +
    (step.error ? '<p class="err">' + escapeHtml(step.error) + '</p>' : '') +
    (tests ? '<ul class="tests">' + tests + '</ul>' : '') +
    detail +
  '</div>';
}

/**
 * 报告 HTML。
 *
 * @param {{suiteName: string, status: string, environmentName: string, source?: string,
 *   label?: string, startedAt: number, finishedAt: number, summary: object, result: object}} run
 */
export function reportHtml(run) {
  const summary = run.summary || {};
  const iterations = (run.result && run.result.iterations) || [];
  const status = run.status || 'error';

  const rows = [
    [t('utils.repResult'), STATUS_LABEL[status] || status],
    [t('utils.repIterations'), summary.iterations === undefined ? iterations.length : summary.iterations],
    [t('utils.repRequests'), summary.requests],
    [t('utils.repPassFail'), (summary.passed || 0) + ' / ' + (summary.failed || 0)],
    [t('utils.repErrors'), summary.errors || 0],
    [t('utils.repAsserts'), (summary.assertions ? summary.assertions.passed : 0) + ' / ' + (summary.assertions ? summary.assertions.failed : 0)],
    [t('utils.repTotalTime'), formatMs(summary.durationMs)],
    [t('utils.repAvgTime'), formatMs(summary.avgMs)],
    [t('utils.repEnv'), run.environmentName || t('utils.repNoEnv')],
    [t('utils.repSource'), run.source === 'cli' ? t('utils.repCli') : t('utils.repClient')],
    [t('utils.repStartedAt'), formatTime(run.startedAt)],
    [t('utils.repFinishedAt'), formatTime(run.finishedAt)]
  ].map(function (pair) {
    return '<tr><th>' + escapeHtml(pair[0]) + '</th><td>' + escapeHtml(pair[1] === undefined ? '' : pair[1]) + '</td></tr>';
  }).join('');

  const body = iterations.map(function (item, index) {
    const steps = (item.steps || []).map(stepHtml).join('');
    const failed = (item.steps || []).some(function (step) { return step.ok === false; });
    const label = item.data ? dataSummary(item.data) : '';

    return '<section class="iter">' +
      '<h3>' + (item.data ? t('utils.repRound', { n: index + 1 }) + ' · ' + escapeHtml(label) : t('utils.repRound', { n: index + 1 })) +
      (failed ? ' <span class="badge bad">' + escapeHtml(t('utils.repHasFail')) + '</span>' : '') + '</h3>' +
      steps +
    '</section>';
  }).join('');

  return '<!DOCTYPE html>\n<html lang="' + escapeHtml(currentLocale()) + '">\n<head>\n<meta charset="utf-8">\n' +
    '<title>' + escapeHtml(t('utils.repTitle', { name: run.suiteName || '' })) + '</title>\n' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'margin:0;padding:24px;background:#f7f8fa;color:#1f2937;font-size:13px;line-height:1.6}' +
    '.wrap{max-width:960px;margin:0 auto;background:#fff;border-radius:8px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
    'h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;opacity:.7}' +
    'h3{font-size:13px;margin:16px 0 6px}' +
    'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eee}' +
    'table th{width:130px;font-weight:500;color:#6b7280}' +
    '.step{border:1px solid #eee;border-radius:6px;padding:6px 10px;margin-bottom:6px}' +
    '.step.failed{border-color:#f4c7c3;background:#fff8f7}' +
    '.step-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.idx{color:#9ca3af;min-width:16px;text-align:right}' +
    '.method{font-family:ui-monospace,Menlo,monospace;font-weight:600}' +
    '.right{margin-left:auto;color:#6b7280}' +
    '.badge{font-size:12px}.badge.ok{color:#18a058}.badge.bad{color:#d03050}' +
    '.tag{background:#f3f4f6;border-radius:3px;padding:0 5px;font-size:11px;color:#6b7280}' +
    '.err{color:#d03050;margin:4px 0}' +
    '.tests{margin:4px 0;padding-left:18px}.tests .ok{color:#18a058}.tests .bad{color:#d03050}' +
    'pre{background:#f7f8fa;border-radius:4px;padding:8px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}' +
    '.k{margin:6px 0 2px;color:#6b7280}' +
    'details{margin-top:6px}summary{cursor:pointer;color:#6b7280}' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<h1>' + escapeHtml(run.suiteName || t('utils.repSuite')) + ' · ' + escapeHtml(t('utils.repRunReport')) + '</h1>\n' +
    '<p style="color:#6b7280;margin:0">' + escapeHtml(formatTime(run.finishedAt || run.startedAt)) +
      (run.label ? ' · ' + escapeHtml(t('utils.repBuild', { label: run.label })) : '') + '</p>\n' +
    '<h2>' + escapeHtml(t('utils.repSummary')) + '</h2>\n<table>' + rows + '</table>\n' +
    '<h2>' + escapeHtml(t('utils.repDetail')) + '</h2>\n' +
    (body || '<p style="color:#6b7280">' + escapeHtml(t('utils.repNoSteps')) + '</p>') + '\n' +
    '</div>\n</body>\n</html>\n';
}

/** 触发下载 */
export function downloadReport(run) {
  const html = reportHtml(run);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = t('utils.repFileName', { name: run.suiteName || 'suite', stamp: formatTime(run.finishedAt || Date.now()).replace(/[: ]/g, '-') });
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}
