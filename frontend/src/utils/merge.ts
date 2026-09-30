/**
 * 勘察包合并引擎（纯函数 + 一个事务化提交函数）。
 *
 * 离线分头编录没有共同祖先快照，因此采用「按业务键逐字段二选一」的两路合并：
 *   - 同一项两边都改出差异的字段并排列出（conflict），等人逐项确认后才写库；
 *   - 只有一方有值的字段自动并入（same / localOnly / incomingOnly）；
 *   - 因子评估是「多轮勘察记录」：包内未见的轮次直接追加，绝不改写旧记录；
 *     仅当双方最新一轮评估内容不一致时，请人在两份最新评估间二选一；
 *   - 风险否决按「营位编号 + 否决类型」去重，未登记过的类型自动追加。
 *
 * 写库前做营地容量硬校验：合并后同营地各营位帐篷数之和超过容量上限，
 * 或容量未登记，整体拒绝写入（不触碰库数据），由页面保留草稿。
 */
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type {
  FactorKey,
  FactorWeights,
  GradeThresholds,
  NormalizeMethod,
  ScoreProfile
} from '@/types/score'
import { FACTOR_KEYS, NORMALIZE_LABELS } from '@/types/score'
import type { RiskVeto, VetoType } from '@/types/veto'
import type { CampCapacity } from '@/types/campCapacity'
import { nowIso } from '@/utils/format'
import type { SurveyPackage } from '@/utils/package'

/* ------------------------------ 字段元数据 ------------------------------ */

export interface FieldSpec<K extends string = string> {
  key: K
  label: string
}

type SiteMergeKey =
  | 'name'
  | 'campName'
  | 'lng'
  | 'lat'
  | 'elevation'
  | 'slope'
  | 'aspect'
  | 'surface'
  | 'tentCapacity'
  | 'flatness'
  | 'access'
  | 'note'

export const SITE_FIELDS: FieldSpec<SiteMergeKey>[] = [
  { key: 'name', label: '营位名称' },
  { key: 'campName', label: '所属营地' },
  { key: 'lng', label: '经度' },
  { key: 'lat', label: '纬度' },
  { key: 'elevation', label: '海拔（m）' },
  { key: 'slope', label: '坡度（°）' },
  { key: 'aspect', label: '坡向' },
  { key: 'surface', label: '地表类型' },
  { key: 'tentCapacity', label: '可容帐篷数' },
  { key: 'flatness', label: '平整度' },
  { key: 'access', label: '进出方式' },
  { key: 'note', label: '备注' }
]

/** 因子评估用于对照 / 判重的业务字段（不含 id、siteId、时间戳）。 */
type FactorMergeKey = Exclude<
  keyof FactorAssessment,
  'id' | 'siteId' | 'createdAt' | 'updatedAt'
>

export const FACTOR_FIELDS: FieldSpec<FactorMergeKey>[] = [
  { key: 'waterDistance', label: '水源距离（m）' },
  { key: 'windDir', label: '风向' },
  { key: 'windForce', label: '风力（级）' },
  { key: 'signalBars', label: '信号（格）' },
  { key: 'sunHours', label: '日照（h）' },
  { key: 'rockfallRisk', label: '落石落枝风险' },
  { key: 'shade', label: '植被遮蔽' },
  { key: 'distanceToCar', label: '离车距离（m）' },
  { key: 'distanceToTrail', label: '离步道距离（m）' },
  { key: 'assessor', label: '评估人' },
  { key: 'assessedAt', label: '评估日期' }
]

type VetoMergeKey = Exclude<keyof RiskVeto, 'id' | 'siteId' | 'createdAt' | 'updatedAt'>

export const VETO_FIELDS: FieldSpec<VetoMergeKey>[] = [
  { key: 'type', label: '否决类型' },
  { key: 'description', label: '说明' },
  { key: 'judge', label: '判定人' },
  { key: 'judgedAt', label: '判定日期' }
]

type ProfileMergeKey =
  | 'name'
  | 'weights'
  | 'normalize'
  | 'thresholds'
  | 'season'
  | 'active'
  | 'note'

