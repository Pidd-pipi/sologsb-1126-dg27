/**
 * CampCapacity（营地容量表）—— 每个营地可接待的帐篷总数上限。
 * 合并勘察包时，同一营地名下各营位的「可容帐篷数」之和不得超过该上限，
 * 超出则拒绝写入并保留草稿，等人调整后再提交。
 */

export interface CampCapacity {
  /** 主键，自增 */
  id?: number
  /** 营地名称（与 Campsite.campName 对应） */
  campName: string
  /** 该营地可接待的帐篷总数上限 */
  tentCapacity: number
  /** 备注（营地范围、限流说明等） */
  note: string
  updatedAt: string
}
