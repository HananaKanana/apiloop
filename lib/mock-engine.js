/**
 * Mock 数据引擎：响应体模板渲染 + 随机数据生成。
 *
 * 模板语法（写在路由的 response 里，每个请求都会重新渲染）：
 *   {{@cname}}              随机中文姓名
 *   {{@int(1,100)}}         区间随机整数
 *   {{@repeat(3)}}...{{/repeat}}   把中间内容重复 3 份，支持嵌套，也支持 {{@repeat(2-5)}} 随机份数
 *   {{@query(page)}}        回显请求参数（query / body / params / header 同理）
 *
 * 单独占满一个 JSON 字符串的数值类占位符会自动去掉引号，
 * 例如 "age": "{{@int(1,100)}}" 渲染成 "age": 42 而不是 "age": "42"。
 */

var COUNTERS = {};

/* ------------------------------------------------------------------ 基础工具 */

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(list) {
    return list[randomInt(0, list.length - 1)];
}

function pad(num, len) {
    var str = String(num);
    while (str.length < len) str = '0' + str;
    return str;
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
        var r = Math.random() * 16 | 0;
        var v = ch === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/* ------------------------------------------------------------------ 中文语料 */

var SURNAMES = ('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤').split('');

var GIVEN_NAMES = ('伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂华文博子涵欣怡浩然雨泽思远嘉怡梓涵一诺俊杰晨曦若曦宇轩诗琪梦洁志强建国春梅冬梅晓明小红国庆建华淑珍桂芳玉兰秀兰金凤秀珍海燕丽娟雪梅').match(/.{2}/g);

var CITIES = ('北京 上海 广州 深圳 杭州 成都 武汉 西安 南京 重庆 天津 苏州 长沙 郑州 青岛 大连 厦门 宁波 无锡 福州 合肥 昆明 济南 沈阳 哈尔滨 南昌 贵阳 南宁 兰州 太原 石家庄 海口 三亚').split(' ');

var PROVINCES = ('北京市 上海市 广东省 浙江省 江苏省 山东省 河南省 四川省 湖北省 湖南省 福建省 安徽省 河北省 陕西省 辽宁省 江西省 云南省 广西壮族自治区 山西省 吉林省 黑龙江省 内蒙古自治区 新疆维吾尔自治区 甘肃省 贵州省 天津市 重庆市 海南省 宁夏回族自治区 青海省 西藏自治区').split(' ');

var COMPANIES = ('字节跳动 腾讯 阿里巴巴 百度 美团 京东 网易 小米 华为 滴滴出行 快手 拼多多 哔哩哔哩 携程 蔚来 商汤科技 大疆创新 中兴通讯 联想集团').split(' ');

var JOBS = '前端工程师 后端工程师 测试工程师 产品经理 UI设计师 交互设计师 数据分析师 算法工程师 运维工程师 项目经理 运营专员 市场专员 人力资源专员'.split(' ');

var UNIVERSITIES = ('清华大学 北京大学 复旦大学 上海交通大学 浙江大学 南京大学 武汉大学 中山大学 四川大学 华中科技大学 西安交通大学 哈尔滨工业大学 同济大学 南开大学 厦门大学 东南大学').split(' ');

var WORDS = ('苹果 用户 订单 数据 系统 接口 服务 模块 页面 组件 消息 任务 报表 权限 日志 网络 缓存 队列 索引 配置 支付 库存 物流 结算 订单号 商品 分类 标签 评论 收藏').split(' ');

var STREETS = ('中山路 人民路 解放路 建设路 长江路 南京路 淮海路 文化路 高新大道 科技路 学院路 环城北路').split(' ');

var EN_FIRST = ('Alice Bob Carol David Emma Frank Grace Henry Ivy Jack Kate Leo Mona Nick Olivia Peter Queen Rose Sam Tom Uma Victor Wendy Xavier Yoyo Zack').split(' ');

var EN_LAST = ('Smith Johnson Williams Brown Jones Miller Davis Wilson Moore Taylor Anderson Thomas Jackson White Harris Martin').split(' ');

var EMAIL_DOMAINS = 'example.com test.com demo.com mock.dev mail.com 163.com qq.com'.split(' ');

/* ------------------------------------------------------------------ 生成器 */

function formatDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
}

function formatTime(d) {
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
}

