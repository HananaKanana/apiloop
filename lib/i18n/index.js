/**
 * 后端提示的多语言（第十六轮）。
 *
 * 界面能在中英之间切，前端每个请求都带 `Accept-Language`（`en` 或 `zh-CN`），
 * 后端照它返回对应语言的提示。这一层只做**提示文案**的翻译 ——
 * 注释、日志（`console.*`）、存进库的数据、机器可读的 `code` 字段都不动。
 *
 * 三条约定（后两个任务也照这个写）：
 *
 * 1. **以中文原文作键**。`m('找不到接口「{name}」', { name: x })` —— 中文语言下原样返回
 *    （只做占位符替换），英文下查 `lib/i18n/en/<区域>.js`，查不到退回中文。
 *    所以**漏翻不会报错**，原文改一个字就得同时改翻译文件里的键。
 * 2. **当前语言用 `AsyncLocalStorage` 存**：`middleware` 解析 `Accept-Language`，
 *    然后用 `als.run` 把后续处理包住 —— 请求里所有（含异步）的 `m` 都拿到同一个语言。
 *    请求之外（定时任务、同步引擎这类后台代码）用**最近一次请求的语言**：
 *    网关是单用户，后台消息跟着界面语言走才符合直觉；进程启动后还没收到请求时是中文。
 * 3. **拼接出来的句子改成整句 + 占位符**：`'找不到' + what` → `m('找不到{what}', {...})`。
 *    不要拆成半句翻译 —— 英文语序和中文不一样，半句拼出来的东西没法看。
 *
 * 翻译文件按**区域**拆：`lib/i18n/en/api.js`（管理接口 / 登录 / 权限）、
 * `lib/i18n/en/gateway.js`（网关 / 同步）、以后还有 `run.js`、`io.js`。
 * 一个区域一个文件，几个人并行迁也不会互相打架；加载时合并成一张表。
 */

var fs = require('fs');
var path = require('path');
var AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;

/** 支持的语言。第一个是默认语言，也是「认不出来时」的选择 */
var LOCALES = ['zh-CN', 'en'];
var DEFAULT_LOCALE = 'zh-CN';

/** 英文翻译所在的目录：一个区域一个文件 */
var EN_DIR = path.join(__dirname, 'en');

var als = new AsyncLocalStorage();

/**
 * 最近一次请求的语言。后台代码（定时器、同步引擎）不在任何请求的 ALS 里，
 * 就拿它当当前语言。
 */
var lastLocale = DEFAULT_LOCALE;

/**
 * 加载所有英文区域文件，合并成一张「中文原文 → 英文」的表。
 *
 * 加载不了（文件坏、目录不在）只打日志、不抛：翻译挂了不该让整个服务起不来。
 */
function loadTranslations() {
    var table = {};
    var names;

    try {
        names = fs.readdirSync(EN_DIR);
    } catch (err) {
        return table;
    }

    names.filter(function (name) { return /\.js$/.test(name); }).sort().forEach(function (name) {
        var part;
        try {
            part = require(path.join(EN_DIR, name));
        } catch (err) {
            console.error('[apiloop] 加载 ' + name + ' 的英文翻译失败：' + ((err && err.message) || err));
            return;
        }

        Object.keys(part || {}).forEach(function (key) {
            table[key] = part[key];
        });
    });

    return table;
}

var translations = loadTranslations();

/**
 * `Accept-Language` → 语言。
 *
 * **只看开头**：以 `en` 开头就算英文（`en`、`en-US`、`en-US,en;q=0.9` 都是），
 * 其余（`zh-CN`、`zh`、没带头、认不出来的）都是中文。按约定就这两档，不做加权协商。
 */
function normalizeLocale(value) {
    var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (text.indexOf('en') === 0) return 'en';
    return DEFAULT_LOCALE;
}

function has(text) {
    return Object.prototype.hasOwnProperty.call(translations, text);
}

/** `{占位符}` 替换。**参数值本身不翻译**（那多半是项目名、接口名这类用户数据） */
function fill(text, params) {
    var out = String(text);
    if (!params) return out;

    return out.replace(/\{(\w+)\}/g, function (whole, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
    });
}

/** 查一条翻译（已按语言选好），再填占位符 */
function pick(localeName, text, params) {
    var key = String(text === undefined || text === null ? '' : text);
    var out = localeName === 'en' && has(key) ? translations[key] : key;
    return fill(out, params);
}

/** 当前语言：`'zh-CN'` 或 `'en'` */
function locale() {
    var current = als.getStore();
    return LOCALES.indexOf(current) > -1 ? current : lastLocale;
}

/**
 * 按当前语言取一条提示。
 *
 * @param {string} text 中文原文（也是查翻译用的键）
 * @param {object} [params] 占位符的值
 */
function m(text, params) {
    return pick(locale(), text, params);
}

/**
 * 按**指定**语言取一条提示。
 *
 * 给「手里拿着一个语言、但当前不在那个请求里」的地方用（比如同步引擎拿着会话的
 * 语言去拼一条要写进运行记录的话）。
 */
function mIn(localeName, text, params) {
    return pick(LOCALES.indexOf(localeName) > -1 ? localeName : DEFAULT_LOCALE, text, params);
}

/**
 * express 中间件：解析 `Accept-Language`，把后续处理包在对应的语言里。
 *
 * `next` 之后的整条链路（含 await 出来的异步部分）看 `locale()` 都会拿到这个语言；
 * 同时也记成「最近一次请求的语言」，给后台代码用。
 */
function middleware(req, res, next) {
    var wanted = normalizeLocale(req.headers ? req.headers['accept-language'] : '');
    lastLocale = wanted;
    als.run(wanted, next);
}

/** 在指定语言下执行 `fn`（同步返回）。不改变「最近一次请求的语言」 */
function runWith(localeName, fn) {
    var wanted = LOCALES.indexOf(localeName) > -1 ? localeName : DEFAULT_LOCALE;
    return als.run(wanted, fn);
}

module.exports = {
    LOCALES: LOCALES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    normalizeLocale: normalizeLocale,
    m: m,
    mIn: mIn,
    locale: locale,
    middleware: middleware,
    runWith: runWith,
    // 自测用：看看翻译表里有多少条、漏了哪些
    translations: translations
};