export const PROFILE_FIELDS: FieldSpec<ProfileMergeKey>[] = [
  { key: 'name', label: '方案名' },
  { key: 'weights', label: '因子权重' },
  { key: 'normalize', label: '归一化方式' },
  { key: 'thresholds', label: 'A/B 等级阈值' },
  { key: 'season', label: '适用季节' },
  { key: 'active', label: '是否启用' },
  { key: 'note', label: '方案说明' }
]

/* ------------------------------ 合并计划类型 ------------------------------ */

export type MergeSide = 'local' | 'incoming'

/** 单个字段的对照结果 */
export interface FieldPlan {
  key: string
  label: string
  local: unknown
  incoming: unknown
  hasLocal: boolean
  hasIncoming: boolean
  /** 两边都有值且不同 = 冲突，必须等人确认 */
  conflict: boolean
  /** 非冲突字段自动选定的一方；冲突字段未决时为 null */
  choice: MergeSide | null
}

export type MergeItemStatus = 'both' | 'local-only' | 'incoming-only'

interface BaseItem {
  key: string
  status: MergeItemStatus
  fields: FieldPlan[]
  /** incoming-only 时是否接收（默认接收） */
  include: boolean
}

export interface SiteMergeItem extends BaseItem {
  kind: 'site'
  code: string
  local: Campsite | null
  incoming: Campsite | null
}

export interface FactorMergeItem extends BaseItem {
  kind: 'factor'
  /** 营位编号 */
  siteCode: string
  local: FactorAssessment | null
  incoming: FactorAssessment | null
}

export interface ProfileMergeItem extends BaseItem {
  kind: 'profile'
  /** 方案名（业务键） */
  name: string
  local: ScoreProfile | null
  incoming: ScoreProfile | null
}

export interface VetoMergeItem extends BaseItem {
  kind: 'veto'
  /** 业务键：`营位编号::否决类型` */
  businessKey: string
  siteCode: string
  local: RiskVeto | null
  incoming: RiskVeto | null
}

export interface MergePlan {
  sites: SiteMergeItem[]
  factors: FactorMergeItem[]
  profiles: ProfileMergeItem[]
  vetos: VetoMergeItem[]
}

/** 人的确认结果（可持久化为草稿） */
export interface MergeResolutions {
  /** 冲突字段选择：`<itemKey>::<fieldKey>` -> 选择方 */
  fields: Record<string, MergeSide>
  /** incoming-only 项是否接收：itemKey -> false 表示不接收 */
  includes: Record<string, boolean>
  /** 因子 / 否决整项二选一：itemKey -> 选择方 */
  items: Record<string, MergeSide>
}

export function emptyResolutions(): MergeResolutions {
  return { fields: {}, includes: {}, items: {} }
}

/* ------------------------------ 值比较 ------------------------------ */

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

export function weightsEqual(a?: FactorWeights, b?: FactorWeights): boolean {
  const wa = a ?? ({} as FactorWeights)
  const wb = b ?? ({} as FactorWeights)
  return FACTOR_KEYS.every((k) => Number(wa[k] ?? 0) === Number(wb[k] ?? 0))
}

function thresholdsEqual(a?: GradeThresholds, b?: GradeThresholds): boolean {
  return (
    Number(a?.gradeA ?? 0) === Number(b?.gradeA ?? 0) &&
    Number(a?.gradeB ?? 0) === Number(b?.gradeB ?? 0)
  )
}

function valuesEqual(key: string, a: unknown, b: unknown): boolean {
  if (key === 'weights') return weightsEqual(a as FactorWeights, b as FactorWeights)
  if (key === 'thresholds') return thresholdsEqual(a as GradeThresholds, b as GradeThresholds)
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return a === b
}

function makeField(key: string, label: string, local: unknown, incoming: unknown): FieldPlan {
  const hasLocal = !isBlank(local)
  const hasIncoming = !isBlank(incoming)
  const differ = !valuesEqual(key, local, incoming)
  const conflict = hasLocal && hasIncoming && differ
  return {
    key,
    label,
    local,
    incoming,
    hasLocal,
    hasIncoming,
    conflict,
    choice: conflict ? null : hasIncoming ? 'incoming' : 'local'
  }
}

