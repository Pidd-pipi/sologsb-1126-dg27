/**
 * 勘察包合并引擎 —— 三路合并（base / local / incoming）的纯函数实现。
 *
 * 关键语义：
 *  - 按营位编号（code）匹配营位；权重方案按方案名匹配；营地容量按营地名匹配。
 *  - 某一项「两边都改过」（base 与两边都不同，或无 base 且两边不同）→ 标记为冲突，
 *    并由调用方收集人工选择（resolutions）后再定夺，绝不自动写库。
 *  - 只改了一边的字段自动合并；两边一致的字段保持不变。
 *  - 因子评估与否决记录是「追加日志」：只增补不删除，旧轮次/旧记录全部保留，
 *    评分时自然取最新一轮因子。
 *  - 营地容量校验：合并后同一营地名下各营位帐篷数之和不得超过容量表上限，
 *    超出则生成 capacityIssues，调用方据此拒绝写入。
 */
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type {
  FactorWeights,
  NormalizeMethod,
  ScoreProfile
} from '@/types/score'
import { FACTOR_META } from '@/types/score'
import type { RiskVeto, VetoType } from '@/types/veto'
import type { CampCapacity } from '@/types/capacity'

export const PACKAGE_FORMAT = 'gbcampsite-package'
export const PACKAGE_VERSION = 1

/* ------------------------------ 勘察包结构 ------------------------------ */

export interface SurveyPackage {
  format: typeof PACKAGE_FORMAT
  version: number
  /** 勘察包名称（如 云栖山谷-北坡队 离线包） */
  packageName: string
  /** 勘察队 / 编制人 */
  team: string
  /** 导出时间 ISO */
  exportedAt: string
  /** 基准时间（可选） */
  baseAt?: string
  campsites: Campsite[]
  factors: FactorAssessment[]
  profiles: ScoreProfile[]
  vetos: RiskVeto[]
  campCapacities: CampCapacity[]
  /** 三路合并用的基准快照（导出时的当前库状态） */
  base?: {
    campsites?: Campsite[]
    profiles?: ScoreProfile[]
    campCapacities?: CampCapacity[]
  }
}

/** 本地库数据（合并的目标侧） */
export interface LocalData {
  campsites: Campsite[]
  factors: FactorAssessment[]
  profiles: ScoreProfile[]
  vetos: RiskVeto[]
  campCapacities: CampCapacity[]
}

/* ------------------------------ 合并结果类型 ------------------------------ */

export type MergeStatus = 'unchanged' | 'added' | 'auto' | 'conflict'

export interface FieldConflict {
  field: string
  label: string
  local: unknown
  incoming: unknown
  base?: unknown
  chosen: 'local' | 'incoming'
}

export interface AutoChange {
  field: string
  label: string
  from: unknown
  to: unknown
}

export interface CampsiteMerge {
  code: string
  name: string
  campName: string
  status: MergeStatus
  local?: Campsite
  incoming?: Campsite
  conflicts: FieldConflict[]
  autoChanges: AutoChange[]
  resolved: Campsite
}

export interface ProfileMerge {
  /** 方案名（匹配键） */
  key: string
  status: MergeStatus
  local?: ScoreProfile
  incoming?: ScoreProfile
  conflicts: FieldConflict[]
  autoChanges: AutoChange[]
  resolved: ScoreProfile
}

export interface CapacityMerge {
  campName: string
  status: MergeStatus
  local?: CampCapacity
  incoming?: CampCapacity
  conflicts: FieldConflict[]
  autoChanges: AutoChange[]
  resolved: CampCapacity
}

export interface FactorMerge {
  siteCode: string
  siteName: string
  campName: string
  localSiteId?: number
  incomingCount: number
  /** 去重后实际会新增的轮次数 */
  newCount: number
  latestAssessor: string
  latestAssessedAt: string
  latestSummary: string
}

export interface VetoMerge {
  siteCode: string
  siteName: string
  campName: string
  incomingCount: number
  newCount: number
  types: VetoType[]
}

export interface CapacityIssue {
  campName: string
  capacity: number
  mergedTotal: number
  over: number
  siteCodes: string[]
}

