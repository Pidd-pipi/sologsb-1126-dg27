<script setup lang="ts">
/**
 * ConflictFields —— 合并冲突字段的「本地 vs 包内」并排对照，等人确认采用哪一侧。
 * 被勘察包合并页（/merge）的营位、权重方案、营地容量三个分区复用。
 * 选择直接写入 mergeStore.resolutions，合并计划随之重算。
 */
import { useMergeStore } from '@/stores/mergeStore'
import type { FieldConflict } from '@/utils/merge'

const props = defineProps<{
  conflicts: FieldConflict[]
  kind: 'site' | 'profile' | 'capacity'
  /** 匹配键：营位编号 / 方案名 / 营地名 */
  mergeKey: string
}>()

const mergeStore = useMergeStore()

function choose(field: string, choice: 'local' | 'incoming'): void {
  mergeStore.setResolution(props.kind, props.mergeKey, field, choice)
}

function fmt(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
</script>

<template>
  <div class="conflict-fields">
    <div v-for="c in conflicts" :key="c.field" class="conflict-row">
      <div class="conflict-row__label">{{ c.label }}</div>
      <div class="conflict-row__vals">
        <label class="conflict-opt" :class="{ 'is-chosen': c.chosen === 'local' }">
          <input
            type="radio"
            :name="`${kind}-${mergeKey}-${c.field}`"
            :checked="c.chosen === 'local'"
            @change="choose(c.field, 'local')"
          />
          <span class="conflict-opt__tag">本地</span>
          <span class="conflict-opt__val">{{ fmt(c.local) }}</span>
        </label>
        <label class="conflict-opt" :class="{ 'is-chosen': c.chosen === 'incoming' }">
          <input
            type="radio"
            :name="`${kind}-${mergeKey}-${c.field}`"
            :checked="c.chosen === 'incoming'"
            @change="choose(c.field, 'incoming')"
          />
          <span class="conflict-opt__tag">包内</span>
          <span class="conflict-opt__val">{{ fmt(c.incoming) }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conflict-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conflict-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 8px;
  background: #fff8f8;
  border: 1px solid #f3d6d6;
  border-radius: 8px;
}
.conflict-row__label {
  width: 96px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--gb-muted);
  padding-top: 4px;
}
.conflict-row__vals {
  display: flex;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}
.conflict-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--gb-line);
  border-radius: 7px;
  background: #ffffff;
  cursor: pointer;
  min-width: 200px;
}
.conflict-opt input {
  margin: 0;
}
.conflict-opt__tag {
  font-size: 11px;
  color: var(--gb-muted);
  flex-shrink: 0;
}
.conflict-opt__val {
  font-size: 13px;
  color: var(--gb-ink);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
.conflict-opt.is-chosen {
  border-color: var(--gb-accent-strong);
  background: #eef6f0;
}
.conflict-opt.is-chosen .conflict-opt__tag {
  color: var(--gb-accent-strong);
  font-weight: 700;
}
</style>
