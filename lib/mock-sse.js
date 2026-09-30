/**
 * SSE mock 回放（契约第 17 节）。
 *
 * 示例的 `responseType` 是 `sse` 时，`body` 是一段 JSON 文本：
 *
 *   { events: [{ delay, event?, data, id? }], repeat: false }
 *
 * `delay` 是**和上一条之间的间隔**（第一条相对于响应头）。每条的 `data`
 * **在发送的那一刻**才用模板引擎渲染 —— 所以同一个示例每次请求拿到的随机值都不一样，
 * 这正是「mock」该有的样子。
 *
 * 这个模块只负责「校验 + 往回放」，不碰数据库也不碰 Express 路由表 ——
 * 由 `lib/mock-runtime.js` 在命中 sse 示例时调用。
 */

var MAX_EVENTS = 5000;
var MAX_DELAY = 60000;

/** 强制覆盖的三个响应头（契约第 17 节） */
var FORCED_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
};

/**
 * 解析并校验示例的 body。
 *
 * @param {string} body
 * @returns {{ok: true, spec: object}|{ok: false, reason: string}}
 */
function parseSpec(body) {
    var text = typeof body === 'string' ? body : '';
    if (!text.trim()) return { ok: false, reason: 'SSE 示例的 body 不能为空' };

    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, reason: 'SSE 示例的 body 必须是合法的 JSON：' + err.message };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'SSE 示例的 body 必须是一个 JSON 对象' };
    }
    if (!Array.isArray(parsed.events)) {
        return { ok: false, reason: 'SSE 示例缺少 events 数组' };
    }
    if (!parsed.events.length) {
        return { ok: false, reason: 'SSE 示例的 events 不能为空' };
    }
    if (parsed.events.length > MAX_EVENTS) {
        return {
            ok: false,
            reason: 'SSE 示例最多 ' + MAX_EVENTS + ' 条事件，收到 ' + parsed.events.length + ' 条'
        };
    }

    for (var i = 0; i < parsed.events.length; i++) {
        var item = parsed.events[i];
        var at = '第 ' + (i + 1) + ' 条事件';

        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, reason: at + '必须是对象' };
        }
        if (typeof item.data !== 'string') {
            return { ok: false, reason: at + '的 data 必须是字符串' };
        }

        var delay = item.delay === undefined || item.delay === null ? 0 : Number(item.delay);
        if (!isFinite(delay) || delay < 0 || delay > MAX_DELAY) {
            return { ok: false, reason: at + '的 delay 必须在 0 到 ' + MAX_DELAY + ' 之间' };
        }

        if (item.event !== undefined && item.event !== null && typeof item.event !== 'string') {
            return { ok: false, reason: at + '的 event 必须是字符串' };
        }
        if (item.id !== undefined && item.id !== null &&
            typeof item.id !== 'string' && typeof item.id !== 'number') {
            return { ok: false, reason: at + '的 id 只能是字符串或数字' };
        }
    }

    return { ok: true, spec: normalize(parsed) };
}

function normalize(parsed) {
    return {
        repeat: parsed.repeat === true,
        events: parsed.events.map(function (item) {
            return {
                delay: item.delay === undefined || item.delay === null
                    ? 0
                    : Math.max(0, Math.round(Number(item.delay))),
                event: item.event === undefined || item.event === null ? '' : String(item.event),
                id: item.id === undefined || item.id === null ? null : String(item.id),
                data: item.data
            };
        })
    };
}

/**
 * 写入时的校验：不合法返回可以直接给用户看的中文原因，合法返回 null。
 * @param {string} body
 * @returns {string|null}
 */
function validate(body) {
    var result = parseSpec(body);
    return result.ok ? null : result.reason;
}

/**
 * 把一段 SSE 回放给客户端。
 *
 * @param {object} res Express 的响应对象（还没写过任何东西）
 * @param {object} spec `{ events, repeat }`
 * @param {object} options
 * @param {number} options.status 示例上配的状态码
 * @param {Array} options.headers 示例上配的响应头
 * @param {string} options.mockHeader `X-Apiloop-Mock` 的值
 * @param {Function} options.render `(data) => string`，**每发送一条才调一次**
 * @param {Function} [options.onHeaders] 响应头发出去之后的回调（记 mock 日志用）
 * @param {Function} [options.onError] 渲染或写入出错时回调，只用来打日志
 * @returns {{stop: Function}} 需要提前停掉时调 `stop()`
 */
function replay(res, spec, options) {
    var events = spec.events;
    var index = 0;
    var timer = null;
    var stopped = false;

    /** 客户端断开、或者回放正常结束时都要走到这里：**一个计时器都不能剩** */
    function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function finish() {
        stop();
        if (!res.writableEnded) {
            try {
                res.end();
            } catch (err) {
                // 连接已经断了
            }
        }
    }

    /** 一条事件的字节。多行的 data 要拆成多行 `data:`（SSE 格式） */
    function buildChunk(item) {
        var text = options.render(item.data);

        var lines = [];
        if (item.event) lines.push('event: ' + item.event);
        if (item.id !== null) lines.push('id: ' + item.id);
        String(text).split(/\r?\n/).forEach(function (line) {
            lines.push('data: ' + line);
        });
        lines.push('', '');

        return lines.join('\n');
    }

    function step() {
        if (stopped) return;
        if (res.writableEnded || res.destroyed) {
            stop();
            return;
        }

        if (index >= events.length) {
            if (!spec.repeat) {
                finish();
                return;
            }
            index = 0;
        }

        var item = events[index];
        index += 1;

        timer = setTimeout(function () {
            timer = null;
            if (stopped) return;
            if (res.writableEnded || res.destroyed) {
                stop();
                return;
            }

            var flushed;
            try {
                flushed = res.write(buildChunk(item));
            } catch (err) {
                // 渲染或写入抛错：这里是 setTimeout 回调，没人能接住，必须自己兜
                if (options.onError) options.onError(err);
                finish();
                return;
            }

            /**
             * 背压：写不进去说明客户端读得慢，等 drain 再继续 ——
             * 不等的话，`repeat: true` 的示例会一直往发送缓冲区里堆。
             */
            if (flushed === false && !res.writableEnded) {
                res.once('drain', step);
                return;
            }

            step();
        }, item.delay);

        // 长连接的计时器不挡住进程退出
        if (timer.unref) timer.unref();
    }

    res.status(options.status || 200);

    (options.headers || []).forEach(function (header) {
        try {
            res.set(header.key, header.value);
        } catch (err) {
            // 头名不合法就跳过，不能因为一条坏响应头让整个示例回放不出来
        }
    });

    // 放在用户响应头之后设：这三项是**强制**的，用户配的同名头不作数
    Object.keys(FORCED_HEADERS).forEach(function (name) {
        // Content-Type 用 setHeader 直接写：Express 的 res.set 会给它补上 `; charset=utf-8`，
        // 而契约第 17 节写的就是 `text/event-stream` 这个值，别自作主张加后缀
        if (name === 'Content-Type') res.setHeader(name, FORCED_HEADERS[name]);
        else res.set(name, FORCED_HEADERS[name]);
    });

    if (options.mockHeader) res.set('X-Apiloop-Mock', options.mockHeader);

    res.flushHeaders();
    if (options.onHeaders) options.onHeaders();

    // 客户端断开：立刻清掉计时器
    res.on('close', stop);

    step();

    return { stop: stop };
}

module.exports = {
    parseSpec: parseSpec,
    validate: validate,
    replay: replay,
    MAX_EVENTS: MAX_EVENTS,
    MAX_DELAY: MAX_DELAY,
    FORCED_HEADERS: FORCED_HEADERS
};
