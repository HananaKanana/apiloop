/**
 * 沙箱内运行时（契约第 16 节）：`pm` 对象、chai 子集、以及老集合里的那种写法。
 *
 * 这一段**在 QuickJS 里执行**，不是 Node 里 —— 唯一的通信方式是 `globalThis.__host` 上的
 * 三个宿主函数，以及进来时的 `globalThis.__input`、出去时的 `globalThis.__export()`。
 * **prelude 里不能有任何宿主相关的东西**（不 require、不碰 Node 全局）。
 *
 * 源码用 `function () {…}.toString()` 导出，而不是写成一个大字符串字面量：
 * 这样这一段本身是被宿主的解析器检查过的真 JS，不用到处转义引号和换行。
 * 函数在宿主里**从不调用**，只取它的源码。
 *
 * QuickJS 只带 ECMAScript 内置对象：没有 `URL` / `URLSearchParams` / `console` /
 * `setTimeout` / `TextEncoder`。所以：
 * - 自己写了一个够用的 URL 拆分与查询串拼装（`pm.request.url` 要用）；
 * - `console` 由这里注入，转给宿主；
 * - 脚本里用 `setTimeout` 会直接 ReferenceError，这与「沙箱里没有宿主能力」是一致的。
 */

var SOURCE = '(' + function () {
    'use strict';

    var input = globalThis.__input || {};
    var host = globalThis.__host || {};

    /* ================================================================ 小工具 */

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function toText(value) {
        if (value === undefined || value === null) return '';
        return typeof value === 'string' ? value : String(value);
    }

    function safeStringify(value) {
        try {
            var text = JSON.stringify(value);
            return text === undefined ? String(value) : text;
        } catch (err) {
            return String(value);
        }
    }

    /* ================================================================ URL */

    /** 够用的 URL 拆分。QuickJS 没有 URL / URLSearchParams，只能自己来。 */
    function splitUrl(text) {
        var raw = toText(text);
        var hash = '';
        var at = raw.indexOf('#');
        if (at > -1) {
            hash = raw.slice(at + 1);
            raw = raw.slice(0, at);
        }

        var search = '';
        at = raw.indexOf('?');
        if (at > -1) {
            search = raw.slice(at + 1);
            raw = raw.slice(0, at);
        }

        var scheme = '';
        var hostName = '';
        var rest = raw;
        var match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
        if (match) {
            scheme = match[1];
            rest = raw.slice(match[0].length);
            var slash = rest.indexOf('/');
            if (slash === -1) {
                hostName = rest;
                rest = '';
            } else {
                hostName = rest.slice(0, slash);
                rest = rest.slice(slash);
            }
        }

        return { scheme: scheme, host: hostName, path: rest || '/', search: search, hash: hash };
    }

    function decodeSafe(text) {
        try {
            return decodeURIComponent(String(text).replace(/\+/g, ' '));
        } catch (err) {
            return String(text);
        }
    }

    function parseQuery(search) {
        var out = [];
        toText(search).split('&').forEach(function (pair) {
            if (!pair) return;
            var eq = pair.indexOf('=');
            out.push({
                key: decodeSafe(eq === -1 ? pair : pair.slice(0, eq)),
                value: decodeSafe(eq === -1 ? '' : pair.slice(eq + 1))
            });
        });
        return out;
    }

    function buildQuery(pairs) {
        return pairs.map(function (pair) {
            return encodeURIComponent(pair.key) + '=' + encodeURIComponent(pair.value);
        }).join('&');
    }

    function writeQuery(url, pairs) {
        var parts = splitUrl(url);
        var suffix = (parts.search ? '?' + buildQuery(pairs) : '') +
            (parts.hash ? '#' + parts.hash : '');
        var prefix = parts.scheme ? parts.scheme + '://' + parts.host : parts.host;
        return prefix + (parts.path === '/' && !suffix ? '' : parts.path) + suffix;
    }

    /* ================================================================ 变量作用域 */

    var scopesInput = input.scopes || {};
    var projectVars = clone(scopesInput.project || {}) || {};
    var folderVars = (scopesInput.folders || []).map(function (map) { return clone(map) || {}; });
    var envVars = scopesInput.environment === undefined || scopesInput.environment === null
        ? null
        : (clone(scopesInput.environment) || {});
    var transientVars = clone(scopesInput.transient || {}) || {};

    /** 没选环境时，`pm.environment` 的写入落在这里 —— 只在本次请求内有效 */
    var ephemeralEnv = {};

    var changes = {
        environment: { set: {}, unset: [] },
        project: { set: {}, unset: [] }
    };

    var warnings = [];

    function warnOnce(text) {
        if (warnings.indexOf(text) === -1) warnings.push(text);
    }

    var ENV_WARNING = '没有选中环境：脚本对 pm.environment 的修改只在本次请求内有效，不会保存';

    /**
     * pm.variables 的查找顺序（契约第 16 节）：
     * 本次请求的临时变量 > 环境 > 内层目录 > 外层目录 > 项目。
     *
     * `folderVars` 是**从外到内**存的（和宿主里那条目录链同一个方向），
     * 而查找要从内往外，所以倒着遍历。
     */
    function lookup(key) {
        if (hasOwn(transientVars, key)) return { found: true, value: transientVars[key] };
        if (envVars && hasOwn(envVars, key)) return { found: true, value: envVars[key] };
        for (var i = folderVars.length - 1; i >= 0; i--) {
            if (hasOwn(folderVars[i], key)) return { found: true, value: folderVars[i][key] };
        }
        if (hasOwn(projectVars, key)) return { found: true, value: projectVars[key] };
        return { found: false };
    }

    function mergedVariables() {
        var out = {};
        Object.keys(projectVars).forEach(function (k) { out[k] = projectVars[k]; });
        folderVars.forEach(function (map) {
            Object.keys(map).forEach(function (k) { out[k] = map[k]; });
        });
        if (envVars) Object.keys(envVars).forEach(function (k) { out[k] = envVars[k]; });
        Object.keys(transientVars).forEach(function (k) { out[k] = transientVars[k]; });
        return out;
    }

    function readEnv(key) {
        if (hasOwn(ephemeralEnv, key)) return ephemeralEnv[key];
        if (envVars && hasOwn(envVars, key)) return envVars[key];
        return undefined;
    }

    function writeEnv(key, value) {
        if (envVars) {
            envVars[key] = value;
            changes.environment.set[key] = value;
            var at = changes.environment.unset.indexOf(key);
            if (at > -1) changes.environment.unset.splice(at, 1);
            return;
        }
        warnOnce(ENV_WARNING);
        ephemeralEnv[key] = value;
        transientVars[key] = value;
    }

    function unsetEnv(key) {
        if (envVars) {
            delete envVars[key];
            delete changes.environment.set[key];
            if (changes.environment.unset.indexOf(key) === -1) changes.environment.unset.push(key);
            return;
        }
        warnOnce(ENV_WARNING);
        delete ephemeralEnv[key];
        delete transientVars[key];
    }

    function writeProject(key, value) {
        projectVars[key] = value;
        changes.project.set[key] = value;
        var at = changes.project.unset.indexOf(key);
        if (at > -1) changes.project.unset.splice(at, 1);
    }

    function unsetProject(key) {
        delete projectVars[key];
        delete changes.project.set[key];
        if (changes.project.unset.indexOf(key) === -1) changes.project.unset.push(key);
    }

    var variablesApi = {
        get: function (key) {
            var hit = lookup(toText(key));
            return hit.found ? hit.value : undefined;
        },
        has: function (key) { return lookup(toText(key)).found; },
        set: function (key, value) { transientVars[toText(key)] = toText(value); },
        unset: function (key) { delete transientVars[toText(key)]; },
        toObject: function () { return mergedVariables(); },
        clear: function () {
            Object.keys(transientVars).forEach(function (k) { delete transientVars[k]; });
            Object.keys(ephemeralEnv).forEach(function (k) { delete ephemeralEnv[k]; });
        }
    };

    var environmentApi = {
        get: function (key) { return readEnv(toText(key)); },
        has: function (key) {
            var value = readEnv(toText(key));
            return value !== undefined;
        },
        set: function (key, value) { writeEnv(toText(key), toText(value)); },
        unset: function (key) { unsetEnv(toText(key)); },
        toObject: function () {
            var out = {};
            if (envVars) Object.keys(envVars).forEach(function (k) { out[k] = envVars[k]; });
            Object.keys(ephemeralEnv).forEach(function (k) { out[k] = ephemeralEnv[k]; });
            return out;
        }
    };

    var projectApi = {
        get: function (key) { return hasOwn(projectVars, toText(key)) ? projectVars[toText(key)] : undefined; },
        has: function (key) { return hasOwn(projectVars, toText(key)); },
        set: function (key, value) { writeProject(toText(key), toText(value)); },
        unset: function (key) { unsetProject(toText(key)); },
        toObject: function () { return clone(projectVars) || {}; }
    };

    var projectApi2 = {
        get: projectApi.get,
        has: projectApi.has,
        set: projectApi.set,
        unset: projectApi.unset,
        toObject: projectApi.toObject
    };

    /* ================================================================ pm.request */

    var requestInput = input.request || {};
    var requestState = {
        method: toText(requestInput.method) || 'GET',
        url: toText(requestInput.url),
        headers: clone(requestInput.headers || []) || [],
        body: clone(requestInput.body || { mode: 'none' }) || { mode: 'none' }
    };

    function headerIndex(name, list) {
        var lower = toText(name).toLowerCase();
        for (var i = 0; i < list.length; i++) {
            if (toText(list[i][0]).toLowerCase() === lower) return i;
        }
        return -1;
    }

    var requestHeadersApi = {
        get: function (name) {
            var at = headerIndex(name, requestState.headers);
            return at === -1 ? undefined : requestState.headers[at][1];
        },
        has: function (name) { return headerIndex(name, requestState.headers) !== -1; },
        add: function (item) {
            var pair = item || {};
            requestState.headers.push([toText(pair.key), toText(pair.value)]);
        },
        upsert: function (item) {
            var pair = item || {};
            var at = headerIndex(pair.key, requestState.headers);
            if (at === -1) requestState.headers.push([toText(pair.key), toText(pair.value)]);
            else requestState.headers[at] = [requestState.headers[at][0], toText(pair.value)];
        },
        remove: function (name) {
            var at = headerIndex(name, requestState.headers);
            if (at !== -1) requestState.headers.splice(at, 1);
        },
        // 键一律小写，和 pm.response.headers.toObject() 一个口径
        toObject: function () {
            var out = {};
            requestState.headers.forEach(function (pair) {
                out[toText(pair[0]).toLowerCase()] = toText(pair[1]);
            });
            return out;
        }
    };

    var requestQueryApi = {
        get: function (name) {
            var parts = splitUrl(requestState.url);
            var hit = parseQuery(parts.search).filter(function (pair) {
                return pair.key === toText(name);
            })[0];
            return hit ? hit.value : undefined;
        },
        add: function (item) {
            var pair = item || {};
            var parts = splitUrl(requestState.url);
            var list = parseQuery(parts.search);
            list.push({ key: toText(pair.key), value: toText(pair.value) });
            requestState.url = writeQuery(requestState.url, list);
        },
        upsert: function (item) {
            var pair = item || {};
            var parts = splitUrl(requestState.url);
            var list = parseQuery(parts.search);
            var index = -1;
            for (var i = 0; i < list.length; i++) {
                if (list[i].key === toText(pair.key)) { index = i; break; }
            }
            if (index === -1) list.push({ key: toText(pair.key), value: toText(pair.value) });
            else list[index].value = toText(pair.value);
            requestState.url = writeQuery(requestState.url, list);
        },
        remove: function (name) {
            var parts = splitUrl(requestState.url);
            var list = parseQuery(parts.search).filter(function (pair) {
                return pair.key !== toText(name);
            });
            requestState.url = writeQuery(requestState.url, list);
        },
        toObject: function () {
            var out = {};
            parseQuery(splitUrl(requestState.url).search).forEach(function (pair) {
                out[pair.key] = pair.value;
            });
            return out;
        }
    };

    var requestBodyApi = {};
    Object.defineProperty(requestBodyApi, 'mode', {
        enumerable: true,
        get: function () { return toText(requestState.body.mode) || 'none'; },
        set: function (value) { requestState.body.mode = toText(value); }
    });
    Object.defineProperty(requestBodyApi, 'raw', {
        enumerable: true,
        get: function () {
            return requestState.body.raw === undefined ? undefined : toText(requestState.body.raw);
        },
        set: function (value) { requestState.body.raw = toText(value); }
    });

    var requestUrlApi = {
        toString: function () { return requestState.url; },
        getHost: function () { return splitUrl(requestState.url).host; },
        getPath: function () { return splitUrl(requestState.url).path; },
        query: requestQueryApi
    };

    var requestApi = {
        headers: requestHeadersApi,
        body: requestBodyApi
    };
    Object.defineProperty(requestApi, 'method', {
        enumerable: true,
        get: function () { return requestState.method; },
        set: function (value) { requestState.method = toText(value).toUpperCase(); }
    });
    Object.defineProperty(requestApi, 'url', {
        enumerable: true,
        get: function () { return requestUrlApi; },
        set: function (value) { requestState.url = toText(value); }
    });

    /* ================================================================ pm.response */

    var responseInput = input.response || null;

    function headerPairsToApi(pairs) {
        var list = pairs || [];
        return {
            get: function (name) {
                var at = headerIndex(name, list);
                return at === -1 ? undefined : toText(list[at][1]);
            },
            has: function (name) { return headerIndex(name, list) !== -1; },
            // 键一律小写：和 Postman 一致，也和 get / has 的大小写不敏感口径一致
            toObject: function () {
                var out = {};
                list.forEach(function (pair) { out[toText(pair[0]).toLowerCase()] = toText(pair[1]); });
                return out;
            }
        };
    }

    function responseUnavailable() {
        throw new Error('pm.response 只在测试脚本里可用（前置脚本执行时还没有响应）');
    }

    function buildResponseApi() {
        if (!responseInput) return null;

        var api = {
            code: responseInput.code,
            status: toText(responseInput.status),
            responseTime: responseInput.responseTime,
            headers: headerPairsToApi(responseInput.headers),
            size: function () { return responseInput.size; },
            text: function () { return toText(responseInput.body); },
            json: function () {
                var text = toText(responseInput.body);
                var parsed = JSON.parse(text);
                return parsed;
            }
        };

        var to = { have: {}, be: {} };
        to.have.status = function (code) {
            if (api.code !== code) {
                throw new Error('期望状态码是 ' + code + '，实际是 ' + api.code);
            }
        };
        to.have.header = function (name) {
            if (!api.headers.has(name)) throw new Error('期望响应头里有 ' + name + '，实际没有');
        };
        Object.defineProperty(to.be, 'ok', {
            enumerable: true,
            get: function () {
                if (!(api.code >= 200 && api.code < 300)) {
                    throw new Error('期望状态码是 2xx，实际是 ' + api.code);
                }
                return true;
            }
        });
        api.to = to;

        return api;
    }

    var responseApi = buildResponseApi();

    /* ================================================================ chai 子集 */

    function typeName(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }

    function deepEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || a === undefined || b === undefined) return false;
        if (typeof a !== 'object' || typeof b !== 'object') return false;

        if (Array.isArray(a) !== Array.isArray(b)) return false;

        var aKeys = Object.keys(a);
        var bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;

        for (var i = 0; i < aKeys.length; i++) {
            if (!hasOwn(b, aKeys[i])) return false;
            if (!deepEqual(a[aKeys[i]], b[aKeys[i]])) return false;
        }
        return true;
    }

    function subsetOf(actual, expected) {
        if (expected === null || typeof expected !== 'object') return deepEqual(actual, expected);
        if (actual === null || typeof actual !== 'object') return false;

        return Object.keys(expected).every(function (key) {
            return hasOwn(actual, key) && (typeof expected[key] === 'object' && expected[key] !== null
                ? subsetOf(actual[key], expected[key])
                : deepEqual(actual[key], expected[key]));
        });
    }

    function inspect(value) {
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'object' && value !== null) return safeStringify(value);
        return String(value);
    }

    /** 链式词，取了什么也不做，只是让 `to.be.a` 这种写法读得通 */
    var CHAIN_WORDS = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same'];

    function makeExpect(actual, flags) {
        var self = {};

        function assert(pass, describe) {
            var ok = flags.negate ? !pass : pass;
            if (!ok) throw new Error((flags.negate ? '期望「不」' : '期望 ') + describe);
        }

        function same(a, b) {
            return flags.deep ? deepEqual(a, b) : a === b;
        }

        CHAIN_WORDS.forEach(function (word) {
            Object.defineProperty(self, word, {
                enumerable: false,
                get: function () { return self; }
            });
        });
        Object.defineProperty(self, 'not', {
            enumerable: false,
            get: function () { return makeExpect(actual, { negate: !flags.negate, deep: flags.deep }); }
        });
        Object.defineProperty(self, 'deep', {
            enumerable: false,
            get: function () { return makeExpect(actual, { negate: flags.negate, deep: true }); }
        });

        self.equal = function (expected) {
            assert(same(actual, expected),
                inspect(actual) + ' 等于 ' + inspect(expected) + '（实际是 ' + inspect(actual) + '）');
            return self;
        };
        self.eql = function (expected) {
            assert(deepEqual(actual, expected),
                inspect(actual) + ' 深等于 ' + inspect(expected) + '（实际是 ' + inspect(actual) + '）');
            return self;
        };

        self.include = function (expected) {
            var pass;
            if (typeof actual === 'string') pass = actual.indexOf(toText(expected)) !== -1;
            else if (Array.isArray(actual)) {
                pass = actual.some(function (item) {
                    return flags.deep ? deepEqual(item, expected) : item === expected;
                });
            } else if (actual && typeof actual === 'object' && expected && typeof expected === 'object') {
                pass = subsetOf(actual, expected);
            } else {
                pass = false;
            }
            assert(pass, inspect(actual) + ' 包含 ' + inspect(expected));
            return self;
        };
        self.contain = self.include;
        self.contains = self.include;

        self.a = function (type) {
            assert(typeName(actual) === toText(type),
                inspect(actual) + ' 的类型是 ' + toText(type) + '（实际是 ' + typeName(actual) + '）');
            return self;
        };
        self.an = self.a;

        self.property = function (name, value) {
            var target = actual;
            var key = toText(name);

            if (target === null || target === undefined) {
                assert(false, '一个对象上有属性 ' + key);
                return self;
            }

            var found = hasOwn(Object(target), key);
            var got = found ? target[key] : undefined;

            if (!found && key.indexOf('.') > -1) {
                var cur = target;
                var parts = key.split('.');
                found = true;
                for (var i = 0; i < parts.length; i++) {
                    if (cur === null || cur === undefined || typeof cur !== 'object') { found = false; break; }
                    if (!hasOwn(cur, parts[i])) { found = false; break; }
                    cur = cur[parts[i]];
                }
                if (found) got = cur;
            }

            if (arguments.length < 2) {
                assert(found, inspect(actual) + ' 上有属性 ' + key);
                return self;
            }

            assert(found && (flags.deep ? deepEqual(got, value) : got === value),
                inspect(actual) + ' 的属性 ' + key + ' 是 ' + inspect(value) + '（实际是 ' + inspect(got) + '）');
            return self;
        };

        self.lengthOf = function (expected) {
            var size = actual === null || actual === undefined ? undefined : actual.length;
            assert(size === expected, inspect(actual) + ' 的长度是 ' + expected + '（实际是 ' + size + '）');
            return self;
        };
        self.length = self.lengthOf;

        function numeric(op, expected, label) {
            var pass = typeof actual === 'number' && typeof expected === 'number' &&
                (op === 'above' ? actual > expected
                    : op === 'below' ? actual < expected
                        : op === 'least' ? actual >= expected
                            : actual <= expected);
            assert(pass, inspect(actual) + ' ' + label + ' ' + inspect(expected));
            return self;
        }

        self.above = function (expected) { return numeric('above', expected, '大于'); };
        self.below = function (expected) { return numeric('below', expected, '小于'); };
        self.least = function (expected) { return numeric('least', expected, '不小于'); };
        self.most = function (expected) { return numeric('most', expected, '不大于'); };

        self.match = function (pattern) {
            var pass = false;
            try {
                var re = pattern instanceof RegExp ? pattern : new RegExp(toText(pattern));
                pass = typeof actual === 'string' && re.test(actual);
            } catch (err) {
                pass = false;
            }
            assert(pass, inspect(actual) + ' 匹配 ' + String(pattern));
            return self;
        };

        self.oneOf = function (list) {
            var items = Array.isArray(list) ? list : [];
            assert(items.some(function (item) { return same(actual, item); }),
                inspect(actual) + ' 是 ' + inspect(items) + ' 之一');
            return self;
        };

        function addFlag(name, predicate, label) {
            Object.defineProperty(self, name, {
                enumerable: false,
                get: function () {
                    assert(predicate(actual), inspect(actual) + ' ' + label);
                    return self;
                }
            });
        }

        addFlag('ok', function (v) { return !!v; }, '是真值');
        addFlag('true', function (v) { return v === true; }, '是 true');
        addFlag('false', function (v) { return v === false; }, '是 false');
        addFlag('null', function (v) { return v === null; }, '是 null');
        addFlag('undefined', function (v) { return v === undefined; }, '是 undefined');
        addFlag('exist', function (v) { return v !== null && v !== undefined; }, '存在');
        addFlag('empty', function (v) {
            if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
            if (v && typeof v === 'object') return Object.keys(v).length === 0;
            return false;
        }, '是空的');

        return self;
    }

    function expect(value) {
        return makeExpect(value, { negate: false, deep: false });
    }

    /* ================================================================ 测试与输出 */

    var testResults = [];
    var scriptErrors = [];
    var consoleLines = [];
    var CONSOLE_LIMIT = 200;
    var CONSOLE_LINE_LIMIT = 2048;

    function test(name, fn) {
        var entry = { name: toText(name), passed: true };

        if (typeof fn !== 'function') {
            entry.passed = false;
            entry.error = 'pm.test 的第二个参数必须是一个函数';
            testResults.push(entry);
            return;
        }

        try {
            fn();
        } catch (err) {
            entry.passed = false;
            entry.error = (err && err.message) ? String(err.message) : String(err);
        }

        testResults.push(entry);
    }

    function record(level, args) {
        if (consoleLines.length >= CONSOLE_LIMIT) return;

        var parts = Array.prototype.slice.call(args).map(function (item) {
            return typeof item === 'string' ? item : safeStringify(item);
        });
        var text = parts.join(' ');
        if (text.length > CONSOLE_LINE_LIMIT) text = text.slice(0, CONSOLE_LINE_LIMIT);

        consoleLines.push({ level: level, text: text });
        // 立刻交给宿主：脚本死循环被中断时，已经打出来的日志也要看得到
        try {
            host.log(level, text);
        } catch (err) {
            // 记录日志失败不能把脚本带崩
        }
    }

    globalThis.console = {
        log: function () { record('log', arguments); },
        info: function () { record('info', arguments); },
        warn: function () { record('warn', arguments); },
        error: function () { record('error', arguments); }
    };

    /* ================================================================ pm.sendRequest */

    var SEND_LIMIT = 10;
    var sendCount = 0;

    function normalizeSendRequest(req) {
        if (typeof req === 'string') return { url: req, method: 'GET', headers: [], body: null };

        if (!req || typeof req !== 'object') throw new Error('pm.sendRequest 的第一个参数必须是地址或对象');

        var headers = [];
        var raw = req.header || req.headers;
        if (Array.isArray(raw)) {
            raw.forEach(function (item) {
                if (item && item.key !== undefined) headers.push([toText(item.key), toText(item.value)]);
            });
        } else if (raw && typeof raw === 'object') {
            Object.keys(raw).forEach(function (key) { headers.push([key, toText(raw[key])]); });
        }

        var body = null;
        if (req.body && typeof req.body === 'object') {
            body = { mode: toText(req.body.mode) || 'raw', raw: toText(req.body.raw) };
        }

        return { url: toText(req.url), method: (toText(req.method) || 'GET').toUpperCase(), headers: headers, body: body };
    }

    function makeSendResponse(payload) {
        var pairs = payload.headers || [];
        var bodyText = toText(payload.body);

        return {
            code: payload.code,
            status: toText(payload.status),
            responseTime: payload.responseTime,
            headers: headerPairsToApi(pairs),
            size: function () { return payload.size; },
            text: function () { return bodyText; },
            json: function () { return JSON.parse(bodyText); }
        };
    }

    function sendRequest(req, callback) {
        var done = typeof callback === 'function' ? callback : function () {};

        if (sendCount >= SEND_LIMIT) {
            done(new Error('一次发送中最多调用 ' + SEND_LIMIT + ' 次 pm.sendRequest'));
            return;
        }
        sendCount += 1;

        var normalized;
        try {
            normalized = normalizeSendRequest(req);
        } catch (err) {
            done(err);
            return;
        }

        var raw = host.sendRequest(JSON.stringify(normalized));
        var payload;
        try {
            payload = JSON.parse(toText(raw));
        } catch (err) {
            done(new Error('pm.sendRequest 返回了无法解析的内容'));
            return;
        }

        if (!payload || payload.error) {
            done(new Error((payload && payload.error && payload.error.message) || 'pm.sendRequest 失败'));
            return;
        }

        done(null, makeSendResponse(payload));
    }

    /* ================================================================ pm 本体 */

    var pm = {
        variables: variablesApi,
        environment: environmentApi,
        collectionVariables: projectApi,
        globals: projectApi2,
        request: requestApi,
        test: test,
        expect: expect,
        sendRequest: sendRequest,
        info: {
            eventName: toText(input.phase) === 'test' ? 'test' : 'prerequest',
            requestName: toText((input.info || {}).requestName)
        }
    };

    Object.defineProperty(pm, 'response', {
        enumerable: true,
        get: function () {
            if (!responseApi) responseUnavailable();
            return responseApi;
        }
    });

    /**
     * 没列出来的 API：**调用时**抛「apiloop 暂不支持 xxx」。
     *
     * 用可调用的 Proxy 而不是 `undefined`，是为了让错误信息指出到底是哪个 API 不支持 ——
     * 报一句 `undefined is not a function`，用户根本不知道该改什么。
     *
     * 而且必须**能一路点下去**：`pm.cookies.get("a")` 里 `pm.cookies` 本身就被取了一次，
     * 只拦第一级的话这里会变成 `not a function`。
     */
    function unsupportedApi(label) {
        return new Proxy(function () {
            throw new Error('apiloop 暂不支持 ' + label);
        }, {
            get: function (target, key) {
                if (typeof key !== 'string') return target[key];
                if (key === 'inspect' || key === 'toString' || key === 'valueOf') return target[key];
                return unsupportedApi(label + '.' + key);
            }
        });
    }

    globalThis.pm = new Proxy(pm, {
        get: function (target, key) {
            if (typeof key !== 'string') return target[key];
            if (key in target) return target[key];
            return unsupportedApi('pm.' + key);
        }
    });

    /* ================================================================ 老写法 */

    globalThis.tests = {};

    if (responseInput) {
        globalThis.responseBody = toText(responseInput.body);
        globalThis.responseCode = { code: responseInput.code, name: toText(responseInput.status) };
        globalThis.responseTime = responseInput.responseTime;
    } else {
        globalThis.responseBody = undefined;
        globalThis.responseCode = undefined;
        globalThis.responseTime = undefined;
    }

    globalThis.responseHeaders = responseInput
        ? headerPairsToApi(responseInput.headers).toObject()
        : {};

    var postmanApi = {
        setEnvironmentVariable: function (key, value) { environmentApi.set(key, value); },
        getEnvironmentVariable: function (key) { return environmentApi.get(key); },
        clearEnvironmentVariable: function (key) { environmentApi.unset(key); },
        setGlobalVariable: function (key, value) { projectApi.set(key, value); },
        getGlobalVariable: function (key) { return projectApi.get(key); },
        clearGlobalVariable: function (key) { projectApi.unset(key); },
        setNextRequest: function () {
            warnOnce('postman.setNextRequest 不会生效：apiloop 不支持跳转执行');
        },
        clearEnvironmentVariables: function () {
            Object.keys(environmentApi.toObject()).forEach(function (key) { environmentApi.unset(key); });
        },
        clearGlobalVariables: function () {
            Object.keys(projectApi.toObject()).forEach(function (key) { projectApi.unset(key); });
        }
    };

    globalThis.postman = new Proxy(postmanApi, {
        get: function (target, key) {
            if (typeof key !== 'string') return target[key];
            if (key in target) return target[key];
            return unsupportedApi('postman.' + key);
        }
    });

    /* ================================================================ 导出 */

    globalThis.__export = function () {
        // 老写法的 tests["名称"] = 布尔值 也要计入结果，排在 pm.test 后面
        var legacy = [];
        Object.keys(globalThis.tests || {}).forEach(function (key) {
            legacy.push({ name: key, passed: !!globalThis.tests[key] });
        });

        return JSON.stringify({
            request: {
                method: requestState.method,
                url: requestState.url,
                headers: requestState.headers,
                body: requestState.body
            },
            variables: {
                transient: transientVars,
                environment: changes.environment,
                project: changes.project,
                environmentSelected: envVars !== null
            },
            console: consoleLines,
            tests: testResults.concat(legacy),
            errors: scriptErrors,
            warnings: warnings
        });
    };
}.toString() + ')();';

module.exports = {
    SOURCE: SOURCE
};
