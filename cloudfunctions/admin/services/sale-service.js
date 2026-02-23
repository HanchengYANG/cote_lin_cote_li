function createSaleService(deps) {
  const {
    cloud,
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    listSalesFn,
    getSale,
    getSaleTx,
    getOrCreateAdminConfig,
    getOrCreateRuntimeStateTx,
    parseAndValidateDeliverySlot,
    normalizeDishConfigs,
    dishConfigMap,
    getDishesByIds,
    toSafeInt,
    normalizeImageIds,
    getTempUrlMap,
    replaceSaleItemsForSale,
    replaceSaleItemsForSaleTx,
    buildOrderId,
    normalizeOrderItems,
    throwBiz,
    normalizeSaleStatusForForceSet,
    ORDER_STATUS,
    SALE_STATUS,
    HANDOFF_STATUS,
  } = deps

  return {
    async listSales(event) {
      const limit = Math.min(50, Math.max(1, Number(event.limit || 20)))
      const sales = await listSalesFn(limit)
      return ok({ sales })
    },

    async getActiveSaleEditor() {
      const cfg = await getOrCreateAdminConfig()
      const currentSaleId = String((cfg && cfg.currentSaleId) || '').trim()
      if (!currentSaleId) return ok({ sale: null, dishes: [] })
      let sale = null
      try {
        sale = await getSale(currentSaleId)
      } catch (err) {
        sale = null
      }
      if (!sale || sale.status !== 'OPEN') return ok({ sale: null, dishes: [] })
      const dishesRows = await getAllByPaging(
        (skip, limit) => db.collection('dishes').orderBy('updatedAt', 'desc').skip(skip).limit(limit),
        { pageSize: 100 }
      )
      const dishes = dishesRows.map((d) => ({
        ...d,
        images: normalizeImageIds(d.images),
      }))
      const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
      const urlMap = await getTempUrlMap(firstIds)
      const out = dishes.map((d) => ({
        ...d,
        thumbUrl: urlMap.get(d.images[0] || '') || '',
      }))
      return ok({ sale: { ...sale, dishConfigs: normalizeDishConfigs(sale.dishConfigs) }, dishes: out })
    },

    async updateActiveSaleConfig(event) {
      const cfg = await getOrCreateAdminConfig()
      const saleId = String(event.saleId || cfg.currentSaleId || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale || sale.status !== 'OPEN') return fail('BAD_REQUEST', 'Sale is not open')

      const slot = parseAndValidateDeliverySlot(event)
      const note = String(event.note || '').trim()
      const incomingConfigs = normalizeDishConfigs(event.dishConfigs)
      if (incomingConfigs.length === 0) return fail('BAD_REQUEST', 'Missing dishConfigs')
      if (!slot.ok) return fail('BAD_REQUEST', slot.message)

      const oldConfigs = normalizeDishConfigs(sale.dishConfigs)
      const oldMap = dishConfigMap(oldConfigs)
      const incomingSet = new Set(incomingConfigs.map((x) => x.dishId))
      for (const old of oldConfigs) {
        if (!incomingSet.has(old.dishId)) {
          return fail('BAD_REQUEST', 'Cannot remove existing dish in OPEN sale')
        }
      }

      const allDishIds = incomingConfigs.map((x) => x.dishId)
      const dishList = await getDishesByIds(allDishIds)
      if (dishList.length !== allDishIds.length) return fail('BAD_REQUEST', 'Dish not found')
      const dishMap = new Map((dishList || []).map((d) => [d._id, d]))

      const nextConfigs = []
      const addedDishIds = []
      for (const cfgItem of incomingConfigs) {
        const old = oldMap.get(cfgItem.dishId) || null
        const dish = dishMap.get(cfgItem.dishId)
        if (!dish) return fail('BAD_REQUEST', 'Dish not found')
        if (!old && !dish.isActive) return fail('BAD_REQUEST', 'New dish must be active')
        const soldQty = old ? toSafeInt(old.soldQty, 0) : 0
        if (cfgItem.limitQty < soldQty) {
          return fail('BAD_REQUEST', `limitQty too low for dish ${cfgItem.dishId}`)
        }
        if (!old) addedDishIds.push(cfgItem.dishId)
        nextConfigs.push({ dishId: cfgItem.dishId, limitQty: cfgItem.limitQty, soldQty })
      }

      const nextVersion = Math.max(1, toSafeInt(sale.saleConfigVersion, 0) + 1)
      await db.collection('sales').doc(saleId).update({
        data: {
          deliveryTimeSlotLabel: slot.deliveryTimeSlotLabel,
          deliverySlotDate: slot.deliverySlotDate,
          deliverySlotStartTime: slot.deliverySlotStartTime,
          deliverySlotEndTime: slot.deliverySlotEndTime,
          note,
          saleConfigVersion: nextVersion,
          updatedAt: db.serverDate(),
        },
      })
      await replaceSaleItemsForSale(saleId, nextConfigs, { dishes: dishList })
      return ok({ saleId, addedDishIds, saleConfigVersion: nextVersion })
    },

    async getOrCreateDraft() {
      const sales = await listSalesFn(50)
      const draft = (sales || []).find((s) => s.status === 'DRAFT')
      if (draft) return ok({ sale: draft })
      const now = db.serverDate()
      const addRes = await db.collection('sales').add({
        data: {
          status: 'DRAFT',
          note: '',
          deliveryTimeSlotLabel: '',
          deliverySlotDate: null,
          deliverySlotStartTime: null,
          deliverySlotEndTime: null,
          saleConfigVersion: 0,
          createdAt: now,
          updatedAt: now,
        },
      })
      const sale = await getSale(addRes._id)
      return ok({ sale })
    },

    async updateSaleDraft(event) {
      const { saleId } = event
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      const sale = await getSale(saleId)
      if (!sale || sale.status !== 'DRAFT') return fail('BAD_REQUEST', 'Sale is not draft')
      const slot = parseAndValidateDeliverySlot(event)
      const note = String(event.note || '').trim()
      const incomingConfigs = normalizeDishConfigs(event.dishConfigs)
      if (incomingConfigs.length === 0) return fail('BAD_REQUEST', 'Missing dishConfigs')
      const dishIds = incomingConfigs.map((x) => x.dishId)
      const dishList = await getDishesByIds(dishIds)
      if (dishList.length !== dishIds.length) return fail('BAD_REQUEST', 'Dish not found')
      const activeSet = new Set((dishList || []).filter((d) => d && d.isActive).map((d) => d._id))
      if (activeSet.size !== dishIds.length) return fail('BAD_REQUEST', 'Contains inactive dish')
      if (!slot.ok) return fail('BAD_REQUEST', slot.message)
      await db.collection('sales').doc(saleId).update({
        data: {
          deliveryTimeSlotLabel: slot.deliveryTimeSlotLabel,
          deliverySlotDate: slot.deliverySlotDate,
          deliverySlotStartTime: slot.deliverySlotStartTime,
          deliverySlotEndTime: slot.deliverySlotEndTime,
          note,
          saleConfigVersion: 0,
          updatedAt: db.serverDate(),
        },
      })
      await replaceSaleItemsForSale(
        saleId,
        incomingConfigs.map((x) => ({ dishId: x.dishId, limitQty: x.limitQty, soldQty: 0 })),
        { dishes: dishList }
      )
      return ok({})
    },

    async openSale(event, ctx) {
      const openId = ctx && ctx.openId
      const { saleId } = event
      const deferredOrderIds = Array.from(
        new Set(
          (Array.isArray(event.deferredOrderIds) ? event.deferredOrderIds : [])
            .map((x) => String(x || '').trim())
            .filter(Boolean)
        )
      )
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      const sale = await getSale(saleId)
      if (!sale || sale.status !== 'DRAFT') return fail('BAD_REQUEST', 'Sale is not draft')
      if (!String(sale.deliveryTimeSlotLabel || '').trim()) return fail('BAD_REQUEST', 'Missing deliveryTimeSlotLabel')
      if (!(sale.deliverySlotDate && sale.deliverySlotStartTime && sale.deliverySlotEndTime)) {
        return fail('BAD_REQUEST', 'Missing structured slot fields')
      }
      const draftConfigs = normalizeDishConfigs(sale.dishConfigs)
      if (draftConfigs.length === 0) return fail('BAD_REQUEST', 'Missing dishConfigs')
      const draftSet = new Set(draftConfigs.map((x) => x.dishId))

      try {
        const txRes = await db.runTransaction(async (tx) => {
          const runtimeCtx = await getOrCreateRuntimeStateTx(tx)
          const runtimeRef = runtimeCtx.ref
          const runtime = runtimeCtx.data || { currentSaleId: null }
          const runtimeCurrentSaleId = String((runtime && runtime.currentSaleId) || '').trim()
          if (runtimeCurrentSaleId) {
            let runtimeCurrentSale = null
            try {
              const runtimeCurrentSaleGet = await tx.collection('sales').doc(runtimeCurrentSaleId).get()
              runtimeCurrentSale = runtimeCurrentSaleGet.data
            } catch (err) {
              runtimeCurrentSale = null
            }
            if (runtimeCurrentSale && String((runtimeCurrentSale && runtimeCurrentSale.status) || '').trim() === SALE_STATUS.OPEN) {
              return { blocked: true, currentSaleId: runtimeCurrentSaleId }
            }
          }

          // Safety net: if runtime state is missing currentSaleId but there is an OPEN sale, block opening.
          const openSales = await tx.collection('sales').where({ status: 'OPEN' }).limit(1).get()
          const existingOpen = (openSales.data && openSales.data[0]) || null
          if (existingOpen && existingOpen._id) {
            await runtimeRef.update({ data: { currentSaleId: existingOpen._id, updatedAt: db.serverDate() } })
            return { blocked: true, currentSaleId: existingOpen._id }
          }

          const deferredOrders = []
          for (const orderId of deferredOrderIds) {
            let order = null
            try {
              const got = await tx.collection('orders').doc(orderId).get()
              order = got.data
            } catch (err) {
              order = null
            }
            if (!order) throwBiz('ORDER_NOT_FOUND', `待确认订单不存在: ${orderId}`)
            if (order.status !== ORDER_STATUS.PENDING_REVIEW) throwBiz('ORDER_NOT_PENDING', `订单不是待确认状态: ${orderId}`)
            deferredOrders.push(order)
          }

          const deferredDemand = new Map()
          const deferredMissing = []
          for (const order of deferredOrders) {
            const items = normalizeOrderItems(order.items)
            if (items.length === 0) throwBiz('BAD_REQUEST', `待确认订单无有效菜品: ${order._id}`)
            for (const it of items) {
              if (!draftSet.has(it.dishId)) {
                const rawItem = (order.items || []).find((x) => x && x.dishId === it.dishId)
                deferredMissing.push({
                  orderId: order._id,
                  dishId: it.dishId,
                  dishName: String((rawItem && rawItem.dishName) || ''),
                })
                continue
              }
              deferredDemand.set(it.dishId, (deferredDemand.get(it.dishId) || 0) + it.qty)
            }
          }
          if (deferredMissing.length > 0) {
            throwBiz('DEFERRED_ORDER_DISH_MISSING', '勾选的延后订单包含本次未售卖菜品', { items: deferredMissing })
          }

          const shortage = []
          for (const cfgItem of draftConfigs) {
            const needQty = toSafeInt(deferredDemand.get(cfgItem.dishId), 0)
            if (needQty > cfgItem.limitQty) {
              shortage.push({
                dishId: cfgItem.dishId,
                requiredQty: needQty,
                limitQty: cfgItem.limitQty,
                exceedBy: needQty - cfgItem.limitQty,
              })
            }
          }
          if (shortage.length > 0) {
            throwBiz('DEFERRED_ORDER_STOCK_EXCEED', '勾选的延后订单库存需求超过本次开单总量', { items: shortage })
          }

          const openedConfigs = draftConfigs.map((cfgItem) => {
            const soldQty = toSafeInt(deferredDemand.get(cfgItem.dishId), 0)
            return {
              dishId: cfgItem.dishId,
              limitQty: cfgItem.limitQty,
              soldQty: Math.max(0, Math.min(cfgItem.limitQty, soldQty)),
            }
          })

          await runtimeRef.update({ data: { currentSaleId: saleId, updatedAt: db.serverDate() } })
          await tx.collection('sales').doc(saleId).update({
            data: {
              status: 'OPEN',
              saleConfigVersion: 1,
              openedAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          })
          await replaceSaleItemsForSaleTx(tx, saleId, openedConfigs)

          const seenTargetOrderIds = new Set()
          for (const order of deferredOrders) {
            const targetOrderId = buildOrderId(saleId, order.customerOpenId)
            if (seenTargetOrderIds.has(targetOrderId)) {
              throwBiz('DEFERRED_ORDER_DUPLICATE_CUSTOMER', '勾选的延后订单存在同一顾客重复订单')
            }
            seenTargetOrderIds.add(targetOrderId)

            if (targetOrderId !== order._id) {
              let existingTarget = null
              try {
                const got = await tx.collection('orders').doc(targetOrderId).get()
                existingTarget = got.data
              } catch (err) {
                existingTarget = null
              }
              if (existingTarget) {
                throwBiz('DEFERRED_ORDER_TARGET_EXISTS', `目标订单已存在，无法迁移: ${targetOrderId}`)
              }
            }
          }

          for (const order of deferredOrders) {
            const targetOrderId = buildOrderId(saleId, order.customerOpenId)
            const now = db.serverDate()
            const nextData = {
              ...order,
              saleId,
              status: ORDER_STATUS.ACTIVE,
              handoffStatus: HANDOFF_STATUS.PENDING,
              handedOffAt: null,
              handedOffByOpenId: null,
              deliveryTimeSlotLabelSnapshot:
                order.fulfillmentType === 'delivery' ? String(sale.deliveryTimeSlotLabel || '').trim() : null,
              acceptDeliverySlot: order.fulfillmentType === 'delivery' ? true : false,
              saleConfigVersionSnapshot: 1,
              approvedAt: now,
              customerLocked: true,
              customerLockedAt: now,
              customerLockedReason: 'ADMIN_APPROVED_PENDING',
              updatedAt: now,
            }
            delete nextData._id
            delete nextData.pendingReason
            delete nextData.pendingDetail
            delete nextData.pendingAt
            delete nextData.rejectedAt
            delete nextData.rejectedByOpenId
            delete nextData.rejectedReason
            delete nextData.cancelledAt
            delete nextData.cancelledByOpenId

            if (targetOrderId === order._id) {
              await tx.collection('orders').doc(order._id).update({
                data: {
                  saleId: nextData.saleId,
                  status: nextData.status,
                  handoffStatus: HANDOFF_STATUS.PENDING,
                  handedOffAt: _.remove,
                  handedOffByOpenId: _.remove,
                  deliveryTimeSlotLabelSnapshot: nextData.deliveryTimeSlotLabelSnapshot,
                  acceptDeliverySlot: nextData.acceptDeliverySlot,
                  saleConfigVersionSnapshot: nextData.saleConfigVersionSnapshot,
                  pendingReason: _.remove,
                  pendingDetail: _.remove,
                  pendingAt: _.remove,
                  approvedAt: now,
                  customerLocked: true,
                  customerLockedAt: now,
                  customerLockedReason: 'ADMIN_APPROVED_PENDING',
                  updatedAt: now,
                  rejectedAt: _.remove,
                  rejectedByOpenId: _.remove,
                  rejectedReason: _.remove,
                  cancelledAt: _.remove,
                  cancelledByOpenId: _.remove,
                },
              })
            } else {
              await tx.collection('orders').doc(targetOrderId).set({ data: nextData })
              await tx.collection('orders').doc(order._id).remove()
            }
            await tx.collection('orderAuditLogs').add({
              data: {
                orderId: targetOrderId,
                action: 'DEFERRED_APPROVE_ON_OPEN',
                byOpenId: openId,
                at: now,
              },
            })
          }

          return { blocked: false, deferredApprovedCount: deferredOrders.length }
        })
        if (txRes && txRes.blocked) return fail('ACTIVE_SALE_EXISTS', '已有开单中开单，请先截单', { currentSaleId: txRes.currentSaleId })
        return ok({ deferredApprovedCount: toSafeInt(txRes && txRes.deferredApprovedCount, 0) })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Open sale failed', err.detail)
        return fail('TX_FAILED', 'Open sale failed', String(err && err.message))
      }
    },

    async closeSale(event) {
      const { saleId } = event
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      try {
        await db.runTransaction(async (tx) => {
          const runtimeCtx = await getOrCreateRuntimeStateTx(tx)
          const runtimeRef = runtimeCtx.ref
          const runtime = runtimeCtx.data || { currentSaleId: null }
          const currentSaleId = String((runtime && runtime.currentSaleId) || '').trim()
          if (!currentSaleId || currentSaleId !== saleId) {
            throw Object.assign(new Error('NOT_ACTIVE'), { code: 'NOT_ACTIVE' })
          }
          await runtimeRef.update({ data: { currentSaleId: saleId, updatedAt: db.serverDate() } })
          await tx.collection('sales').doc(saleId).update({
            data: { status: 'CLOSED', closedAt: db.serverDate(), updatedAt: db.serverDate() },
          })
        })
      } catch (err) {
        return fail('TX_FAILED', 'Close sale failed', String(err && err.message))
      }
      return ok({})
    },

    async forceSetCurrentSaleStatus(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      const nextStatus = normalizeSaleStatusForForceSet(event && event.status)
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      if (!nextStatus) return fail('BAD_REQUEST', 'Invalid status')
      try {
        const txRes = await db.runTransaction(async (tx) => {
          let sale = null
          try {
            const got = await tx.collection('sales').doc(saleId).get()
            sale = got.data
          } catch (err) {
            sale = null
          }
          if (!sale) throwBiz('NOT_FOUND', 'Sale not found')

          const prevStatus = String((sale && sale.status) || '').trim()
          const now = db.serverDate()
          const saleUpdate = {
            status: nextStatus,
            updatedAt: now,
          }
          if (nextStatus === SALE_STATUS.OPEN) saleUpdate.openedAt = now
          if (nextStatus === SALE_STATUS.CLOSED) saleUpdate.closedAt = now
          if (nextStatus === SALE_STATUS.FULFILLING) {
            saleUpdate.fulfillingAt = now
            saleUpdate.fulfillingByOpenId = openId
          }
          if (nextStatus === SALE_STATUS.COMPLETED) {
            saleUpdate.completedAt = now
            saleUpdate.completedByOpenId = openId
          }
          await tx.collection('sales').doc(saleId).update({ data: saleUpdate })

          const runtimeCtx = await getOrCreateRuntimeStateTx(tx)
          const runtimeRef = runtimeCtx.ref
          let currentSaleId = String((runtimeCtx.data && runtimeCtx.data.currentSaleId) || '').trim()
          if (nextStatus === SALE_STATUS.OPEN || nextStatus === SALE_STATUS.CLOSED || nextStatus === SALE_STATUS.FULFILLING) {
            currentSaleId = saleId
          } else if (currentSaleId === saleId) {
            currentSaleId = ''
          }
          await runtimeRef.update({
            data: {
              currentSaleId: currentSaleId || null,
              updatedAt: now,
            },
          })

          return {
            saleId,
            fromStatus: prevStatus,
            toStatus: nextStatus,
            currentSaleId: currentSaleId || null,
          }
        })
        return ok(txRes || {})
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Force set sale status failed', err.detail)
        return fail('TX_FAILED', 'Force set sale status failed', String(err && err.message))
      }
    },
  }
}

module.exports = {
  createSaleService,
}
