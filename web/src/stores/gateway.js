import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as gatewayApi from '@/api/gateway';
import { useSessionStore } from '@/stores/session';

/**
 * 「这个页面是从哪儿打开的」以及网关的状态。
 *
 * 三种形态，界面上的表现完全不同：
 * - **网关上**（从本机 apiloop 打开）：请求从这台电脑发出，能访问本机和内网地址；
 * - **直接打开云端**：请求从云端服务器发出，访问不了用户电脑和内网的地址；
 * - **直接打开云端、而且云端不发送请求**（`serverSend` 为 false）：连发送都不给发。
 */

/** 「云端连得上吗」每 30 秒重新探一次 —— 它随时会变，用户也可能刚把云端地址改对 */
const REFRESH_MS = 30000;

export const useGatewayStore = defineStore('gateway', function () {
  /** 页面是不是从网关上打开的 */
  const isGateway = ref(false);
  /** `{ version, cloudUrl, cloudReachable, mode }`，不是网关时为 null */
  const status = ref(null);
  /** 探测过一次了没有（没探测完之前不要先闪一个「云端发送」出来） */
  const loaded = ref(false);

  let timer = null;

  /**
   * 云端到底发不发送请求。G1 的 `/meta.serverSend` 还没合进来时这个字段不存在，
   * 按 **true** 处理（契约里写明了）—— 宁可让按钮可用，也不要凭空把功能锁掉。
   */
  const serverSend = computed(function () {
    const meta = useSessionStore().meta;
    if (!meta || meta.serverSend === undefined || meta.serverSend === null) return true;
    return meta.serverSend !== false;
  });

  /** 顶栏那个圆点要不要显示。直接打开云端 + 云端不发送时，不显示（发送按钮那边会说） */
  const showIndicator = computed(function () {
    if (!loaded.value) return false;
    if (isGateway.value) return true;
    return serverSend.value;
  });

  const cloudUrl = computed(function () {
    return (status.value && status.value.cloudUrl) || '';
  });

  /**
   * 网关当前的模式：`'local'` 或 `'cloud'`（L1）。
   * 不是网关时为空串 —— 直接打开云端没有「模式」这一说。
   */
  const mode = computed(function () {
    return (status.value && status.value.mode) || '';
  });

  /**
   * 本机模式：页面读写的是**本机库**，数据不出这台电脑。
   *
   * 这个模式下要藏起来的东西：mock 地址（mock 服务在云端）、成员管理、用户管理、
   * 退出登录 —— 本机没有「登录」这回事，本机用户是自动的。
   */
  const isLocal = computed(function () {
    return isGateway.value && mode.value === 'local';
  });

  /**
   * 网关版本和云端版本不一致 —— 说明云端那边有新的安装包。
   *
   * 放在 store 里而不是各组件自己算：顶栏的「有新版本」和页面顶部的横幅要用同一个判断，
   * 两处各写一遍迟早会走岔。
   *
   * @returns {{gatewayVersion: string, cloudVersion: string}|null}
   */
  const versionMismatch = computed(function () {
    if (!isGateway.value || !status.value) return null;

    const gatewayVersion = status.value.version || '';
    const cloudVersion = (useSessionStore().meta && useSessionStore().meta.version) || '';
    if (!gatewayVersion || !cloudVersion || gatewayVersion === cloudVersion) return null;

    return { gatewayVersion: gatewayVersion, cloudVersion: cloudVersion };
  });

  /**
   * 直接打开云端、而且云端不发送请求：发送按钮要变灰。
   * 探测还没回来时（`loaded` 为 false）先不当成禁止，免得页面刚开就闪一下灰按钮。
   */
  const cloudSendBlocked = computed(function () {
    if (!loaded.value) return false;
    return !isGateway.value && !serverSend.value;
  });

  async function load() {
    const result = await gatewayApi.getStatus();
    isGateway.value = result.isGateway;
    status.value = result.isGateway
      ? {
          version: result.version,
          cloudUrl: result.cloudUrl,
          cloudReachable: result.cloudReachable,
          mode: result.mode
        }
      : null;
    loaded.value = true;
    return result;
  }

  /** 只刷「云端连得上吗」和模式。失败就沿用上一次的结果，不要因此把圆点变成红的 */
  async function refresh() {
    if (!isGateway.value) return;
    try {
      const result = await gatewayApi.getStatus();
      if (!result.isGateway) return;
      status.value = {
        version: result.version,
        cloudUrl: result.cloudUrl,
        cloudReachable: result.cloudReachable,
        mode: result.mode
      };
    } catch (err) {
      // 探测失败不打扰用户，下个周期自己会重试
    }
  }

  function start() {
    stop();
    timer = setInterval(refresh, REFRESH_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    isGateway: isGateway,
    status: status,
    serverSend: serverSend,
    loaded: loaded,
    showIndicator: showIndicator,
    cloudUrl: cloudUrl,
    mode: mode,
    isLocal: isLocal,
    versionMismatch: versionMismatch,
    cloudSendBlocked: cloudSendBlocked,
    load: load,
    refresh: refresh,
    start: start,
    stop: stop
  };
});
