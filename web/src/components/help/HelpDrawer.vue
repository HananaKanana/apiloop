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
  { id: 'export-doc', title: '导出文档' },
  { id: 'suite', title: '测试集' },
  { id: 'load', title: '压测' },
  { id: 'db', title: '数据库操作' },
  { id: 'sio', title: 'Socket.IO' },
  { id: 'preflight', title: '前置接口' },
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
    where: '项目设置 →「脚本」/ 目录 →「请求前」（下面所有接口都会执行）',
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
              <tr><td>项目变量</td><td>整个项目的所有接口</td><td>项目设置 → 请求设置 → 项目变量</td></tr>
              <tr><td>目录变量</td><td>这个目录（含子目录）下的接口</td><td>点开目录 → 变量</td></tr>
              <tr><td>环境变量</td><td>选中这个环境时</td><td>左边栏「环境」</td></tr>
              <tr><td>临时变量</td><td>只在这一次请求里</td><td>脚本里 <code>pm.variables.set()</code></td></tr>
            </table>

            <h3>同名时谁说了算</h3>
            <p>后面的覆盖前面的：</p>
            <p class="flow">项目变量 → 目录变量（从外层到里层）→ 环境变量 → 脚本里的临时变量</p>
            <p>比如项目里 <code>host</code> 是生产地址，「测试」环境里也定义了 <code>host</code>，选「测试」时用的就是测试地址。</p>

            <h3>内置的动态变量</h3>
            <p>不用定义，写在地址、参数、请求头、请求体里就行。<b>每出现一次生成一个新值</b>，
              名字不区分大小写，中英文两种写法等价：</p>
            <table>
              <tr><th>写法</th><th>生成什么</th><th>例子</th></tr>
              <tr><td><code v-pre>{{$guid}}</code></td><td>随机 UUID</td><td>3f2b8c1e-…</td></tr>
              <tr><td><code v-pre>{{$timestamp}}</code></td><td>当前时间戳（秒）</td><td>1790944794</td></tr>
              <tr><td><code v-pre>{{$timestampMs}}</code></td><td>当前毫秒时间戳</td><td>1790944794000</td></tr>
              <tr><td><code v-pre>{{$isoTimestamp}}</code></td><td>当前时间（ISO 格式）</td><td>2026-10-02T08:00:00.000Z</td></tr>
              <tr><td><code v-pre>{{$randomInt}}</code></td><td>0~1000 的随机整数</td><td>427</td></tr>
              <tr><td><code v-pre>{{$randomInt(1,100)}}</code> / <code v-pre>{{$整数(1,100)}}</code></td><td>区间内的随机整数</td><td>39</td></tr>
              <tr><td><code v-pre>{{$randomPhone}}</code> / <code v-pre>{{$手机号}}</code></td><td>11 位手机号（真实号段）</td><td>13800138000</td></tr>
              <tr><td><code v-pre>{{$randomIdCard}}</code> / <code v-pre>{{$身份证}}</code></td><td>18 位身份证号（校验位正确）</td><td>11010519900307123X</td></tr>
              <tr><td><code v-pre>{{$randomChineseName}}</code> / <code v-pre>{{$中文名}}</code></td><td>中文姓名</td><td>张伟</td></tr>
              <tr><td><code v-pre>{{$randomEmail}}</code> / <code v-pre>{{$邮箱}}</code></td><td>邮箱</td><td>user1234@example.com</td></tr>
              <tr><td><code v-pre>{{$randomDate}}</code> / <code v-pre>{{$日期}}</code></td><td>近一年内的日期</td><td>2026-04-11</td></tr>
              <tr><td><code v-pre>{{$randomDateTime}}</code> / <code v-pre>{{$时间}}</code></td><td>近一年内的日期时间</td><td>2026-04-11 15:20:33</td></tr>
              <tr><td><code v-pre>{{$randomAddress}}</code> / <code v-pre>{{$地址}}</code></td><td>省市区 + 详细地址</td><td>杭州市中山路12号3栋501室</td></tr>
              <tr><td><code v-pre>{{$randomCompany}}</code> / <code v-pre>{{$公司}}</code></td><td>公司名</td><td>字节跳动</td></tr>
              <tr><td><code v-pre>{{$randomBankCard}}</code> / <code v-pre>{{$银行卡}}</code></td><td>16 / 19 位卡号（Luhn 校验正确）</td><td>6222021234567890</td></tr>
              <tr><td><code v-pre>{{$randomCreditCode}}</code> / <code v-pre>{{$信用代码}}</code></td><td>18 位统一社会信用代码</td><td>91330106MA27XYZ123</td></tr>
              <tr><td><code v-pre>{{$randomPlate}}</code> / <code v-pre>{{$车牌}}</code></td><td>车牌号</td><td>浙A1B2C3</td></tr>
              <tr><td><code v-pre>{{$randomIp}}</code></td><td>IPv4 地址</td><td>192.168.1.20</td></tr>
            </table>
            <p>在输入框里打 <code v-pre>{{$</code> 会把这些列出来（带中文说明）。</p>
            <p><b>同一个值要用两次</b>：先在「请求前」脚本里存一次，再用普通变量引用 ——</p>
            <pre v-pre><code>pm.variables.set('phone', pm.variables.replaceIn('{{$手机号}}'));</code></pre>
            <p>之后写 <code v-pre>{{phone}}</code> 就是同一个号码了。脚本里也能用
              <code>pm.variables.replaceIn()</code> 直接展开任意带变量的文本。</p>
            <p><b>变量名可以用中文</b>：<code v-pre>{{账号}}</code> 这种写法在环境变量、目录变量、
              项目变量和数据驱动的 CSV 列名里都认。</p>

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

          <!-- ============================================================ 导出文档 -->
          <section id="help-export-doc">
            <h2>导出文档</h2>
            <p>把接口文档导出成一个能直接发出去的文件（外包、甲方、测试要的就是这个）：
              项目名下拉里的「导出文档…」，或者目录右键「导出文档…」（默认只导这个目录）。</p>

            <h3>三种格式</h3>
            <table>
              <tr><th>格式</th><th>说明</th></tr>
              <tr><td>Markdown（.md）</td><td>贴到 Wiki、仓库 README 里用</td></tr>
              <tr><td>HTML</td><td>单个文件，样式内联、不引外部资源，左边有可点的目录；能直接打开、能打印</td></tr>
              <tr><td>Word（.docx）</td><td>带 Word 自己的目录域（打开时按提示更新一下域就有页码了）</td></tr>
            </table>

            <h3>选项</h3>
            <ul>
              <li><b>包含示例响应</b>（默认勾）：把每个接口的示例响应也写进去。</li>
              <li><b>包含 Mock 地址</b>（默认不勾）：写进 Mock 地址。文件发出去之后 Mock 地址可能会变，
                所以默认不带。</li>
              <li><b>只导出已完成的接口</b>（默认不勾）：只导状态是「已完成」的接口。</li>
            </ul>

            <p class="note">内容和你打开分享链接看到的一样：按目录分章节，每个接口有名字、方法 + 地址、
              状态和负责人、说明、参数表、请求体、示例响应、响应字段说明。
              <b>密码、token 这类值会自动遮住</b>；环境变量的值、脚本不会导出。</p>
          </section>

          <!-- ============================================================ 测试集 -->
          <section id="help-suite">
            <h2>测试集</h2>
            <p>把几个接口<b>排成一个流程</b>（登录 → 建订单 → 查订单 → 取消订单）存下来反复跑，
              每次跑完留下记录和报告。侧栏上方切到「测试集」就能看到这个项目的测试集。</p>

            <h3>怎么建一个</h3>
            <ol>
              <li>侧栏切到「测试集」，点右上角的 + 新建；或者从「批量运行」里勾好接口之后点「存为测试集」。</li>
              <li>「步骤」页签里点「添加接口」从目录树里挑（勾目录会把它下面的接口按树的顺序一起加进来；
                WebSocket 接口不能加）。拖动可以调顺序。</li>
              <li>每一步可以单独设：失败时<b>继续</b>还是<b>跳过本轮剩下的步骤</b>、这一步跑完等多久。</li>
              <li>点开某一步可以给它<b>追加</b>断言和提取变量 —— 接口自己的断言照样会跑，这里的是在它之后追加的。</li>
            </ol>

            <h3>换一批数据跑很多遍</h3>
            <ul>
              <li>「数据」页签选 CSV 或 JSON（粘贴，或者选文件）。CSV 第一行是列名；JSON 是对象数组。</li>
              <li><b>每一行跑一轮</b>。列名就是变量名：接口里写 <code v-pre>{{列名}}</code> 就能用，
                脚本里用 <code>pm.iterationData.get('列名')</code>。</li>
              <li>数据变量<b>优先于环境变量</b>（环境里同名的会被这一行盖掉）。上限 1000 行 / 2 MB。</li>
              <li>不用数据时，按「设置」里那个轮数跑（默认 1 轮）。</li>
            </ul>

            <h3>运行时要注意的</h3>
            <ul>
              <li>运行时提取、脚本设置的变量<b>只在这次运行里有效</b>，不会改环境里保存的值。</li>
              <li>Cookie 每次运行从空开始、步骤之间共用（所以「先登录、后面自动带上」这种流程能跑通）。</li>
              <li>不记历史；失败的步骤会存下实际发出的请求和响应（响应体最多 32 KB，存之前打码）。</li>
              <li>运行<b>只能在本机客户端里跑</b>；网页版能编辑、能看运行记录，点运行会提示去客户端。</li>
            </ul>

            <h3>运行记录和报告</h3>
            <ul>
              <li>「运行记录」页签列出历次运行（谁跑的、什么环境、通过多少、用时），最多留最近 100 条。</li>
              <li>点一条打开报告：汇总、按轮分组、每一步的状态码 / 耗时 / 断言结果；失败的步骤能展开看
                实际发出的请求和响应。</li>
              <li>「导出报告」下载一个单独的 HTML 文件（样式内联、不引外部资源），可以直接发出去。</li>
              <li>运行记录保存在云端，同事都能看到；没登录时运行照样能跑，只是不留记录。</li>
            </ul>
          </section>

          <!-- ============================================================ 压测 -->
          <section id="help-load">
            <h2>压测</h2>
            <p>想知道「这个接口 50 个并发扛不扛得住、P95 多少」时用它。接口标签页的「发送」旁边
              点下拉里的「压测…」，会打开一个压测标签页（每个接口一个）。</p>

            <h3>怎么用</h3>
            <ol>
              <li>选并发数（同时有多少个请求在打）和停止条件：按次数打完多少就停，或者按时长打多少秒。</li>
              <li>「预热」是慢慢把并发加上去：填 10 秒、并发 50，就是从 1 个慢慢加到 50 个，
                避免一上来就把对方打懵（也能看出它在压力上来时什么时候开始变慢）。</li>
              <li>点「开始压测」。跑的时候上面几个数每秒刷新：已发、成功、失败、当前 QPS、平均响应时间、
                P95、进行中、已用时间；下面那张图是每秒请求数和每秒平均响应时间，有失败的那一秒底下标红条。</li>
              <li>「停止」会取消在途的请求、不再发新的；已经统计到的结果留着。</li>
              <li>跑完看汇总：错误率、平均 QPS、最小 / 平均 / 最大、P50 / P90 / P95 / P99、
                状态码分布、错误分组。「复制结果」可以贴到群里。</li>
            </ol>

            <h3>几个要注意的</h3>
            <ul>
              <li><b>会在目标服务器上产生真实压力</b>，开始前先和接口负责人说一声。
                环境名里带「生产」「线上」「prod」时会先弹一个红色确认框。</li>
              <li>压测<b>不看响应内容</b>：只统计状态码和响应时间，不跑脚本、不跑断言、不记历史。
                「算成功」默认是 2xx 和 3xx，也可以自己填（比如 <code>200,201</code>）。</li>
              <li>变量在<b>开始那一刻</b>按当前环境算一次，之后整轮都用这一份；地址、请求头、
                请求体都是开始那一刻接口标签页里的内容（没保存的修改也算），
                跑起来之后再去改接口不影响正在跑的这一次。</li>
              <li>压测结果<b>不会保存</b>，关掉标签页就没了；设置（并发数、次数……）按接口记住，下次接着用。</li>
              <li>压测<b>只能在本机客户端里跑</b>（请求从你自己的电脑发出）；网页版上这个入口是灰的。
                一个客户端同时只能跑一个压测。</li>
            </ul>
          </section>

          <!-- ============================================================ 数据库 -->
          <section id="help-db">
            <h2>数据库操作</h2>
            <p>测接口时常要「先往库里造一条测试数据」「调完接口去库里看看有没有写进去」
              「拿库里刚生成的验证码填进下一个请求」。这些不用再开一个数据库工具 ——
              在项目设置里配好连接，接口的「数据库」页签里写语句就行。</p>

            <h3>先配连接</h3>
            <ol>
              <li>进入「项目设置 → 数据库」，点「+ 新增连接」，填名字、类型（MySQL / PostgreSQL / Redis）、
                主机、端口、用户名、密码、数据库名（Redis 填库号）。</li>
              <li>点「测试连接」当场试一下（用的是当前环境里的变量）。</li>
              <li>连接保存后跟着「保存」一起生效，项目里所有接口都能用。</li>
            </ol>

            <h3>再写操作</h3>
            <ol>
              <li>接口的「数据库」页签里分两组：<b>请求前</b>（发请求之前跑，可以先造数据、
                也可以把查到的值填进这次请求的地址 / 请求头 / 请求体）和<b>响应后</b>（拿到响应之后跑，
                可以检查数据有没有写进去）。</li>
              <li>每行选一个连接、写一条语句（多行也行，语句里能写 <code v-pre>{{变量}}</code>）。</li>
              <li>要「把结果存成变量」就点这一行的「+ 提取」：填取值路径（SQL 的结果是行数组，
                <code>[0].code</code> 就是第一行的 code 列；MySQL 的 INSERT 用 <code>[0].insertId</code> 取刚插入的 id，
                PostgreSQL 在语句后面加 <code>RETURNING id</code> 再用 <code>[0].id</code>；Redis 留空就是整个返回值）、存到环境还是项目、变量名。</li>
              <li>执行顺序是<b>请求前的数据库操作 → 请求前脚本 → 发请求 → 响应后的数据库操作 →
                断言和提取 → 响应后脚本</b>。所以「响应后」查出来的变量可以直接写进断言里。</li>
            </ol>

            <h3>几个要注意的</h3>
            <ul>
              <li>每次操作在响应面板的「<b>控制台</b>」里占一行：连了哪个库、语句、耗时、返回几行
                （SELECT 的前 5 行也贴出来）；失败的那一行是红的。</li>
              <li><b>请求前的操作失败就不发这次请求</b>（多半是造数据没成功）；响应后的操作失败
                只记一条没通过的测试结果，不影响已经拿到的响应。</li>
              <li>连接里的每个字段都能写变量（开发库 / 测试库用环境变量区分最省事）。密码建议
                在环境里设成<b>保密变量</b>再写 <code v-pre>{{dbPassword}}</code>；
                直接填明文密码的话，它会同步给项目里所有人，界面上会黄字提醒。</li>
              <li>数据库操作<b>只在客户端里执行</b>（连接里有密码，不该让云端拿着它去连库）。
                网页版上发送时会跳过，控制台里会说一句。</li>
              <li>每次操作单独开一个连接、跑完就关（不建连接池），10 秒还没跑完就超时；
                SELECT 最多取 100 行。测试集和批量运行会照常带上这些操作，压测不跑。</li>
              <li>导出接口 JSON 时会带上连接清单，但<b>密码一律清空</b>；导入到已有项目时不会动
                那个项目里已经配好的连接。</li>
            </ul>
          </section>

          <!-- ============================================================ Socket.IO -->
          <section id="help-sio">
            <h2>Socket.IO</h2>
            <p>很多推送服务（聊天、通知、行情）用的是 Socket.IO —— 它在 WebSocket 之上还有自己的
              协议（握手、事件名、确认），普通的 WebSocket 标签页连不上，或者连上了只看到一堆
              <code>42["message",…]</code>。左边目录树工具条的「＋ → Socket.IO」新建一个调试标签页
              （接口页签的方法里也能直接选 <code>SIO</code>，存下来就是一个 Socket.IO 接口）。</p>

            <h3>连接</h3>
            <ul>
              <li><b>地址</b>填 <code>http://host:port</code>，<b>路径</b>默认 <code>/socket.io</code>，
                <b>命名空间</b>默认 <code>/</code>。三者拼起来才是真正连的地址。</li>
              <li>请求头、查询参数里可以写 <code>{{变量}}</code>，按当前环境替换；<code>鉴权</code>那一块和 HTTP
                接口是同一套规则（Bearer / Basic / API Key）。</li>
              <li><b>握手 auth</b> 是 Socket.IO 自己的认证对象（服务端拿 <code>socket.handshake.auth</code>），
                和上面的「鉴权」不是一回事，写 JSON。</li>
              <li>传输方式两档：<b>先长轮询再升级</b>（默认，最稳）和 <b>只用 WebSocket</b>。</li>
            </ul>

            <h3>收发</h3>
            <ul>
              <li><b>监听的事件</b>一行一个；留空表示监听全部事件。</li>
              <li>发送区填事件名和参数（JSON 数组，可以多个参数）；勾上「等待确认（ack）」时，
                服务端的回值也会记一条。</li>
              <li>「存为常用」把这条事件记进接口，下次打开点一下就发。</li>
              <li>和 WebSocket 一样，<b>连接是由服务端建立的</b>：浏览器装不了客户端、也绕不开跨域，
                所以要在本机客户端（不是网页版）里用。</li>
              <li>本客户端连的是 Socket.IO <b>3.x / 4.x</b> 的服务端；2.x 及更早的握手格式不一样，
                连不上时会提示。</li>
            </ul>
          </section>

          <!-- ============================================================ 前置接口 -->
          <section id="help-preflight">
            <h2>前置接口</h2>
            <p>token 过期之后就不用再手动点一次「登录」再回来发请求了：在<b>项目设置</b>或
              <b>目录设置</b>里指一个接口（通常就是登录接口），发送时会自动先调它一遍。
              测试集、批量运行同样生效，而且<b>一次运行只登录一次</b>（拿到的 token 留在这次运行里）。</p>

            <h3>怎么配</h3>
            <ul>
              <li>「前置接口」选一个接口；两个触发条件（默认都勾着）：</li>
              <li>☑ <b>变量没有值时</b> —— 变量名默认 <code>token</code>，取不到或者为空就先调一次；</li>
              <li>☑ <b>响应是 401 时</b> —— 主请求回了 401 就自动登录再重发一次（只重发一次）。</li>
              <li>目录上设了就用目录的（离接口最近的那一层），没设就往上找，一直到项目。
                目录上还能选「不使用前置接口」，挡住往上找。</li>
              <li>单个接口不想用，在它的「设置」页签里勾「不使用前置接口」。</li>
              <li>前置接口自己不会再触发前置接口 —— 不然把登录接口设成前置接口就套起来了。</li>
            </ul>

            <h3>token 从哪儿来</h3>
            <p>前置接口要<b>自己</b>把 token 存起来：在它的「断言」页签里配一条<b>提取变量</b>
              （提取到环境，变量名 <code>token</code>），或者写一段「响应后」脚本
              <code>pm.environment.set('token', ...)</code>。存下来的值会写回环境，
              所以下一次连前置接口都不用调。</p>

            <h3>发生了什么</h3>
            <ul>
              <li>自动调了前置接口时，响应面板的「控制台」里会有一行说明（是因为变量没有值，还是因为 401）。</li>
              <li>401 重发的那一次，响应面板顶上会提示「token 失效，已自动登录并重发」。</li>
              <li>前置接口自己失败（连不上、响应 4xx/5xx、它自己的断言没过）<b>不影响主请求</b>
                —— token 可能其实还有效，控制台里会写清楚失败原因。</li>
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
