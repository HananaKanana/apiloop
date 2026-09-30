import { h, ref } from 'vue';
import { NInput, useDialog } from 'naive-ui';

/**
 * 一句话要个名字的小弹窗（新建目录、新建接口、重命名都用它）。
 * 用 useDialog 的 render 形式自己放一个输入框，比再写一个组件省事。
 *
 * @returns {(options: {title: string, label?: string, value?: string, placeholder?: string, confirmText?: string}) => Promise<string|null>}
 *          取消或关掉返回 null
 */
export function usePrompt() {
  const dialog = useDialog();

  return function prompt(options) {
    const value = ref(options.value || '');
    let instance = null;
    let settled = false;

    return new Promise(function (resolve) {
      function finish(result) {
        if (settled) return;
        settled = true;
        resolve(result);
      }

      instance = dialog.create({
        title: options.title,
        content: function () {
          return h('div', null, [
            options.label
              ? h('p', { style: 'margin: 0 0 8px; font-size: 12px; opacity: 0.65' }, options.label)
              : null,
            h(NInput, {
              value: value.value,
              placeholder: options.placeholder || '',
              autofocus: true,
              'onUpdate:value': function (next) { value.value = next; },
              onKeyup: function (event) {
                if (event.key !== 'Enter') return;
                const result = value.value;
                finish(result);
                if (instance) instance.destroy();
              }
            })
          ]);
        },
        positiveText: options.confirmText || '确定',
        negativeText: '取消',
        onPositiveClick: function () { finish(value.value); },
        onNegativeClick: function () { finish(null); },
        onClose: function () { finish(null); },
        onMaskClick: function () { finish(null); }
      });
    });
  };
}
