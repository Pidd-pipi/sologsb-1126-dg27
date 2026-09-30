<script setup lang="ts">
/**
 * `/merge` 勘察包合并 —— 联合勘察队归队后，导入离线分包，按营位编号做两路合并：
 *   1. 基础信息 / 权重方案：逐字段并排对照，两边都改出差异的字段必须逐项确认；
 *   2. 最新因子评估、风险否决：整项并排二选一；包内历史评估只追加、不改旧记录；
 *   3. 营地容量表：合并后帐篷数超上限（或容量未登记）则整体拒绝写库，草稿保留；
 *   4. 确认写入后名次 / 等级 / 地图标记随 store 自动重算，权重变化时给出提示。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useCapacityStore } from '@/stores/capacityStore'
import {
  buildMergePlan,
  checkCapacity,
  commitMerge,
  emptyResolutions,
  fieldValueText,
  planStats,
  SITE_FIELDS,
  PROFILE_FIELDS,
  FACTOR_FIELDS,
  VETO_FIELDS,
  type FieldPlan,
  type MergePlan,
  type MergeResolutions,
  type MergeSide
} from '@/utils/merge'
import { CapacityGuardError } from '@/utils/merge'
import {
  buildSurveyPackage,
  downloadSurveyPackage,
  parseSurveyPackage,
  type SurveyPackage
} from '@/utils/package'
import { buildDemoPackage } from '@/utils/demoPackage'
import { clearDraft, loadDraft, saveDraft } from '@/utils/draft'
import { formatDateTime } from '@/utils/format'
import type { CampCapacity } from '@/types/campCapacity'

const DRAFT_KEY = 'merge-package'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const capacityStore = useCapacityStore()

const pkg = ref<SurveyPackage | null>(null)
const plan = ref<MergePlan | null>(null)
const resolutions = reactive<MergeResolutions>(emptyResolutions())
const committing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const draftSavedAt = ref('')

/** 容量表编辑副本（营地名 -> 行），未登记营地以空行补齐 */
const capacityDraft = reactive<Record<string, { limit: number | null; note: string }>>({})
const newCampName = ref('')
const newCampLimit = ref<number | null>(null)

/* ------------------------------ 计划与统计 ------------------------------ */

const stats = computed(() =>
  plan.value ? planStats(plan.value, resolutions) : { unresolved: 0, incomingOnly: 0 }
)

const capacityUsages = computed(() =>
  plan.value && pkg.value
    ? checkCapacity(plan.value, resolutions, capacityStore.list, pkg.value.capacities)
    : []
)

const capacityBlocked = computed(() => capacityUsages.value.some((u) => u.over || u.missing))

const canCommit = computed(
  () => !!plan.value && stats.value.unresolved === 0 && !capacityBlocked.value
)

const conflictSiteItems = computed(
  () => plan.value?.sites.filter((s) => s.status === 'both') ?? []
)
const incomingSites = computed(
  () => plan.value?.sites.filter((s) => s.status === 'incoming-only') ?? []
)
const conflictProfileItems = computed(
  () => plan.value?.profiles.filter((p) => p.status === 'both') ?? []
)
const incomingProfiles = computed(
  () => plan.value?.profiles.filter((p) => p.status === 'incoming-only') ?? []
)
const bothFactorItems = computed(
  () => plan.value?.factors.filter((f) => f.status === 'both') ?? []
)
const incomingFactorItems = computed(
  () => plan.value?.factors.filter((f) => f.status === 'incoming-only') ?? []
)
const bothVetoItems = computed(
  () => plan.value?.vetos.filter((v) => v.status === 'both') ?? []
)
const incomingVetoItems = computed(
  () => plan.value?.vetos.filter((v) => v.status === 'incoming-only') ?? []
)

/* ------------------------------ 载入勘察包 ------------------------------ */

function syncCapacityDraft(): void {
  for (const c of capacityStore.list) {
    if (!(c.campName in capacityDraft)) {
      capacityDraft[c.campName] = { limit: c.tentLimit, note: c.note }
    }
  }
  // 合并涉及、但容量表没有的营地，补可编辑空行
  if (plan.value) {
    for (const s of plan.value.sites) {
      const name = s.incoming?.campName ?? s.local?.campName ?? ''
      if (name && !(name in capacityDraft)) {
        capacityDraft[name] = { limit: null, note: '' }
      }
    }
  }
}

