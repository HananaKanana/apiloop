<script setup>
import { computed } from 'vue';
import { chartGeometry } from '@/utils/load';

/**
 * 压测的实时曲线（第八轮第 2 节）：两条线一条红条。
 *
 * - 蓝线（左轴）：每秒请求数；橙线（右轴）：每秒平均响应时间；
 * - 底下红条：那一秒有失败，高度按失败数占最高值的比例。
 *
 * **不加图表库**（整个前端就这一个地方要画图，为它引一个库不值当）：
 * 坐标全在 `@/utils/load.js` 的 `chartGeometry` 里算好（纯函数，能单独跑断言），
 * 这里只往里填 `<path>` 和 `<rect>`。
 */
const props = defineProps({
  /** 每秒一个点：`{ t, qps, avgMs, failed }` */
  rows: { type: Array, default: function () { return []; } },
  height: { type: Number, default: 190 }
});

const chart = computed(function () {
  return chartGeometry(props.rows, { height: props.height });
});
</script>

<template>
  <div class="load-chart">
    <div class="legend">
      <span class="item"><i class="dot qps" />每秒请求数</span>
      <span class="item"><i class="dot ms" />每秒平均响应时间</span>
      <span v-if="chart.bars.length" class="item"><i class="dot failed" />有失败的那一秒</span>
    </div>

    <p v-if="!rows.length" class="empty">还没有数据</p>

    <svg
      v-else
      class="svg"
      :viewBox="'0 0 ' + chart.width + ' ' + chart.height"
      :style="{ height: chart.height + 'px' }"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="压测曲线"
    >
      <!-- 网格与两侧刻度 -->
      <g class="grid">
        <template v-for="tick in chart.leftTicks" :key="'g' + tick.y">
          <line :x1="chart.plot.x" :x2="chart.plot.x + chart.plot.width" :y1="tick.y" :y2="tick.y" />
        </template>
      </g>
      <g class="axis">
        <template v-for="tick in chart.leftTicks" :key="'l' + tick.y">
          <text :x="chart.plot.x - 6" :y="Number(tick.y) + 3" text-anchor="end">{{ tick.value }}</text>
        </template>
        <template v-for="tick in chart.rightTicks" :key="'r' + tick.y">
          <text
            :x="chart.plot.x + chart.plot.width + 6"
            :y="Number(tick.y) + 3"
            text-anchor="start"
          >{{ tick.value }}ms</text>
        </template>
        <template v-for="label in chart.xLabels" :key="'x' + label.x">
          <text
            :x="label.x"
            :y="chart.plot.y + chart.plot.height + 14"
            text-anchor="middle"
          >{{ label.text }}</text>
        </template>
      </g>

      <!-- 失败的红条画在曲线下面，别盖住线 -->
      <g class="bars">
        <rect
          v-for="bar in chart.bars"
          :key="'b' + bar.t"
          :x="bar.x"
          :y="bar.y"
          :width="bar.width"
          :height="bar.height"
        />
      </g>

      <path class="line qps" :d="chart.qpsPath" />
      <path class="line ms" :d="chart.msPath" />
    </svg>
  </div>
</template>

<style scoped>
.load-chart {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  opacity: 0.7;
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}

.dot.qps { background: #2080f0; }
.dot.ms { background: #f0a020; }
.dot.failed { background: #d03050; }

.svg {
  width: 100%;
  display: block;
}

.empty {
  margin: 0;
  padding: 30px 0;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}

.grid line {
  stroke: rgba(128, 128, 128, 0.22);
  stroke-width: 1;
}

.axis text {
  font-size: 10px;
  fill: currentColor;
  opacity: 0.55;
}

.bars rect {
  fill: rgba(208, 48, 80, 0.45);
}

.line {
  fill: none;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.line.qps { stroke: #2080f0; }
.line.ms { stroke: #f0a020; }
</style>