export interface CampCapacityRow {
  campName: string
  /** 容量表上限；null 表示该营地未登记容量（不设限） */
  capacity: number | null
  mergedTotal: number
  over: boolean
  siteCodes: string[]
}

export interface MergePlan {
  packageName: string
  team: string
  exportedAt: string
  campsites: CampsiteMerge[]
  profiles: ProfileMerge[]
  capacities: CapacityMerge[]
  factors: FactorMerge[]
  vetos: VetoMerge[]
  capacityIssues: CapacityIssue[]
  capacityByCamp: CampCapacityRow[]
  counts: {
    addedSites: number
    updatedSites: number
    conflictSites: number
    unchangedSites: number
    addedFactors: number
    addedVetos: number
    addedProfiles: number
    conflictProfiles: number
    addedCapacities: number
  }
}

/** 人工选择表：key = `${kind}:${匹配键}:${字段}`，值为采用哪一侧。 */
export type ResolutionMap = Record<string, 'local' | 'incoming'>

/* ------------------------------ 工具函数 ------------------------------ */

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 因子轮次的内容指纹：同营位 + 同评估日期/评估人 + 全部实测值，视为同一轮。 */
export function factorFingerprint(f: FactorAssessment, siteCode: string): string {
  return [
    siteCode,
    f.assessedAt,
    f.assessor,
    f.waterDistance,
    f.windDir,
    f.windForce,
    f.signalBars,
    f.sunHours,
    f.rockfallRisk,
    f.shade,
    f.distanceToCar,
    f.distanceToTrail
  ].join('|')
}

/** 否决记录的内容指纹：同营位 + 同类型/判定日期/判定人/说明，视为同一条。 */
export function vetoFingerprint(v: RiskVeto, siteCode: string): string {
  return [siteCode, v.type, v.judgedAt, v.judge, v.description].join('|')
}

interface FlatField {
  key: string
  label: string
  value: unknown
}

const SITE_FIELDS: Array<{ key: keyof Campsite; label: string }> = [
  { key: 'name', label: '营位名称' },
  { key: 'campName', label: '所属营地' },
  { key: 'lng', label: '经度' },
  { key: 'lat', label: '纬度' },
  { key: 'elevation', label: '海拔' },
  { key: 'slope', label: '坡度' },
  { key: 'aspect', label: '坡向' },
  { key: 'surface', label: '地表类型' },
  { key: 'tentCapacity', label: '可容帐篷数' },
  { key: 'flatness', label: '平整度' },
  { key: 'access', label: '进出方式' },
  { key: 'note', label: '备注' }
]

const CAPACITY_FIELDS: Array<{ key: keyof CampCapacity; label: string }> = [
  { key: 'tentCapacity', label: '可接待帐篷总数' },
  { key: 'note', label: '备注' }
]

function flattenSite(site: Campsite): FlatField[] {
  return SITE_FIELDS.map((f) => ({ key: f.key, label: f.label, value: site[f.key] }))
}

function flattenCapacity(row: CampCapacity): FlatField[] {
  return CAPACITY_FIELDS.map((f) => ({ key: f.key, label: f.label, value: row[f.key] }))
}

function flattenProfile(profile: ScoreProfile): FlatField[] {
  const fields: FlatField[] = [
    { key: 'name', label: '方案名', value: profile.name },
    { key: 'normalize', label: '归一化方式', value: profile.normalize },
    { key: 'season', label: '适用季节', value: profile.season },
    { key: 'note', label: '备注', value: profile.note }
  ]
  for (const meta of FACTOR_META) {
    fields.push({ key: `weights.${meta.key}`, label: `权重 · ${meta.label}`, value: profile.weights[meta.key] })
  }
  fields.push({ key: 'thresholds.gradeA', label: 'A 级阈值', value: profile.thresholds.gradeA })
  fields.push({ key: 'thresholds.gradeB', label: 'B 级阈值', value: profile.thresholds.gradeB })
  return fields
}

/**
 * 通用字段级合并：对 local / incoming / base 三组扁平字段做三路合并。
 * 分歧字段：无 base 时一律视为冲突；有 base 时仅一方改动则自动采用改动方，双方都改则冲突。
 */