function loadPackage(next: SurveyPackage): void {
  pkg.value = next
  plan.value = buildMergePlan(
    {
      sites: siteStore.list,
      factors: siteStore.factors,
      profiles: profileStore.list,
      vetos: uiStore.vetos
    },
    next
  )
  Object.assign(resolutions, emptyResolutions())
  syncCapacityDraft()
  persistDraft()
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = parseSurveyPackage(String(reader.result ?? ''))
      loadPackage(parsed)
      ElMessage.success(`已读入勘察包：${parsed.meta.team}`)
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    } finally {
      input.value = ''
    }
  }
  reader.onerror = () => ElMessage.error('读取文件失败，请重试。')
  reader.readAsText(file, 'utf-8')
}

function loadDemo(): void {
  loadPackage(
    buildDemoPackage({
      sites: siteStore.list,
      factors: siteStore.factors,
      profiles: profileStore.list,
      vetos: uiStore.vetos,
      capacities: capacityStore.list
    })
  )
  ElMessage.info('已载入二队演示分包：含字段冲突、新增营位与否决，以及容量超限场景。')
}

function exportCurrent(): void {
  const pack = buildSurveyPackage(
    {
      sites: siteStore.list,
      factors: siteStore.factors,
      profiles: profileStore.list,
      vetos: uiStore.vetos,
      capacities: capacityStore.list
    },
    { team: '主队' }
  )
  downloadSurveyPackage(pack)
}

function resetSession(): void {
  pkg.value = null
  plan.value = null
  Object.assign(resolutions, emptyResolutions())
  clearDraft(DRAFT_KEY)
  draftSavedAt.value = ''
}

/* ------------------------------ 草稿 ------------------------------ */

function persistDraft(): void {
  if (!pkg.value) return
  saveDraft(DRAFT_KEY, { pkg: pkg.value, resolutions: { ...resolutions } })
  draftSavedAt.value = formatDateTime(new Date().toISOString())
}

watch(
  resolutions,
  () => persistDraft(),
  { deep: true }
)

/** 页面挂载后尝试恢复上次未完成的合并草稿。 */
function restoreDraft(): boolean {
  const raw = loadDraft<{ pkg: SurveyPackage; resolutions: MergeResolutions }>(DRAFT_KEY)
  if (!raw) return false
  try {
    const parsed = parseSurveyPackage(JSON.stringify(raw.pkg))
    pkg.value = parsed
    plan.value = buildMergePlan(
      {
        sites: siteStore.list,
        factors: siteStore.factors,
        profiles: profileStore.list,
        vetos: uiStore.vetos
      },
      parsed
    )
    Object.assign(resolutions, raw.resolutions ?? emptyResolutions())
    syncCapacityDraft()
    draftSavedAt.value = formatDateTime(new Date().toISOString())
    return true
  } catch {
    clearDraft(DRAFT_KEY)
    return false
  }
}

const restored = ref(false)
if (restoreDraft()) restored.value = true

/* ------------------------------ 冲突选择 ------------------------------ */

function fieldChoiceKey(itemKey: string, fieldKey: string): string {
  return `${itemKey}::${fieldKey}`
}

function chooseField(itemKey: string, field: FieldPlan, side: MergeSide): void {
  if (!field.conflict) return
  resolutions.fields[fieldChoiceKey(itemKey, field.key)] = side
}

function chosenFieldSide(itemKey: string, field: FieldPlan): MergeSide | '' {
  if (!field.conflict) return ''
  return resolutions.fields[fieldChoiceKey(itemKey, field.key)] ?? ''
}

function chooseItem(itemKey: string, side: MergeSide): void {
  resolutions.items[itemKey] = side
}

function itemSide(itemKey: string): MergeSide | '' {
  return resolutions.items[itemKey] ?? ''
}

function setInclude(itemKey: string, value: boolean): void {
  resolutions.includes[itemKey] = value
}

