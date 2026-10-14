/**
 * 构建前检查全部界面文案（用户 2026-10-13：「打包前自动检查全部文案」）。
 *
 * vue-i18n 把文案当成一种小语法来编译：`@` 是链接、`{ }` 是插值、`|` 是复数分隔。
 * 文案里直接写了这些字符，**构建不报错，界面用到那一句时才炸**（2026-10-09 铃铛：
 * 「别人在评论里 @ 你」这句一显示就编译失败，弹框闪一下就没了、再也点不开）。
 * 要原样显示这些字符得写成 `{'@'}`、`{'{'}`、`{'}'}`、`{'|'}`。
 *
 * 这里把 locales 下每一条都真的编译一遍，另外核对各语言的键是不是一一对应。
 * 有问题就列出来、退出码 1，`npm run build:web` 跟着失败，坏文案进不了安装包。
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', '..', 'package.json'));
const { createI18n } = await import(pathToFileURL(require.resolve('vue-i18n')).href);

const base = path.join(here, '..', 'src', 'i18n', 'locales');
const problems = [];
const keysByLang = {};
let total = 0;

function flatten(obj, prefix, out) {
  Object.keys(obj).forEach(function (key) {
    const full = prefix ? prefix + '.' + key : key;
    const value = obj[key];
    if (value && typeof value === 'object') flatten(value, full, out);
    else out[full] = value;
  });
  return out;
}

for (const lang of readdirSync(base)) {
  keysByLang[lang] = new Set();
  for (const file of readdirSync(path.join(base, lang)).filter(function (f) { return f.endsWith('.js'); })) {
    const area = file.replace(/\.js$/, '');
    const mod = (await import(pathToFileURL(path.join(base, lang, file)).href)).default;
    const flat = flatten(mod, '', {});
    for (const key of Object.keys(flat)) {
      keysByLang[lang].add(area + '.' + key);
      const value = flat[key];
      if (typeof value !== 'string') continue;
      total++;
      const i18n = createI18n({ legacy: false, locale: 'x', missingWarn: false, fallbackWarn: false, warnHtmlMessage: false, messages: { x: { m: value } } });
      try {
        i18n.global.t('m', {});
      } catch (err) {
        problems.push(lang + '/' + file + '  ' + key + '\n    ' + JSON.stringify(value) +
          '\n    ' + String(err.message).split('\n')[0]);
      }
    }
  }
}

const langs = Object.keys(keysByLang);
for (const a of langs) {
  for (const b of langs) {
    if (a === b) continue;
    for (const key of keysByLang[a]) {
      if (!keysByLang[b].has(key)) problems.push(b + ' 缺少 ' + key + '（' + a + ' 里有）');
    }
  }
}

if (problems.length) {
  console.error('\n文案检查没通过（' + problems.length + ' 处）：\n');
  problems.forEach(function (line) { console.error('  ' + line); });
  console.error('\n要原样显示 @ { } | 这些字符，写成 {\'@\'} {\'{\'} {\'}\'} {\'|\'}。\n');
  process.exit(1);
}

console.log('文案检查通过：' + langs.join(' / ') + '，共 ' + total + ' 条');
