/**
 * 网关上的 WebSocket 调试会话（G1，设计稿第 3.3 节）。
 *
 * 和 HTTP 发送一样拆成两半：**云端「准备」（`ws/prepare`：解析好变量的地址、合并好
 * 鉴权与 Cookie 的请求头、子协议），连接在用户的电脑上建立**。连接一旦建立，
 * 收发消息、事件缓冲、生命周期全在本机跑 —— 中间不经过云端，延迟和断线都少一跳。
 *
 * 会话的**所有者**用「浏览器会话令牌的哈希」来定，而不是用户 id：
 * 同一台电脑上同一个账号开两个浏览器，各是各的会话，一个看不到另一个的（会话里带着
 * 创建者的凭据）。网关这边没有库、也不认识用户，这个哈希是它唯一能拿到的稳定标识。
 */

var crypto = require('crypto');

var appInfo = require('../app-info');
var auth = require('../auth');
var ndjson = require('../api/ndjson');
var wsSessions = require('../ws-sessions');
var cloud = require('./cloud');

/**
 * 会话所有者。取的是浏览器那份登录 Cookie 里的令牌，**只保留哈希** ——
 * 令牌本身不该在内存里多留一份。
 *
 * 没有登录 Cookie 时返回 null：那种情况云端 `ws/prepare` 会先把它挡掉。
 */
function ownerIdFor(req) {
    var cookies = auth.parseCookies((req.headers || {}).cookie);
    var token = cookies[appInfo.SESSION_COOKIE];
    if (!token) return null;

    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @param {{getCloudUrl: Function, log: Function, sessionOptions: object}} options
 */
function createWsRoutes(options) {
    var getCloudUrl = options.getCloudUrl;
    var log = options.log || function () {};
    var registry = wsSessions.createRegistry(options.sessionOptions);

    /** 会话不存在 / 不是这个浏览器的 —— 一律同一句 404 */
    function sessionMissing(res) {
        res.status(404).json({ error: 'WebSocket 会话不存在' });
    }

    function locate(req) {
        var owner = ownerIdFor(req);
        if (!owner) return null;
        return registry.get(req.params.id, owner);
    }

    /**
     * 建会话：先向云端要「怎么连」，再在本机连出去。
     *
     * 云端回什么状态码就转什么（401 没登录、400 地址不合法、404 项目不对……），
     * 连不上云端则是 502 —— 页面能分清「我填错了」和「云端挂了」。
     */
    function create(req, res, body) {
        var cloudUrl = getCloudUrl();
        if (!cloudUrl) {
            res.status(503).json({ error: '网关还没有配置云端地址' });
            return;
        }

        var owner = ownerIdFor(req);
        if (!owner) {
            res.status(401).json({ error: '网关上没有登录状态，请重新登录' });
            return;
        }

        var apiBase = '/__admin/api/projects/' + encodeURIComponent(req.params.pid);

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: apiBase + '/ws/prepare',
            method: 'POST',
            headers: req.headers,
            body: body || {}
        }).then(function (answer) {
            if (answer.status !== 200 || !answer.json || !answer.json.session) {
                res.status(answer.status || 502)
                    .json(answer.json || { error: '云端返回了无法识别的内容' });
                return;
            }

            var prepared = answer.json.session;
            var session;

            try {
                session = registry.create({
                    // **所有者是这台浏览器，不是用户 id** —— 同一账号的另一台/另一个
                    // 浏览器不该能打开这个会话
                    userId: owner,
                    projectId: prepared.projectId,
                    url: prepared.url,
                    headers: prepared.headers,
                    protocols: prepared.protocols,
                    note: prepared.note
                });
            } catch (err) {
                res.status(Number(err && err.status) || 400)
                    .json({ error: (err && err.message) || '建立 WebSocket 会话失败' });
                return;
            }

            res.json({ ok: true, session: { id: session.id, url: session.url } });
        }).catch(function (err) {
            res.status(502).json({ error: cloud.cloudDownMessage(cloudUrl, err) });
        });
    }

    /** 事件流：NDJSON，和云端 `/ws/:id/events` 一个形状 */
    function events(req, res) {
        var session = locate(req);
        if (!session) return sessionMissing(res);

        var after = Number((req.query || {}).after);

        // 先开响应头再订阅：到这一步为止一个字节都还没写过，所以错误还能按 JSON 返回
        ndjson.start(res);

        var unsubscribe = registry.subscribe(session.id, after, function (event) {
            // null 表示会话已经销毁：把这条流收掉，否则前端会一直等一个永远不来的事件
            if (!event) {
                if (!res.writableEnded) res.end();
                return;
            }
            ndjson.write(res, event);
        });

        // 浏览器关掉页面 / 刷新：立刻退订，让「没人看」的倒计时开始走
        res.on('close', function () { unsubscribe(); });
        return undefined;
    }

    /** 发一条消息 */
    function send(req, res, body) {
        var session = locate(req);
        if (!session) return sessionMissing(res);

        var input = body || {};
        var payload = {};

        // 二进制用 base64 传。先认 base64：同时给了两个时以二进制为准
        if (typeof input.base64 === 'string') payload.base64 = input.base64;
        else if (typeof input.text === 'string') payload.text = input.text;
        else {
            res.status(400).json({ error: '缺少 text 或 base64' });
            return undefined;
        }

        try {
            registry.send(session.id, payload);
        } catch (err) {
            res.status(Number(err && err.status) || 409)
                .json({ error: (err && err.message) || '发送失败' });
            return undefined;
        }

        res.json({ ok: true });
        return undefined;
    }

    /** 断开（会话由注册表销毁，上游连接一并关掉） */
    function destroy(req, res) {
        var session = locate(req);
        if (!session) return sessionMissing(res);

        registry.destroy(session.id);
        res.json({ ok: true });
        return undefined;
    }

    return {
        registry: registry,
        create: create,
        events: events,
        send: send,
        destroy: destroy,
        closeAll: function () {
            log('关闭网关，收掉所有 WebSocket 会话');
            registry.closeAll();
        }
    };
}

module.exports = {
    createWsRoutes: createWsRoutes,
    ownerIdFor: ownerIdFor
};