/** 因子评估业务字段签名，用于轮次判重。 */
export function factorSignature(f: FactorAssessment): string {
  return FACTOR_FIELDS.map(({ key }) => `${key}=${String(f[key] ?? '')}`).join('|')
}

function latestFactorOf(rows: FactorAssessment[]): FactorAssessment | null {
  if (!rows.length) return null
  return [...rows].sort((a, b) => {
    const da = `${a.assessedAt} ${a.createdAt}`
    const dbv = `${b.assessedAt} ${b.createdAt}`
    return da < dbv ? 1 : -1
  })[0]
}

/* ------------------------------ 计划构建 ------------------------------ */

function buildSiteItems(local: Campsite[], incoming: Campsite[]): SiteMergeItem[] {
  const lm = new Map(local.map((s) => [s.code, s]))
  const im = new Map(incoming.map((s) => [s.code, s]))
  const codes = Array.from(new Set([...lm.keys(), ...im.keys()])).sort()
  return codes.map((code) => {
    const lo = lm.get(code) ?? null
    const inc = im.get(code) ?? null
    const status: MergeItemStatus = lo && inc ? 'both' : lo ? 'local-only' : 'incoming-only'
    return {
      kind: 'site',
      key: `site::${code}`,
      code,
      status,
      local: lo,
      incoming: inc,
      include: status !== 'local-only',
      fields: SITE_FIELDS.map((f) => makeField(f.key, f.label, lo?.[f.key], inc?.[f.key]))
    }
  })
}

function groupFactors(rows: FactorAssessment[]): Map<number, FactorAssessment[]> {
  const m = new Map<number, FactorAssessment[]>()
  for (const f of rows) {
    const arr = m.get(f.siteId) ?? []
    arr.push(f)
    m.set(f.siteId, arr)
  }
  return m
}

function buildFactorItems(
  localSites: Campsite[],
  incomingSites: Campsite[],
  localFactors: FactorAssessment[],
  incomingFactors: FactorAssessment[]
): FactorMergeItem[] {
  const localBySiteId = groupFactors(localFactors)
  const incomingBySiteId = groupFactors(incomingFactors)
  const items: FactorMergeItem[] = []

  for (const incSite of incomingSites) {
    const incRows = incomingBySiteId.get(incSite.id ?? -1) ?? []
    const loSite = localSites.find((s) => s.code === incSite.code)
    const loRows = loSite ? (localBySiteId.get(loSite.id ?? -1) ?? []) : []

    const incLatest = latestFactorOf(incRows)
    const loLatest = latestFactorOf(loRows)
    if (!incLatest) continue
    // 包内最新一轮本地已逐字存在 -> 无差异，无需确认
    if (loLatest && factorSignature(loLatest) === factorSignature(incLatest)) continue

    items.push({
      kind: 'factor',
      key: `factor::${incSite.code}`,
      siteCode: incSite.code,
      status: loLatest ? 'both' : 'incoming-only',
      local: loLatest,
      incoming: incLatest,
      include: true,
      fields: FACTOR_FIELDS.map((f) => makeField(f.key, f.label, loLatest?.[f.key], incLatest[f.key]))
    })
  }
  return items.sort((a, b) => (a.siteCode < b.siteCode ? -1 : 1))
}

function buildProfileItems(local: ScoreProfile[], incoming: ScoreProfile[]): ProfileMergeItem[] {
  const lm = new Map(local.map((p) => [p.name, p]))
  const im = new Map(incoming.map((p) => [p.name, p]))
  const names = Array.from(new Set([...lm.keys(), ...im.keys()])).sort()
  return names.map((name) => {
    const lo = lm.get(name) ?? null
    const inc = im.get(name) ?? null
    const status: MergeItemStatus = lo && inc ? 'both' : lo ? 'local-only' : 'incoming-only'
    return {
      kind: 'profile',
      key: `profile::${name}`,
      name,
      status,
      local: lo,
      incoming: inc,
      include: status !== 'local-only',
      fields: PROFILE_FIELDS.map((f) => makeField(f.key, f.label, lo?.[f.key], inc?.[f.key]))
    }
  })
}

