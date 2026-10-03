/**
 * 给「会跑用户自己写的正则」的计算加一个时间上限。
 *
 * 正则在**服务器上**跑：一个写坏的正则（`(a+)+$` 这种回溯爆炸的）能把整个进程卡住几分钟，
 * 云端是单线程，卡住的时候全队都用不了。JS 的正则没有超时参数，但 `vm` 的 `timeout`
 * 能打断正在跑的 JS（包括从里面调用的外部函数），所以把计算放进去跑。
 *
 * **只包纯计算**（不写库）：被打断时调用方拿到 `{ timedOut: true }`，自己决定怎么报错。
 *
 * 用在：全局查找替换（lib/api/search.js）、可视化断言和提取变量（lib/send-core.js）。
 */

var vm = require('vm');

/**
 * @param {function(): *} compute
 * @param {number} timeoutMs
 * @returns {{ timedOut: boolean, value?: * }}
 */
function runWithTimeout(compute, timeoutMs) {
    var box = { compute: compute, value: undefined };
    try {
        vm.runInNewContext('box.value = box.compute()', { box: box }, { timeout: timeoutMs });
    } catch (err) {
        if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { timedOut: true };
        throw err;
    }
    return { timedOut: false, value: box.value };
}

module.exports = {
    runWithTimeout: runWithTimeout
};