function mergeFlatRecords(
  localFields: FlatField[],
  incomingFields: FlatField[],
  baseFields: FlatField[] | undefined,
  getResolution: (field: string) => 'local' | 'incoming' | undefined
): {
  status: MergeStatus
  conflicts: FieldConflict[]
  autoChanges: AutoChange[]
  resolved: Record<string, unknown>
} {
  const baseMap = new Map(baseFields?.map((f) => [f.key, f.value]) ?? [])
  const localMap = new Map(localFields.map((f) => [f.key, f.value]))
  const incomingMap = new Map(incomingFields.map((f) => [f.key, f.value]))
  const labelMap = new Map(
    [...localFields, ...incomingFields].map((f) => [f.key, f.label])
  )

  const keys = new Set([...localMap.keys(), ...incomingMap.keys()])
  const conflicts: FieldConflict[] = []
  const autoChanges: AutoChange[] = []
  const resolved: Record<string, unknown> = {}
  let hasConflict = false
  let hasAuto = false

  for (const key of keys) {
    const lv = localMap.get(key)
    const iv = incomingMap.get(key)
    const bv = baseMap.get(key)
    const label = labelMap.get(key) ?? key
    const inLocal = localMap.has(key)
    const inIncoming = incomingMap.has(key)

    if (!inLocal) {
      // 仅包内有 → 采用包内
      resolved[key] = iv
      hasAuto = true
      autoChanges.push({ field: key, label, from: undefined, to: iv })
      continue
    }
    if (!inIncoming) {
      resolved[key] = lv
      continue
    }
    if (deepEqual(lv, iv)) {
      resolved[key] = lv
      continue
    }
    // 两边分歧
    if (bv === undefined) {
      hasConflict = true
      const chosen = getResolution(key) ?? 'incoming'
      conflicts.push({ field: key, label, local: lv, incoming: iv, chosen })
      resolved[key] = chosen === 'local' ? lv : iv
    } else if (deepEqual(bv, lv)) {
      // 仅包内改过 → 自动采用包内
      hasAuto = true
      autoChanges.push({ field: key, label, from: lv, to: iv })
      resolved[key] = iv
    } else if (deepEqual(bv, iv)) {
      // 仅本地改过 → 保持本地
      resolved[key] = lv
    } else {
      // 两边都改过 → 冲突，等人确认
      hasConflict = true
      const chosen = getResolution(key) ?? 'incoming'
      conflicts.push({ field: key, label, local: lv, incoming: iv, base: bv, chosen })
      resolved[key] = chosen === 'local' ? lv : iv
    }
  }

  return {
    status: hasConflict ? 'conflict' : hasAuto ? 'auto' : 'unchanged',
    conflicts,
    autoChanges,
    resolved
  }
}

/* ------------------------------ 包校验 ------------------------------ */

export function isSurveyPackage(value: unknown): value is SurveyPackage {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    p.format === PACKAGE_FORMAT &&
    Array.isArray(p.campsites) &&
    Array.isArray(p.factors) &&
    Array.isArray(p.profiles) &&
    Array.isArray(p.vetos) &&
    Array.isArray(p.campCapacities)
  )
}

/* ------------------------------ 主合并函数 ------------------------------ */