function buildVetoItems(
  localSites: Campsite[],
  incomingSites: Campsite[],
  localVetos: RiskVeto[],
  incomingVetos: RiskVeto[]
): VetoMergeItem[] {
  const localSiteById = new Map(localSites.map((s) => [s.id, s]))
  const incomingSiteById = new Map(incomingSites.map((s) => [s.id, s]))
  const keyOf = (siteCode: string, type: VetoType): string => `${siteCode}::${type}`

  const lm = new Map<string, { veto: RiskVeto; siteCode: string }>()
  for (const v of localVetos) {
    const site = localSiteById.get(v.siteId)
    if (!site) continue
    lm.set(keyOf(site.code, v.type), { veto: v, siteCode: site.code })
  }
  const im = new Map<string, { veto: RiskVeto; siteCode: string }>()
  for (const v of incomingVetos) {
    const site = incomingSiteById.get(v.siteId)
    if (!site) continue
    im.set(keyOf(site.code, v.type), { veto: v, siteCode: site.code })
  }

  const keys = Array.from(new Set([...lm.keys(), ...im.keys()])).sort()
  return keys.map((bk) => {
    const lo = lm.get(bk) ?? null
    const inc = im.get(bk) ?? null
    const siteCode = lo?.siteCode ?? inc?.siteCode ?? ''
    const status: MergeItemStatus = lo && inc ? 'both' : lo ? 'local-only' : 'incoming-only'
    const loV = lo?.veto ?? null
    const incV = inc?.veto ?? null
    return {
      kind: 'veto',
      key: `veto::${bk}`,
      businessKey: bk,
      siteCode,
      status,
      local: loV,
      incoming: incV,
      include: status !== 'local-only',
      fields: VETO_FIELDS.map((f) => makeField(f.key, f.label, loV?.[f.key], incV?.[f.key]))
    }
  })
}

/** 用本地库快照 + 勘察包构建合并计划（纯函数；确认结果由调用方单独持有）。 */
export function buildMergePlan(
  local: {
    sites: Campsite[]
    factors: FactorAssessment[]
    profiles: ScoreProfile[]
    vetos: RiskVeto[]
  },
  pkg: SurveyPackage
): MergePlan {
  return {
    sites: buildSiteItems(local.sites, pkg.sites),
    factors: buildFactorItems(local.sites, pkg.sites, local.factors, pkg.factors),
    profiles: buildProfileItems(local.profiles, pkg.profiles),
    vetos: buildVetoItems(local.sites, pkg.sites, local.vetos, pkg.vetos)
  }
}

/* ------------------------------ 未决冲突统计 ------------------------------ */

export interface PlanStats {
  /** 仍待人确认的冲突字段 / 整项数量 */
  unresolved: number
  /** 勘察包带来的新增项数量（含被排除的） */
  incomingOnly: number
}

export function planStats(plan: MergePlan, res: MergeResolutions): PlanStats {
  let unresolved = 0
  let incomingOnly = 0

  for (const item of [...plan.sites, ...plan.profiles]) {
    if (item.status === 'incoming-only') incomingOnly += 1
    if (item.status === 'incoming-only' && res.includes[item.key] === false) continue
    for (const f of item.fields) {
      if (f.conflict && !res.fields[`${item.key}::${f.key}`]) unresolved += 1
    }
  }
  for (const item of [...plan.factors, ...plan.vetos]) {
    if (item.status === 'incoming-only') incomingOnly += 1
    if (item.status === 'incoming-only' && res.includes[item.key] === false) continue
    if (item.fields.some((f) => f.conflict) && !res.items[item.key]) unresolved += 1
  }
  return { unresolved, incomingOnly }
}

/* ------------------------------ 字段展示格式化 ------------------------------ */

const SHORT_WEIGHT_LABEL: Record<FactorKey, string> = {
  slope: '坡度',
  flatness: '平整',
  aspect: '坡向',
  waterDistance: '水源',
  wind: '风力',
  signal: '信号',
  sun: '日照',
  rockfall: '落石',
  shade: '遮蔽',
  distanceToCar: '离车',
  distanceToTrail: '离步道'
}

