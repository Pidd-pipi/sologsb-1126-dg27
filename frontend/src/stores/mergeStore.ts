/**
 * 勘察包合并的本地状态与写入逻辑。
 *
 * 流程：导出当前库为勘察包（JSON）→ 离线方带出编录 → 回来导入包 →
 * 引擎按营位编号做三路合并并列出冲突 → 人工逐项确认 →
 * 容量校验通过后事务写库（因子与否决只增补不删除，旧记录保留）。
 *
 * 容量超限时**不写库**，并把勘察包与人工选择保留到 localStorage 草稿，
 * 调整后可继续提交（对应「拒绝写入并保留草稿」）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import {
  buildMergePlan,
  buildSurveyPackage,
  factorFingerprint,
  isSurveyPackage,
  vetoFingerprint,
  type LocalData,
  type MergePlan,
  type ResolutionMap,
  type SurveyPackage
} from '@/utils/merge'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { ScoreProfile } from '@/types/score'
import type { RiskVeto } from '@/types/veto'
import type { CampCapacity } from '@/types/capacity'
import { nowIso } from '@/utils/format'
import { clearDraft, loadDraft, saveDraft } from '@/utils/draft'
import { useSiteStore } from './siteStore'
import { useProfileStore } from './profileStore'
import { useUiStore } from './uiStore'

const MERGE_DRAFT_KEY = 'merge-package'

interface MergeDraft {
  pkg: SurveyPackage
  resolutions: ResolutionMap
}

export const useMergeStore = defineStore('merge', () => {
  const capacities = ref<CampCapacity[]>([])
  const loading = ref(false)

  const pkg = ref<SurveyPackage | null>(null)
  const plan = ref<MergePlan | null>(null)
  const resolutions = ref<ResolutionMap>({})
  /** 导入时缓存的本地数据快照，供同步重算合并计划 */
  const localBase = ref<LocalData | null>(null)

  const importing = ref(false)
  const applying = ref(false)
  const error = ref('')

  const hasDraft = computed(() => loadDraft<MergeDraft>(MERGE_DRAFT_KEY) != null)

  const hasPackage = computed(() => pkg.value != null)
  const conflictCount = computed(() => {
    const p = plan.value
    if (!p) return 0
    return p.campsites.filter((m) => m.status === 'conflict').length +
      p.profiles.filter((m) => m.status === 'conflict').length
  })
  const capacityBlocked = computed(() => (plan.value?.capacityIssues.length ?? 0) > 0)

  async function loadCapacities(): Promise<void> {
    loading.value = true
    try {
      capacities.value = await db.campCapacities.orderBy('campName').toArray()
    } finally {
      loading.value = false
    }
  }

  async function readLocalData(): Promise<LocalData> {
    const [campsites, factors, profiles, vetos, campCapacities] = await Promise.all([
      db.sites.toArray(),
      db.factors.toArray(),
      db.profiles.toArray(),
      db.vetos.toArray(),
      db.campCapacities.toArray()
    ])
    return { campsites, factors, profiles, vetos, campCapacities }
  }

  function recompute(): void {
    if (!pkg.value || !localBase.value) {
      plan.value = null
      return
    }
    plan.value = buildMergePlan(localBase.value, pkg.value, resolutions.value)
  }

  function persistDraft(): void {
    if (!pkg.value) return
    const draft: MergeDraft = { pkg: pkg.value, resolutions: resolutions.value }
    saveDraft(MERGE_DRAFT_KEY, draft)
  }

  /** 导出当前库为勘察包并触发下载。 */
  async function exportPackage(meta: { packageName: string; team: string }): Promise<SurveyPackage> {
    const local = await readLocalData()
    const surveyPkg = buildSurveyPackage(local, meta)
    const blob = new Blob([JSON.stringify(surveyPkg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${surveyPkg.packageName || '勘察包'}.gbcampsite.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    return surveyPkg
  }

  /** 导入勘察包 JSON：校验 → 建合并计划 → 存草稿。 */
  async function importPackage(jsonText: string): Promise<boolean> {
    error.value = ''
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      error.value = '勘察包不是合法 JSON，请检查文件内容。'
      return false
    }
    if (!isSurveyPackage(parsed)) {
      error.value = '勘察包格式不正确：缺少 format 标记或必要的营位/因子/方案/否决/容量表。'
      return false
    }
    const local = await readLocalData()
    localBase.value = local
    pkg.value = parsed
    resolutions.value = {}
    recompute()
    persistDraft()
    return true
  }

  /** 恢复上次未写入的合并草稿（容量超限时保留的就是它）。 */
  async function restoreDraft(): Promise<boolean> {
    const draft = loadDraft<MergeDraft>(MERGE_DRAFT_KEY)
    if (!draft) return false
    const local = await readLocalData()
    localBase.value = local
    pkg.value = draft.pkg
    resolutions.value = draft.resolutions ?? {}
    recompute()
    return true
  }

  function discardDraft(): void {
    clearDraft(MERGE_DRAFT_KEY)
    pkg.value = null
    plan.value = null
    resolutions.value = {}
    localBase.value = null
    error.value = ''
  }

  /** 人工选择某冲突字段采用哪一侧。 */
  function setResolution(kind: 'site' | 'profile' | 'capacity', key: string, field: string, choice: 'local' | 'incoming'): void {
    const next: ResolutionMap = {
      ...resolutions.value,
      [`${kind}:${key}:${field}`]: choice
    }
    resolutions.value = next
    recompute()
    persistDraft()
  }

  /** 批量选择某营位/方案/容量的全部冲突字段采用同一侧。 */
  function setAllResolution(kind: 'site' | 'profile' | 'capacity', key: string, choice: 'local' | 'incoming'): void {
    if (!plan.value) return
    const next: ResolutionMap = { ...resolutions.value }
    let target: { conflicts: { field: string }[] } | undefined
    if (kind === 'site') {
      target = plan.value.campsites.find((m) => m.code === key)
    } else if (kind === 'profile') {
      target = plan.value.profiles.find((m) => m.key === key)
    } else {
      target = plan.value.capacities.find((m) => m.campName === key)
    }
    if (!target) return
    for (const c of target.conflicts) {
      next[`${kind}:${key}:${c.field}`] = choice
    }
    resolutions.value = next
    recompute()
    persistDraft()
  }

  /** 确认写入：容量校验通过后事务写库，因子与否决只增补不删除。 */
  async function applyMerge(): Promise<{ ok: boolean; message: string }> {
    if (!pkg.value || !plan.value) return { ok: false, message: '尚未导入勘察包' }
    if (plan.value.capacityIssues.length > 0) {
      // 容量超限：拒绝写入，保留草稿
      persistDraft()
      return {
        ok: false,
        message: `合并后帐篷数超过营地容量上限（${plan.value.capacityIssues
          .map((i) => `${i.campName} 超 ${i.over} 帐`)
          .join('；')}），已保留草稿，请调整营位帐篷数或容量后再提交。`
      }
    }
    applying.value = true
    try {
      const now = nowIso()
      await db.transaction(
        'rw',
        db.sites,
        db.factors,
        db.profiles,
        db.vetos,
        db.campCapacities,
        async () => {
          // 1. 营位：新增的 add，匹配上的（含冲突/自动合并）update
          for (const m of plan.value!.campsites) {
            if (m.status === 'added') {
              const rec = toPlain({ ...m.resolved }) as Campsite
              delete rec.id
              // defaultProfileId 指向包内库的方案 id，合并后会失效，置空由系统按启用方案评分
              rec.defaultProfileId = null
              rec.createdAt = now
              rec.updatedAt = now
              await db.sites.add(rec)
            } else if (m.local && (m.status === 'conflict' || m.status === 'auto')) {
              const rec = toPlain({ ...m.resolved }) as Campsite
              await db.sites.update(m.local.id!, { ...rec, id: m.local.id, updatedAt: now })
            }
          }

          // 2. 建立 营位编号 → 本地 id 映射（含新增营位）
          const allSites = await db.sites.toArray()
          const codeToId = new Map(allSites.map((s) => [s.code, s.id!]))

          // 3. 因子评估：只增补去重后的新轮次，旧轮次全部保留
          const incomingSiteIdToCode = new Map(pkg.value!.campsites.map((s) => [s.id, s.code]))
          const existingFactorFps = new Set(
            (await db.factors.toArray()).map((f) => {
              const code = allSites.find((s) => s.id === f.siteId)?.code ?? ''
              return factorFingerprint(f, code || `__unknown_${f.siteId}`)
            })
          )
          for (const f of pkg.value!.factors) {
            const code = incomingSiteIdToCode.get(f.siteId)
            const siteId = code ? codeToId.get(code) : undefined
            if (siteId == null || !code) continue
            const fp = factorFingerprint(f, code)
            if (existingFactorFps.has(fp)) continue
            const rec = toPlain({ ...f, siteId }) as FactorAssessment
            delete rec.id
            rec.createdAt = now
            rec.updatedAt = now
            await db.factors.add(rec)
            existingFactorFps.add(fp)
          }

          // 4. 风险否决：只增补去重后的新记录，旧记录保留
          const existingVetoFps = new Set(
            (await db.vetos.toArray()).map((v) => {
              const code = allSites.find((s) => s.id === v.siteId)?.code ?? ''
              return vetoFingerprint(v, code || `__unknown_${v.siteId}`)
            })
          )
          for (const v of pkg.value!.vetos) {
            const code = incomingSiteIdToCode.get(v.siteId)
            const siteId = code ? codeToId.get(code) : undefined
            if (siteId == null || !code) continue
            const fp = vetoFingerprint(v, code)
            if (existingVetoFps.has(fp)) continue
            const rec = toPlain({ ...v, siteId }) as RiskVeto
            delete rec.id
            rec.createdAt = now
            rec.updatedAt = now
            await db.vetos.add(rec)
            existingVetoFps.add(fp)
          }

          // 5. 权重方案：新增的 add，匹配上的 update
          for (const m of plan.value!.profiles) {
            if (m.status === 'added') {
              const rec = toPlain({ ...m.resolved }) as ScoreProfile
              delete rec.id
              rec.createdAt = now
              rec.updatedAt = now
              await db.profiles.add(rec)
            } else if (m.local && m.status !== 'unchanged') {
              const rec = toPlain({ ...m.resolved }) as ScoreProfile
              await db.profiles.update(m.local.id!, { ...rec, id: m.local.id, updatedAt: now })
            }
          }

          // 6. 营地容量：新增的 add，匹配上的 update
          for (const m of plan.value!.capacities) {
            if (m.status === 'added') {
              const rec = toPlain({ ...m.resolved }) as CampCapacity
              delete rec.id
              rec.updatedAt = now
              await db.campCapacities.add(rec)
            } else if (m.local && m.status !== 'unchanged') {
              const rec = toPlain({ ...m.resolved }) as CampCapacity
              await db.campCapacities.update(m.local.id!, { ...rec, id: m.local.id, updatedAt: now })
            }
          }
        }
      )

      // 7. 刷新各 store，名次/等级/地图标记随权重变化自动重算
      const siteStore = useSiteStore()
      const profileStore = useProfileStore()
      const uiStore = useUiStore()
      await Promise.all([siteStore.load(), profileStore.load(), uiStore.loadVetos(), loadCapacities()])

      // 若包内启用方案在合并后存在，则切换为启用，让新权重立即生效
      const incomingActive = pkg.value.profiles.find((p) => p.active)
      if (incomingActive) {
        const merged = profileStore.list.find((p) => p.name === incomingActive.name)
        if (merged && typeof merged.id === 'number' && !merged.active) {
          await profileStore.activate(merged.id)
        }
      }

      clearDraft(MERGE_DRAFT_KEY)
      return { ok: true, message: '勘察包已合并写入，旧勘察记录已保留，名次/等级/地图已按新权重重算。' }
    } catch (err) {
      // 写入异常也保留草稿，便于排查后重试
      persistDraft()
      return {
        ok: false,
        message: `写入失败，已保留草稿：${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      applying.value = false
    }
  }

  return {
    capacities,
    loading,
    pkg,
    plan,
    resolutions,
    importing,
    applying,
    error,
    hasDraft,
    hasPackage,
    conflictCount,
    capacityBlocked,
    loadCapacities,
    exportPackage,
    importPackage,
    restoreDraft,
    discardDraft,
    setResolution,
    setAllResolution,
    applyMerge
  }
})