function isIncluded(itemKey: string): boolean {
  return resolutions.includes[itemKey] !== false
}

/** 整项全部采用某一方（仅作用于该项的冲突字段；因子/否决写整项选择） */
function resolveAllSiteFields(itemKey: string, side: MergeSide): void {
  const item = plan.value?.sites.find((s) => s.key === itemKey)
  if (!item) return
  for (const f of item.fields) {
    if (f.conflict) resolutions.fields[fieldChoiceKey(itemKey, f.key)] = side
  }
}

function resolveAllProfileFields(itemKey: string, side: MergeSide): void {
  const item = plan.value?.profiles.find((p) => p.key === itemKey)
  if (!item) return
  for (const f of item.fields) {
    if (f.conflict) resolutions.fields[fieldChoiceKey(itemKey, f.key)] = side
  }
}

/** 一键采用某一方的全部未决冲突（跨所有项） */
function resolveEveryConflict(side: MergeSide): void {
  if (!plan.value) return
  for (const item of [...plan.value.sites, ...plan.value.profiles]) {
    for (const f of item.fields) {
      const k = fieldChoiceKey(item.key, f.key)
      if (f.conflict && !resolutions.fields[k]) resolutions.fields[k] = side
    }
  }
  for (const item of [...plan.value.factors, ...plan.value.vetos]) {
    if (item.fields.some((f) => f.conflict) && !resolutions.items[item.key]) {
      resolutions.items[item.key] = side
    }
  }
}

/* ------------------------------ 容量表维护 ------------------------------ */

const packageCapOf = (campName: string): number | null =>
  pkg.value?.capacities.find((c) => c.campName === campName)?.tentLimit ?? null

async function saveCapacityRow(campName: string): Promise<void> {
  const row = capacityDraft[campName]
  if (!row) return
  await capacityStore.upsert(campName, row.limit, row.note)
  ElMessage.success(`已保存「${campName}」容量：${row.limit ?? '未设限'} 帐`)
}

async function saveNewCapacity(): Promise<void> {
  const name = newCampName.value.trim()
  if (!name) {
    ElMessage.warning('请填写营地名称')
    return
  }
  await capacityStore.upsert(name, newCampLimit.value, '')
  capacityDraft[name] = { limit: newCampLimit.value, note: '' }
  newCampName.value = ''
  newCampLimit.value = null
  ElMessage.success(`已登记「${name}」容量`)
}

async function removeCapacity(campName: string): Promise<void> {
  await capacityStore.remove(campName)
  // 该营地在合并结果中仍占一行：保留可编辑空行，避免模板访问 undefined
  capacityDraft[campName] = { limit: null, note: '' }
}

/* ------------------------------ 提交写库 ------------------------------ */

