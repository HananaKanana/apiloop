import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as gatewayApi from '@/api/gateway';
import { useSessionStore } from '@/stores/session';

/**
 * 「这个页面是从哪儿打开的」以及网关的状态。
 *
 * 三种形态，界面上的表现完全不同：
 * - **直接打开云端**：请求从云端服务器发出，访问不了用户电脑和内网的地址；
 * - **网关、未绑定 / 已退出**：数据只在本机，不同步，但功能照常可用；
 * - **网关、已登录**：双向同步，只有云端有的功能才可用。
 *
 * 判据统一收在这里，别在各组件里自己拼：
 * - `mockAvailable`：mock 服务在**本机**（网关自己起），所以只要空间不是「未绑定」就能用；
 * - `cloudFeaturesAvailable`：改密码、用户管理、成员管理、mock 日志、安装包列表
 *   这些数据在云端，必须登录才能用。
 */

/** 网关上的状态每 3 秒问一次（设计稿第 7 节）：同步进度和「N 项待同步」要跟得上 */
const REFRESH_MS = 3000;

export const useGatewayStore = defineStore('gateway', function () {
  /** 页面是不是从网关上打开的 */
  const isGateway = ref(false);
  /** `{ version, cloudUrl, cloudReachable, space, sync }`，不是网关时为 null */
  const status = ref(null);
  /** 探测过一次了没有（没探完之前不要先闪一个状态出来） */
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
   * 空间状态：`'unbound'`（还没登录过）、`'signedIn'`、`'signedOut'`。
   * 不是网关时是空串 —— 直接打开云端没有「空间」这一说。
   */
  const spaceState = computed(function () {
    return (status.value && status.value.space && status.value.space.state) || '';
  });

  /** 登录着（而且云端会话没过期）—— 双向同步在跑 */
  const signedIn = computed(function () {
    return spaceState.value === 'signedIn';
  });

  /**
   * 同步状态：`{ running, online, pending, conflicts, lastSyncAt, lastError, expired }`。
   * 网关还没实现同步引擎时是 null，界面按「没有同步信息」处理。
   */
  const sync = computed(function () {
    return (status.value && status.value.sync) || null;
  });

  /**
   * 「只有云端有的功能」能不能用：改密码、用户管理、成员管理、mock 日志、安装包列表。
   * 这些数据不同步到本机，没登录就没有。
   */
  const cloudFeaturesAvailable = computed(function () {
    if (!isGateway.value) return true;
    return signedIn.value;
  });

  /**
   * mock 能不能用。
   *
   * mock 服务跑在**网关本机**（不是云端），所以只要空间不是「未绑定」就能用 ——
   * 退出登录之后数据都在本机，mock 照常跑。
   */
  const mockAvailable = computed(function () {
    if (!isGateway.value) return true;
    return spaceState.value !== '' && spaceState.value !== 'unbound';
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
    status.value = result.isGateway ? pick(result) : null;
    loaded.value = true;
    return result;
  }

  /** 只刷状态。失败就沿用上一次的结果，不要因此把圆点变成红的 */
  async function refresh() {
    if (!isGateway.value) return;
    try {
      const result = await gatewayApi.getStatus();
      if (!result.isGateway) return;
      status.value = pick(result);
    } catch (err) {
      // 探测失败不打扰用户，下个周期自己会重试
    }
  }

  /** 只留界面要用的几个字段 */
  function pick(result) {
    return {
      version: result.version,
      cloudUrl: result.cloudUrl,
      cloudReachable: result.cloudReachable,
      space: result.space,
      sync: result.sync
    };
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
    spaceState: spaceState,
    signedIn: signedIn,
    sync: sync,
    cloudFeaturesAvailable: cloudFeaturesAvailable,
    mockAvailable: mockAvailable,
    versionMismatch: versionMismatch,
    cloudSendBlocked: cloudSendBlocked,
    load: load,
    refresh: refresh,
    start: start,
    stop: stop
  };
});
