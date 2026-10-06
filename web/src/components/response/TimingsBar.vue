<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 分阶段耗时。timings 里的值是毫秒，某个阶段没发生就是 null。
 * 条形长度按「各阶段之和」的比例算，这样一眼能看出时间花在哪一段。
 */
const props = defineProps({
  timings: { type: Object, default: null }
});

const { t } = useI18n();

const STAGES = [
  { key: 'dns', labelKey: 'timingDns' },
  { key: 'connect', labelKey: 'timingConnect' },
  { key: 'tls', labelKey: 'timingTls' },
  { key: 'ttfb', labelKey: 'timingTtfb' },
  { key: 'download', labelKey: 'timingDownload' }
];

const STAGE_COLORS = {
  dns: '#8a2be2',
  connect: '#2080f0',
  tls: '#18a058',
  ttfb: '#f0a020',
  download: '#d03050'
};

const rows = computed(function () {
  const source = props.timings || {};
  return STAGES.map(function (stage) {
    return {
      key: stage.key,
      label: t('response.' + stage.labelKey),
      color: STAGE_COLORS[stage.key],
      value: source[stage.key] === null || source[stage.key] === undefined ? null : source[stage.key]
    };
  });
});

const total = computed(function () {
  return (props.timings && props.timings.total) || 0;
});

/** 各阶段是串行的，加起来近似总耗时；用它当分母，条形比例才直观 */
const sum = computed(function () {
  return rows.value.reduce(function (acc, row) {
    return acc + (row.value || 0);
  }, 0) || total.value || 1;
});

function percent(value) {
  if (!value) return 0;
  return Math.max(1, Math.round((value / sum.value) * 100));
}

function fmt(value) {
  if (value === null || value === undefined) return '—';
  return Math.round(value * 100) / 100 + ' ms';
}
</script>

<template>
  <div class="timings">
    <p class="total">{{ t('response.totalTiming') }} <b>{{ fmt(total) }}</b></p>

    <div v-for="row in rows" :key="row.key" class="stage">
      <div class="label">{{ row.label }}</div>
      <div class="bar">
        <div
          class="fill"
          :style="{ width: percent(row.value) + '%', background: row.color }"
        />
      </div>
      <div class="value">{{ fmt(row.value) }}</div>
    </div>
  </div>
</template>

<style scoped>
.timings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.total {
  margin: 0 0 4px;
  font-size: 13px;
}

.stage {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.label {
  flex: 0 0 90px;
  opacity: 0.7;
}

.bar {
  flex: 1;
  min-width: 0;
  height: 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.16);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s;
}

.value {
  flex: 0 0 82px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.8;
}
</style>
