# 前端国际化（i18n）

界面支持中文和英文两种语言（先做这两种，以后再加）。**后端返回的错误信息这一轮还没做**，
仍然是中文 —— 下一阶段再说。

## 目录与约定

```
web/src/i18n/
  index.js            创建 i18n 实例、语言切换、`t` 的导出（非组件代码用）
  locales/
    zh-CN/app.js      区域「app」：中文
    zh-CN/layout.js   区域「layout」：中文
    en/app.js         区域「app」：英文
    en/layout.js      区域「layout」：英文
```

- **按区域拆文件**：一个区域一个文件，`locales/<语言>/<区域>.js`，`export default { ... }`。
  区域名就是文件名，键写成 `t('<区域>.<键>')`（比如 `locales/zh-CN/layout.js` 里的 `searchHint`
  在组件里是 `t('layout.searchHint')`）。
- 区域名和界面目录对应：`layout`（顶栏、侧栏、项目/环境切换、头像菜单……）、`app`（跨组件的通用词）、
  按需要再开 `request`、`response`、`grpc`、`sio`、`stores`、`utils` 等。**每个任务只写自己区域的文件**，
  几个人并行迁也不会互相打架。
- 文件由 `index.js` 用 `import.meta.glob('./locales/*/*.js', { eager: true })` 收集，
  新增区域文件不用改 `index.js`。
- 中英两边的**键必须完全一致**（少一个就是漏翻译）。

## 怎么用

组件里：

```js
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const label = computed(function () { return t('layout.trash'); });
```

```html
<button :title="t('layout.trash')">{{ t('layout.trash') }}</button>
```

store / 工具函数 / api 层（拿不到 `useI18n()`）用 `index.js` 导出的 `t`：

```js
import { t } from '@/i18n';

message.error(t('app.copyFailed'));
```

带参数：

```js
t('layout.recordRecording', { n: record.count });   // 录制中：3 条
```

复数用 vue-i18n 的 `|` 写法（中文只有一种形式，英文写两种）：

```js
// en: count: 'no items | {n} item | {n} items'
t('x.count', 2);
```

**依赖语言的选项数组、表头、下拉项一定要用 `computed` 包住**，切换语言后要立刻变，
不能只在创建时算一次。

## 语言选择

- 入口在**头像菜单里的「语言 / Language」**（中文 / English）。
- 选过之后记在 `localStorage.apiloop.locale`，下次打开就用它；
  **第一次打开（没记过）按浏览器语言**：`navigator.language` 以 `zh` 开头用中文，其余英文。
- 切换后整个界面立刻换（不刷新页面），`<html lang>` 跟着改。
- 读写 localStorage 都包了 try/catch（隐私模式里会抛异常）。

## 什么不翻译

- 用户数据：项目名、接口名、目录名、变量名、环境名。
- 代码：HTTP 方法、状态码、`{{变量}}` 写法、脚本内容、日志原文。
- 产品名 `apiloop`、`Mock`、`OpenAPI`、`JSON`、`GitHub` 这类专有名词。
- 界面和文档里**不许出现「Postman」字样**（用户明确要求）。

## 术语表

英文统一用下面这些词，别各写各的：

| 中文 | 英文 | 说明 |
| --- | --- | --- |
| 项目 | Project | |
| 目录 | Folder | 接口树里的分组，**不要**用 Directory |
| 接口 | API | |
| 环境 | Environment | 复数 Environments |
| 变量 | Variable | |
| 保密变量 | Secret variable | |
| Mock / 期望 | Mock / Expectation | Mock 不翻译 |
| 示例 | Example | |
| 测试集 | Test suite | |
| 断言 | Assertion | |
| 提取变量 | Extract | |
| 工作台 | Workbench | |
| 请求前 / 响应后脚本 | Pre-request / Response script | |
| 历史 | History | |
| 回收站 | Trash | |
| 收藏 | Favorites | |
| 未分组 | Ungrouped | |
| 同步 | Sync | |
| 云端 / 本机 | Cloud / Local | |
| 仅本机 | Local only | 网关未登录时的状态 |
| 只读 | Read-only | |
| 保存 / 取消 / 删除 | Save / Cancel / Delete | |
| 复制到剪贴板 | Copy | |

## 自测

（不写自动化测试，这里是临时脚本的做法，跑完就删。）

- **键一致性**：写个临时脚本 `import` 两边的区域文件，递归比键集合。
- **组件渲染**：用 vite SSR 分别用 `zh-CN` / `en` 渲染 `components/layout/` 下的每个组件
  （带上真实形状的 props），英文那次检查渲染结果里没有中文；
  记得给测试的 app 装上 `i18n` 插件，并设 `i18n.global.locale.value`。
