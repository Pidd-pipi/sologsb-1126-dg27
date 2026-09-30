<script setup lang="ts">
/**
 * `/merge` 勘察包合并 —— 联合勘察队分头离线编录，回来后合并勘察包。
 *
 * 流程：导出当前库为勘察包（JSON）→ 离线编录 → 导入包 →
 * 按营位编号合并基础信息、最新因子评估、权重方案与风险否决；
 * 同一项两边都改过时并排列出，人工确认后才写库；
 * 合并后帐篷数超过营地容量上限则拒绝写入并保留草稿。
 * 确认写入后权重变化即重算排名、等级与地图标记，旧勘察记录继续保留。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import ConflictFields from '@/components/merge/ConflictFields.vue'
import { useMergeStore } from '@/stores/mergeStore'
import type { MergeStatus } from '@/utils/merge'
import { NORMALIZE_LABELS } from '@/types/score'
import type { NormalizeMethod } from '@/types/score'
import { todayIso, formatDateTime } from '@/utils/format'

const router = useRouter()
const mergeStore = useMergeStore()

const exportForm = ref({ packageName: `勘察包-${todayIso()}`, team: '' })
const importText = ref('')
const importing = ref(false)
const activeTab = ref('sites')
const conflictsOnly = ref(false)

onMounted(async () => {
  await mergeStore.loadCapacities()
  if (mergeStore.hasDraft) {
    ElMessage.info('检测到上次未写入的合并草稿，可点击「恢复草稿」继续处理')
  }
})

const hasPlan = computed(() => mergeStore.plan != null)

const statusMeta: Record<MergeStatus, { type: 'info' | 'success' | 'warning' | 'danger'; text: string }> = {
  unchanged: { type: 'info', text: '无变化' },
  added: { type: 'success', text: '新增' },
  auto: { type: 'warning', text: '自动合并' },
  conflict: { type: 'danger', text: '待确认' }
}

const siteMerges = computed(() => {
  const rows = mergeStore.plan?.campsites ?? []
  return conflictsOnly.value ? rows.filter((m) => m.status === 'conflict') : rows
})
const profileMerges = computed(() => {
  const rows = mergeStore.plan?.profiles ?? []
  return conflictsOnly.value ? rows.filter((m) => m.status === 'conflict') : rows
})
const capacityMerges = computed(() => {
  const rows = mergeStore.plan?.capacities ?? []
  return conflictsOnly.value ? rows.filter((m) => m.status === 'conflict') : rows
})

async function doExport(): Promise<void> {
  if (!exportForm.value.packageName.trim()) {
    ElMessage.warning('请填写勘察包名称')
    return
  }
  await mergeStore.exportPackage({
    packageName: exportForm.value.packageName.trim(),
    team: exportForm.value.team.trim() || '未署名'
  })
  ElMessage.success('勘察包已导出（含当前库快照与基准），可发给离线勘察队')
}

function onFileChange(file: UploadFile): void {
  const raw = file.raw
  if (!raw) return
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result ?? '')
  }
  reader.readAsText(raw)
}

async function doImport(): Promise<void> {
  if (!importText.value.trim()) {
    ElMessage.warning('请先选择勘察包文件或粘贴勘察包 JSON')
    return
  }
  importing.value = true
  try {
    const ok = await mergeStore.importPackage(importText.value)
    if (ok) {
      ElMessage.success('勘察包已导入并生成合并计划，请逐项确认冲突后写入')
    } else {
      ElMessage.error(mergeStore.error ||('导入失败'))
    }
  } finally {
    importing.value = false
  }
}

async function doRestore(): Promise<void> {
  const ok = await mergeStore.restoreDraft()
  if (ok) {
    ElMessage.success('已恢复上次未写入的合并草稿')
  } else {
    ElMessage.info('没有可恢复的草稿')
  }
}

function doDiscard(): void {
  mergeStore.discardDraft()
  importText.value = ''
  ElMessage.info('合并草稿已清除')
}

async function doApply(): Promise<void> {
  const result = await mergeStore.applyMerge()
  if (result.ok) {
    ElMessage.success(result.message)
    importText.value = ''
  } else {
    ElMessage.error(result.message)
  }
}

function fmtValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function normalizeLabel(value: unknown): string {
  return NORMALIZE_LABELS[(value as NormalizeMethod) ?? 'minmax'] ?? '—'
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>勘察包合并</h1>
        <p>
          联合勘察队分头离线编录，回来后合并勘察包。按营位编号合并基础信息、最新因子评估、权重方案与风险否决；
          同一项两边都改过时并排列出，人工确认后才写库。合并后帐篷数超过营地容量上限将拒绝写入并保留草稿。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="合并规则"
      description="按营位编号（code）匹配：只改一边的字段自动合并；两边都改过的字段标记为「待确认」，并排显示本地与包内的值，由你确认采用哪一侧。因子与否决记录只增补不删除，旧轮次/旧记录全部保留。"
    />

    <!-- 导出 / 导入 -->
    <div class="merge-grid">
      <section class="panel">
        <div class="panel__head">
          <h2>① 导出勘察包</h2>
        </div>
        <p class="panel__hint">
          把当前库（营位、因子、方案、否决、容量表）导出为 JSON，离线勘察队带出编录后再带回合并。
        </p>
        <el-form label-width="92px" @submit.prevent>
          <el-form-item label="勘察包名称">
            <el-input v-model="exportForm.packageName" placeholder="如 云栖山谷-北坡队 离线包" />
          </el-form-item>
          <el-form-item label="编制队/人">
            <el-input v-model="exportForm.team" placeholder="如 北坡勘察队" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="doExport">导出勘察包（下载 JSON）</el-button>
          </el-form-item>
        </el-form>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2>② 导入并合并</h2>
          <el-tag v-if="mergeStore.hasDraft" type="warning" size="small">有未写入草稿</el-tag>
        </div>
        <el-form label-width="92px" @submit.prevent>
          <el-form-item label="勘察包文件">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              :on-change="onFileChange"
              accept="application/json,.json"
            >
              <el-button>选择 JSON 文件</el-button>
            </el-upload>
          </el-form-item>
          <el-form-item label="或粘贴内容">
            <el-input
              v-model="importText"
              type="textarea"
              :rows="4"
              placeholder="也可直接把勘察包 JSON 粘贴到这里"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="importing" @click="doImport">
              导入并生成合并计划
            </el-button>
            <el-button v-if="mergeStore.hasDraft" @click="doRestore">恢复草稿</el-button>
            <el-button v-if="mergeStore.hasDraft" @click="doDiscard">清除草稿</el-button>
          </el-form-item>
        </el-form>
        <el-alert
          v-if="mergeStore.error"
          type="error"
          :closable="false"
          show-icon
          :title="mergeStore.error"
        />
      </section>
    </div>

    <!-- 合并计划 -->
    <template v-if="hasPlan && mergeStore.plan">
      <div class="stat-row">
        <div class="stat-card">
          <div class="stat-card__label">新增营位</div>
          <div class="stat-card__value">{{ mergeStore.plan.counts.addedSites }}</div>
          <div class="stat-card__extra">包内独有，将登记入库</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">自动合并</div>
          <div class="stat-card__value">{{ mergeStore.plan.counts.updatedSites }}</div>
          <div class="stat-card__extra">仅一方改动的营位</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">待确认冲突</div>
          <div class="stat-card__value" :style="{ color: mergeStore.conflictCount ? '#b91c1c' : undefined }">
            {{ mergeStore.conflictCount }}
          </div>
          <div class="stat-card__extra">两边都改过的字段</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">新增因子轮次</div>
          <div class="stat-card__value">{{ mergeStore.plan.counts.addedFactors }}</div>
          <div class="stat-card__extra">旧轮次保留，取最新一轮评分</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">新增否决</div>
          <div class="stat-card__value">{{ mergeStore.plan.counts.addedVetos }}</div>
          <div class="stat-card__extra">旧记录保留</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">容量状态</div>
          <div class="stat-card__value" :style="{ color: mergeStore.capacityBlocked ? '#b91c1c' : '#15803d' }">
            {{ mergeStore.capacityBlocked ? '超限' : '正常' }}
          </div>
          <div class="stat-card__extra">{{ mergeStore.plan.capacityByCamp.length }} 个营地</div>
        </div>
      </div>

      <el-alert
        v-if="mergeStore.capacityBlocked"
        type="error"
        :closable="false"
        show-icon
        title="合并后帐篷数超过营地容量上限，已拒绝写入并保留草稿"
        :description="mergeStore.plan.capacityIssues
          .map((i) => `${i.campName}：容量 ${i.capacity} 帐，合并后 ${i.mergedTotal} 帐（超 ${i.over} 帐，涉及 ${i.siteCodes.join('、')}）`)
          .join(' ｜ ')"
      />

      <section class="panel">
        <div class="panel__head">
          <h2>合并明细</h2>
          <el-checkbox v-model="conflictsOnly">只看待确认冲突</el-checkbox>
        </div>

        <el-tabs v-model="activeTab">
          <!-- 营位 -->
          <el-tab-pane name="sites">
            <template #label>
              营位
              <el-badge v-if="mergeStore.plan.counts.conflictSites" :value="mergeStore.plan.counts.conflictSites" class="tab-badge" type="danger" />
            </template>
            <div v-if="!siteMerges.length" class="empty-line">没有需要合并的营位。</div>
            <div v-for="m in siteMerges" :key="m.code" class="merge-card" :class="{ 'merge-card--conflict': m.status === 'conflict' }">
              <div class="merge-card__head">
                <div class="merge-card__title">
                  <strong>{{ m.code }}</strong>
                  <span>{{ m.name }}</span>
                  <span class="muted">{{ m.campName }}</span>
                  <el-tag :type="statusMeta[m.status].type" size="small">{{ statusMeta[m.status].text }}</el-tag>
                </div>
                <div v-if="m.status === 'conflict'" class="merge-card__actions">
                  <el-button size="small" @click="mergeStore.setAllResolution('site', m.code, 'local')">全部采用本地</el-button>
                  <el-button size="small" type="primary" plain @click="mergeStore.setAllResolution('site', m.code, 'incoming')">全部采用包内</el-button>
                </div>
              </div>

              <ConflictFields
                v-if="m.conflicts.length"
                :conflicts="m.conflicts"
                kind="site"
                :merge-key="m.code"
              />

              <details v-if="m.autoChanges.length" class="auto-changes">
                <summary>自动合并的变更（{{ m.autoChanges.length }} 项，仅一方改动）</summary>
                <ul>
                  <li v-for="c in m.autoChanges" :key="c.field">
                    {{ c.label }}：{{ fmtValue(c.from) }} → <strong>{{ fmtValue(c.to) }}</strong>
                  </li>
                </ul>
              </details>

              <div v-if="m.status === 'added'" class="merge-card__added">
                包内新增营位：{{ m.incoming?.code }} · {{ m.incoming?.name }} · {{ m.incoming?.campName }} ·
                容 {{ m.incoming?.tentCapacity }} 帐 · {{ m.incoming?.surface }} · {{ m.incoming?.access }}
              </div>
              <div v-else-if="m.status === 'unchanged'" class="merge-card__same">两边一致，无变化。</div>
            </div>
          </el-tab-pane>

          <!-- 因子评估 -->
          <el-tab-pane name="factors">
            <template #label>因子评估</template>
            <el-table v-if="mergeStore.plan.factors.length" :data="mergeStore.plan.factors" size="small" border stripe>
              <el-table-column label="营位编号" prop="siteCode" width="120" />
              <el-table-column label="营位名称" min-width="180">
                <template #default="{ row }">{{ row.siteName }} <span class="muted">· {{ row.campName }}</span></template>
              </el-table-column>
              <el-table-column label="包内轮次" prop="incomingCount" width="90" align="center" />
              <el-table-column label="将新增" prop="newCount" width="80" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.newCount" type="success" size="small">+{{ row.newCount }}</el-tag>
                  <span v-else class="muted">0</span>
                </template>
              </el-table-column>
              <el-table-column label="包内最新评估" min-width="260">
                <template #default="{ row }">
                  {{ row.latestAssessedAt }} · {{ row.latestAssessor }} · {{ row.latestSummary }}
                </template>
              </el-table-column>
            </el-table>
            <p v-else class="empty-line">包内没有因子评估记录。</p>
            <p class="panel__hint">因子记录为追加日志：仅新增去重后的轮次，旧轮次全部保留；评分时自动取最新一轮。</p>
          </el-tab-pane>

          <!-- 风险否决 -->
          <el-tab-pane name="vetos">
            <template #label>风险否决</template>
            <el-table v-if="mergeStore.plan.vetos.length" :data="mergeStore.plan.vetos" size="small" border stripe>
              <el-table-column label="营位编号" prop="siteCode" width="120" />
              <el-table-column label="营位名称" min-width="180">
                <template #default="{ row }">{{ row.siteName }} <span class="muted">· {{ row.campName }}</span></template>
              </el-table-column>
              <el-table-column label="包内条数" prop="incomingCount" width="90" align="center" />
              <el-table-column label="将新增" prop="newCount" width="80" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.newCount" type="danger" size="small">+{{ row.newCount }}</el-tag>
                  <span v-else class="muted">0</span>
                </template>
              </el-table-column>
              <el-table-column label="否决类型" min-width="200">
                <template #default="{ row }">
                  <el-tag v-for="t in row.types" :key="t" type="danger" size="small" class="mr6">{{ t }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
            <p v-else class="empty-line">包内没有风险否决记录。</p>
            <p class="panel__hint">否决记录为追加日志：仅新增去重后的记录，旧记录保留；命中否决即标红并降为 C 级。</p>
          </el-tab-pane>

          <!-- 权重方案 -->
          <el-tab-pane name="profiles">
            <template #label>
              权重方案
              <el-badge v-if="mergeStore.plan.counts.conflictProfiles" :value="mergeStore.plan.counts.conflictProfiles" class="tab-badge" type="danger" />
            </template>
            <div v-if="!profileMerges.length" class="empty-line">没有需要合并的权重方案。</div>
            <div v-for="m in profileMerges" :key="m.key" class="merge-card" :class="{ 'merge-card--conflict': m.status === 'conflict' }">
              <div class="merge-card__head">
                <div class="merge-card__title">
                  <strong>{{ m.key }}</strong>
                  <el-tag :type="statusMeta[m.status].type" size="small">{{ statusMeta[m.status].text }}</el-tag>
                  <span v-if="m.resolved.active" class="muted">· 启用中</span>
                </div>
                <div v-if="m.status === 'conflict'" class="merge-card__actions">
                  <el-button size="small" @click="mergeStore.setAllResolution('profile', m.key, 'local')">全部采用本地</el-button>
                  <el-button size="small" type="primary" plain @click="mergeStore.setAllResolution('profile', m.key, 'incoming')">全部采用包内</el-button>
                </div>
              </div>
              <ConflictFields
                v-if="m.conflicts.length"
                :conflicts="m.conflicts"
                kind="profile"
                :merge-key="m.key"
              />
              <details v-if="m.autoChanges.length" class="auto-changes">
                <summary>自动合并的变更（{{ m.autoChanges.length }} 项）</summary>
                <ul>
                  <li v-for="c in m.autoChanges" :key="c.field">
                    {{ c.label }}：{{ fmtValue(c.from) }} → <strong>{{ fmtValue(c.to) }}</strong>
                  </li>
                </ul>
              </details>
              <div v-if="m.status === 'added'" class="merge-card__added">
                包内新增方案：归一 {{ normalizeLabel(m.resolved.normalize) }} ·
                阈值 A ≥ {{ m.resolved.thresholds.gradeA }} / B ≥ {{ m.resolved.thresholds.gradeB }} ·
                适用 {{ m.resolved.season }}
              </div>
              <div v-else-if="m.status === 'unchanged'" class="merge-card__same">两边一致，无变化。</div>
            </div>
          </el-tab-pane>

          <!-- 营地容量 -->
          <el-tab-pane name="capacities">
            <template #label>营地容量</template>
            <div v-if="!capacityMerges.length" class="empty-line">没有需要合并的营地容量。</div>
            <div v-for="m in capacityMerges" :key="m.campName" class="merge-card">
              <div class="merge-card__head">
                <div class="merge-card__title">
                  <strong>{{ m.campName }}</strong>
                  <el-tag :type="statusMeta[m.status].type" size="small">{{ statusMeta[m.status].text }}</el-tag>
                </div>
                <div v-if="m.status === 'conflict'" class="merge-card__actions">
                  <el-button size="small" @click="mergeStore.setAllResolution('capacity', m.campName, 'local')">全部采用本地</el-button>
                  <el-button size="small" type="primary" plain @click="mergeStore.setAllResolution('capacity', m.campName, 'incoming')">全部采用包内</el-button>
                </div>
              </div>
              <ConflictFields
                v-if="m.conflicts.length"
                :conflicts="m.conflicts"
                kind="capacity"
                :merge-key="m.campName"
              />
              <div class="capacity-value">
                合并后容量上限：<strong>{{ m.resolved.tentCapacity }}</strong> 帐
                <span class="muted">· {{ m.resolved.note }}</span>
              </div>
            </div>
          </el-tab-pane>

          <!-- 容量校验 -->
          <el-tab-pane name="capacity-check">
            <template #label>容量校验</template>
            <el-table :data="mergeStore.plan.capacityByCamp" size="small" border stripe>
              <el-table-column label="营地" prop="campName" min-width="160" />
              <el-table-column label="容量上限（帐）" width="130" align="center">
                <template #default="{ row }">
                  <strong v-if="row.capacity != null">{{ row.capacity }}</strong>
                  <span v-else class="muted">未登记</span>
                </template>
              </el-table-column>
              <el-table-column label="合并后帐篷数（帐）" width="170" align="center">
                <template #default="{ row }">
                  <strong :style="{ color: row.over ? '#b91c1c' : '#15803d' }">{{ row.mergedTotal }}</strong>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.over" type="danger" size="small">超限 {{ row.over }}</el-tag>
                  <el-tag v-else type="success" size="small">正常</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="涉及营位" min-width="220">
                <template #default="{ row }">
                  <span v-for="code in row.siteCodes" :key="code" class="site-chip">{{ code }}</span>
                </template>
              </el-table-column>
            </el-table>
            <p class="panel__hint">
              容量上限来自「营地容量表」；合并后同一营地名下各营位可容帐篷数之和不得超过该上限。
              超限时拒绝写入并保留草稿，可调整营位帐篷数或容量后重新提交。
            </p>
          </el-tab-pane>
        </el-tabs>
      </section>

      <!-- 写入操作 -->
      <section class="panel merge-actions">
        <div class="merge-actions__info">
          <span>勘察包：{{ mergeStore.plan.packageName }} · {{ mergeStore.plan.team }} · 导出于 {{ formatDateTime(mergeStore.plan.exportedAt) }}</span>
          <span v-if="mergeStore.capacityBlocked" class="merge-actions__block">容量超限，已拒绝写入并保留草稿</span>
          <span v-else class="merge-actions__ok">冲突已确认，容量校验通过，可写入</span>
        </div>
        <el-button
          type="primary"
          size="large"
          :loading="mergeStore.applying"
          :disabled="mergeStore.capacityBlocked"
          @click="doApply"
        >
          确认写入合并结果
        </el-button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.merge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 16px;
  align-items: start;
}
.merge-card {
  padding: 12px 14px;
  margin-bottom: 10px;
  background: var(--gb-surface);
  border: 1px solid var(--gb-line);
  border-radius: 10px;
}
.merge-card--conflict {
  background: #fff8f8;
  border-color: #f3d6d6;
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
  flex-wrap: wrap;
  font-size: 14px;
}
.merge-card__actions {
  display: flex;
  gap: 6px;
}
.merge-card__added {
  margin-top: 6px;
  font-size: 12px;
  color: var(--gb-accent-strong);
}
.merge-card__same {
  margin-top: 4px;
  font-size: 12px;
  color: var(--gb-muted);
}
.auto-changes {
  margin-top: 6px;
  font-size: 12px;
  color: var(--gb-muted);
}
.auto-changes summary {
  cursor: pointer;
  color: var(--gb-warn);
}
.auto-changes ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.capacity-value {
  margin-top: 8px;
  font-size: 13px;
}
.empty-line {
  padding: 18px;
  text-align: center;
  color: var(--gb-muted);
  font-size: 13px;
}
.tab-badge {
  margin-left: 4px;
}
.mr6 {
  margin-right: 6px;
}
.site-chip {
  display: inline-block;
  margin: 2px 4px 2px 0;
  padding: 1px 8px;
  font-size: 11px;
  background: var(--gb-surface);
  border: 1px solid var(--gb-line);
  border-radius: 6px;
}
.merge-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.merge-actions__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-actions__block {
  color: var(--gb-danger);
  font-weight: 600;
}
.merge-actions__ok {
  color: var(--gb-accent-strong);
}
</style>