function toNumber(value, fallback) {
    var num = Number(value);
    return isNaN(num) ? fallback : num;
}

/**
 * 生成器表。每项：{ name, args, group, desc, insert, fn }
 * insert 是插入到编辑器里的默认写法；args 是参数说明（没有参数则为空串）。
 */
var PLACEHOLDERS = [
    /* 文本 */
    { name: 'cname', args: '', group: '文本', desc: '随机中文姓名', fn: function () { return pick(SURNAMES) + pick(GIVEN_NAMES); } },
    { name: 'firstname', args: '', group: '文本', desc: '随机中文姓氏', fn: function () { return pick(SURNAMES); } },
    { name: 'ename', args: '', group: '文本', desc: '随机英文姓名', fn: function () { return pick(EN_FIRST) + ' ' + pick(EN_LAST); } },
    { name: 'word', args: '', group: '文本', desc: '随机词语', fn: function () { return pick(WORDS); } },
    { name: 'words', args: 'n', group: '文本', desc: 'n 个随机词语（空格分隔）', insert: '{{@words(3)}}', fn: function (args) {
        var n = toNumber(args[0], 3);
        var out = [];
        for (var i = 0; i < n; i++) out.push(pick(WORDS));
        return out.join(' ');
    } },
    { name: 'sentence', args: '', group: '文本', desc: '随机一句话', fn: function () {
        return pick(WORDS) + '的' + pick(WORDS) + '已经' + pick(['完成', '更新', '生效', '提交', '同步']) + '，' + pick(['请及时查看', '如有问题请联系管理员', '详情见附件', '感谢配合']);
    } },
    { name: 'paragraph', args: '', group: '文本', desc: '随机一段话（较长，适合详情/备注）', fn: function () {
        var out = [];
        for (var i = 0; i < 3; i++) out.push(pick(WORDS) + pick(['用于', '负责', '涉及', '覆盖']) + pick(WORDS) + '的' + pick(['处理', '展示', '校验', '同步', '统计']));
        return out.join('；') + '。';
    } },
    { name: 'title', args: '', group: '文本', desc: '随机标题', fn: function () {
        return pick(['关于', '浅谈', '深入理解', '一文搞懂', '从零实现']) + pick(WORDS) + pick(['的最佳实践', '的实现原理', '常见问题汇总', '入门指南']);
    } },
    { name: 'company', args: '', group: '文本', desc: '随机公司名', fn: function () { return pick(COMPANIES); } },
    { name: 'job', args: '', group: '文本', desc: '随机职位', fn: function () { return pick(JOBS); } },
    { name: 'university', args: '', group: '文本', desc: '随机大学', fn: function () { return pick(UNIVERSITIES); } },
    { name: 'city', args: '', group: '文本', desc: '随机城市', fn: function () { return pick(CITIES); } },
    { name: 'province', args: '', group: '文本', desc: '随机省份', fn: function () { return pick(PROVINCES); } },
    { name: 'address', args: '', group: '文本', desc: '随机详细地址', fn: function () {
        return pick(CITIES) + '市' + pick(STREETS) + randomInt(1, 500) + '号' + randomInt(1, 30) + '栋' + randomInt(101, 2508) + '室';
    } },

    /* 数字 */
    { name: 'int', args: 'min,max', group: '数字', desc: '区间内随机整数，默认 1~100', insert: '{{@int(1,100)}}', fn: function (args) {
        return randomInt(toNumber(args[0], 1), toNumber(args[1], 100));
    } },
    { name: 'float', args: 'min,max,digits', group: '数字', desc: '区间内随机小数，默认 0~100 保留 2 位', insert: '{{@float(1,100,2)}}', fn: function (args) {
        var min = toNumber(args[0], 0);
        var max = toNumber(args[1], 100);
        var digits = toNumber(args[2], 2);
        return Number((Math.random() * (max - min) + min).toFixed(digits));
    } },
    { name: 'price', args: 'min,max', group: '数字', desc: '随机价格（两位小数），默认 1~999', insert: '{{@price(1,999)}}', fn: function (args) {
        var min = toNumber(args[0], 1);
        var max = toNumber(args[1], 999);
        return Number((Math.random() * (max - min) + min).toFixed(2));
    } },
    { name: 'id', args: 'start', group: '数字', desc: '自增 ID，默认从 1 开始，每次请求递增', insert: '{{@id}}', fn: function (args) {
        var start = toNumber(args[0], 1);
        COUNTERS[start] = (COUNTERS[start] === undefined) ? start : COUNTERS[start] + 1;
        return COUNTERS[start];
    } },
    { name: 'bool', args: '', group: '其他', desc: '随机布尔值 true/false', fn: function () { return Math.random() < 0.5; } },
    { name: 'pick', args: 'a,b,c', group: '其他', desc: '从候选值中随机取一个', insert: '{{@pick(待付款,已付款,已发货)}}', fn: function (args) {
        return args.length ? pick(args) : '';
    } },

    /* 时间 */
    { name: 'date', args: '', group: '时间', desc: '今天日期 YYYY-MM-DD', fn: function () { return formatDate(new Date()); } },
    { name: 'time', args: '', group: '时间', desc: '当前时间 HH:mm:ss', fn: function () { return formatTime(new Date()); } },
    { name: 'datetime', args: '', group: '时间', desc: '当前日期时间 YYYY-MM-DD HH:mm:ss', fn: function () { return formatDate(new Date()) + ' ' + formatTime(new Date()); } },
    { name: 'timestamp', args: '', group: '时间', desc: '当前毫秒时间戳', fn: function () { return Date.now(); } },
    { name: 'dateOffset', args: 'days', group: '时间', desc: '相对今天偏移 n 天的日期，负数表示过去', insert: '{{@dateOffset(-3)}}', fn: function (args) {
        var d = new Date();
        d.setDate(d.getDate() + toNumber(args[0], 0));
        return formatDate(d);
    } },
    { name: 'datetimeOffset', args: 'days', group: '时间', desc: '相对当前时间偏移 n 天的日期时间', insert: '{{@datetimeOffset(7)}}', fn: function (args) {
        var d = new Date();
        d.setDate(d.getDate() + toNumber(args[0], 0));
        return formatDate(d) + ' ' + formatTime(d);
    } },

    /* 网络 / 标识 */
    { name: 'uuid', args: '', group: '网络', desc: '随机 UUID', fn: function () { return uuid(); } },
    { name: 'phone', args: '', group: '网络', desc: '随机手机号', fn: function () { return '1' + pick(['3', '5', '7', '8', '9']) + pad(randomInt(0, 999999999), 9); } },
    { name: 'email', args: '', group: '网络', desc: '随机邮箱', fn: function () {
        return pick(WORDS) + randomInt(1, 999) + '@' + pick(EMAIL_DOMAINS);
    } },
    { name: 'url', args: '', group: '网络', desc: '随机 URL', fn: function () { return 'https://' + pick(['www', 'api', 'm', 'static']) + '.' + pick(['example', 'test', 'demo']) + '.com/' + pick(WORDS) + '/' + randomInt(1, 999); } },
    { name: 'image', args: 'w,h', group: '网络', desc: '随机图片地址，默认 200x200', insert: '{{@image(200x200)}}', fn: function (args) {
        var size = String(args[0] || '200x200').split('x');
        var w = toNumber(size[0], 200);
        var h = toNumber(size[1], w);
        return 'https://picsum.photos/seed/' + uuid().slice(0, 8) + '/' + w + '/' + h;
    } },
    { name: 'ip', args: '', group: '网络', desc: '随机 IP 地址', fn: function () { return [randomInt(1, 254), randomInt(0, 255), randomInt(0, 255), randomInt(1, 254)].join('.'); } },
    { name: 'color', args: '', group: '网络', desc: '随机十六进制颜色', fn: function () { return '#' + pad((Math.random() * 0xffffff | 0).toString(16), 6); } },
    { name: 'token', args: '', group: '网络', desc: '随机 token（32 位十六进制）', fn: function () { return (uuid() + uuid()).replace(/-/g, '').slice(0, 32); } },

    /* 输入回显 */
    { name: 'query', args: 'key', group: '输入回显', desc: '回显 URL 查询参数', insert: '{{@query(id)}}', fn: function (args, ctx) { return readInput(ctx.query, args[0]); } },
    { name: 'body', args: 'key', group: '输入回显', desc: '回显请求体字段（支持 a.b 取嵌套）', insert: '{{@body(name)}}', fn: function (args, ctx) { return readInput(ctx.body, args[0]); } },
    { name: 'params', args: 'key', group: '输入回显', desc: '回显路径参数', insert: '{{@params(id)}}', fn: function (args, ctx) { return readInput(ctx.params, args[0]); } },
    { name: 'header', args: 'key', group: '输入回显', desc: '回显请求头', insert: '{{@header(token)}}', fn: function (args, ctx) { return readInput(ctx.headers, args[0]); } }
];