export function buildMergePlan(local: LocalData, pkg: SurveyPackage, resolutions: ResolutionMap = {}): MergePlan {
  const getResolution = (kind: string, key: string, field: string) =>
    resolutions[`${kind}:${key}:${field}`]

  const baseSites = new Map((pkg.base?.campsites ?? []).map((s) => [s.code, s]))
  const baseProfiles = new Map((pkg.base?.profiles ?? []).map((p) => [p.name, p]))
  const baseCapacities = new Map((pkg.base?.campCapacities ?? []).map((c) => [c.campName, c]))

  const localSitesByCode = new Map(local.campsites.map((s) => [s.code, s]))
  const incomingSitesByCode = new Map(pkg.campsites.map((s) => [s.code, s]))
  const localProfilesByName = new Map(local.profiles.map((p) => [p.name, p]))
  const incomingProfilesByName = new Map(pkg.profiles.map((p) => [p.name, p]))
  const localCapacitiesByName = new Map(local.campCapacities.map((c) => [c.campName, c]))
  const incomingCapacitiesByName = new Map(pkg.campCapacities.map((c) => [c.campName, c]))

  /* ---------- 营位（按编号） ---------- */
  const campsiteMerges: CampsiteMerge[] = []
  const allSiteCodes = new Set([...localSitesByCode.keys(), ...incomingSitesByCode.keys()])
  for (const code of allSiteCodes) {
    const localSite = localSitesByCode.get(code)
    const incomingSite = incomingSitesByCode.get(code)
    if (localSite && !incomingSite) {
      campsiteMerges.push({
        code,
        name: localSite.name,
        campName: localSite.campName,
        status: 'unchanged',
        local: localSite,
        conflicts: [],
        autoChanges: [],
        resolved: localSite
      })
      continue
    }
    if (!localSite && incomingSite) {
      campsiteMerges.push({
        code,
        name: incomingSite.name,
        campName: incomingSite.campName,
        status: 'added',
        incoming: incomingSite,
        conflicts: [],
        autoChanges: [],
        resolved: incomingSite
      })
      continue
    }
    // 两边都有 → 字段级合并
    const baseSite = baseSites.get(code)
    const { status, conflicts, autoChanges, resolved } = mergeFlatRecords(
      flattenSite(localSite!),
      flattenSite(incomingSite!),
      baseSite ? flattenSite(baseSite) : undefined,
      (field) => getResolution('site', code, field)
    )
    campsiteMerges.push({
      code,
      name: String(resolved.name ?? localSite!.name),
      campName: String(resolved.campName ?? localSite!.campName),
      status,
      local: localSite,
      incoming: incomingSite,
      conflicts,
      autoChanges,
      resolved: { ...localSite!, ...resolved } as Campsite
    })
  }
  campsiteMerges.sort((a, b) => a.code.localeCompare(b.code))

  /* ---------- 权重方案（按方案名） ---------- */
  const profileMerges: ProfileMerge[] = []
  const allProfileNames = new Set([...localProfilesByName.keys(), ...incomingProfilesByName.keys()])
  for (const name of allProfileNames) {
    const localProfile = localProfilesByName.get(name)
    const incomingProfile = incomingProfilesByName.get(name)
    if (localProfile && !incomingProfile) {
      profileMerges.push({
        key: name,
        status: 'unchanged',
        local: localProfile,
        conflicts: [],
        autoChanges: [],
        resolved: localProfile
      })
      continue
    }
    if (!localProfile && incomingProfile) {
      profileMerges.push({
        key: name,
        status: 'added',
        incoming: incomingProfile,
        conflicts: [],
        autoChanges: [],
        resolved: incomingProfile
      })
      continue
    }
    const baseProfile = baseProfiles.get(name)
    const { status, conflicts, autoChanges, resolved } = mergeFlatRecords(
      flattenProfile(localProfile!),
      flattenProfile(incomingProfile!),
      baseProfile ? flattenProfile(baseProfile) : undefined,
      (field) => getResolution('profile', name, field)
    )
    const weights = {} as FactorWeights
    for (const meta of FACTOR_META) {
      weights[meta.key] = Number(resolved[`weights.${meta.key}`] ?? localProfile!.weights[meta.key]) || 0
    }
    const resolvedProfile: ScoreProfile = {
      ...localProfile!,
      name: String(resolved.name ?? localProfile!.name),
      normalize: (resolved.normalize as NormalizeMethod) ?? localProfile!.normalize,
      season: String(resolved.season ?? localProfile!.season),
      note: String(resolved.note ?? localProfile!.note),
      weights,
      thresholds: {
        gradeA: Number(resolved['thresholds.gradeA'] ?? localProfile!.thresholds.gradeA),
        gradeB: Number(resolved['thresholds.gradeB'] ?? localProfile!.thresholds.gradeB)
      }
    }
    profileMerges.push({
      key: name,
      status,
      local: localProfile,
      incoming: incomingProfile,
      conflicts,
      autoChanges,
      resolved: resolvedProfile
    })
  }
  profileMerges.sort((a, b) => a.key.localeCompare(b.key))

  /* ---------- 营地容量（按营地名） ---------- */
  const capacityMerges: CapacityMerge[] = []
  const allCapacityNames = new Set([...localCapacitiesByName.keys(), ...incomingCapacitiesByName.keys()])
  for (const campName of allCapacityNames) {
    const localCap = localCapacitiesByName.get(campName)
    const incomingCap = incomingCapacitiesByName.get(campName)
    if (localCap && !incomingCap) {
      capacityMerges.push({
        campName,
        status: 'unchanged',
        local: localCap,
        conflicts: [],
        autoChanges: [],
        resolved: localCap
      })
      continue
    }
    if (!localCap && incomingCap) {
      capacityMerges.push({
        campName,
        status: 'added',
        incoming: incomingCap,
        conflicts: [],
        autoChanges: [],
        resolved: incomingCap
      })
      continue
    }
    const baseCap = baseCapacities.get(campName)
    const { status, conflicts, autoChanges, resolved } = mergeFlatRecords(
      flattenCapacity(localCap!),
      flattenCapacity(incomingCap!),
      baseCap ? flattenCapacity(baseCap) : undefined,
      (field) => getResolution('capacity', campName, field)
    )
    capacityMerges.push({
      campName,
      status,
      local: localCap,
      incoming: incomingCap,
      conflicts,
      autoChanges,
      resolved: {
        ...localCap!,
        tentCapacity: Number(resolved.tentCapacity ?? localCap!.tentCapacity),
        note: String(resolved.note ?? localCap!.note)
      } as CampCapacity
    })
  }
  capacityMerges.sort((a, b) => a.campName.localeCompare(b.campName, 'zh'))

  /* ---------- 因子评估（追加日志，按营位编号归组去重） ---------- */
  const incomingSiteIdToCode = new Map(pkg.campsites.map((s) => [s.id, s.code]))
  const siteCodeToName = new Map(
    [...local.campsites, ...pkg.campsites].map((s) => [s.code, s.name])
  )
  const siteCodeToCamp = new Map(
    [...local.campsites, ...pkg.campsites].map((s) => [s.code, s.campName])
  )

  /** 本地因子指纹集（siteId → code 反查），用于剔除重复轮次。 */
  const localFactorFingerprints = new Set(
    local.factors.map((f) => {
      const code = local.campsites.find((s) => s.id === f.siteId)?.code ?? ''
      return factorFingerprint(f, code || `__unknown_${f.siteId}`)
    })
  )

  const factorsByCode = new Map<string, FactorAssessment[]>()
  for (const f of pkg.factors) {
    const code = incomingSiteIdToCode.get(f.siteId)
    if (!code) continue
    const arr = factorsByCode.get(code) ?? []
    arr.push(f)
    factorsByCode.set(code, arr)
  }

  const factorMerges: FactorMerge[] = []
  let addedFactors = 0
  for (const [code, rows] of factorsByCode) {
    const localSite = localSitesByCode.get(code)
    const newRows = rows.filter((f) => !localFactorFingerprints.has(factorFingerprint(f, code)))
    addedFactors += newRows.length
    const latest = [...rows].sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))[0]
    factorMerges.push({
      siteCode: code,
      siteName: siteCodeToName.get(code) ?? code,
      campName: siteCodeToCamp.get(code) ?? '—',
      localSiteId: localSite?.id,
      incomingCount: rows.length,
      newCount: newRows.length,
      latestAssessor: latest?.assessor ?? '—',
      latestAssessedAt: latest?.assessedAt ?? '—',
      latestSummary: latest
        ? `水源 ${latest.waterDistance}m · 信号 ${latest.signalBars} 格 · 风力 ${latest.windForce} 级`
        : '—'
    })
  }
  factorMerges.sort((a, b) => a.siteCode.localeCompare(b.siteCode))

  /* ---------- 风险否决（追加日志，按营位编号归组去重） ---------- */
  const localVetoFingerprints = new Set(
    local.vetos.map((v) => {
      const code = local.campsites.find((s) => s.id === v.siteId)?.code ?? `__unknown_${v.siteId}`
      return vetoFingerprint(v, code)
    })
  )

  const vetosByCode = new Map<string, RiskVeto[]>()
  for (const v of pkg.vetos) {
    const code = incomingSiteIdToCode.get(v.siteId)
    if (!code) continue
    const arr = vetosByCode.get(code) ?? []
    arr.push(v)
    vetosByCode.set(code, arr)
  }

  const vetoMerges: VetoMerge[] = []
  let addedVetos = 0
  for (const [code, rows] of vetosByCode) {
    const newRows = rows.filter((v) => !localVetoFingerprints.has(vetoFingerprint(v, code)))
    addedVetos += newRows.length
    vetoMerges.push({
      siteCode: code,
      siteName: siteCodeToName.get(code) ?? code,
      campName: siteCodeToCamp.get(code) ?? '—',
      incomingCount: rows.length,
      newCount: newRows.length,
      types: Array.from(new Set(rows.map((v) => v.type)))
    })
  }
  vetoMerges.sort((a, b) => a.siteCode.localeCompare(b.siteCode))

  /* ---------- 营地容量校验 ---------- */
  // 合并后的营位全集：本地营位（应用匹配项的 resolved）+ 包内新增营位
  const finalSites: Campsite[] = campsiteMerges.map((m) => m.resolved)
  const finalCapacities: CampCapacity[] = capacityMerges.map((m) => m.resolved)

  const capacityByName = new Map(finalCapacities.map((c) => [c.campName, c.tentCapacity]))
  const campTotals = new Map<string, { total: number; codes: string[] }>()
  for (const s of finalSites) {
    const cur = campTotals.get(s.campName) ?? { total: 0, codes: [] }
    cur.total += Number(s.tentCapacity) || 0
    cur.codes.push(s.code)
    campTotals.set(s.campName, cur)
  }

  const capacityByCamp: CampCapacityRow[] = []
  const capacityIssues: CapacityIssue[] = []
  for (const [campName, { total, codes }] of campTotals) {
    const cap = capacityByName.get(campName)
    const capacity = typeof cap === 'number' ? cap : null
    const over = capacity != null && total > capacity
    capacityByCamp.push({ campName, capacity, mergedTotal: total, over, siteCodes: codes.sort() })
    if (over && capacity != null) {
      capacityIssues.push({
        campName,
        capacity,
        mergedTotal: total,
        over: total - capacity,
        siteCodes: codes.sort()
      })
    }
  }
  capacityByCamp.sort((a, b) => a.campName.localeCompare(b.campName, 'zh'))

  /* ---------- 汇总计数 ---------- */
  const counts = {
    addedSites: campsiteMerges.filter((m) => m.status === 'added').length,
    updatedSites: campsiteMerges.filter((m) => m.status === 'auto').length,
    conflictSites: campsiteMerges.filter((m) => m.status === 'conflict').length,
    unchangedSites: campsiteMerges.filter((m) => m.status === 'unchanged').length,
    addedFactors,
    addedVetos,
    addedProfiles: profileMerges.filter((m) => m.status === 'added').length,
    conflictProfiles: profileMerges.filter((m) => m.status === 'conflict').length,
    addedCapacities: capacityMerges.filter((m) => m.status === 'added').length
  }

  return {
    packageName: pkg.packageName,
    team: pkg.team,
    exportedAt: pkg.exportedAt,
    campsites: campsiteMerges,
    profiles: profileMerges,
    capacities: capacityMerges,
    factors: factorMerges,
    vetos: vetoMerges,
    capacityIssues,
    capacityByCamp,
    counts
  }
}

/* ------------------------------ 导出包构造 ------------------------------ */

/** 由当前库数据构造一个勘察包（base 即当前状态，供离线方带出后三路合并）。 */
export function buildSurveyPackage(
  local: LocalData,
  meta: { packageName: string; team: string }
): SurveyPackage {
  const now = new Date().toISOString()
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    packageName: meta.packageName,
    team: meta.team,
    exportedAt: now,
    baseAt: now,
    campsites: JSON.parse(JSON.stringify(local.campsites)),
    factors: JSON.parse(JSON.stringify(local.factors)),
    profiles: JSON.parse(JSON.stringify(local.profiles)),
    vetos: JSON.parse(JSON.stringify(local.vetos)),
    campCapacities: JSON.parse(JSON.stringify(local.campCapacities)),
    base: {
      campsites: JSON.parse(JSON.stringify(local.campsites)),
      profiles: JSON.parse(JSON.stringify(local.profiles)),
      campCapacities: JSON.parse(JSON.stringify(local.campCapacities))
    }
  }
}