async function commit(): Promise<void> {
  if (!plan.value || !pkg.value) return
  if (stats.value.unresolved > 0) {
    ElMessage.warning(`还有 ${stats.value.unresolved} 处冲突未确认`)
    return
  }
  if (capacityBlocked.value) {
    ElMessage.error('营地容量校验未通过，已拒绝写入；草稿已保留，可调整容量或选择后重试。')
    return
  }
  try {
    await ElMessageBox.confirm(
      '确认把合并结果写入本地库？因子评估仅追加、旧勘察记录会继续保留；权重方案变化后名次与等级立即重算。',
      '确认写入勘察包',
      { confirmButtonText: '确认写入', cancelButtonText: '再核对一下', type: 'warning' }
    )
  } catch {
    return
  }

  committing.value = true
  try {
    const result = await commitMerge(plan.value, resolutions, capacityStore.list, pkg.value)
    await Promise.all([
      siteStore.load(),
      profileStore.load(),
      uiStore.loadVetos(),
      capacityStore.load()
    ])

    // 权重（启用方案）是否真的发生内容变化
    const activeChanged =
      result.activeProfileChanged ||
      !!plan.value.profiles.some((p) =>
        p.status === 'both'
          ? p.fields.some((f) => f.key === 'weights' && f.conflict &&
              resolutions.fields[`${p.key}::weights`] === 'incoming')
          : false
      )

    clearDraft(DRAFT_KEY)
    draftSavedAt.value = ''
    ElMessageBox.alert(
      [
        `营位：新增 ${result.sitesAdded} 个、更新 ${result.sitesUpdated} 个`,
        `因子评估：追加 ${result.factorsAppended} 轮（历史记录全部保留）`,
        `权重方案：新增 ${result.profilesAdded} 个、更新 ${result.profilesUpdated} 个`,
        `风险否决：新增 ${result.vetosAdded} 条`,
        activeChanged
          ? '启用权重发生变化：名次、等级与地图标记已按新权重重算。'
          : '权重未变，名次与地图标记已随合并数据刷新。'
      ].join('<br/>'),
      '合并写入完成',
      { dangerouslyUseHTMLString: true, confirmButtonText: '查看名次表', type: 'success' }
    ).then(() => router.push('/'))
    pkg.value = null
    plan.value = null
  } catch (err) {
    if (err instanceof CapacityGuardError) {
      ElMessage.error(`容量超限，已拒绝写入并保留草稿：${err.message}`)
    } else {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    committing.value = false
  }
}

/* ------------------------------ 模板辅助 ------------------------------ */

function fmt(fieldKey: string, value: unknown): string {
  return fieldValueText(fieldKey, value)
}

function fieldLabel(fieldKey: string): string {
  return (
    SITE_FIELDS.find((f) => f.key === fieldKey)?.label ??
    PROFILE_FIELDS.find((f) => f.key === fieldKey)?.label ??
    fieldKey
  )
}

const siteFieldLabels: Record<string, string> = Object.fromEntries(
  SITE_FIELDS.map((f) => [f.key, f.label])
)
const profileFieldLabels: Record<string, string> = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.key, f.label])
)
const factorFieldLabels: Record<string, string> = Object.fromEntries(
  FACTOR_FIELDS.map((f) => [f.key, f.label])
)
const vetoFieldLabels: Record<string, string> = Object.fromEntries(
  VETO_FIELDS.map((f) => [f.key, f.label])
)