var PLACEHOLDER_MAP = {};
PLACEHOLDERS.forEach(function (item) {
    if (!item.insert) item.insert = '{{@' + item.name + '}}';
    PLACEHOLDER_MAP[item.name.toLowerCase()] = item;
});

/**
 * 入参字段类型（管理台表单下拉用）。
 *   sample      —— 真实的示例值，「🎲」按钮填这个，因为入参示例会被自测面板直接发出去
 *   placeholder —— Mock 表达式，用于往「响应体」里插入随机字段
 */
var FIELD_TYPES = [
    { value: 'string', label: '字符串', sample: '示例文本', placeholder: '{{@word}}' },
    { value: 'text', label: '长文本', sample: '这是一段较长的示例文本，用于说明字段内容。', placeholder: '{{@paragraph}}' },
    { value: 'number', label: '数字', sample: '42', placeholder: '{{@int(1,100)}}' },
    { value: 'price', label: '金额', sample: '99.90', placeholder: '{{@price(1,999)}}' },
    { value: 'boolean', label: '布尔', sample: 'true', placeholder: '{{@bool}}' },
    { value: 'id', label: 'ID', sample: '1', placeholder: '{{@id}}' },
    { value: 'uuid', label: 'UUID', sample: 'a1b2c3d4-1111-4222-8333-444455556666', placeholder: '{{@uuid}}' },
    { value: 'phone', label: '手机号', sample: '13800138000', placeholder: '{{@phone}}' },
    { value: 'email', label: '邮箱', sample: 'zhangsan@example.com', placeholder: '{{@email}}' },
    { value: 'name', label: '姓名', sample: '张三', placeholder: '{{@cname}}' },
    { value: 'city', label: '城市', sample: '杭州', placeholder: '{{@city}}' },
    { value: 'date', label: '日期', sample: '2026-01-01', placeholder: '{{@date}}' },
    { value: 'datetime', label: '日期时间', sample: '2026-01-01 12:00:00', placeholder: '{{@datetime}}' },
    { value: 'image', label: '图片', sample: 'https://picsum.photos/seed/demo/200/200', placeholder: '{{@image(200x200)}}' },
    { value: 'url', label: 'URL', sample: 'https://example.com/api/users', placeholder: '{{@url}}' },
    { value: 'array', label: '数组', sample: '[]', placeholder: '' },
    { value: 'object', label: '对象', sample: '{}', placeholder: '' }
];