export function fieldValueText(fieldKey: string, value: unknown): string {
  if (value == null || value === '') return '—'
  if (fieldKey === 'weights') {
    const w = value as FactorWeights
    return FACTOR_KEYS.map((k) => `${SHORT_WEIGHT_LABEL[k]}${Number(w[k] ?? 0)}`).join('，')
  }
  if (fieldKey === 'thresholds') {
    const t = value as GradeThresholds
    return `A ≥ ${t.gradeA} ／ B ≥ ${t.gradeB}`
  }
  if (fieldKey === 'normalize') return NORMALIZE_LABELS[value as NormalizeMethod] ?? String(value)
  if (fieldKey === 'active') return value ? '启用' : '不启用'
  if (fieldKey === 'lng' || fieldKey === 'lat') return Number(value).toFixed(4)
  return String(value)
}

/* ------------------------------ 容量校验 ------------------------------ */

export interface CampCapacityUsage {
  campName: string
  /** 合并后该营地全部营位帐篷数之和 */
  used: number
  /** 容量上限；null = 未登记 */
  limit: number | null
  /** 包内参考上限（仅展示，不参与判定） */
  packageLimit: number | null
  over: boolean
  missing: boolean
  siteCodes: string[]
}

function numOr0(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function chosenField(itemKey: string, fields: FieldPlan[], key: string, res: MergeResolutions): unknown {
  const f = fields.find((x) => x.key === key)
  if (!f) return undefined
  const side = f.conflict ? res.fields[`${itemKey}::${key}`] : f.choice
  return side === 'incoming' ? f.incoming : f.local
}

/** 应用确认结果，算出每个营位合并后的帐篷数与归属营地。 */
export function mergedSitesOf(
  plan: MergePlan,
  res: MergeResolutions
): Array<{ code: string; campName: string; tentCapacity: number }> {
  const out: Array<{ code: string; campName: string; tentCapacity: number }> = []
  for (const item of plan.sites) {
    if (item.status === 'local-only') {
      if (item.local) {
        out.push({
          code: item.code,
          campName: item.local.campName,
          tentCapacity: numOr0(item.local.tentCapacity)
        })
      }
      continue
    }
    if (item.status === 'incoming-only') {
      if (res.includes[item.key] === false || !item.incoming) continue
      out.push({
        code: item.code,
        campName: item.incoming.campName,
        tentCapacity: numOr0(item.incoming.tentCapacity)
      })
      continue
    }
    const campName =
      String(chosenField(item.key, item.fields, 'campName', res) ?? '') ||
      item.local?.campName ||
      ''
    const tent = numOr0(chosenField(item.key, item.fields, 'tentCapacity', res))
    out.push({ code: item.code, campName, tentCapacity: tent })
  }
  return out
}

/** 按营地汇总合并后帐篷数并对照容量表。 */
export function checkCapacity(
  plan: MergePlan,
  res: MergeResolutions,
  capacities: CampCapacity[],
  packageCapacities: CampCapacity[] = []
): CampCapacityUsage[] {
  const byCamp = new Map<string, { used: number; codes: string[] }>()
  for (const r of mergedSitesOf(plan, res)) {
    const cur = byCamp.get(r.campName) ?? { used: 0, codes: [] }
    cur.used += r.tentCapacity
    cur.codes.push(r.code)
    byCamp.set(r.campName, cur)
  }
  const capMap = new Map(capacities.map((c) => [c.campName, c]))
  const pkgMap = new Map(packageCapacities.map((c) => [c.campName, c]))
  return Array.from(byCamp.entries())
    .map(([campName, cur]) => {
      const cap = capMap.get(campName)
      const limit = cap && cap.tentLimit != null ? Number(cap.tentLimit) : null
      const pkgCap = pkgMap.get(campName)
      const packageLimit = pkgCap && pkgCap.tentLimit != null ? Number(pkgCap.tentLimit) : null
      const missing = limit == null
      return {
        campName,
        used: cur.used,
        limit,
        packageLimit,
        over: !missing && limit != null && cur.used > limit,
        missing,
        siteCodes: cur.codes.sort()
      }
    })
    .sort((a, b) => (a.campName < b.campName ? -1 : 1))
}

/* ------------------------------ 提交写库 ------------------------------ */

export interface CommitResult {
  sitesAdded: number
  sitesUpdated: number
  factorsAppended: number
  profilesAdded: number
  profilesUpdated: number
  vetosAdded: number
  /** 启用权重方案是否发生变化（用于提示名次 / 等级 / 地图标记已重算） */
  activeProfileChanged: boolean
}

export class CapacityGuardError extends Error {
  usages: CampCapacityUsage[]
  constructor(usages: CampCapacityUsage[]) {
    const over = usages
      .filter((u) => u.over)
      .map((u) => `${u.campName}（合并后 ${u.used} 帐 / 上限 ${u.limit} 帐）`)
      .join('；')
    const missing = usages.filter((u) => u.missing).map((u) => u.campName).join('、')
    const parts: string[] = []
    if (over) parts.push(`超出营地容量上限：${over}`)
    if (missing) parts.push(`以下营地尚未登记容量上限：${missing}`)
    super(parts.join('。'))
    this.name = 'CapacityGuardError'
    this.usages = usages
  }
}

/**
 * 确认写入：单事务内落库。因子评估只追加，旧勘察记录全部保留。
 * 容量不通过时在事务开启**之前**抛 CapacityGuardError，库内数据不受影响。
 */
export async function commitMerge(
  plan: MergePlan,
  res: MergeResolutions,
  capacities: CampCapacity[],
  pkg: SurveyPackage
): Promise<CommitResult> {
  const usages = checkCapacity(plan, res, capacities, pkg.capacities)
  if (usages.some((u) => u.over || u.missing)) {
    throw new CapacityGuardError(usages)
  }
  const unresolved = planStats(plan, res).unresolved
  if (unresolved > 0) {
    throw new Error(`还有 ${unresolved} 处两边修改的冲突未确认，请并排核对后再写库。`)
  }

  const [dbSites, dbFactors, dbProfiles, dbVetos] = await Promise.all([
    db.sites.toArray(),
    db.factors.toArray(),
    db.profiles.toArray(),
    db.vetos.toArray()
  ])

  const result: CommitResult = {
    sitesAdded: 0,
    sitesUpdated: 0,
    factorsAppended: 0,
    profilesAdded: 0,
    profilesUpdated: 0,
    vetosAdded: 0,
    activeProfileChanged: false
  }

  // 包内方案 包内id -> 方案名，方案名 -> 写库后的本地 id
  const pkgProfileNameById = new Map<number, string>()
  for (const p of pkg.profiles) {
    if (typeof p.id === 'number') pkgProfileNameById.set(p.id, p.name)
  }
  const profileIdByName = new Map<string, number>()
  const siteIdByCode = new Map<string, number>()

  const localActiveBefore = dbProfiles.find((p) => p.active) ?? null

  await db.transaction('rw', db.sites, db.factors, db.profiles, db.vetos, async () => {
    /* ---- 权重方案（先落库，营位默认方案映射要用） ---- */
    let desiredActiveId: number | null = null
    for (const item of plan.profiles) {
      if (item.status === 'local-only') {
        if (item.local && typeof item.local.id === 'number') {
          profileIdByName.set(item.name, item.local.id)
        }
        continue
      }
      if (item.status === 'incoming-only') {
        if (res.includes[item.key] === false || !item.incoming) continue
        const rec = cloneProfile(item.incoming)
        delete rec.id
        const id = await db.profiles.add(rec)
        profileIdByName.set(rec.name, id)
        result.profilesAdded += 1
        if (rec.active) desiredActiveId = id
        continue
      }
      const lo = item.local
      const inc = item.incoming
      if (!lo || !inc || typeof lo.id !== 'number') continue
      const merged = mergeProfilePatch(item, res, lo)
      profileIdByName.set(lo.name, lo.id)
      if (merged) {
        await db.profiles.update(lo.id, toPlain({ ...merged, updatedAt: nowIso() }))
        result.profilesUpdated += 1
      }
      const activeAfter = merged?.active ?? lo.active
      if (activeAfter) desiredActiveId = lo.id
    }

    /* ---- 营位基础信息 ---- */
    for (const item of plan.sites) {
      if (item.status === 'local-only') {
        if (item.local && typeof item.local.id === 'number') {
          siteIdByCode.set(item.code, item.local.id)
        }
        continue
      }
      if (item.status === 'incoming-only') {
        if (res.includes[item.key] === false || !item.incoming) continue
        const rec = cloneSite(item.incoming)
        delete rec.id
        rec.defaultProfileId = mapDefaultProfile(rec.defaultProfileId, pkgProfileNameById, profileIdByName)
        const id = await db.sites.add(rec)
        siteIdByCode.set(item.code, id)
        result.sitesAdded += 1
        continue
      }
      const lo = item.local
      const inc = item.incoming
      if (!lo || !inc || typeof lo.id !== 'number') continue
      const patch = mergeSitePatch(item, res, lo, inc)
      // 选中值与本地完全一致时跳过（不刷新 updatedAt），避免把未改动的营位记成更新。
      if (Object.keys(patch).length === 0) {
        siteIdByCode.set(item.code, lo.id)
        continue
      }
      await db.sites.update(lo.id, toPlain({ ...patch, updatedAt: nowIso() }))
      siteIdByCode.set(item.code, lo.id)
      result.sitesUpdated += 1
    }

    /* ---- 因子评估：只追加 ---- */
    const existingSigs = new Map<number, Set<string>>()
    for (const f of dbFactors) {
      const set = existingSigs.get(f.siteId) ?? new Set<string>()
      set.add(factorSignature(f))
      existingSigs.set(f.siteId, set)
    }
    // 包内营位 id -> 编号；最新评估选择本地的营位集合；包内最新因子（用于跳过判断）
    const pkgCodeBySiteId = new Map<number, string>()
    for (const s of pkg.sites) {
      if (typeof s.id === 'number') pkgCodeBySiteId.set(s.id, s.code)
    }
    const keepLocalLatestCodes = new Set(
      plan.factors.filter((f) => res.items[f.key] === 'local').map((f) => f.siteCode)
    )
    const excludedIncomingSites = new Set(
      plan.sites
        .filter((s) => s.status === 'incoming-only' && res.includes[s.key] === false)
        .map((s) => s.code)
    )
    const pkgLatestBySite = new Map<number, FactorAssessment>()
    for (const item of plan.factors) {
      if (item.incoming) pkgLatestBySite.set(item.incoming.siteId, item.incoming)
    }

    for (const f of pkg.factors) {
      const code = pkgCodeBySiteId.get(f.siteId)
      if (!code || excludedIncomingSites.has(code)) continue
      const targetId = siteIdByCode.get(code)
      if (typeof targetId !== 'number') continue
      if (keepLocalLatestCodes.has(code) && pkgLatestBySite.get(f.siteId) === f) continue
      const sigs = existingSigs.get(targetId) ?? new Set<string>()
      if (sigs.has(factorSignature(f))) continue
      const now = nowIso()
      const rec = toPlain({ ...f, siteId: targetId, createdAt: now, updatedAt: now }) as FactorAssessment
      delete rec.id
      await db.factors.add(rec)
      sigs.add(factorSignature(rec))
      existingSigs.set(targetId, sigs)
      result.factorsAppended += 1
    }

    /* ---- 风险否决：按「编号 + 类型」判重后追加 ---- */
    const localCodeById = new Map<number, string>()
    for (const s of dbSites) if (typeof s.id === 'number') localCodeById.set(s.id, s.code)
    const existingVetoKeys = new Set<string>()
    for (const v of dbVetos) {
      const code = localCodeById.get(v.siteId)
      if (code) existingVetoKeys.add(`${code}::${v.type}`)
    }
    for (const item of plan.vetos) {
      if (item.status === 'local-only') continue
      if (item.status === 'incoming-only' && res.includes[item.key] === false) continue
      const src = item.status === 'both'
        ? (res.items[item.key] === 'incoming' ? item.incoming : null)
        : item.incoming
      if (!src) continue
      const targetId = siteIdByCode.get(item.siteCode)
      if (typeof targetId !== 'number') continue
      const bk = `${item.siteCode}::${src.type}`
      if (existingVetoKeys.has(bk)) continue
      const now = nowIso()
      const rec = toPlain({ ...src, siteId: targetId, createdAt: now, updatedAt: now }) as RiskVeto
      delete rec.id
      await db.vetos.add(rec)
      existingVetoKeys.add(bk)
      result.vetosAdded += 1
    }

    /* ---- 启用方案唯一：仅翻转确实需要变更的行 ---- */
    if (desiredActiveId != null) {
      const all = await db.profiles.toArray()
      const now = nowIso()
      for (const p of all) {
        if (typeof p.id !== 'number') continue
        const want = p.id === desiredActiveId
        if (p.active === want) continue
        await db.profiles.update(p.id, { active: want, updatedAt: now })
      }
    }
  })

  // 启用方案是否发生变化（名字层面）；页面还会额外判断同方案内权重是否被改。
  const localActiveNameAfter = desiredActiveName(plan, res)
  result.activeProfileChanged =
    localActiveNameAfter != null && localActiveNameAfter !== (localActiveBefore?.name ?? null)

  return result
}

/** 提交后应启用的方案名（仅在勘察包带来 active 选择时非 null）。 */
function desiredActiveName(plan: MergePlan, res: MergeResolutions): string | null {
  for (const item of plan.profiles) {
    if (item.status === 'incoming-only') {
      if (res.includes[item.key] === false || !item.incoming) continue
      if (item.incoming.active) return item.incoming.name
      continue
    }
    if (item.status === 'both') {
      const active = chosenField(item.key, item.fields, 'active', res)
      if (active) return item.name
    }
  }
  return null
}

/** 新增营位的默认方案：包内 id → 包内方案名 → 本地同方案名 id；找不到则不指定。 */
function mapDefaultProfile(
  pkgProfileId: number | null,
  pkgNameById: Map<number, string>,
  localIdByName: Map<string, number>
): number | null {
  if (pkgProfileId == null) return null
  const name = pkgNameById.get(pkgProfileId)
  if (!name) return null
  return localIdByName.get(name) ?? null
}

function mergeSitePatch(
  item: SiteMergeItem,
  res: MergeResolutions,
  local: Campsite,
  incoming: Campsite
): Partial<Campsite> {
  const patch: Partial<Campsite> = {}
  for (const f of SITE_FIELDS) {
    const chosen = chosenField(item.key, item.fields, f.key, res)
    const value = chosen ?? local[f.key]
    // 与本地一致则不产生补丁（数值字段按 number 比较）
    if (
      (f.key === 'lng' ||
        f.key === 'lat' ||
        f.key === 'elevation' ||
        f.key === 'slope' ||
        f.key === 'tentCapacity' ||
        f.key === 'flatness')
    ) {
      if (Number(value) === Number(local[f.key])) continue
    } else if (value === local[f.key]) {
      continue
    }
    ;(patch as Record<string, unknown>)[f.key] = value
  }
  void incoming
  return patch
}

function mergeProfilePatch(
  item: ProfileMergeItem,
  res: MergeResolutions,
  local: ScoreProfile
): Partial<ScoreProfile> | null {
  const choice = (key: string): unknown => chosenField(item.key, item.fields, key, res)
  const weights = { ...((choice('weights') as FactorWeights) ?? local.weights) }
  const normalize = (choice('normalize') as NormalizeMethod) ?? local.normalize
  const thresholds = { ...((choice('thresholds') as GradeThresholds) ?? local.thresholds) }
  const season = String(choice('season') ?? local.season)
  const active = Boolean(choice('active') ?? local.active)
  const note = String(choice('note') ?? local.note ?? '')

  const changed =
    !weightsEqual(weights, local.weights) ||
    normalize !== local.normalize ||
    !thresholdsEqual(thresholds, local.thresholds) ||
    season !== local.season ||
    active !== local.active ||
    note !== (local.note ?? '')
  if (!changed) return null
  return { weights, normalize, thresholds, season, active, note }
}

function cloneSite(s: Campsite): Campsite {
  return {
    ...s,
    lng: Number(s.lng),
    lat: Number(s.lat),
    elevation: Number(s.elevation),
    slope: Number(s.slope),
    tentCapacity: Number(s.tentCapacity),
    flatness: Number(s.flatness),
    note: s.note ?? ''
  }
}

function cloneProfile(p: ScoreProfile): ScoreProfile {
  return { ...p, weights: { ...p.weights }, thresholds: { ...p.thresholds } }
}
