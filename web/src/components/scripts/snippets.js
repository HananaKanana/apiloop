/**
 * 「常用片段」下拉里的内容（P8 B1）。
 *
 * 每一条都是契约第 16 节里明确支持的写法，点一下插到光标处，用户自己再改。
 * `phase` 决定它出现在哪个子页签里：`pm.response` 只在测试脚本里有，
 * 插进前置脚本是错的，所以按阶段过滤。
 */
export const SCRIPT_SNIPPETS = [
  {
    label: '设置环境变量',
    phase: 'both',
    code: "pm.environment.set('key', 'value');"
  },
  {
    label: '从 JSON 响应取值存成环境变量',
    phase: 'test',
    code: [
      'const data = pm.response.json();',
      "pm.environment.set('token', data.data.token);"
    ].join('\n')
  },
  {
    label: '检查状态码是 200',
    phase: 'test',
    code: [
      "pm.test('状态码 200', function () {",
      '  pm.response.to.have.status(200);',
      '});'
    ].join('\n')
  },
  {
    label: '检查响应时间小于 500ms',
    phase: 'test',
    code: [
      "pm.test('响应时间小于 500ms', function () {",
      '  pm.expect(pm.response.responseTime).to.be.below(500);',
      '});'
    ].join('\n')
  },
  {
    label: '检查响应体包含某个字段',
    phase: 'test',
    code: [
      "pm.test('响应体包含 token', function () {",
      "  pm.expect(pm.response.text()).to.include('token');",
      '});'
    ].join('\n')
  },
  {
    label: '用 pm.sendRequest 取 token',
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
