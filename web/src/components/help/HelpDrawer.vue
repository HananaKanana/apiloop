<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NDrawer, NDrawerContent } from 'naive-ui';
import { useUiStore } from '@/stores/ui';
import { useSessionStore } from '@/stores/session';

/**
 * 帮助（用户 2026-10-02：能传什么变量、怎么用、用例）。
 *
 * 做成抽屉而不是单独的页面：看帮助的时候人往往正写着请求或脚本，跳走会打断（还要处理没保存的标签页）。
 * 内容按代码里实际支持的写 —— 变量优先级见 lib/send-core.js 的 mergeScopes，
 * 动态变量见 lib/variables.js，脚本 API 见 lib/scripts/prelude.js，
 * Mock 函数表直接用服务端下发的 meta.placeholders，和实现永远一致。
 */
const ui = useUiStore();
const session = useSessionStore();
const { t } = useI18n();

const SECTIONS = [
  { id: 'start', titleKey: 'help.secStart' },
  { id: 'variables', titleKey: 'help.secVariables' },
  { id: 'scripts', titleKey: 'help.secScripts' },
  { id: 'examples', titleKey: 'help.secExamples' },
  { id: 'mock', titleKey: 'help.secMock' },
  { id: 'record', titleKey: 'help.secRecord' },
  { id: 'import', titleKey: 'help.secImport' },
  { id: 'export-doc', titleKey: 'help.secExportDoc' },
  { id: 'backup', titleKey: 'help.secBackup' },
  { id: 'suite', titleKey: 'help.secSuite' },
  { id: 'load', titleKey: 'help.secLoad' },
  { id: 'db', titleKey: 'help.secDb' },
  { id: 'sio', titleKey: 'help.secSio' },
  { id: 'grpc', titleKey: 'help.secGrpc' },
  { id: 'mqtt', titleKey: 'help.secMqtt' },
  { id: 'tcpudp', titleKey: 'help.secTcpUdp' },
  { id: 'preflight', titleKey: 'help.secPreflight' },
  { id: 'language', titleKey: 'help.secLanguage' },
  { id: 'shortcuts', titleKey: 'help.secShortcuts' }
];

const active = ref('start');
const bodyRef = ref(null);

