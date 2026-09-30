/**
 * 营地容量表（CampCapacity）的本地读写。
 * 合并勘察包前按营地汇总帐篷数，超过 tentLimit 即拒绝写库；
 * 未登记上限（tentLimit = null 或缺行）的营地也必须先补齐容量。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { CampCapacity } from '@/types/campCapacity'
import { nowIso } from '@/utils/format'

export const useCapacityStore = defineStore('capacity', () => {
  const list = ref<CampCapacity[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.capacities.orderBy('campName').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 某营地的容量登记，未登记时返回 null。 */
  function ofCamp(campName: string): CampCapacity | null {
    return list.value.find((c) => c.campName === campName) ?? null
  }

  /** 某营地可接待帐篷总数；未登记或留空时返回 null（合并前必须补齐）。 */
  function limitOf(campName: string): number | null {
    const row = ofCamp(campName)
    if (!row || row.tentLimit == null) return null
    return Number(row.tentLimit)
  }

  /** 新增或更新一个营地的容量。 */
  async function upsert(
    campName: string,
    tentLimit: number | null,
    note: string
  ): Promise<void> {
    const key = campName.trim()
    if (!key) return
    const existing = ofCamp(key)
    const now = nowIso()
    const record: CampCapacity = toPlain({
      campName: key,
      tentLimit,
      note: note.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    await db.capacities.put(record)
    await load()
  }

  async function remove(campName: string): Promise<void> {
    await db.capacities.delete(campName)
    await load()
  }

  const total = computed(() => list.value.length)

  return { list, loading, loaded, total, load, ofCamp, limitOf, upsert, remove }
})
