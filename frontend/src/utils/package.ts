/**
 * 勘察包（SurveyPackage）：离线编录的分包导出 / 合并导入载体。
 *
 * 勘察队分头离线作业，各自带着浏览器里的 IndexedDB 数据，归队后导出 JSON 勘察包，
 * 由合并页读取。记录主键（id）仅在导出设备内有效，**跨设备合并绝不按 id 对齐**：
 *   - 营位按编号 code 对齐
 *   - 权重方案按方案名 name 对齐
 *   - 风险否决按「营位编号 + 否决类型」对齐
 *   - 因子评估按业务字段判重，合并时只追加、不改写旧勘察记录
 */
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { ScoreProfile } from '@/types/score'
import type { RiskVeto } from '@/types/veto'
import type { CampCapacity } from '@/types/campCapacity'

export const PACKAGE_KIND = 'gbcampsite-survey-package' as const
export const PACKAGE_VERSION = 1

/** 勘察包元信息 */
export interface PackageMeta {
  /** 导出方（勘察队 / 编录人） */
  team: string
  /** 设备标识 */
  device: string
  exportedAt: string
  note: string
}

export interface SurveyPackage {
  kind: typeof PACKAGE_KIND
  version: number
  meta: PackageMeta
  sites: Campsite[]
  factors: FactorAssessment[]
  profiles: ScoreProfile[]
  vetos: RiskVeto[]
  /** 容量表随包携带，仅作合并页对照参考，不自动覆盖本地容量。 */
  capacities: CampCapacity[]
}

/** 从当前库内容组装勘察包（id 原样保留，仅在本包内用于外键关联）。 */
export function buildSurveyPackage(
  data: {
    sites: Campsite[]
    factors: FactorAssessment[]
    profiles: ScoreProfile[]
    vetos: RiskVeto[]
    capacities: CampCapacity[]
  },
  meta: { team: string; note?: string }
): SurveyPackage {
  return {
    kind: PACKAGE_KIND,
    version: PACKAGE_VERSION,
    meta: {
      team: meta.team.trim() || '未署名勘察队',
      device: deviceLabel(),
      exportedAt: new Date().toISOString(),
      note: meta.note?.trim() ?? ''
    },
    // id 原样保留：包内 factors.siteId / vetos.siteId 依赖它关联，
    // 合并端不按 id 对齐，而是用营位编号 code 重新映射。
    sites: data.sites,
    factors: data.factors,
    profiles: data.profiles,
    vetos: data.vetos,
    capacities: data.capacities
  }
}

function deviceLabel(): string {
  try {
    const ua = window.navigator.userAgent
    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : 'Linux'
    return `${os} · ${window.navigator.language || '未知语言'}`
  } catch {
    return '未知设备'
  }
}

/** 触发浏览器下载勘察包 JSON。 */
export function downloadSurveyPackage(pkg: SurveyPackage): void {
  const payload = JSON.stringify(pkg, null, 2)
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = pkg.meta.exportedAt.slice(0, 10).replace(/-/g, '')
  a.href = url
  a.download = `勘察包_${pkg.meta.team}_${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 解析并校验勘察包文件内容；结构不合法时抛错，由页面提示。 */
export function parseSurveyPackage(text: string): SurveyPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('文件不是合法的 JSON，请确认选择的是勘察包导出文件。')
  }
  const obj = raw as Partial<SurveyPackage>
  if (!obj || obj.kind !== PACKAGE_KIND) {
    throw new Error(`缺少 "${PACKAGE_KIND}" 标识，不是本系统导出的勘察包。`)
  }
  if (typeof obj.version !== 'number') {
    throw new Error('勘察包缺少版本号，无法识别。')
  }
  if (obj.version > PACKAGE_VERSION) {
    throw new Error(`勘察包版本 v${obj.version} 高于当前支持的 v${PACKAGE_VERSION}，请先升级本应用。`)
  }
  if (!obj.meta || typeof obj.meta.team !== 'string') {
    throw new Error('勘察包缺少导出方（勘察队）信息。')
  }
  const sites = Array.isArray(obj.sites) ? obj.sites : []
  if (!sites.length) {
    throw new Error('勘察包内没有任何营位记录，无法合并。')
  }
  const codes = new Set<string>()
  for (const s of sites) {
    if (!s || typeof s.code !== 'string' || !s.code.trim()) {
      throw new Error('勘察包内存在缺少营位编号的记录。')
    }
    if (codes.has(s.code)) throw new Error(`勘察包内营位编号 ${s.code} 重复，无法按编号合并。`)
    codes.add(s.code)
  }
  return {
    kind: PACKAGE_KIND,
    version: obj.version,
    meta: {
      team: obj.meta.team,
      device: typeof obj.meta.device === 'string' ? obj.meta.device : '未知设备',
      exportedAt: typeof obj.meta.exportedAt === 'string' ? obj.meta.exportedAt : '',
      note: typeof obj.meta.note === 'string' ? obj.meta.note : ''
    },
    sites,
    factors: Array.isArray(obj.factors) ? obj.factors : [],
    profiles: Array.isArray(obj.profiles) ? obj.profiles : [],
    vetos: Array.isArray(obj.vetos) ? obj.vetos : [],
    capacities: Array.isArray(obj.capacities) ? obj.capacities : []
  }
}
