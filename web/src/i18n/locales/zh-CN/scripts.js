/**
 * scripts 区域：`web/src/components/scripts/` 下的界面文字（脚本编辑器、常用片段）。
 *
 * 术语按 README.md 的术语表：Variable、Environment、Assertion、Pre-request、Response。
 * 注意：常用片段里的 `code` 是插入编辑器的脚本原文，不翻译。
 */
export default {
  /* ---------------- ScriptEditor ---------------- */
  phasePrerequest: '请求前',
  phaseTest: '响应后',
  hintPrerequest: '请求发出之前执行。这里改过的变量会参与变量替换；抛出异常时请求不会发出去。',
  hintTest: '响应回来之后执行。用 pm.test 写断言，结果显示在响应面板的「测试结果」里。',
  snippets: '常用片段',
  helpLink: '怎么写？看帮助和用例',
  readonlyHint: '当前角色是只读，不能修改脚本。',

  /* ---------------- 常用片段 snippets ---------------- */
  snippetSetEnv: '设置环境变量',
  snippetJsonToEnv: '从 JSON 响应取值存成环境变量',
  snippetStatus200: '检查状态码是 200',
  snippetResponseTime: '检查响应时间小于 500ms',
  snippetBodyContains: '检查响应体包含某个字段',
  snippetSendRequest: '用 pm.sendRequest 取 token'
};