function capacityRowClassName(scope: { row: { over: boolean; missing: boolean } }): string {
  if (scope.row.over) return 'cap-row--over'
  if (scope.row.missing) return 'cap-row--missing'
  return ''
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>勘察包合并</h1>
        <p>
          联合勘察队分头离线编录，归队后导入分包，按营位编号合并基础信息、最新因子评估、权重方案与风险否决。
          两边都改过的内容会并排列出，逐项确认后才写库；合并后帐篷数超过营地容量上限则拒绝写入并保留草稿。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="exportCurrent">导出本队勘察包</el-button>
        <el-button type="primary" @click="fileInput?.click()">导入勘察包</el-button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          style="display: none"
          @change="onFileChange"
        />
      </div>
    </div>

    <!-- 未载入分包 -->
    <template v-if="!pkg || !plan">
      <el-alert
        v-if="restored"
        type="warning"
        show-icon
        :closable="false"
        title="检测到上次未完成的合并草稿"
        description="已自动恢复勘察包与已确认的选择，可继续核对；放弃草稿请点击下方按钮。"
      />
      <section class="panel">
        <div class="panel__head">
          <h2>导入离线分包</h2>
        </div>
        <div class="import-zone">
          <el-button type="primary" size="large" @click="fileInput?.click()">选择勘察包 JSON 文件</el-button>
          <el-button size="large" @click="loadDemo">载入二队演示分包</el-button>
          <el-button size="large" @click="exportCurrent">先导出本队当前勘察包</el-button>
        </div>
        <p class="panel__hint">
          合并规则：按营位编号（CS-xxxx）对齐基础信息；权重方案按方案名对齐；风险否决按「营位编号 + 否决类型」判重；
          因子评估仅追加新轮次，绝不覆盖历史勘察记录。
        </p>
      </section>
    </template>

    <!-- 已载入分包 -->
    <template v-else>
      <!-- 分包概要 + 操作 -->
      <section class="panel">
        <div class="panel__head">
          <h2>分包概要：{{ pkg.meta.team }}</h2>
          <div class="pkg-meta">
            <el-tag size="small" type="info" effect="plain">{{ pkg.meta.device || '未知设备' }}</el-tag>
            <el-tag v-if="pkg.meta.exportedAt" size="small" type="info" effect="plain">
              导出于 {{ pkg.meta.exportedAt.slice(0, 10) }}
            </el-tag>
            <el-button size="small" text type="danger" @click="resetSession">放弃本次合并</el-button>
          </div>
        </div>
        <p v-if="pkg.meta.note" class="panel__hint">分包说明：{{ pkg.meta.note }}</p>
        <div class="stat-row">
          <div class="stat-card">
            <div class="stat-card__label">未决冲突</div>
            <div class="stat-card__value" :style="{ color: stats.unresolved ? '#b91c1c' : undefined }">
              {{ stats.unresolved }}
            </div>
            <div class="stat-card__extra">两边都改过，必须确认</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">分包新增项</div>
            <div class="stat-card__value">{{ stats.incomingOnly }}</div>
            <div class="stat-card__extra">营位 / 方案 / 否决</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">容量校验</div>
            <div class="stat-card__value" :style="{ color: capacityBlocked ? '#b91c1c' : '#15803d' }">
              {{ capacityBlocked ? '未通过' : '通过' }}
            </div>
            <div class="stat-card__extra">超限将拒绝写库</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">草稿</div>
            <div class="stat-card__value" style="font-size: 13px; line-height: 1.7">
              自动保留
            </div>
            <div class="stat-card__extra">选择变化即存 localStorage</div>
          </div>
        </div>
        <div class="bulk-bar">
          <span class="weight-note">未决冲突可一键倾向性处理，之后仍可逐项修改：</span>
          <el-button size="small" @click="resolveEveryConflict('local')">未决项全部保留本队</el-button>
          <el-button size="small" @click="resolveEveryConflict('incoming')">未决项全部采用分包</el-button>
        </div>
      </section>

      <!-- 营地容量表 -->
      <section class="panel">
        <div class="panel__head">
          <h2>营地容量表</h2>
          <span class="weight-note">合并后同营地各营位帐篷数之和不得超过上限；包内容量仅作对照</span>
        </div>
        <el-table
          :data="capacityUsages"
          size="small"
          border
          stripe
          class="cap-table"
          :row-class-name="capacityRowClassName"
        >
          <el-table-column prop="campName" label="营地" min-width="160" />
          <el-table-column label="合并后帐篷数" width="130" align="right">
            <template #default="{ row }">
              <strong :class="{ 'cap-danger': row.over }">{{ row.used }} 帐</strong>
              <div class="cell-sub">{{ row.siteCodes.join('、') }}</div>
            </template>
          </el-table-column>
          <el-table-column label="容量上限（本队）" width="230">
            <template #default="{ row }">
              <div class="cap-edit">
                <el-input-number
                  v-model="capacityDraft[row.campName].limit"
                  :min="0"
                  :max="9999"
                  size="small"
                  controls-position="right"
                  style="width: 120px"
                  placeholder="未登记"
                />
                <el-button
                  size="small"
                  type="primary"
                  text
                  @click="saveCapacityRow(row.campName)"
                >
                  保存
                </el-button>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="分包自报上限" width="130" align="center">
            <template #default="{ row }">
              <span v-if="row.packageLimit != null" class="muted">{{ row.packageLimit }} 帐</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <el-tag v-if="row.over" type="danger" size="small">超限 {{ row.used - (row.limit ?? 0) }} 帐</el-tag>
              <el-tag v-else-if="row.missing" type="warning" size="small">未登记容量</el-tag>
              <el-tag v-else type="success" size="small">可容纳</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="danger" @click="removeCapacity(row.campName)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="cap-add">
          <el-input v-model="newCampName" placeholder="新增营地名称" size="small" style="width: 200px" />
          <el-input-number
            v-model="newCampLimit"
            :min="0"
            :max="9999"
            size="small"
            controls-position="right"
            placeholder="帐篷上限"
            style="width: 140px"
          />
          <el-button size="small" @click="saveNewCapacity">登记新营地容量</el-button>
        </div>
      </section>

      <!-- 基础信息（两边都有，逐字段） -->
      <section class="panel">
        <div class="panel__head">
          <h2>基础信息合并（按营位编号）</h2>
          <span class="weight-note">{{ conflictSiteItems.length }} 个同编号营位需要对照</span>
        </div>
        <template v-if="conflictSiteItems.length">
          <div v-for="item in conflictSiteItems" :key="item.key" class="merge-card">
            <div class="merge-card__head">
              <div class="merge-card__title">
                <el-tag size="small" effect="plain">{{ item.code }}</el-tag>
                <strong>{{ item.local?.campName }} ／ {{ item.incoming?.campName }}</strong>
              </div>
              <div class="merge-card__actions">
                <el-button size="small" text @click="resolveAllSiteFields(item.key, 'local')">
                  全部保留本队
                </el-button>
                <el-button size="small" text type="primary" @click="resolveAllSiteFields(item.key, 'incoming')">
                  全部采用分包
                </el-button>
              </div>
            </div>
            <el-table :data="item.fields" size="small" border>
              <el-table-column label="字段" width="150">
                <template #default="{ row }">
                  {{ siteFieldLabels[row.key] ?? row.label }}
                </template>
              </el-table-column>
              <el-table-column label="本队（本地库）" min-width="200">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.local) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="勘察包（{{ pkg.meta.team }}）" min-width="200">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.incoming) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="确认" width="220" align="center">
                <template #default="{ row }">
                  <template v-if="row.conflict">
                    <el-radio-group
                      :model-value="chosenFieldSide(item.key, row)"
                      size="small"
                      @change="(v: MergeSide) => chooseField(item.key, row, v)"
                    >
                      <el-radio-button value="local">本队</el-radio-button>
                      <el-radio-button value="incoming">分包</el-radio-button>
                    </el-radio-group>
                  </template>
                  <el-tag v-else size="small" type="info" effect="plain">一致 / 自动并入</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
        <p v-else class="panel__hint">没有同编号营位的基础信息冲突。</p>
      </section>

      <!-- 分包新增营位 -->
      <section v-if="incomingSites.length" class="panel">
        <div class="panel__head">
          <h2>分包新增营位</h2>
          <span class="weight-note">本地库中没有这些编号，默认接收</span>
        </div>
        <el-table :data="incomingSites" size="small" border>
          <el-table-column label="接收" width="80" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="isIncluded(row.key)"
                @update:model-value="(v: boolean) => setInclude(row.key, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="营位编号" width="120">
            <template #default="{ row }">
              <el-tag size="small">{{ row.code }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="名称" min-width="180">
            <template #default="{ row }">{{ row.incoming?.name }}</template>
          </el-table-column>
          <el-table-column label="所属营地" min-width="140">
            <template #default="{ row }">{{ row.incoming?.campName }}</template>
          </el-table-column>
          <el-table-column label="帐篷数" width="90" align="right">
            <template #default="{ row }">{{ row.incoming?.tentCapacity }}</template>
          </el-table-column>
          <el-table-column label="备注" min-width="200">
            <template #default="{ row }">{{ row.incoming?.note || '—' }}</template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 最新因子评估 -->
      <section class="panel">
        <div class="panel__head">
          <h2>最新因子评估</h2>
          <span class="weight-note">
            两边最新一轮不一致时整项二选一；分包带回的其余历史轮次将自动追加，不覆盖旧记录
          </span>
        </div>

        <div v-if="bothFactorItems.length" class="factor-list">
          <div v-for="item in bothFactorItems" :key="item.key" class="merge-card">
            <div class="merge-card__head">
              <div class="merge-card__title">
                <el-tag size="small" effect="plain">{{ item.siteCode }}</el-tag>
                <strong>最新一轮评估两边不一致</strong>
              </div>
              <el-radio-group
                :model-value="itemSide(item.key)"
                size="small"
                @change="(v: MergeSide) => chooseItem(item.key, v)"
              >
                <el-radio-button value="local">保留本队最新</el-radio-button>
                <el-radio-button value="incoming">采用分包最新</el-radio-button>
              </el-radio-group>
            </div>
            <el-table :data="item.fields" size="small" border>
              <el-table-column label="因子" width="150">
                <template #default="{ row }">{{ factorFieldLabels[row.key] ?? row.label }}</template>
              </el-table-column>
              <el-table-column label="本队最新" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.local) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="分包最新" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.incoming) }}</span>
                </template>
              </el-table-column>
            </el-table>
            <p class="panel__hint">
              无论选择哪一方，双方历史勘察轮次都会保留在营位详情的「多轮复核」中。
            </p>
          </div>
        </div>

        <div v-if="incomingFactorItems.length" class="factor-list">
          <el-alert
            type="success"
            :closable="false"
            show-icon
            :title="`分包还带来 ${incomingFactorItems.length} 个本地没有评估记录的营位`"
            description="这些营位的最新评估将随营位一并写入（营位若被排除则不写入）。"
          />
        </div>

        <p v-if="!bothFactorItems.length && !incomingFactorItems.length" class="panel__hint">
          双方最新因子评估内容一致，无需确认。
        </p>
      </section>

      <!-- 权重方案 -->
      <section class="panel">
        <div class="panel__head">
          <h2>权重方案合并</h2>
          <span class="weight-note">按方案名对齐；权重变化写入后名次、等级与地图标记立即重算</span>
        </div>
        <template v-if="conflictProfileItems.length">
          <div v-for="item in conflictProfileItems" :key="item.key" class="merge-card">
            <div class="merge-card__head">
              <div class="merge-card__title">
                <el-tag size="small" effect="plain">{{ item.name }}</el-tag>
              </div>
              <div class="merge-card__actions">
                <el-button size="small" text @click="resolveAllProfileFields(item.key, 'local')">
                  全部保留本队
                </el-button>
                <el-button size="small" text type="primary" @click="resolveAllProfileFields(item.key, 'incoming')">
                  全部采用分包
                </el-button>
              </div>
            </div>
            <el-table :data="item.fields" size="small" border>
              <el-table-column label="项" width="150">
                <template #default="{ row }">
                  {{ profileFieldLabels[row.key] ?? row.label }}
                </template>
              </el-table-column>
              <el-table-column label="本队" min-width="240">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.local) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="分包" min-width="240">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.incoming) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="确认" width="220" align="center">
                <template #default="{ row }">
                  <template v-if="row.conflict">
                    <el-radio-group
                      :model-value="chosenFieldSide(item.key, row)"
                      size="small"
                      @change="(v: MergeSide) => chooseField(item.key, row, v)"
                    >
                      <el-radio-button value="local">本队</el-radio-button>
                      <el-radio-button value="incoming">分包</el-radio-button>
                    </el-radio-group>
                  </template>
                  <el-tag v-else size="small" type="info" effect="plain">一致</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
        <p v-else class="panel__hint">没有同名权重方案的冲突。</p>

        <el-table
          v-if="incomingProfiles.length"
          :data="incomingProfiles"
          size="small"
          border
          style="margin-top: 10px"
        >
          <el-table-column label="接收" width="80" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="isIncluded(row.key)"
                @update:model-value="(v: boolean) => setInclude(row.key, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="新方案名" min-width="180">
            <template #default="{ row }">{{ row.incoming?.name }}</template>
          </el-table-column>
          <el-table-column label="季节" width="100">
            <template #default="{ row }">{{ row.incoming?.season }}</template>
          </el-table-column>
          <el-table-column label="启用状态" width="100">
            <template #default="{ row }">
              <el-tag v-if="row.incoming?.active" type="warning" size="small">将启用</el-tag>
              <span v-else class="muted">不启用</span>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="220">
            <template #default="{ row }">{{ row.incoming?.note || '—' }}</template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 风险否决 -->
      <section class="panel">
        <div class="panel__head">
          <h2>风险否决合并</h2>
          <span class="weight-note">按「营位编号 + 否决类型」判重；本地已有同类型记录时不会重复登记</span>
        </div>

        <div v-if="bothVetoItems.length" class="factor-list">
          <div v-for="item in bothVetoItems" :key="item.key" class="merge-card">
            <div class="merge-card__head">
              <div class="merge-card__title">
                <el-tag size="small" type="danger" effect="plain">{{ item.siteCode }}</el-tag>
                <strong>同一否决类型两边记录不同：{{ item.local?.type }}</strong>
              </div>
              <el-radio-group
                :model-value="itemSide(item.key)"
                size="small"
                @change="(v: MergeSide) => chooseItem(item.key, v)"
              >
                <el-radio-button value="local">保留本队记录</el-radio-button>
                <el-radio-button value="incoming">补登分包记录</el-radio-button>
              </el-radio-group>
            </div>
            <el-table :data="item.fields.filter((f) => f.key !== 'type')" size="small" border>
              <el-table-column label="项" width="120">
                <template #default="{ row }">{{ vetoFieldLabels[row.key] ?? row.label }}</template>
              </el-table-column>
              <el-table-column label="本队" min-width="220">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.local) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="分包" min-width="220">
                <template #default="{ row }">
                  <span :class="{ 'val-conflict': row.conflict }">{{ fmt(row.key, row.incoming) }}</span>
                </template>
              </el-table-column>
            </el-table>
            <p class="panel__hint">选择「补登分包记录」会在该营位下新增一条否决记录，本队原记录继续保留。</p>
          </div>
        </div>

        <el-table
          v-if="incomingVetoItems.length"
          :data="incomingVetoItems"
          size="small"
          border
          style="margin-top: 10px"
        >
          <el-table-column label="接收" width="80" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="isIncluded(row.key)"
                @update:model-value="(v: boolean) => setInclude(row.key, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="营位" width="140">
            <template #default="{ row }">
              <el-tag size="small" type="danger" effect="plain">{{ row.siteCode }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="否决类型" width="120">
            <template #default="{ row }">
              <el-tag size="small" type="danger">{{ row.incoming?.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="260">
            <template #default="{ row }">{{ row.incoming?.description }}</template>
          </el-table-column>
          <el-table-column label="判定人" width="110">
            <template #default="{ row }">{{ row.incoming?.judge }}</template>
          </el-table-column>
          <el-table-column label="判定日期" width="110">
            <template #default="{ row }">{{ row.incoming?.judgedAt }}</template>
          </el-table-column>
        </el-table>
        <p v-if="!bothVetoItems.length && !incomingVetoItems.length" class="panel__hint">
          没有需要新增或对照的否决记录。
        </p>
      </section>

      <!-- 底部提交栏 -->
      <section class="panel commit-bar">
        <div class="commit-bar__info">
          <el-tag v-if="stats.unresolved" type="danger" size="small">
            还有 {{ stats.unresolved }} 处冲突待确认
          </el-tag>
          <el-tag v-else type="success" size="small">冲突已全部确认</el-tag>
          <el-tag v-if="capacityBlocked" type="danger" size="small">容量未通过，写入将被拒绝</el-tag>
          <el-tag v-else type="success" size="small">容量校验通过</el-tag>
          <span class="weight-note">
            草稿自动保存于本地浏览器，写入失败或关闭页面后可恢复；旧勘察记录写入后继续保留。
          </span>
        </div>
        <div class="commit-bar__actions">
          <el-button @click="resetSession">放弃合并</el-button>
          <el-button
            type="primary"
            :disabled="!canCommit"
            :loading="committing"
            @click="commit"
          >
            确认写入本地库
          </el-button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.import-zone {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0 6px;
}
.pkg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.merge-card {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 14px;
  background: #fff;
}
.merge-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.merge-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.merge-card__actions {
  display: flex;
  gap: 4px;
}
.val-conflict {
  color: var(--gb-danger);
  font-weight: 600;
}
.cell-sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.cap-edit {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cap-danger {
  color: var(--gb-danger);
}
.cap-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.factor-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.commit-bar {
  position: sticky;
  bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  box-shadow: 0 6px 20px rgba(21, 128, 61, 0.08);
}
.commit-bar__info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.commit-bar__actions {
  display: flex;
  gap: 8px;
}
:deep(.cap-row--over) {
  background: #fff4f4 !important;
}
:deep(.cap-row--missing) {
  background: #fff8eb !important;
}
</style>