/**
 * 常用响应体模板，管理台「常用模板」下拉直接用。
 */
var TEMPLATES = [
    {
        name: '标准成功',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {}\n}'
    },
    {
        name: '列表分页',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "list": [\n{{@repeat(3)}}      {\n        "id": "{{@id}}",\n        "name": "{{@cname}}",\n        "price": "{{@price(1,999)}}",\n        "status": "{{@pick(待付款,已付款,已发货)}}",\n        "createdAt": "{{@datetime}}"\n      }\n{{/repeat}}    ],\n    "total": {{@int(10,999)}},\n    "page": 1,\n    "pageSize": 10\n  }\n}'
    },
    {
        name: '对象详情',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "id": "{{@id}}",\n    "name": "{{@cname}}",\n    "job": "{{@job}}",\n    "company": "{{@company}}",\n    "phone": "{{@phone}}",\n    "email": "{{@email}}",\n    "city": "{{@city}}",\n    "address": "{{@address}}",\n    "avatar": "{{@image(80x80)}}",\n    "createdAt": "{{@datetime}}"  }\n}'
    },
    {
        name: '业务失败',
        response: '{\n  "code": 1,\n  "msg": "参数错误",\n  "data": null\n}'
    },
    {
        name: '登录成功',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "token": "{{@token}}",\n    "expiresIn": 7200,\n    "userInfo": {\n      "id": "{{@id}}",\n      "name": "{{@cname}}",\n      "avatar": "{{@image(80x80)}}"\n    }\n  }\n}'
    },
    {
        name: '回显请求参数',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "你提交的id": "{{@params(id)}}",\n    "你提交的name": "{{@body(name)}}",\n    "你提交的query": "{{@query(keyword)}}",\n    "收到时间": "{{@datetime}}"\n  }\n}'
    },
    {
        name: '空列表',
        response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "list": [],\n    "total": 0\n  }\n}'
    }
];

