import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as recordApi from '@/api/record';

/**
 * Mock 录制（第十一轮第 2 节）。
 *
 * 记录只在服务端内存里、按项目分开，所以这个 store 只负责**当前项目**那一份：
 *   - `status`：这个项目正在录时的 recording 对象；没在录（或录的是别的项目）是 null；
 *   - `busy`：别的项目正在录时是 `{ projectId, projectName }`，界面拿它提示；
 *   - `entries`：录到的记录，**新的在最前面**（和 Mock 日志抽屉一致，边录边看最方便）。
 *
 * 轮询的四条要求（照 Mock 日志抽屉那一套）：
 *   1. 只在需要时轮询 —— 打开抽屉 1 秒一次，关着时顶栏只要状态，5 秒一次；
 *   2. 切项目、关抽屉、组件卸载都要停；
 *   3. 同一时刻只有一个定时器（start 之前一定先 stop）；
 *   4. 防请求交叠：`inFlight` 保证同一时刻只拉一次，`generation` 把「切项目 / 清空」
 *      之前发出的那批结果整批作废（否则慢网络下会重复、清空之后旧记录会自己回来）。
 */

/** 抽屉开着时的刷新间隔（「录制中每秒拉增量」） */
export const FAST_POLL_MS = 1000;
/** 抽屉关着时的刷新间隔：顶栏只想知道「在不在录、录了几条」 */
export const SLOW_POLL_MS = 5000;
/** 和服务端一致：每个项目最多留最近 500 条 */
const MAX_ROWS = 500;

export const useRecordStore = defineStore('record', function () {
  const status = ref(null);
  const busy = ref(null);
  const entries = ref([]);
  const lastSeq = ref(0);
  const loaded = ref(false);
  const error = ref('');

  let timer = null;
  let projectId = '';
  /**
   * 正在途的那次拉取属于哪一代（0 = 没有在途）。同一代里只允许一次在途请求。
   * 用「代」而不是布尔：重拉 / 切项目之后，旧请求回来时不能把新一代的在途标记清掉。
   */
  let inFlightGen = 0;
  /** 每次「换项目 / 清空 / 保存后重拉」都 +1，用来把之前那批在途结果作废 */
  let generation = 1;

  const isRecording = computed(function () {
    return !!status.value;
  });

  /** 这个项目录了几条（顶栏的「录制中：N 条」用它） */
  const count = computed(function () {
    return status.value ? Number(status.value.count) || 0 : 0;
  });

  function apply(data) {
    status.value = data.recording || null;
    busy.value = data.busy || null;
    if (typeof data.lastSeq === 'number') lastSeq.value = data.lastSeq;

    const list = data.entries || [];
    if (list.length) {
      // 服务端按时间正序给，界面上新的在最前面
      entries.value = list.slice().reverse().concat(entries.value).slice(0, MAX_ROWS);
    }
  }

  /** 拉一次增量。`pid` 不传就用记住的那个项目 */
  async function refresh(pid) {
    const target = pid || projectId;
    if (!target) return;
    // 这一代已经有在途的了（比如重拉正在进行），别再发第二个
    if (inFlightGen === generation) return;

    const mine = generation;
    inFlightGen = mine;

    try {
      const data = await recordApi.listRecord(target, lastSeq.value);
      // 这一批是「切项目 / 清空 / 保存后重拉」之前发出的，整批丢掉
      if (mine !== generation) return;
      apply(data);
      loaded.value = true;
      error.value = '';
    } catch (err) {
      if (mine === generation) error.value = err.message;
    } finally {
      if (inFlightGen === mine) inFlightGen = 0;
    }
  }

  /** 换项目（或首次打开）：把这一份清干净重新拉 */
  async function load(pid) {
    generation += 1;
    inFlightGen = 0;
    projectId = pid || '';
    status.value = null;
    busy.value = null;
    entries.value = [];
    lastSeq.value = 0;
    loaded.value = false;
    error.value = '';

    if (!projectId) return;
    await refresh(projectId);
  }

  /**
   * 整份重拉当前项目的记录（保存之后用）。
   *
   * 保存会新建接口 / 加示例，列表里那些行的「对应接口」就变了 —— 但增量轮询只拉
   * `seq > lastSeq` 的新记录，**已经在列表里的行不会再拉**，所以那些行会一直挂着「新接口」，
   * 要关掉抽屉重开才变。这里用 `after=0` 整份拉一遍替换掉 entries。
   *
   * 拉的过程中把这一代标成「有在途」，轮询就不会插进来；同时 generation +1，
   * 保存前发出的那次轮询结果整批作废（不然它回来会把旧的 match 写回去）。
   */
  async function reload(pid) {
    const target = pid || projectId;
    if (!target) return;

    const mine = generation + 1;
    generation = mine;
    inFlightGen = mine;

    try {
      const data = await recordApi.listRecord(target, 0);
      if (mine !== generation) return;

      entries.value = (data.entries || []).slice().reverse().slice(0, MAX_ROWS);
      if (typeof data.lastSeq === 'number') lastSeq.value = data.lastSeq;
      status.value = data.recording || null;
      busy.value = data.busy || null;
      loaded.value = true;
      error.value = '';
    } catch (err) {
      if (mine === generation) error.value = err.message;
    } finally {
      if (inFlightGen === mine) inFlightGen = 0;
    }
  }

  function startPolling(intervalMs) {
    stopPolling();
    timer = setInterval(function () { refresh(); }, intervalMs || FAST_POLL_MS);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function start(pid, options) {
    const data = await recordApi.startRecord(pid, options);
    await load(pid);
    return data.recording;
  }

  async function stop(pid) {
    const target = pid || projectId;
    await recordApi.stopRecord(target);
    await refresh(target);
  }

  async function clear(pid) {
    const target = pid || projectId;
    if (!target) return;

    const mine = generation + 1;
    generation = mine;
    inFlightGen = mine;

    try {
      const data = await recordApi.clearRecord(target);
      if (mine !== generation) return;

      entries.value = [];
      if (typeof data.lastSeq === 'number') lastSeq.value = data.lastSeq;
      status.value = data.recording || null;
      busy.value = data.busy || null;
      loaded.value = true;
      error.value = '';
    } catch (err) {
      if (mine === generation) error.value = err.message;
      throw err;
    } finally {
      if (inFlightGen === mine) inFlightGen = 0;
    }
  }

  async function save(pid, payload) {
    return recordApi.saveRecord(pid || projectId, payload);
  }

  return {
    status: status,
    busy: busy,
    entries: entries,
    lastSeq: lastSeq,
    loaded: loaded,
    error: error,
    isRecording: isRecording,
    count: count,
    load: load,
    reload: reload,
    refresh: refresh,
    startPolling: startPolling,
    stopPolling: stopPolling,
    start: start,
    stop: stop,
    clear: clear,
    save: save
  };
});
