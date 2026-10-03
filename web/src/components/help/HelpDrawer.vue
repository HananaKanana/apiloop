<script setup>
import { computed, nextTick, ref, watch } from 'vue';
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

const SECTIONS = [
  { id: 'start', title: '快速上手' },
  { id: 'variables', title: '变量' },
  { id: 'scripts', title: '脚本' },
  { id: 'examples', title: '脚本用例' },
  { id: 'mock', title: 'Mock' },
  { id: 'import', title: '导入导出' },
  { id: 'shortcuts', title: '快捷键' }
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
    if (!item || !item.group || item.group === '模板') return;
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

const EXAMPLES = [
  {
    title: '登录后把 token 存成环境变量，其他接口自动带上',
    where: '登录接口 →「响应后」',
    code: [
      'const data = pm.response.json();',
      "pm.environment.set('token', data.data.token);",
      '',
      '// 其他接口：Auth 选 Bearer Token，值填 {{token}}',
      '// 或者在 Headers 里加 Authorization: Bearer {{token}}'
    ].join('\n')
  },
  {
    title: '断言：状态码、字段、响应时间',
    where: '任意接口 →「响应后」',
    code: [
      "pm.test('状态码是 200', function () {",
      '  pm.response.to.have.status(200);',
      '});',
      '',
      "pm.test('业务码为 0，并且返回了列表', function () {",
      '  const body = pm.response.json();',
      '  pm.expect(body.code).to.equal(0);',
      "  pm.expect(body.data).to.have.property('list');",
      '  pm.expect(body.data.list).to.be.an(\'array\');',
      '});',
      '',
      "pm.test('500ms 内返回', function () {",
      '  pm.expect(pm.response.responseTime).to.be.below(500);',
      '});'
    ].join('\n')
  },
  {
    title: '每次请求带上时间戳和签名',
    where: '项目设置 / 目录 →「请求前」（下面所有接口都会执行）',
    code: [
      'const ts = String(Date.now());',
      "pm.variables.set('ts', ts);",
      '',
      "pm.request.headers.upsert({ key: 'X-Timestamp', value: ts });",
      "pm.request.headers.upsert({ key: 'X-Request-Id', value: '{{$guid}}' });"
    ].join('\n')
  },
  {
    title: '发请求之前先去拿 token',
    where: '需要登录的接口 →「请求前」',
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
    title: '把列表画成表格（可视化页签）',
    where: '列表接口 →「响应后」',
    code: [
      'const template = `',
      '  <table border="1" cellpadding="6">',
      '    <tr><th>ID</th><th>名字</th></tr>',
      '    {{#each list}}<tr><td>{{id}}</td><td>{{name}}</td></tr>{{/each}}',
      '  </table>`;',
      '',
      'pm.visualizer.set(template, { list: pm.response.json().data.list });'
    ].join('\n')
  }
];
</script>

<template>
  <n-drawer v-model:show="ui.helpVisible" :width="760" placement="right">
    <n-drawer-content title="帮助" closable body-content-style="padding: 0; height: 100%; overflow: hidden">
      <div class="help">
        <nav class="toc">
          <a
            v-for="section in SECTIONS"
            :key="section.id"
            :class="{ active: active === section.id }"
            @click="go(section.id)"
          >
            {{ section.title }}
          </a>
        </nav>

        <div ref="bodyRef" class="body">
          <!-- ============================================================ 快速上手 -->
          <section id="help-start">
            <h2>快速上手</h2>
            <ol>
              <li>左边目录里新建接口（或者用「导入」把已有的接口导进来）。</li>
              <li>地址栏写请求地址，可以用变量：<code v-pre>{{host}}/api/users/:id</code>。
                <code>:id</code> 这种路径参数会出现在 Params 页签里填值。</li>
              <li>右上角选环境（比如「测试」「生产」），同一个 <code v-pre>{{host}}</code> 就会换成不同的地址。</li>
              <li>点「发送」看响应；<kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd> 保存。</li>
              <li>请求在<b>你自己的电脑上</b>发出（客户端里），所以内网、本机的地址都能访问。</li>
            </ol>
            <p>登录后，项目、接口、环境会自动同步到云端，同事也能看到；没网时改动先存在本机，联网后自动补上。</p>
          </section>

          <!-- ============================================================ 变量 -->
          <section id="help-variables">
            <h2>变量</h2>
            <p>在地址、参数、请求头、请求体、鉴权里写 <code v-pre>{{变量名}}</code>，发送时替换成实际值。
              鼠标移到变量上能看到当前的值；没定义的变量会标红。</p>

            <h3>在哪里定义</h3>
            <table>
              <tr><th>位置</th><th>作用范围</th><th>在哪改</th></tr>
              <tr><td>项目变量</td><td>整个项目的所有接口</td><td>项目设置 → 变量</td></tr>
              <tr><td>目录变量</td><td>这个目录（含子目录）下的接口</td><td>点开目录 → 变量</td></tr>
              <tr><td>环境变量</td><td>选中这个环境时</td><td>左边栏「环境」</td></tr>
              <tr><td>临时变量</td><td>只在这一次请求里</td><td>脚本里 <code>pm.variables.set()</code></td></tr>
            </table>

            <h3>同名时谁说了算</h3>
            <p>后面的覆盖前面的：</p>
            <p class="flow">项目变量 → 目录变量（从外层到里层）→ 环境变量 → 脚本里的临时变量</p>
            <p>比如项目里 <code>host</code> 是生产地址，「测试」环境里也定义了 <code>host</code>，选「测试」时用的就是测试地址。</p>

            <h3>内置的动态变量</h3>
            <p>每次发送都会重新生成，不用定义，名字不区分大小写：</p>
            <table>
              <tr><th>写法</th><th>值</th><th>例子</th></tr>
              <tr><td><code v-pre>{{$guid}}</code></td><td>随机 UUID</td><td>3f2b8c1e-…</td></tr>
              <tr><td><code v-pre>{{$timestamp}}</code></td><td>当前时间戳（秒）</td><td>1790944794</td></tr>
              <tr><td><code v-pre>{{$isoTimestamp}}</code></td><td>当前时间（ISO 格式）</td><td>2026-10-02T08:00:00.000Z</td></tr>
              <tr><td><code v-pre>{{$randomInt}}</code></td><td>0~1000 的随机整数</td><td>427</td></tr>
            </table>

            <h3>内置的 Mock 环境</h3>
            <p>环境下拉里固定有一项「Mock」，选中后 <code v-pre>{{host}}</code> 就是这个项目的 Mock 地址。
              接口都带统一前缀（比如 <code>/api</code>）时，到左边栏「环境」→「Mock」里改 host，改坏了可以「还原默认值」。</p>
          </section>

          <!-- ============================================================ 脚本 -->
          <section id="help-scripts">
            <h2>脚本</h2>
            <p>接口的 Scripts 页签里有两段，写 JavaScript：</p>
            <ul>
              <li><b>请求前</b>：请求发出去之前执行。可以改变量、改请求头；这里出错，请求不会发出去。</li>
              <li><b>响应后</b>：响应回来之后执行。取值存变量、写断言，结果在响应面板的「测试结果」里。</li>
            </ul>
            <p>项目设置、目录上也能写脚本，执行顺序是 <span class="flow-inline">项目 → 目录（从外到里）→ 接口</span>。
              公共的逻辑（比如签名）写在项目或目录上，下面的接口都会执行。</p>

            <h3>常用 API</h3>
            <table class="api">
              <tr><th>写法</th><th>说明</th></tr>
              <tr><td><code>pm.environment.get('k')</code> / <code>.set('k', v)</code> / <code>.unset('k')</code></td><td>读写<b>当前环境</b>的变量（会保存下来）</td></tr>
              <tr><td><code>pm.collectionVariables.get / set / unset</code></td><td>读写<b>项目变量</b>（会保存下来）</td></tr>
              <tr><td><code>pm.variables.get('k')</code></td><td>读变量的最终值（按上面的优先级）</td></tr>
              <tr><td><code>pm.variables.set('k', v)</code></td><td>设<b>临时变量</b>，只在这一次请求里有效，不保存</td></tr>
              <tr><td><code>pm.request.headers.upsert({ key, value })</code></td><td>加或改请求头（还有 <code>add</code>、<code>remove('名字')</code>）</td></tr>
              <tr><td><code>pm.request.url</code> / <code>pm.request.method</code> / <code>pm.request.body.raw</code></td><td>读或改请求地址、方法、请求体（请求前）</td></tr>
              <tr><td><code>pm.response.json()</code> / <code>.text()</code></td><td>响应体（响应后）</td></tr>
              <tr><td><code>pm.response.code</code> / <code>.responseTime</code> / <code>.headers.get('名字')</code></td><td>状态码、耗时（毫秒）、响应头</td></tr>
              <tr><td><code>pm.test('名字', function () { … })</code></td><td>一条断言，里面抛错就算失败</td></tr>
              <tr><td><code>pm.expect(值).to.equal(…)</code></td><td>断言写法，见下面</td></tr>
              <tr><td><code>pm.sendRequest(请求, function (err, res) {})</code></td><td>脚本里再发一个请求（每次最多 10 个）</td></tr>
              <tr><td><code>pm.visualizer.set(模板, 数据)</code></td><td>把数据画成网页，显示在响应的「可视化」页签（Handlebars 模板）</td></tr>
              <tr><td><code>console.log(…)</code></td><td>输出到响应面板的「控制台」</td></tr>
            </table>

            <h3>断言写法（pm.expect）</h3>
            <table class="api">
              <tr><td><code>.to.equal(1)</code></td><td>等于</td></tr>
              <tr><td><code>.to.eql({ a: 1 })</code></td><td>深比较（对象、数组）</td></tr>
              <tr><td><code>.to.include('ok')</code></td><td>字符串包含 / 数组包含</td></tr>
              <tr><td><code>.to.have.property('id')</code></td><td>有这个字段（可以再给个值比较）</td></tr>
              <tr><td><code>.to.have.lengthOf(3)</code></td><td>长度</td></tr>
              <tr><td><code>.to.be.above(0)</code> / <code>.below(500)</code> / <code>.least</code> / <code>.most</code></td><td>大于 / 小于 / 不小于 / 不大于</td></tr>
              <tr><td><code>.to.match(/^\d+$/)</code></td><td>正则匹配</td></tr>
              <tr><td><code>.to.be.oneOf([1, 2])</code></td><td>是其中之一</td></tr>
              <tr><td><code>.to.not.equal(…)</code></td><td>加 <code>not</code> 取反</td></tr>
              <tr><td><code>pm.response.to.have.status(200)</code> / <code>pm.response.to.be.ok</code></td><td>状态码是 200 / 是 2xx</td></tr>
            </table>
            <p class="note">用了不支持的 API 会报「apiloop 暂不支持 xxx」，告诉你是哪一个。</p>
          </section>

          <!-- ============================================================ 用例 -->
          <section id="help-examples">
            <h2>脚本用例</h2>
            <div v-for="example in EXAMPLES" :key="example.title" class="example">
              <h3>{{ example.title }}</h3>
              <p class="where">写在：{{ example.where }}</p>
              <pre><code>{{ example.code }}</code></pre>
            </div>
            <p class="note">脚本编辑器右上角的「常用片段」可以一键插入常见写法。</p>
          </section>

          <!-- ============================================================ Mock -->
          <section id="help-mock">
            <h2>Mock</h2>
            <p>后端还没好的时候，先让接口返回假数据，前端照常联调。</p>
            <ol>
              <li>打开接口 → Mock 页签，写一个返回的例子（或者发送后在响应上点「保存为示例」）。</li>
              <li>复制上面的 Mock 地址给前端用；或者自己在环境里选「Mock」，同一个接口直接打到 Mock 上。</li>
              <li>「按条件返回（高级）」：比如参数 <code>id=0</code> 时返回「用户不存在」。</li>
              <li>右上角「Mock 日志」能看到谁调了、调了什么。</li>
            </ol>
            <p>Mock 服务在云端，项目要登录、同步上去以后才能访问。</p>

            <h3>响应里能用的随机数据</h3>
            <p>写在返回内容里，每次请求重新生成。整个 JSON 值只有一个数字类占位符时，会自动去掉引号，
              比如 <code v-pre>"age": "{{@int(1,100)}}"</code> 返回的是 <code>"age": 42</code>。</p>
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
            <h4>重复</h4>
            <table class="api">
              <tr><td><code v-pre>{{@repeat(3)}} … {{/repeat}}</code></td><td>把中间的内容重复 3 份（列表数据），可以嵌套；<code v-pre>{{@repeat(2-5)}}</code> 随机 2~5 份</td></tr>
            </table>
            <p class="note">编辑返回内容时，编辑器上方的「插入 Mock 字段」可以直接点选。</p>
          </section>

          <!-- ============================================================ 导入导出 -->
          <section id="help-import">
            <h2>导入导出</h2>
            <table>
              <tr><th>格式</th><th>说明</th></tr>
              <tr><td>JSON 文件</td><td>接口集合（Collection v2.1）、环境、全局变量的 JSON，导入成新项目或导入到当前项目</td></tr>
              <tr><td>cURL</td><td>粘贴一条 curl 命令，变成一个接口</td></tr>
              <tr><td>OpenAPI / Swagger</td><td>填文档地址（比如 <code>/v3/api-docs</code>、<code>/swagger.json</code>，内网地址也行）、选 .json / .yaml 文件，或直接粘贴</td></tr>
              <tr><td>HAR</td><td>浏览器开发者工具「网络」面板导出的抓包文件</td></tr>
            </table>
            <ul>
              <li>导出：项目菜单「导出为 JSON」，环境「…」菜单「导出为 JSON」。</li>
              <li>导出为 OpenAPI：项目菜单「导出为 OpenAPI」，或者目录右键「导出为 OpenAPI」（只导这个目录连同子目录）。格式可选 YAML / JSON。</li>
              <li>复制为 cURL：接口右上角的「&lt;/&gt;」，变量会替换成当前环境的实际值。</li>
            </ul>
          </section>

          <!-- ============================================================ 快捷键 -->
          <section id="help-shortcuts">
            <h2>快捷键</h2>
            <table>
              <tr><td><kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd></td><td>保存当前接口、目录或环境</td></tr>
              <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></td><td>搜索接口</td></tr>
              <tr><td><kbd>⌘\</kbd> / <kbd>Ctrl+\</kbd></td><td>收起 / 展开左边栏</td></tr>
              <tr><td>双击标题</td><td>改接口、目录名字</td></tr>
              <tr><td>双击环境</td><td>设为当前环境</td></tr>
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
