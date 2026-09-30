/**
 * 演示勘察包：基于当前库内容模拟「另一支勘察队离线编录后」带回的分包，
 * 刻意覆盖四类对照情形：
 *   1. 同一营位两边都改了基础信息（CS-0003 / CS-0004 帐篷数等，可触发容量超限）；
 *   2. 同一营位最新因子评估两边不一致（CS-0002）；
 *   3. 勘察包新增营位、新增权重方案、新增否决记录；
 *   4. 包内携带的容量表与本地不同（仅作对照参考，不自动覆盖）。
 */
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { ScoreProfile } from '@/types/score'
import type { RiskVeto } from '@/types/veto'
import type { CampCapacity } from '@/types/campCapacity'
import { buildSurveyPackage, type SurveyPackage } from '@/utils/package'

const TEAM = '二队（离线编录）'
const TS = '2024-04-15T08:00:00.000Z'
const TODAY = '2024-04-15'

/**
 * 由当前库快照生成演示分包。输入为页面 store 中已加载的本地数据。
 */
export function buildDemoPackage(input: {
  sites: Campsite[]
  factors: FactorAssessment[]
  profiles: ScoreProfile[]
  vetos: RiskVeto[]
  capacities: CampCapacity[]
}): SurveyPackage {
  // 深拷贝，避免改动本地响应式数据
  const sites: Campsite[] = JSON.parse(JSON.stringify(input.sites))
  const factors: FactorAssessment[] = JSON.parse(JSON.stringify(input.factors))
  const profiles: ScoreProfile[] = JSON.parse(JSON.stringify(input.profiles))
  const vetos: RiskVeto[] = JSON.parse(JSON.stringify(input.vetos))
  const capacities: CampCapacity[] = JSON.parse(JSON.stringify(input.capacities))

  const byCode = new Map(sites.map((s) => [s.code, s]))
  const factorBySite = new Map(factors.map((f) => [f.siteId, f]))

  /* —— 两边都改：CS-0003 名称与容量、CS-0004 容量（合计顶破北岭上限） —— */
  const cs3 = byCode.get('CS-0003')
  if (cs3) {
    cs3.name = '碎石坝顶 C 区（二队复测）'
    cs3.tentCapacity = 8 // 本地若也改过即产生冲突；保持 8 时与样例一致
    cs3.flatness = 88
    cs3.updatedAt = TS
  }
  const cs4 = byCode.get('CS-0004')
  if (cs4) {
    cs4.tentCapacity = 6 // 本地 2 -> 二队改 6；北岭 8+6=14 > 12
    cs4.slope = 8.2
    cs4.updatedAt = TS
  }

  /* —— CS-0003 再制造一个必冲突字段（海拔两边都改） —— */
  if (cs3) cs3.elevation = 526

  /* —— 两边最新因子评估不一致：CS-0002 —— */
  const f2 = factorBySite.get(2)
  if (f2) {
    f2.waterDistance = 150
    f2.signalBars = 4
    f2.rockfallRisk = '中'
    f2.assessor = '二队·赵勘'
    f2.assessedAt = TODAY
    f2.updatedAt = TS
  }

  /* —— CS-0001 带回一轮更早的历史评估（应自动追加，不改写最新轮） —— */
  const f1 = factorBySite.get(1)
  if (f1) {
    const older: FactorAssessment = {
      ...JSON.parse(JSON.stringify(f1)),
      waterDistance: 60,
      signalBars: 3,
      assessor: '二队·钱勘',
      assessedAt: '2024-03-20',
      createdAt: '2024-03-20T03:00:00.000Z',
      updatedAt: '2024-03-20T03:00:00.000Z'
    }
    delete older.id
    factors.push(older)
  }

  /* —— 新增权重方案 —— */
  profiles.push({
    name: '冬季防滑方案（二队）',
    weights: {
      slope: 18,
      flatness: 14,
      aspect: 4,
      waterDistance: 10,
      wind: 14,
      signal: 6,
      sun: 4,
      rockfall: 12,
      shade: 4,
      distanceToCar: 10,
      distanceToTrail: 4
    },
    normalize: 'threshold',
    thresholds: { gradeA: 80, gradeB: 60 },
    season: '冬季',
    active: false,
    note: '二队离线试编：冬季提高坡度与离车距离权重。',
    createdAt: TS,
    updatedAt: TS
  })

  /* —— 同名启用方案两边都调过权重（写入后触发名次 / 等级 / 地图标记重算） —— */
  const balanced = profiles.find((p) => p.name === '均衡型方案')
  if (balanced) {
    balanced.weights = {
      ...balanced.weights,
      slope: 18,
      waterDistance: 10,
      wind: 6
    }
    balanced.note = '二队复测后认为坡度区分度更高，已上调坡度权重。'
    balanced.updatedAt = TS
  }

  /* —— 新增营位（编号不与本地重复） —— */
  const newSite: Campsite = {
    code: 'CS-0101',
    name: '南坡新设营位 G 区',
    campName: '杉木坪营地',
    lng: 119.8601,
    lat: 30.5402,
    elevation: 366,
    slope: 5.2,
    aspect: '南',
    surface: '草地',
    tentCapacity: 3,
    flatness: 83,
    access: '步行',
    defaultProfileId: null,
    note: '二队新发现的南坡台地，待主队复核。',
    createdAt: TS,
    updatedAt: TS
  }
  sites.push(newSite)
  // 让包内自增 id 与营位关联（合并端按 code 重映射，不依赖本地 id）
  const newSiteId = 1001
  newSite.id = newSiteId
  factors.push({
    siteId: newSiteId,
    waterDistance: 130,
    windDir: '北',
    windForce: 2,
    signalBars: 3,
    sunHours: 4.6,
    rockfallRisk: '低',
    shade: 44,
    distanceToCar: 210,
    distanceToTrail: 70,
    assessor: '二队·赵勘',
    assessedAt: TODAY,
    createdAt: TS,
    updatedAt: TS
  })
  vetos.push({
    siteId: newSiteId,
    type: '孤树下',
    description: '营位边缘有两株孤立高树，雷雨时存在断枝风险。',
    judge: '二队·赵勘',
    judgedAt: TODAY,
    createdAt: TS,
    updatedAt: TS
  })

  /* —— 给已有营位 CS-0003 补一条本地没有的否决类型 —— */
  vetos.push({
    siteId: cs3?.id ?? 3,
    type: '山洪沟',
    description: '二队复测发现营位西侧 40 米有汇水沟口，暴雨夜需警惕。',
    judge: '二队·钱勘',
    judgedAt: TODAY,
    createdAt: TS,
    updatedAt: TS
  })

  /* —— 包内容量表：北岭自报 20（与本地 12 不一致，仅供对照，不自动覆盖） —— */
  for (const c of capacities) {
    if (c.campName === '北岭高地营地') c.tentLimit = 20
  }

  return buildSurveyPackage(
    { sites, factors, profiles, vetos, capacities },
    { team: TEAM, note: '二队离线两天后的复测分包，含 CS-0004 扩容申请，请主队核对容量。' }
  )
}