/* ------------------------------------------------------------------ 渲染 */

/**
 * 从 query / body / params / headers 里按 key 取值，支持 `a.b` 取嵌套字段。
 * 回显占位符用它，mock 期望的匹配也用它 —— 两边取值口径必须一致，
 * 否则「回显到的值」和「条件判断的值」会对不上。
 */
function readInput(source, key) {
    if (!source || !key) return '';
    if (Object.prototype.hasOwnProperty.call(source, key)) {
        var value = source[key];
        return (value === null || value === undefined) ? '' : value;
    }
    // 支持 a.b 取嵌套字段
    if (key.indexOf('.') > -1) {
        var cur = source;
        var parts = key.split('.');
        for (var i = 0; i < parts.length; i++) {
            if (cur === null || typeof cur !== 'object') return '';
            cur = cur[parts[i]];
        }
        return (cur === null || cur === undefined) ? '' : cur;
    }
    return '';
}

function parseArgs(raw) {
    if (raw === undefined || raw === null || raw === '') return [];
    return String(raw).split(',').map(function (item) { return item.trim(); });
}

/**
 * 解析 repeat 的份数：'3' 固定 3 份，'2-5' 随机 2~5 份
 */
function resolveRepeatCount(raw) {
    var text = String(raw).trim();
    var range = text.split('-');
    if (range.length === 2) {
        var min = toNumber(range[0], 1);
        var max = toNumber(range[1], min);
        return Math.max(0, randomInt(min, max));
    }
    return Math.max(0, toNumber(text, 0));
}

var REPEAT_OPEN = '{{@repeat(';
var REPEAT_CLOSE = '{{/repeat}}';

/**
 * 展开 {{@repeat(n)}}...{{/repeat}}，支持嵌套；不配对时保留原文并记 warning。
 */
function expandRepeats(input, warnings) {
    var out = '';
    var cursor = 0;

    while (cursor < input.length) {
        var openAt = input.indexOf(REPEAT_OPEN, cursor);
        if (openAt === -1) {
            out += input.slice(cursor);
            break;
        }
        out += input.slice(cursor, openAt);

        var argEnd = input.indexOf(')}}', openAt);
        if (argEnd === -1) {
            warnings.push('repeat 缺少收尾的 )}}');
            out += input.slice(openAt);
            break;
        }

        var bodyStart = argEnd + 3;
        var depth = 1;
        var scan = bodyStart;
        var bodyEnd = -1;

        while (scan < input.length) {
            var nextOpen = input.indexOf(REPEAT_OPEN, scan);
            var nextClose = input.indexOf(REPEAT_CLOSE, scan);
            if (nextClose === -1) break;
            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth++;
                scan = nextOpen + REPEAT_OPEN.length;
            } else {
                depth--;
                if (depth === 0) {
                    bodyEnd = nextClose;
                    break;
                }
                scan = nextClose + REPEAT_CLOSE.length;
            }
        }

        if (bodyEnd === -1) {
            warnings.push('repeat 缺少配对的 {{/repeat}}');
            out += input.slice(openAt);
            break;
        }

        var count = resolveRepeatCount(input.slice(openAt + REPEAT_OPEN.length, argEnd));
        var body = expandRepeats(input.slice(bodyStart, bodyEnd), warnings);
        out += new Array(count + 1).join(body);
        cursor = bodyEnd + REPEAT_CLOSE.length;
    }

    return out;
}

function evaluate(name, rawArgs, ctx, warnings) {
    var item = PLACEHOLDER_MAP[String(name).toLowerCase()];
    if (!item) {
        if (warnings.indexOf(name) === -1) warnings.push(name);
        return undefined;
    }
    return item.fn(parseArgs(rawArgs), ctx || {});
}

