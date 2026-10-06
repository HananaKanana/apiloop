import { t } from '@/i18n';

/**
 * 「常用片段」下拉里的内容（P8 B1）。
 *
 * 每一条都是契约第 16 节里明确支持的写法，点一下插到光标处，用户自己再改。
 * `phase` 决定它出现在哪个子页签里：`pm.response` 只在测试脚本里有，
 * 插进前置脚本是错的，所以按阶段过滤。
 *
 * `label` 要跟着语言变，所以这里导出的是**函数**，调用方每次取的时候重新翻译；
 * `id` 是不随语言变的稳定标识，调用方用它找回对应的片段。
 * `code` 是插入编辑器的脚本原文，**不翻译**。
 */
export function scriptSnippets() {
  return [
    {
      id: 'setEnvironment',
      label: t('scripts.snippetSetEnv'),
      phase: 'both',
      code: "pm.environment.set('key', 'value');"
    },
    {
      id: 'jsonToEnvironment',
      label: t('scripts.snippetJsonToEnv'),
      phase: 'test',
      code: [
        'const data = pm.response.json();',
        "pm.environment.set('token', data.data.token);"
      ].join('\n')
    },
    {
      id: 'status200',
      label: t('scripts.snippetStatus200'),
      phase: 'test',
      code: [
        "pm.test('状态码 200', function () {",
        '  pm.response.to.have.status(200);',
        '});'
      ].join('\n')
    },
    {
      id: 'responseTime',
      label: t('scripts.snippetResponseTime'),
      phase: 'test',
      code: [
        "pm.test('响应时间小于 500ms', function () {",
        '  pm.expect(pm.response.responseTime).to.be.below(500);',
        '});'
      ].join('\n')
    },
    {
      id: 'bodyContains',
      label: t('scripts.snippetBodyContains'),
      phase: 'test',
      code: [
        "pm.test('响应体包含 token', function () {",
        "  pm.expect(pm.response.text()).to.include('token');",
        '});'
      ].join('\n')
    },
    {
      id: 'sendRequest',
      label: t('scripts.snippetSendRequest'),
      phase: 'both',
      code: [
        'pm.sendRequest({',
        "  url: 'https://example.com/login',",
        "  method: 'POST',",
        "  header: [{ key: 'Content-Type', value: 'application/json' }],",
        "  body: { mode: 'raw', raw: JSON.stringify({ username: 'a', password: 'b' }) }",
        '}, function (err, res) {',
        '  if (err) {',
        '    console.error(err);',
        '    return;',
        '  }',
        "  pm.environment.set('token', res.json().token);",
        '});'
      ].join('\n')
    }
  ];
}
