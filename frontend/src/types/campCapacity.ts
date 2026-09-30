/**
 * CampCapacity（营地容量）—— 每个营地（按 campName）可接待的帐篷总数上限。
 * 勘察包合并写入前，按营地汇总合并后各营位帐篷数，超过上限即拒绝写库。
 */
export interface CampCapacity {
  /** 营地名称（主键，与 Campsite.campName 对应） */
  campName: string
  /** 该营地可接待的帐篷总数；null 表示尚未登记上限（合并前必须补齐） */
  tentLimit: number | null
  /** 备注（容量口径、季节性调整说明等） */
  note: string
  createdAt: string
  updatedAt: string
}