function go(id) {
  active.value = id;
  const root = bodyRef.value;
  const target = root && root.querySelector('#help-' + id);
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// 从别处（比如脚本编辑器的「怎么写？」）带着章节打开时，直接跳过去
watch(function () { return ui.helpVisible; }, async function (open) {
  if (!open) return;
  await nextTick();
  go(ui.helpSection || 'start');
});

/** Mock 响应里能用的函数，按分组排；数据来自 /meta（lib/mock-engine.js 的 PLACEHOLDERS） */
const placeholderGroups = computed(function () {
  const list = (session.meta && session.meta.placeholders) || [];
  const groups = [];
  const byName = {};
  list.forEach(function (item) {
    /*
     * 分组名是后端给的（`group`），会跟着界面语言变，所以**不按某个具体文字过滤** ——
     * 以前这里写的是 `item.group === '模板'`，把「模板」那个分组排除掉；现在模板走的是
     * 另一个字段（`session.meta.templates`），占位符里已经没有这个分组了。
     * 没有分组名的条目跳过（分组是后端说了算的，空名字没法归类）。
     */
    if (!item || !item.group) return;
    if (!byName[item.group]) {
      byName[item.group] = { name: item.group, items: [] };
      groups.push(byName[item.group]);
    }
    byName[item.group].items.push(item);
  });
  return groups;
});

/** 插入写法：带参数的服务端给了 example，其余按名字拼（和「插入 Mock 字段」菜单一样） */
function placeholderText(item) {
  return item.example || ('{{@' + item.name + '}}');
}

/**
 * 脚本示例。**代码本身不翻译**（`pm.*` 的 API 名、变量名、`{{token}}`、JSON 结构），
 * 但里面**给人看的文字**（注释、`pm.test` 的测试名、可视化模板里的表头）跟着语言走 ——
 * 所以整份是 `computed`，切换语言时示例里那几行会跟着变。
 */
const examples = computed(function () {
  return [
    {
      titleKey: 'help.ex1Title',
      whereKey: 'help.ex1Where',
      code: [
        'const data = pm.response.json();',
        "pm.environment.set('token', data.data.token);",
        '',
        t('help.ex1Comment1'),
        t('help.ex1Comment2')
      ].join('\n')
    },
    {
      titleKey: 'help.ex2Title',
      whereKey: 'help.ex2Where',
      code: [
        "pm.test('" + t('help.ex2TestStatus') + "', function () {",
        '  pm.response.to.have.status(200);',
        '});',
        '',
        "pm.test('" + t('help.ex2TestBizCode') + "', function () {",
        '  const body = pm.response.json();',
        '  pm.expect(body.code).to.equal(0);',
        "  pm.expect(body.data).to.have.property('list');",
        '  pm.expect(body.data.list).to.be.an(\'array\');',
        '});',
        '',
        "pm.test('" + t('help.ex2TestTime') + "', function () {",
        '  pm.expect(pm.response.responseTime).to.be.below(500);',
        '});'
      ].join('\n')
    },
    {
      titleKey: 'help.ex3Title',
      whereKey: 'help.ex3Where',
      code: [
        'const ts = String(Date.now());',
        "pm.variables.set('ts', ts);",
        '',
        "pm.request.headers.upsert({ key: 'X-Timestamp', value: ts });",
        "pm.request.headers.upsert({ key: 'X-Request-Id', value: '{{$guid}}' });"
      ].join('\n')
    },
    {
      titleKey: 'help.ex4Title',
      whereKey: 'help.ex4Where',
      code: [
        'pm.sendRequest({',
        "  url: pm.environment.get('host') + '/login',",
        "  method: 'POST',",
        "  header: [{ key: 'Content-Type', value: 'application/json' }],",
        "  body: { mode: 'raw', raw: JSON.stringify({ username: 'test', password: '123456' }) }",
        '}, function (err, res) {',
        '  if (err) return console.error(err);',
        "  pm.environment.set('token', res.json().data.token);",
        '});'
      ].join('\n')
    },
    {
      titleKey: 'help.ex5Title',
      whereKey: 'help.ex5Where',
      code: [
        'const template = `',
        '  <table border="1" cellpadding="6">',
        '    <tr><th>ID</th><th>' + t('help.ex5TableName') + '</th></tr>',
        '    {{#each list}}<tr><td>{{id}}</td><td>{{name}}</td></tr>{{/each}}',
        '  </table>`;',
        '',
        'pm.visualizer.set(template, { list: pm.response.json().data.list });'
      ].join('\n')
    }
  ];
});
</script>

<template>
  <n-drawer v-model:show="ui.helpVisible" :width="760" placement="right">
    <n-drawer-content :title="t('help.title')" closable body-content-style="padding: 0; height: 100%; overflow: hidden">
      <div class="help">
        <nav class="toc">
          <a
            v-for="section in SECTIONS"
            :key="section.id"
            :class="{ active: active === section.id }"
            @click="go(section.id)"
          >
            {{ t(section.titleKey) }}
          </a>
        </nav>

        <div ref="bodyRef" class="body">
          <!-- ============================================================ 快速上手 -->
          <section id="help-start">
            <h2>{{ t('help.secStart') }}</h2>
            <ol>
              <li>{{ t('help.startLi1') }}</li>
              <i18n-t keypath="help.startLi2" tag="li" scope="global">
                <template #code><code v-pre>{{host}}/api/users/:id</code></template>
                <template #param><code>:id</code></template>
              </i18n-t>
              <i18n-t keypath="help.startLi3" tag="li" scope="global">
                <template #host><code v-pre>{{host}}</code></template>
              </i18n-t>
              <i18n-t keypath="help.startLi4" tag="li" scope="global">
                <template #kbd><kbd>⌘S</kbd></template>
                <template #kbd2><kbd>Ctrl+S</kbd></template>
              </i18n-t>
              <i18n-t keypath="help.startLi5" tag="li" scope="global">
                <template #b><b>{{ t('help.startLi5B') }}</b></template>
              </i18n-t>
            </ol>
            <p>{{ t('help.startSync') }}</p>
            <p>{{ t('help.startQuick') }}</p>
            <p>{{ t('help.startTempTabs') }}</p>
          </section>

          <!-- ============================================================ 变量 -->
          <section id="help-variables">
            <h2>{{ t('help.secVariables') }}</h2>
            <i18n-t keypath="help.varIntro" tag="p" scope="global">
              <template #var><code v-pre>{{变量名}}</code></template>
            </i18n-t>

            <h3>{{ t('help.varWhere') }}</h3>
            <table>
              <tr>
                <th>{{ t('help.thLocation') }}</th>
                <th>{{ t('help.thScope') }}</th>
                <th>{{ t('help.thWhereEdit') }}</th>
              </tr>
              <tr>
                <td>{{ t('help.varProjectName') }}</td>
                <td>{{ t('help.varProjectScope') }}</td>
                <td>{{ t('help.varProjectEdit') }}</td>
              </tr>
              <tr>
                <td>{{ t('help.varFolderName') }}</td>
                <td>{{ t('help.varFolderScope') }}</td>
                <td>{{ t('help.varFolderEdit') }}</td>
              </tr>
              <tr>
                <td>{{ t('help.varEnvName') }}</td>
                <td>{{ t('help.varEnvScope') }}</td>
                <td>{{ t('help.varEnvEdit') }}</td>
              </tr>
              <tr>
                <td>{{ t('help.varTempName') }}</td>
                <td>{{ t('help.varTempScope') }}</td>
                <i18n-t keypath="help.varTempEdit" tag="td" scope="global">
                  <template #code><code>pm.variables.set()</code></template>
                </i18n-t>
              </tr>
            </table>

            <h3>{{ t('help.varPriorityTitle') }}</h3>
            <p>{{ t('help.varPriorityLead') }}</p>
            <p class="flow">{{ t('help.varPriorityFlow') }}</p>
            <i18n-t keypath="help.varPriorityExample" tag="p" scope="global">
              <template #code1><code>host</code></template>
              <template #code2><code>host</code></template>
            </i18n-t>

            <h3>{{ t('help.varDynamicTitle') }}</h3>
            <i18n-t keypath="help.varDynamicIntro" tag="p" scope="global">
              <template #b><b>{{ t('help.varDynamicIntroB') }}</b></template>
            </i18n-t>
            <table>
              <tr>
                <th>{{ t('help.thSyntax') }}</th>
                <th>{{ t('help.thGenerates') }}</th>
                <th>{{ t('help.thExample') }}</th>
              </tr>
              <tr><td><code v-pre>{{$guid}}</code></td><td>{{ t('help.dynUuid') }}</td><td>3f2b8c1e-…</td></tr>
              <tr><td><code v-pre>{{$timestamp}}</code></td><td>{{ t('help.dynTsSec') }}</td><td>1790944794</td></tr>
              <tr><td><code v-pre>{{$timestampMs}}</code></td><td>{{ t('help.dynTsMs') }}</td><td>1790944794000</td></tr>
              <tr><td><code v-pre>{{$isoTimestamp}}</code></td><td>{{ t('help.dynIso') }}</td><td>2026-10-02T08:00:00.000Z</td></tr>
              <tr><td><code v-pre>{{$randomInt}}</code></td><td>{{ t('help.dynRandomInt') }}</td><td>427</td></tr>
              <tr><td><code v-pre>{{$randomInt(1,100)}}</code> / <code v-pre>{{$整数(1,100)}}</code></td><td>{{ t('help.dynRandomIntRange') }}</td><td>39</td></tr>
              <tr><td><code v-pre>{{$randomPhone}}</code> / <code v-pre>{{$手机号}}</code></td><td>{{ t('help.dynPhone') }}</td><td>13800138000</td></tr>
              <tr><td><code v-pre>{{$randomIdCard}}</code> / <code v-pre>{{$身份证}}</code></td><td>{{ t('help.dynIdCard') }}</td><td>11010519900307123X</td></tr>
              <tr><td><code v-pre>{{$randomChineseName}}</code> / <code v-pre>{{$中文名}}</code></td><td>{{ t('help.dynChineseName') }}</td><td>{{ t('help.dynChineseNameExample') }}</td></tr>
              <tr><td><code v-pre>{{$randomEmail}}</code> / <code v-pre>{{$邮箱}}</code></td><td>{{ t('help.dynEmail') }}</td><td>user1234@example.com</td></tr>
              <tr><td><code v-pre>{{$randomDate}}</code> / <code v-pre>{{$日期}}</code></td><td>{{ t('help.dynDate') }}</td><td>2026-04-11</td></tr>
              <tr><td><code v-pre>{{$randomDateTime}}</code> / <code v-pre>{{$时间}}</code></td><td>{{ t('help.dynDateTime') }}</td><td>2026-04-11 15:20:33</td></tr>
              <tr><td><code v-pre>{{$randomAddress}}</code> / <code v-pre>{{$地址}}</code></td><td>{{ t('help.dynAddress') }}</td><td>{{ t('help.dynAddressExample') }}</td></tr>
              <tr><td><code v-pre>{{$randomCompany}}</code> / <code v-pre>{{$公司}}</code></td><td>{{ t('help.dynCompany') }}</td><td>{{ t('help.dynCompanyExample') }}</td></tr>
              <tr><td><code v-pre>{{$randomBankCard}}</code> / <code v-pre>{{$银行卡}}</code></td><td>{{ t('help.dynBankCard') }}</td><td>6222021234567890</td></tr>
              <tr><td><code v-pre>{{$randomCreditCode}}</code> / <code v-pre>{{$信用代码}}</code></td><td>{{ t('help.dynCreditCode') }}</td><td>91330106MA27XYZ123</td></tr>
              <tr><td><code v-pre>{{$randomPlate}}</code> / <code v-pre>{{$车牌}}</code></td><td>{{ t('help.dynPlate') }}</td><td>{{ t('help.dynPlateExample') }}</td></tr>
              <tr><td><code v-pre>{{$randomIp}}</code></td><td>{{ t('help.dynIp') }}</td><td>192.168.1.20</td></tr>
            </table>
            <i18n-t keypath="help.varTyping" tag="p" scope="global">
              <template #code><code v-pre>{{$</code></template>
            </i18n-t>
            <i18n-t keypath="help.varSameValue" tag="p" scope="global">
              <template #b><b>{{ t('help.varSameValueB') }}</b></template>
            </i18n-t>
            <pre v-pre><code>pm.variables.set('phone', pm.variables.replaceIn('{{$手机号}}'));</code></pre>
            <i18n-t keypath="help.varAfterPhone" tag="p" scope="global">
              <template #phone><code v-pre>{{phone}}</code></template>
              <template #replaceIn><code>pm.variables.replaceIn()</code></template>
            </i18n-t>
            <i18n-t keypath="help.varNameChinese" tag="p" scope="global">
              <template #b><b>{{ t('help.varNameChineseB') }}</b></template>
              <template #code><code v-pre>{{账号}}</code></template>
            </i18n-t>

            <h3>{{ t('help.varMockEnvTitle') }}</h3>
            <i18n-t keypath="help.varMockEnv" tag="p" scope="global">
              <template #host><code v-pre>{{host}}</code></template>
              <template #api><code>/api</code></template>
            </i18n-t>
          </section>

          <!-- ============================================================ 脚本 -->
          <section id="help-scripts">
            <h2>{{ t('help.secScripts') }}</h2>
            <p>{{ t('help.scriptsIntro') }}</p>
            <ul>
              <i18n-t keypath="help.scriptsPre" tag="li" scope="global">
                <template #b><b>{{ t('help.scriptsPreB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.scriptsPost" tag="li" scope="global">
                <template #b><b>{{ t('help.scriptsPostB') }}</b></template>
              </i18n-t>
            </ul>
            <i18n-t keypath="help.scriptsOrder" tag="p" scope="global">
              <template #flow><span class="flow-inline">{{ t('help.scriptsOrderFlow') }}</span></template>
            </i18n-t>

            <h3>{{ t('help.scriptsApiTitle') }}</h3>
            <table class="api">
              <tr><th>{{ t('help.thSyntax') }}</th><th>{{ t('help.thDescription') }}</th></tr>
              <tr>
                <td><code>pm.environment.get('k')</code> / <code>.set('k', v)</code> / <code>.unset('k')</code></td>
                <i18n-t keypath="help.apiEnv" tag="td" scope="global">
                  <template #b><b>{{ t('help.apiEnvB') }}</b></template>
                </i18n-t>
              </tr>
              <tr>
                <td><code>pm.collectionVariables.get / set / unset</code></td>
                <i18n-t keypath="help.apiProject" tag="td" scope="global">
                  <template #b><b>{{ t('help.apiProjectB') }}</b></template>
                </i18n-t>
              </tr>
              <tr><td><code>pm.variables.get('k')</code></td><td>{{ t('help.apiGetFinal') }}</td></tr>
              <tr>
                <td><code>pm.variables.set('k', v)</code></td>
                <i18n-t keypath="help.apiTemp" tag="td" scope="global">
                  <template #b><b>{{ t('help.apiTempB') }}</b></template>
                </i18n-t>
              </tr>
              <tr>
                <td><code>pm.request.headers.upsert({ key, value })</code></td>
                <i18n-t keypath="help.apiHeaders" tag="td" scope="global">
                  <template #add><code>add</code></template>
                  <template #remove><code>remove('{{ t('help.argName') }}')</code></template>
                </i18n-t>
              </tr>
              <tr><td><code>pm.request.url</code> / <code>pm.request.method</code> / <code>pm.request.body.raw</code></td><td>{{ t('help.apiReqParts') }}</td></tr>
              <tr><td><code>pm.response.json()</code> / <code>.text()</code></td><td>{{ t('help.apiRespBody') }}</td></tr>
              <tr><td><code>pm.response.code</code> / <code>.responseTime</code> / <code>.headers.get('{{ t('help.argName') }}')</code></td><td>{{ t('help.apiRespMeta') }}</td></tr>
              <tr><td><code>pm.test('{{ t('help.argName') }}', function () { … })</code></td><td>{{ t('help.apiTest') }}</td></tr>
              <tr><td><code>pm.expect({{ t('help.argValue') }}).to.equal(…)</code></td><td>{{ t('help.apiExpect') }}</td></tr>
              <tr><td><code>pm.sendRequest({{ t('help.argRequest') }}, function (err, res) {})</code></td><td>{{ t('help.apiSend') }}</td></tr>
              <tr><td><code>pm.visualizer.set({{ t('help.argTemplate') }}, {{ t('help.argData') }})</code></td><td>{{ t('help.apiVisualizer') }}</td></tr>
              <tr><td><code>console.log(…)</code></td><td>{{ t('help.apiConsole') }}</td></tr>
            </table>

            <h3>{{ t('help.apiAssertTitle') }}</h3>
            <table class="api">
              <tr><td><code>.to.equal(1)</code></td><td>{{ t('help.assertEqual') }}</td></tr>
              <tr><td><code>.to.eql({ a: 1 })</code></td><td>{{ t('help.assertEql') }}</td></tr>
              <tr><td><code>.to.include('ok')</code></td><td>{{ t('help.assertInclude') }}</td></tr>
              <tr><td><code>.to.have.property('id')</code></td><td>{{ t('help.assertProperty') }}</td></tr>
              <tr><td><code>.to.have.lengthOf(3)</code></td><td>{{ t('help.assertLength') }}</td></tr>
              <tr><td><code>.to.be.above(0)</code> / <code>.below(500)</code> / <code>.least</code> / <code>.most</code></td><td>{{ t('help.assertCompare') }}</td></tr>
              <tr><td><code>.to.match(/^\d+$/)</code></td><td>{{ t('help.assertMatch') }}</td></tr>
              <tr><td><code>.to.be.oneOf([1, 2])</code></td><td>{{ t('help.assertOneOf') }}</td></tr>
              <tr>
                <td><code>.to.not.equal(…)</code></td>
                <i18n-t keypath="help.assertNot" tag="td" scope="global">
                  <template #code><code>not</code></template>
                </i18n-t>
              </tr>
              <tr><td><code>pm.response.to.have.status(200)</code> / <code>pm.response.to.be.ok</code></td><td>{{ t('help.assertStatus') }}</td></tr>
            </table>
            <p class="note">{{ t('help.scriptsNote') }}</p>
          </section>

          <!-- ============================================================ 用例 -->
          <section id="help-examples">
            <h2>{{ t('help.secExamples') }}</h2>
            <div v-for="example in examples" :key="example.titleKey" class="example">
              <h3>{{ t(example.titleKey) }}</h3>
              <i18n-t keypath="help.exampleWhere" tag="p" class="where" scope="global">
                <template #where>{{ t(example.whereKey) }}</template>
              </i18n-t>
              <pre><code>{{ example.code }}</code></pre>
            </div>
            <p class="note">{{ t('help.examplesNote') }}</p>
          </section>

          <!-- ============================================================ Mock -->
          <section id="help-mock">
            <h2>{{ t('help.secMock') }}</h2>
            <p>{{ t('help.mockIntro') }}</p>
            <ol>
              <li>{{ t('help.mockLi1') }}</li>
              <li>{{ t('help.mockLi2') }}</li>
              <i18n-t keypath="help.mockLi3" tag="li" scope="global">
                <template #code><code>id=0</code></template>
              </i18n-t>
              <li>{{ t('help.mockLi4') }}</li>
            </ol>
            <p>{{ t('help.mockCloud') }}</p>

            <h3>{{ t('help.mockRandomTitle') }}</h3>
            <i18n-t keypath="help.mockRandomIntro" tag="p" scope="global">
              <template #json1><code v-pre>"age": "{{@int(1,100)}}"</code></template>
              <template #json2><code>"age": 42</code></template>
            </i18n-t>
            <template v-if="placeholderGroups.length">
              <div v-for="group in placeholderGroups" :key="group.name" class="ph-group">
                <h4>{{ group.name }}</h4>
                <table class="api">
                  <tr v-for="item in group.items" :key="item.name">
                    <td><code>{{ placeholderText(item) }}</code></td>
                    <td>{{ item.desc }}</td>
                  </tr>
                </table>
              </div>
            </template>
            <h4>{{ t('help.mockRepeatTitle') }}</h4>
            <table class="api">
              <tr>
                <td><code v-pre>{{@repeat(3)}} … {{/repeat}}</code></td>
                <i18n-t keypath="help.mockRepeat" tag="td" scope="global">
                  <template #code><code v-pre>{{@repeat(2-5)}}</code></template>
                </i18n-t>
              </tr>
            </table>
            <p class="note">{{ t('help.mockNote') }}</p>
          </section>

          <!-- ============================================================ Mock 录制 -->
          <section id="help-record">
            <h2>{{ t('help.secRecord') }}</h2>
            <p>{{ t('help.recordIntro') }}</p>
            <ol>
              <i18n-t keypath="help.recordLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.recordLi1B') }}</b></template>
                <template #var><code v-pre>{{变量}}</code></template>
                <template #prefix><code>/api</code></template>
              </i18n-t>
              <i18n-t keypath="help.recordLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.recordLi2B') }}</b></template>
              </i18n-t>
              <li>{{ t('help.recordLi3') }}</li>
              <i18n-t keypath="help.recordLi4" tag="li" scope="global">
                <template #b1><b>{{ t('help.recordLi4B1') }}</b></template>
                <template #b2><b>{{ t('help.recordLi4B2') }}</b></template>
                <template #c1><code>/orders/1001</code></template>
                <template #c2><code>/orders/:id</code></template>
              </i18n-t>
            </ol>
            <p>{{ t('help.recordLan') }}</p>
            <i18n-t keypath="help.recordLocalOnly" tag="p" scope="global">
              <template #b><b>{{ t('help.recordLocalOnlyB') }}</b></template>
            </i18n-t>
          </section>

          <!-- ============================================================ 导入导出 -->
          <section id="help-import">
            <h2>{{ t('help.secImport') }}</h2>
            <table>
              <tr><th>{{ t('help.thFormat') }}</th><th>{{ t('help.thDescription') }}</th></tr>
              <tr><td>{{ t('help.importJson') }}</td><td>{{ t('help.importJsonDesc') }}</td></tr>
              <tr><td>{{ t('help.importCurl') }}</td><td>{{ t('help.importCurlDesc') }}</td></tr>
              <tr>
                <td>{{ t('help.importOpenapi') }}</td>
                <i18n-t keypath="help.importOpenapiDesc" tag="td" scope="global">
                  <template #p1><code>/v3/api-docs</code></template>
                  <template #p2><code>/swagger.json</code></template>
                </i18n-t>
              </tr>
              <tr><td>{{ t('help.importHar') }}</td><td>{{ t('help.importHarDesc') }}</td></tr>
            </table>
            <ul>
              <li>{{ t('help.importLi1') }}</li>
              <li>{{ t('help.importLi2') }}</li>
              <i18n-t keypath="help.importLi3" tag="li" scope="global">
                <template #icon>&lt;/&gt;</template>
              </i18n-t>
            </ul>
          </section>

          <!-- ============================================================ 导出文档 -->
          <section id="help-export-doc">
            <h2>{{ t('help.secExportDoc') }}</h2>
            <p>{{ t('help.exportDocIntro') }}</p>
            <p>{{ t('help.shareTry') }}</p>

            <h3>{{ t('help.exportDocFormats') }}</h3>
            <table>
              <tr><th>{{ t('help.thFormat') }}</th><th>{{ t('help.thDescription') }}</th></tr>
              <tr><td>{{ t('help.exportMd') }}</td><td>{{ t('help.exportMdDesc') }}</td></tr>
              <tr><td>{{ t('help.exportHtml') }}</td><td>{{ t('help.exportHtmlDesc') }}</td></tr>
              <tr><td>{{ t('help.exportWord') }}</td><td>{{ t('help.exportWordDesc') }}</td></tr>
            </table>

            <h3>{{ t('help.exportDocOptions') }}</h3>
            <ul>
              <i18n-t keypath="help.exportOptExamplesDesc" tag="li" scope="global">
                <template #b><b>{{ t('help.exportOptExamples') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.exportOptMockDesc" tag="li" scope="global">
                <template #b><b>{{ t('help.exportOptMock') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.exportOptDoneDesc" tag="li" scope="global">
                <template #b><b>{{ t('help.exportOptDone') }}</b></template>
              </i18n-t>
            </ul>

            <i18n-t keypath="help.exportDocNote" tag="p" class="note" scope="global">
              <template #b><b>{{ t('help.exportDocNoteB') }}</b></template>
            </i18n-t>
          </section>

          <!-- ============================================================ 备份与恢复 -->
          <section id="help-backup">
            <h2>{{ t('help.secBackup') }}</h2>
            <p>{{ t('help.backupIntro') }}</p>

            <h3>{{ t('help.backupDownloadTitle') }}</h3>
            <i18n-t keypath="help.backupDownload" tag="p" scope="global">
              <template #b><b>{{ t('help.backupDownloadB') }}</b></template>
            </i18n-t>

            <h3>{{ t('help.backupRestoreTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.backupRestoreLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.backupRestoreLi1B') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.backupRestoreLi2" tag="li" scope="global">
                <template #b1><b>{{ t('help.backupRestoreLi2B1') }}</b></template>
                <template #b2><b>{{ t('help.backupRestoreLi2B2') }}</b></template>
                <template #b3><b>{{ t('help.backupRestoreLi2B3') }}</b></template>
                <template #b4><b>{{ t('help.backupRestoreLi2B4') }}</b></template>
              </i18n-t>
              <li>{{ t('help.backupRestoreLi3') }}</li>
            </ul>

            <h3>{{ t('help.backupAutoTitle') }}</h3>
            <p>{{ t('help.backupAuto') }}</p>
          </section>

          <!-- ============================================================ 测试集 -->
          <section id="help-suite">
            <h2>{{ t('help.secSuite') }}</h2>
            <i18n-t keypath="help.suiteIntro" tag="p" scope="global">
              <template #b><b>{{ t('help.suiteIntroB') }}</b></template>
            </i18n-t>

            <h3>{{ t('help.suiteHowTitle') }}</h3>
            <ol>
              <li>{{ t('help.suiteLi1') }}</li>
              <li>{{ t('help.suiteLi2') }}</li>
              <i18n-t keypath="help.suiteLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteStepContinueB') }}</b></template>
                <template #b2><b>{{ t('help.suiteStepSkipB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.suiteLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteStepAppendB') }}</b></template>
              </i18n-t>
            </ol>

            <h3>{{ t('help.suiteDataTitle') }}</h3>
            <ul>
              <li>{{ t('help.suiteDataLi1') }}</li>
              <i18n-t keypath="help.suiteDataLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteRowB') }}</b></template>
                <template #col><code v-pre>{{列名}}</code></template>
                <template #iter><code>pm.iterationData.get('{{ t('help.argColumnName') }}')</code></template>
              </i18n-t>
              <i18n-t keypath="help.suiteDataLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteDataPriorityB') }}</b></template>
              </i18n-t>
              <li>{{ t('help.suiteDataLi4') }}</li>
            </ul>

            <h3>{{ t('help.suiteRunTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.suiteRunLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteRunVarB') }}</b></template>
              </i18n-t>
              <li>{{ t('help.suiteRunLi2') }}</li>
              <li>{{ t('help.suiteRunLi3') }}</li>
              <i18n-t keypath="help.suiteRunLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.suiteRunLocalB') }}</b></template>
              </i18n-t>
            </ul>

            <h3>{{ t('help.suiteReportTitle') }}</h3>
            <ul>
              <li>{{ t('help.suiteReportLi1') }}</li>
              <li>{{ t('help.suiteReportLi2') }}</li>
              <li>{{ t('help.suiteReportLi3') }}</li>
              <li>{{ t('help.suiteReportLi4') }}</li>
            </ul>
          </section>

          <!-- ============================================================ 压测 -->
          <section id="help-load">
            <h2>{{ t('help.secLoad') }}</h2>
            <p>{{ t('help.loadIntro') }}</p>

            <h3>{{ t('help.loadHowTitle') }}</h3>
            <ol>
              <li>{{ t('help.loadLi1') }}</li>
              <li>{{ t('help.loadLi2') }}</li>
              <li>{{ t('help.loadLi3') }}</li>
              <li>{{ t('help.loadLi4') }}</li>
              <li>{{ t('help.loadLi5') }}</li>
            </ol>

            <h3>{{ t('help.loadNotesTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.loadNoteLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.loadRealPressureB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.loadNoteLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.loadIgnoreBodyB') }}</b></template>
                <template #code><code>200,201</code></template>
              </i18n-t>
              <i18n-t keypath="help.loadNoteLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.loadAtStartB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.loadNoteLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.loadNotSavedB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.loadNoteLi5" tag="li" scope="global">
                <template #b><b>{{ t('help.loadLocalOnlyB') }}</b></template>
              </i18n-t>
            </ul>
          </section>

          <!-- ============================================================ 数据库 -->
          <section id="help-db">
            <h2>{{ t('help.secDb') }}</h2>
            <p>{{ t('help.dbIntro') }}</p>

            <h3>{{ t('help.dbConnTitle') }}</h3>
            <ol>
              <li>{{ t('help.dbConnLi1') }}</li>
              <li>{{ t('help.dbConnLi2') }}</li>
              <li>{{ t('help.dbConnLi3') }}</li>
            </ol>

            <h3>{{ t('help.dbWriteTitle') }}</h3>
            <ol>
              <i18n-t keypath="help.dbWriteLi1" tag="li" scope="global">
                <template #b1><b>{{ t('help.dbPreB') }}</b></template>
                <template #b2><b>{{ t('help.dbPostB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.dbWriteLi2" tag="li" scope="global">
                <template #var><code v-pre>{{变量}}</code></template>
              </i18n-t>
              <i18n-t keypath="help.dbWriteLi3" tag="li" scope="global">
                <template #p1><code>[0].code</code></template>
                <template #p2><code>[0].insertId</code></template>
                <template #p3><code>RETURNING id</code></template>
                <template #p4><code>[0].id</code></template>
              </i18n-t>
              <i18n-t keypath="help.dbWriteLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.dbOrderB') }}</b></template>
              </i18n-t>
            </ol>

            <h3>{{ t('help.dbNotesTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.dbNoteLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.dbConsoleB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.dbNoteLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.dbPreFailB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.dbNoteLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.dbSecretVarB') }}</b></template>
                <template #var><code v-pre>{{dbPassword}}</code></template>
              </i18n-t>
              <i18n-t keypath="help.dbNoteLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.dbLocalOnlyB') }}</b></template>
              </i18n-t>
              <li>{{ t('help.dbNoteLi5') }}</li>
              <i18n-t keypath="help.dbNoteLi6" tag="li" scope="global">
                <template #b><b>{{ t('help.dbExportClearB') }}</b></template>
              </i18n-t>
            </ul>
          </section>

          <!-- ============================================================ Socket.IO -->
          <section id="help-sio">
            <h2>{{ t('help.secSio') }}</h2>
            <i18n-t keypath="help.sioIntro" tag="p" scope="global">
              <template #code><code>42["message",…]</code></template>
              <template #sio><code>SIO</code></template>
            </i18n-t>

            <h3>{{ t('help.sioConnTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.sioConnLi1" tag="li" scope="global">
                <template #b1><b>{{ t('help.sioAddrB') }}</b></template>
                <template #c1><code>http://host:port</code></template>
                <template #b2><b>{{ t('help.sioPathB') }}</b></template>
                <template #c2><code>/socket.io</code></template>
                <template #b3><b>{{ t('help.sioNamespaceB') }}</b></template>
                <template #c3><code>/</code></template>
              </i18n-t>
              <i18n-t keypath="help.sioConnLi2" tag="li" scope="global">
                <template #var><code>{{变量}}</code></template>
                <template #auth><code>{{ t('help.sioAuthCode') }}</code></template>
              </i18n-t>
              <i18n-t keypath="help.sioConnLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.sioHandshakeAuthB') }}</b></template>
                <template #code><code>socket.handshake.auth</code></template>
              </i18n-t>
              <i18n-t keypath="help.sioConnLi4" tag="li" scope="global">
                <template #b1><b>{{ t('help.sioTransportUpgradeB') }}</b></template>
                <template #b2><b>{{ t('help.sioTransportWsB') }}</b></template>
              </i18n-t>
            </ul>

            <h3>{{ t('help.sioRecvTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.sioRecvLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.sioEventsB') }}</b></template>
              </i18n-t>
              <li>{{ t('help.sioRecvLi2') }}</li>
              <li>{{ t('help.sioRecvLi3') }}</li>
              <i18n-t keypath="help.sioRecvLi4" tag="li" scope="global">
                <template #b><b>{{ t('help.sioServerConnB') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.sioRecvLi5" tag="li" scope="global">
                <template #b><b>{{ t('help.sioVersionB') }}</b></template>
              </i18n-t>
            </ul>
          </section>

          <!-- ============================================================ gRPC -->
          <section id="help-grpc">
            <h2>{{ t('help.secGrpc') }}</h2>
            <i18n-t keypath="help.grpcIntro" tag="p" scope="global">
              <template #b><b>{{ t('help.grpcIntroB') }}</b></template>
              <template #code><code>host:port</code></template>
            </i18n-t>

            <h3>{{ t('help.grpcDefineTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.grpcDefineLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.grpcDefineLi1B') }}</b></template>
                <template #code><code>import</code></template>
              </i18n-t>
              <i18n-t keypath="help.grpcDefineLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.grpcDefineLi2B') }}</b></template>
              </i18n-t>
            </ul>
            <p>{{ t('help.grpcDefineNote') }}</p>

            <h3>{{ t('help.grpcCallTitle') }}</h3>
            <ul>
              <li>{{ t('help.grpcCallLi1') }}</li>
              <li>{{ t('help.grpcCallLi2') }}</li>
              <i18n-t keypath="help.grpcCallLi3" tag="li" scope="global">
                <template #b1><b>{{ t('help.grpcCallLi3B1') }}</b></template>
                <template #b2><b>{{ t('help.grpcCallLi3B2') }}</b></template>
              </i18n-t>
            </ul>
            <p>{{ t('help.grpcCallNote') }}</p>

            <h3>{{ t('help.grpcAssertTitle') }}</h3>
            <p>{{ t('help.grpcAssertIntro') }}</p>
            <ul>
              <i18n-t keypath="help.grpcAssertLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.grpcAssertLi1B') }}</b></template>
              </i18n-t>
              <li>{{ t('help.grpcAssertLi2') }}</li>
              <i18n-t keypath="help.grpcAssertLi3" tag="li" scope="global">
                <template #c1><code>count</code></template>
                <template #c2><code>[0].count</code></template>
              </i18n-t>
              <li>{{ t('help.grpcAssertLi4') }}</li>
            </ul>
            <i18n-t keypath="help.grpcLocalOnly" tag="p" scope="global">
              <template #b><b>{{ t('help.grpcLocalOnlyB') }}</b></template>
            </i18n-t>
          </section>

          <!-- ============================================================ MQTT -->
          <section id="help-mqtt">
            <h2>{{ t('help.secMqtt') }}</h2>
            <i18n-t keypath="help.mqttIntro" tag="p" scope="global">
              <template #b><b>{{ t('help.mqttIntroB') }}</b></template>
            </i18n-t>

            <h3>{{ t('help.mqttConnTitle') }}</h3>
            <ul>
              <i18n-t keypath="help.mqttConnLi1" tag="li" scope="global">
                <template #b><b>{{ t('help.mqttConnLi1B') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.mqttConnLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.mqttConnLi2B') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.mqttConnLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.mqttConnLi3B') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.mqttConnLi4" tag="li" scope="global">
                <template #b1><b>{{ t('help.mqttConnLi4B1') }}</b></template>
                <template #b2><b>{{ t('help.mqttConnLi4B2') }}</b></template>
              </i18n-t>
              <i18n-t keypath="help.mqttConnLi5" tag="li" scope="global">
                <template #b><b>{{ t('help.mqttConnLi5B') }}</b></template>
              </i18n-t>
            </ul>

            <h3>{{ t('help.mqttSubTitle') }}</h3>
            <i18n-t keypath="help.mqttSub" tag="p" scope="global">
              <template #c1><code>+</code></template>
              <template #c2><code>#</code></template>
              <template #c3><code>devices/+/status</code></template>
              <template #b><b>{{ t('help.mqttSubB') }}</b></template>
            </i18n-t>

            <h3>{{ t('help.mqttPubTitle') }}</h3>
            <i18n-t keypath="help.mqttPub" tag="p" scope="global">
              <template #c1><code>+</code></template>
              <template #c2><code>#</code></template>
            </i18n-t>

            <h3>{{ t('help.mqttLogTitle') }}</h3>
            <p>{{ t('help.mqttLog') }}</p>
            <i18n-t keypath="help.mqttLocalOnly" tag="p" scope="global">
              <template #b><b>{{ t('help.mqttLocalOnlyB') }}</b></template>
            </i18n-t>
          </section>

          <!-- ============================================================ TCP / UDP -->
          <section id="help-tcpudp">
            <h2>{{ t('help.secTcpUdp') }}</h2>
            <p>{{ t('help.tcpIntro') }}</p>

            <h3>{{ t('help.tcpConnTitle') }}</h3>
            <ul>
              <li>{{ t('help.tcpConnTcp') }}</li>
              <li>{{ t('help.tcpConnUdp') }}</li>
              <li>{{ t('help.tcpConnBind') }}</li>
            </ul>

            <h3>{{ t('help.tcpFramingTitle') }}</h3>
            <ul>
              <li>{{ t('help.tcpFramingNone') }}</li>
              <li>{{ t('help.tcpFramingDelimiter') }}</li>
              <li>{{ t('help.tcpFramingLength') }}</li>
            </ul>

            <h3>{{ t('help.tcpSendTitle') }}</h3>
            <ul>
              <li>{{ t('help.tcpSendText') }}</li>
              <li>{{ t('help.tcpSendHex') }}</li>
              <li>{{ t('help.tcpSendBase64') }}</li>
            </ul>

            <h3>{{ t('help.tcpLogTitle') }}</h3>
            <p>{{ t('help.tcpLog') }}</p>

            <h3>{{ t('help.tcpUdpTitle') }}</h3>
            <p>{{ t('help.tcpUdp') }}</p>

            <p class="note">{{ t('help.tcpLocalOnly') }}</p>
          </section>

          <!-- ============================================================ 前置接口 -->
          <section id="help-preflight">
            <h2>{{ t('help.secPreflight') }}</h2>
            <i18n-t keypath="help.preflightIntro" tag="p" scope="global">
              <template #b1><b>{{ t('help.pfProjectSettingsB') }}</b></template>
              <template #b2><b>{{ t('help.pfFolderSettingsB') }}</b></template>
              <template #b3><b>{{ t('help.pfOnceB') }}</b></template>
            </i18n-t>

            <h3>{{ t('help.pfHowTitle') }}</h3>
            <ul>
              <li>{{ t('help.pfHowLi1') }}</li>
              <i18n-t keypath="help.pfHowLi2" tag="li" scope="global">
                <template #b><b>{{ t('help.pfWhenNoValueB') }}</b></template>
                <template #code><code>token</code></template>
              </i18n-t>
              <i18n-t keypath="help.pfHowLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.pfWhen401B') }}</b></template>
              </i18n-t>
              <li>{{ t('help.pfHowLi4') }}</li>
              <li>{{ t('help.pfHowLi5') }}</li>
              <li>{{ t('help.pfHowLi6') }}</li>
            </ul>

            <h3>{{ t('help.pfTokenTitle') }}</h3>
            <i18n-t keypath="help.pfToken" tag="p" scope="global">
              <template #b><b>{{ t('help.pfSelfB') }}</b></template>
              <template #b2><b>{{ t('help.pfExtractB') }}</b></template>
              <template #code><code>token</code></template>
              <template #code2><code>pm.environment.set('token', ...)</code></template>
            </i18n-t>

            <h3>{{ t('help.pfWhatTitle') }}</h3>
            <ul>
              <li>{{ t('help.pfWhatLi1') }}</li>
              <li>{{ t('help.pfWhatLi2') }}</li>
              <i18n-t keypath="help.pfWhatLi3" tag="li" scope="global">
                <template #b><b>{{ t('help.pfNotAffectB') }}</b></template>
              </i18n-t>
            </ul>
          </section>

          <!-- ============================================================ 界面语言 -->
          <section id="help-language">
            <h2>{{ t('help.secLanguage') }}</h2>
            <i18n-t keypath="help.langIntro" tag="p" scope="global">
              <template #b><b>{{ t('help.langIntroB') }}</b></template>
            </i18n-t>
            <p>{{ t('help.langDetect') }}</p>
            <p class="note">{{ t('help.langBackendNote') }}</p>
          </section>

          <!-- ============================================================ 快捷键 -->
          <section id="help-shortcuts">
            <h2>{{ t('help.secShortcuts') }}</h2>
            <table>
              <tr><td><kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd></td><td>{{ t('help.shortcutsSave') }}</td></tr>
              <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></td><td>{{ t('help.shortcutsSearch') }}</td></tr>
              <tr><td><kbd>⌘\</kbd> / <kbd>Ctrl+\</kbd></td><td>{{ t('help.shortcutsToggle') }}</td></tr>
              <tr><td>{{ t('help.shortcutsDblTitle') }}</td><td>{{ t('help.shortcutsRename') }}</td></tr>
              <tr><td>{{ t('help.shortcutsDblEnv') }}</td><td>{{ t('help.shortcutsSetEnv') }}</td></tr>
            </table>
          </section>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.help {
  display: flex;
  height: 100%;
  min-height: 0;
}

.toc {
  flex: none;
  width: 120px;
  padding: 16px 8px;
  border-right: 1px solid var(--apiloop-divider);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toc a {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  opacity: 0.75;
}

.toc a:hover {
  background: rgba(128, 128, 128, 0.12);
  opacity: 1;
}

.toc a.active {
  color: var(--apiloop-primary);
  background: rgba(255, 108, 55, 0.1);
  opacity: 1;
}

.body {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 8px 24px 40px;
  font-size: 13px;
  line-height: 1.75;
}

section {
  padding-top: 12px;
  border-bottom: 1px solid var(--apiloop-divider);
  padding-bottom: 16px;
}

section:last-child {
  border-bottom: none;
}

h2 {
  margin: 8px 0 8px;
  font-size: 17px;
}

h3 {
  margin: 16px 0 6px;
  font-size: 14px;
}

h4 {
  margin: 12px 0 4px;
  font-size: 13px;
  opacity: 0.8;
}

p,
ul,
ol {
  margin: 6px 0;
}

ul,
ol {
  padding-left: 20px;
}

code,
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.13);
}

kbd {
  border: 1px solid rgba(128, 128, 128, 0.3);
}

pre {
  margin: 6px 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.1);
  overflow: auto;
}

pre code {
  padding: 0;
  background: none;
  font-size: 12px;
  line-height: 1.6;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 6px 0;
}

th,
td {
  text-align: left;
  vertical-align: top;
  padding: 5px 8px;
  border-bottom: 1px solid var(--apiloop-divider);
}

th {
  font-weight: 600;
  opacity: 0.75;
}

table.api td:first-child {
  width: 52%;
}

.flow {
  padding: 6px 10px;
  border-radius: 4px;
  background: rgba(255, 108, 55, 0.08);
}

.flow-inline {
  font-weight: 600;
}

.where {
  opacity: 0.65;
  font-size: 12px;
}

.note {
  opacity: 0.65;
  font-size: 12px;
}

.example + .example {
  margin-top: 10px;
}
</style>
