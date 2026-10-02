import { useDialog as useNaiveDialog } from 'naive-ui';

/**
 * 全站确认框统一用这个，代替 naive-ui 的 useDialog（用户 2026-10-02：「清空历史」那种框太丑）。
 *
 * naive 默认的样子问题在于：标题前一个大圆形图标、「取消」是描边的幽灵按钮而且一打开就被
 * 自动聚焦成主色橙框，看起来像两个主按钮在打架。这里统一成 Postman 那种：
 *   - 不要类型图标，危险与否只看确认按钮的颜色：error 是红色，其余（warning / info / success）
 *     一律用主色橙 —— naive 的 warning 是黄橙色，和品牌橙摆在一起像配错了色；
 *   - 「取消」是普通的灰底按钮，不自动聚焦；
 *   - 固定宽度、按钮稍大一号。间距和圆角在 App.vue 的 Dialog 主题里改。
 * 调用处传的同名选项优先，按钮 props 是合并而不是覆盖。
 */
const BUTTON = { size: 'medium' };

function withDefaults(options) {
  const opts = options || {};
  return {
    showIcon: false,
    autoFocus: false,
    style: 'width: 420px; max-width: calc(100vw - 32px)',
    ...opts,
    negativeButtonProps: { ...BUTTON, ghost: false, secondary: true, ...(opts.negativeButtonProps || {}) },
    positiveButtonProps: { ...BUTTON, ...(opts.positiveButtonProps || {}) }
  };
}

export function useDialog() {
  const dialog = useNaiveDialog();
  function wrap(method) {
    return function (options) { return dialog[method](withDefaults(options)); };
  }
  /** 没有图标以后 info / success / warning 只剩按钮颜色的区别，都走 create（type 'default' → 主色按钮） */
  function plain(options) {
    return dialog.create({ ...withDefaults(options), type: 'default' });
  }
  return {
    create: wrap('create'),
    info: plain,
    success: plain,
    warning: plain,
    error: wrap('error'),
    destroyAll: function () { return dialog.destroyAll(); }
  };
}