// 占满一整个 JSON 字符串的占位符，非字符串结果要去掉引号
// 名字允许中文等非 ASCII 字符，这样写错的名字也能被识别出来并给出警告
var SOLE_IN_QUOTES = /"\{\{@([^\s(){}]+)(?:\(([^)]*)\))?\}\}"/g;
var ANY_PLACEHOLDER = /\{\{@([^\s(){}]+)(?:\(([^)]*)\))?\}\}/g;

/**
 * 渲染模板。
 * @param {string} template 响应体模板
 * @param {object} ctx { query, body, params, headers }
 * @returns {{text: string, warnings: string[]}}
 */
function render(template, ctx) {
    var warnings = [];
    var text = expandRepeats(String(template === undefined || template === null ? '' : template), warnings);

    text = text.replace(SOLE_IN_QUOTES, function (match, name, args) {
        var value = evaluate(name, args, ctx, warnings);
        if (value === undefined) return match;
        return (typeof value === 'string') ? JSON.stringify(value) : String(value);
    });

    text = text.replace(ANY_PLACEHOLDER, function (match, name, args) {
        var value = evaluate(name, args, ctx, warnings);
        return value === undefined ? match : String(value);
    });

    return { text: text, warnings: warnings };
}

/**
 * JSON 容错修复。用户写 {{@repeat(3)}}{...}{{/repeat}} 时，重复出来的多个
 * 对象之间不会有逗号（模板里写逗号又会导致最后多一个），这里做两件事：
 *   1. 丢掉 ] 或 } 前面多余的尾逗号；
 *   2. 两个相邻的 JSON 值之间补上逗号，例如 } { → }, {。
 * 逐字符扫描并跳过字符串字面量，避免破坏字符串里的 }{ 之类内容。
 * @param {string} text
 * @returns {string}
 */
function repairJson(text) {
    var out = '';
    var index = 0;
    var inString = false;
    var lastMeaningful = '';
    var pendingWs = '';
    var length = text.length;
    var NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
    var LITERAL = /^(?:true|false|null)/;

    function endsValue(ch) {
        return ch === '"' || ch === '}' || ch === ']' || ch === '#';
    }

    function nextMeaningful(from) {
        var cursor = from;
        while (cursor < length && /\s/.test(text[cursor])) cursor++;
        return cursor < length ? text[cursor] : '';
    }

    // 先冲掉缓冲的空白再写内容，保证补出来的逗号紧跟在值后面：}\n{ → },\n{
    function emit(str, needsComma) {
        if (needsComma) out += ',';
        out += pendingWs + str;
        pendingWs = '';
    }

    while (index < length) {
        var ch = text[index];

        if (inString) {
            if (ch === '\\') {
                out += ch + (text[index + 1] === undefined ? '' : text[index + 1]);
                index += 2;
                continue;
            }
            out += ch;
            if (ch === '"') {
                inString = false;
                lastMeaningful = '"';
            }
            index++;
            continue;
        }

        if (/\s/.test(ch)) {
            pendingWs += ch;
            index++;
            continue;
        }

        // 丢掉 ] 或 } 前面多余的尾逗号
        if (ch === ',') {
            var afterComma = nextMeaningful(index + 1);
            if (afterComma === '}' || afterComma === ']' || afterComma === '') {
                index++;
                continue;
            }
            emit(ch, false);
            lastMeaningful = ch;
            index++;
            continue;
        }

        if (ch === '"' || ch === '{' || ch === '[') {
            emit(ch, endsValue(lastMeaningful));
            if (ch === '"') {
                inString = true;
            } else {
                lastMeaningful = ch;
            }
            index++;
            continue;
        }

        var numeric = /[-0-9]/.test(ch) ? NUMBER.exec(text.slice(index)) : null;
        if (numeric) {
            emit(numeric[0], endsValue(lastMeaningful));
            lastMeaningful = '#';
            index += numeric[0].length;
            continue;
        }

        var literal = /[tfn]/.test(ch) ? LITERAL.exec(text.slice(index)) : null;
        if (literal) {
            emit(literal[0], endsValue(lastMeaningful));
            lastMeaningful = '#';
            index += literal[0].length;
            continue;
        }

        emit(ch, false);
        lastMeaningful = ch;
        index++;
    }

    return out + pendingWs;
}

module.exports = {
    render: render,
    repairJson: repairJson,
    readInput: readInput,
    PLACEHOLDERS: PLACEHOLDERS,
    FIELD_TYPES: FIELD_TYPES,
    TEMPLATES: TEMPLATES
};
