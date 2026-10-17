/**
 * 实例退款守卫
 *
 * 以下来源创建的实例，删除 / 注销 / 销毁一律不退款：
 *   1) 折扣券开通或续费（后台 DDY 券 + 机器人 INC 券，都写 bot_promo_codes.used_instance_id）
 *   2) 管理员在后台手动创建、且首周期免费的付费实例
 *      （计费记录 type=newPurchase 且 remark 含「未扣费」）
 */
import { prisma } from './prisma.js'

export async function isInstanceNonRefundable(instanceId: number): Promise<boolean> {
  if (!Number.isInteger(instanceId) || instanceId <= 0) return false

  const [promo, adminFreeFirstCycle] = await Promise.all([
    prisma.botPromoCode.findFirst({
      where: { usedInstanceId: instanceId },
      select: { id: true }
    }),
    prisma.instanceBillingRecord.findFirst({
      where: {
        instanceId,
        type: 'newPurchase',
        remark: { contains: '未扣费' }
      },
      select: { id: true }
    })
  ])

  return Boolean(promo) || Boolean(adminFreeFirstCycle)
}

/** 批量版：返回不可退款的实例 ID 集合 */
export async function getNonRefundableInstanceIds(instanceIds: number[]): Promise<Set<number>> {
  const ids = instanceIds.filter(id => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return new Set()

  const [promos, adminFree] = await Promise.all([
    prisma.botPromoCode.findMany({
      where: { usedInstanceId: { in: ids } },
      select: { usedInstanceId: true }
    }),
    prisma.instanceBillingRecord.findMany({
      where: {
        instanceId: { in: ids },
        type: 'newPurchase',
        remark: { contains: '未扣费' }
      },
      select: { instanceId: true }
    })
  ])

  const out = new Set<number>()
  for (const p of promos) if (p.usedInstanceId) out.add(p.usedInstanceId)
  for (const a of adminFree) out.add(a.instanceId)
  return out
}
