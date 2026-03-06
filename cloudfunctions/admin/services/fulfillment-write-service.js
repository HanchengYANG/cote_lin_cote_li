function createFulfillmentWriteService(deps) {
  const {
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    toSafeInt,
    getSale,
    SALE_STATUS,
    ORDER_STATUS,
    HANDOFF_STATUS,
    PAID_STATUS,
    buildSaleProductionBoardBySale,
    saveSaleProductionProgressBoard,
    getActiveOrdersBySaleWithNicknames,
    filterOrdersByFulfillmentType,
    toEpochMs,
    saveSaleFulfillmentPlan,
    normalizePaymentMethodForAdmin,
    normalizePaidStatus,
    normalizeHandoffStatus,
    throwBiz,
    getOrCreateRuntimeStateTx,
  } = deps

  function toProductionPayload(items) {
    const nextItems = Array.isArray(items) ? items : []
    let totalNeedOrderQty = 0
    let totalNeedPieceQty = 0
    let totalPreparedPieceQty = 0
    let totalPreparedCapped = 0
    nextItems.forEach((it) => {
      const needOrderQty = Math.max(0, toSafeInt(it && it.needOrderQty, 0))
      const needPieceQty = Math.max(0, toSafeInt(it && it.needPieceQty, 0))
      const preparedPieceQty = Math.max(0, toSafeInt(it && it.preparedPieceQty, 0))
      totalNeedOrderQty += needOrderQty
      totalNeedPieceQty += needPieceQty
      totalPreparedPieceQty += preparedPieceQty
      totalPreparedCapped += Math.min(needPieceQty, preparedPieceQty)
    })
    const completionPercent =
      totalNeedPieceQty > 0 ? Math.max(0, Math.min(100, Math.round((totalPreparedCapped * 100) / totalNeedPieceQty))) : 0
    return {
      totalNeedOrderQty,
      totalNeedPieceQty,
      totalPreparedPieceQty,
      completionPercent,
      items: nextItems.map((it) => ({
        dishId: it.dishId,
        dishName: it.dishNameSnapshot,
        needOrderQty: it.needOrderQty,
        needPieceQty: it.needPieceQty,
        preparedPieceQty: it.preparedPieceQty,
      })),
    }
  }

  function buildLegacyAddressRemovePatch(order) {
    return order && Object.prototype.hasOwnProperty.call(order, 'address') ? { address: _.remove } : {}
  }

  return {
    async updateSaleProductionProgress(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      const dishId = String(event.dishId || '').trim()
      const preparedPieceQty = Math.max(0, toSafeInt(event.preparedPieceQty != null ? event.preparedPieceQty : event.preparedQty, 0))
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale) return fail('NOT_FOUND', 'Sale not found')
      const saleStatus = String((sale && sale.status) || '').trim()
      if (saleStatus !== SALE_STATUS.CLOSED) return fail('BAD_REQUEST', 'Only CLOSED sale can update production progress')
      try {
        const board = await buildSaleProductionBoardBySale(sale)
        const idx = board.items.findIndex((it) => String(it.dishId || '').trim() === dishId)
        if (idx < 0) return fail('BAD_REQUEST', 'Dish not found in sale')
        const nextItems = board.items.map((it, i) => (i === idx ? { ...it, preparedPieceQty } : it))
        await saveSaleProductionProgressBoard(saleId, nextItems, openId)
        return ok({
          saleId,
          dishId,
          preparedPieceQty,
          production: toProductionPayload(nextItems),
        })
      } catch (err) {
        const msg = String((err && (err.errMsg || err.message)) || '')
        if (/collection not exists|Db or Table not exist/i.test(msg)) {
          return fail('COLLECTION_NOT_FOUND', '请先创建数据库集合 sale_production_progress', msg)
        }
        return fail('TX_FAILED', 'Update production progress failed', msg || String(err))
      }
    },

    async saveSaleProductionBoard(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      const rawItems = Array.isArray(event.items) ? event.items : null
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      if (!rawItems) return fail('BAD_REQUEST', 'Missing items')

      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale) return fail('NOT_FOUND', 'Sale not found')
      const saleStatus = String((sale && sale.status) || '').trim()
      if (saleStatus !== SALE_STATUS.CLOSED) return fail('BAD_REQUEST', 'Only CLOSED sale can save production board')

      try {
        const board = await buildSaleProductionBoardBySale(sale)
        const boardDishIds = new Set(
          (Array.isArray(board && board.items) ? board.items : []).map((it) => String((it && it.dishId) || '').trim()).filter(Boolean)
        )
        const preparedMap = new Map()
        const invalidDishIds = []
        rawItems.forEach((it) => {
          const dishId = String((it && it.dishId) || '').trim()
          if (!dishId) return
          if (!boardDishIds.has(dishId)) {
            invalidDishIds.push(dishId)
            return
          }
          preparedMap.set(dishId, Math.max(0, toSafeInt(it && (it.preparedPieceQty != null ? it.preparedPieceQty : it.preparedQty), 0)))
        })
        if (invalidDishIds.length) {
          return fail('BAD_REQUEST', 'Contains invalid dishIds', { invalidDishIds })
        }
        const nextItems = (Array.isArray(board && board.items) ? board.items : []).map((it) => {
          const dishId = String((it && it.dishId) || '').trim()
          if (!preparedMap.has(dishId)) return { ...it }
          return { ...it, preparedPieceQty: preparedMap.get(dishId) }
        })
        await saveSaleProductionProgressBoard(saleId, nextItems, openId)
        return ok({
          saleId,
          production: toProductionPayload(nextItems),
        })
      } catch (err) {
        const msg = String((err && (err.errMsg || err.message)) || '')
        if (/collection not exists|Db or Table not exist/i.test(msg)) {
          return fail('COLLECTION_NOT_FOUND', '请先创建数据库集合 sale_production_progress', msg)
        }
        return fail('TX_FAILED', 'Save production board failed', msg || String(err))
      }
    },

    async saveSaleFulfillmentOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      const incomingOrderIds = Array.isArray(event.orderIds) ? event.orderIds : []
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')

      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale) return fail('NOT_FOUND', 'Sale not found')
      const saleStatus = String((sale && sale.status) || '').trim()
      if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING) {
        return fail('BAD_REQUEST', 'Only CLOSED/FULFILLING sale can save fulfillment order')
      }

      const activeOrders = await getActiveOrdersBySaleWithNicknames(saleId)
      const deliveryOrders = filterOrdersByFulfillmentType(activeOrders, 'delivery')
      const deliveryIds = new Set(deliveryOrders.map((o) => String((o && o._id) || '').trim()).filter(Boolean))

      const sanitized = []
      const seen = new Set()
      const invalidOrderIds = []
      for (const rawId of incomingOrderIds) {
        const id = String(rawId || '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (!deliveryIds.has(id)) {
          invalidOrderIds.push(id)
          continue
        }
        sanitized.push(id)
      }
      if (invalidOrderIds.length > 0) {
        return fail('BAD_REQUEST', 'Contains invalid orderIds', { invalidOrderIds })
      }

      const missingIds = deliveryOrders
        .filter((o) => {
          const id = String((o && o._id) || '').trim()
          return !!id && !seen.has(id)
        })
        .sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))
        .map((o) => String((o && o._id) || '').trim())
        .filter(Boolean)
      const finalOrderIds = sanitized.concat(missingIds)

      try {
        await saveSaleFulfillmentPlan(saleId, finalOrderIds, openId)
      } catch (err) {
        const msg = String((err && (err.errMsg || err.message)) || '')
        if (/collection not exists|Db or Table not exist/i.test(msg)) {
          return fail('COLLECTION_NOT_FOUND', '请先创建数据库集合 sale_fulfillment_plans', msg)
        }
        return fail('TX_FAILED', 'Save fulfillment order failed', String(err && err.message))
      }

      return ok({
        orderIds: finalOrderIds,
        appendedOrderIds: missingIds,
        saleStatusChanged: null,
      })
    },

    async markSalePrepDone(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale) return fail('NOT_FOUND', 'Sale not found')
      const saleStatus = String((sale && sale.status) || '').trim()
      if (saleStatus !== SALE_STATUS.CLOSED) {
        return fail('SALE_STATUS_INVALID', 'Only CLOSED sale can be marked prep done', { status: saleStatus })
      }
      await db.collection('sales').doc(saleId).update({
        data: {
          status: SALE_STATUS.FULFILLING,
          fulfillingAt: db.serverDate(),
          fulfillingByOpenId: openId,
          updatedAt: db.serverDate(),
        },
      })
      try {
        await db.collection('system_runtime_state').doc('main').set({
          data: {
            currentSaleId: saleId,
            updatedAt: db.serverDate(),
          },
        })
      } catch (err) {
        // Best effort. Dashboard can fallback by sale status.
      }
      return ok({
        saleId,
        status: SALE_STATUS.FULFILLING,
        changed: true,
      })
    },

    async updateOrderPaymentMethod(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      const paymentMethod = normalizePaymentMethodForAdmin(event && event.paymentMethod)
      if (!paymentMethod) return fail('BAD_REQUEST', 'Invalid paymentMethod')
      try {
        const txRes = await db.runTransaction(async (tx) => {
          let order = null
          try {
            const got = await tx.collection('orders').doc(orderId).get()
            order = got.data
          } catch (err) {
            order = null
          }
          if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
          const orderStatus = String((order && order.status) || '').trim()
          if (orderStatus !== ORDER_STATUS.ACTIVE && orderStatus !== ORDER_STATUS.PENDING_REVIEW) {
            throwBiz('ORDER_NOT_EDITABLE', 'Order payment method is not editable')
          }
          const currentPayment = order && order.payment ? order.payment : {}
          const currentMethod = normalizePaymentMethodForAdmin(currentPayment.method) || 'cash'
          if (currentMethod === paymentMethod) {
            return { changed: false, paymentMethod: currentMethod }
          }
          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              payment: {
                ...currentPayment,
                method: paymentMethod,
              },
              ...buildLegacyAddressRemovePatch(order),
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'ADMIN_UPDATE_PAYMENT_METHOD',
              byOpenId: openId,
              at: now,
              detail: {
                paymentMethod: { from: currentMethod, to: paymentMethod },
              },
            },
          })
          return { changed: true, paymentMethod }
        })
        return ok(txRes || {})
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Update failed', err.detail)
        return fail('TX_FAILED', 'Update failed', String(err && err.message))
      }
    },

    async updateOrderFulfillmentProgress(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      const saleIdInput = String(event.saleId || '').trim()
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      const hasPaymentMethod = Object.prototype.hasOwnProperty.call(event || {}, 'paymentMethod')
      const hasPaidStatus = Object.prototype.hasOwnProperty.call(event || {}, 'paidStatus')
      const hasHandoffStatus = Object.prototype.hasOwnProperty.call(event || {}, 'handoffStatus')
      if (!hasPaymentMethod && !hasPaidStatus && !hasHandoffStatus) {
        return fail('BAD_REQUEST', 'No changes')
      }

      const normalizedMethod = hasPaymentMethod ? normalizePaymentMethodForAdmin(event.paymentMethod) : ''
      if (hasPaymentMethod && !normalizedMethod) return fail('BAD_REQUEST', 'Invalid paymentMethod')
      const normalizedPaidStatus = hasPaidStatus ? normalizePaidStatus(event.paidStatus) : ''
      const normalizedHandoffStatus = hasHandoffStatus ? normalizeHandoffStatus(event.handoffStatus) : ''

      try {
        const txRes = await db.runTransaction(async (tx) => {
          let order = null
          try {
            const got = await tx.collection('orders').doc(orderId).get()
            order = got.data
          } catch (err) {
            order = null
          }
          if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
          if (order.status !== ORDER_STATUS.ACTIVE) throwBiz('ORDER_NOT_EDITABLE', 'Only ACTIVE order can update fulfillment progress')
          if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')
          if (saleIdInput && saleIdInput !== String(order.saleId || '')) throwBiz('BAD_REQUEST', 'Sale mismatch')

          let sale = null
          try {
            const saleGet = await tx.collection('sales').doc(order.saleId).get()
            sale = saleGet.data
          } catch (err) {
            sale = null
          }
          if (!sale) throwBiz('NOT_FOUND', 'Sale not found')
          const saleStatus = String((sale && sale.status) || '').trim()
          if (saleStatus === SALE_STATUS.COMPLETED) throwBiz('SALE_COMPLETED', 'Sale already completed')
          const orderFulfillmentType = String((order && order.fulfillmentType) || '').trim()
          const isPickupOrder = orderFulfillmentType === 'pickup'
          if (isPickupOrder) {
            if (
              saleStatus !== SALE_STATUS.OPEN &&
              saleStatus !== SALE_STATUS.CLOSED &&
              saleStatus !== SALE_STATUS.FULFILLING
            ) {
              throwBiz('BAD_REQUEST', 'Pickup order cannot update in current sale status')
            }
          } else if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING) {
            throwBiz('BAD_REQUEST', 'Delivery order can only update after sale closed')
          }

          const currentPayment = order && order.payment ? order.payment : {}
          const currentMethod = normalizePaymentMethodForAdmin(currentPayment.method) || String(currentPayment.method || 'cash')
          const currentPaid = normalizePaidStatus(currentPayment.paidStatus)
          const currentHandoff = normalizeHandoffStatus(order && order.handoffStatus)

          const nextMethod = hasPaymentMethod ? normalizedMethod : currentMethod
          const nextPaid = hasPaidStatus ? normalizedPaidStatus : currentPaid
          const nextHandoff = hasHandoffStatus ? normalizedHandoffStatus : currentHandoff
          if (nextMethod === currentMethod && nextPaid === currentPaid && nextHandoff === currentHandoff) {
            return {
              changed: false,
              next: { paymentMethod: nextMethod, paidStatus: nextPaid, handoffStatus: nextHandoff },
              saleStatusChanged: null,
            }
          }

          const now = db.serverDate()
          const updateData = {
            payment: {
              ...currentPayment,
              method: nextMethod,
              paidStatus: nextPaid,
            },
            handoffStatus: nextHandoff,
            ...buildLegacyAddressRemovePatch(order),
            updatedAt: now,
          }
          if (currentHandoff !== HANDOFF_STATUS.DELIVERED && nextHandoff === HANDOFF_STATUS.DELIVERED) {
            updateData.handedOffAt = now
            updateData.handedOffByOpenId = openId
          } else if (currentHandoff === HANDOFF_STATUS.DELIVERED && nextHandoff !== HANDOFF_STATUS.DELIVERED) {
            updateData.handedOffAt = _.remove
            updateData.handedOffByOpenId = _.remove
          }

          await tx.collection('orders').doc(orderId).update({ data: updateData })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'ADMIN_UPDATE_FULFILLMENT_PROGRESS',
              byOpenId: openId,
              at: now,
              detail: {
                paymentMethod: { from: currentMethod, to: nextMethod },
                paidStatus: { from: currentPaid, to: nextPaid },
                handoffStatus: { from: currentHandoff, to: nextHandoff },
              },
            },
          })
          return {
            changed: true,
            next: { paymentMethod: nextMethod, paidStatus: nextPaid, handoffStatus: nextHandoff },
            saleStatusChanged: null,
          }
        })
        return ok(txRes || {})
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Update failed', err.detail)
        return fail('TX_FAILED', 'Update failed', String(err && err.message))
      }
    },

    async completeSaleFulfillment(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
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
          const saleStatus = String((sale && sale.status) || '').trim()
          if (saleStatus === SALE_STATUS.COMPLETED) throwBiz('SALE_COMPLETED', 'Sale already completed')
          if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING) {
            throwBiz('BAD_REQUEST', 'Sale is not in fulfilling stage')
          }

          const orders = await getAllByPaging(
            (skip, limit) => tx.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).skip(skip).limit(limit),
            { pageSize: 100 }
          )
          let undeliveredCount = 0
          let unpaidCount = 0
          for (const o of orders) {
            const delivered = normalizeHandoffStatus(o && o.handoffStatus) === HANDOFF_STATUS.DELIVERED
            const paid = normalizePaidStatus(o && o.payment && o.payment.paidStatus) === PAID_STATUS.PAID
            if (!delivered) undeliveredCount += 1
            if (!paid) unpaidCount += 1
          }
          if (undeliveredCount > 0 || unpaidCount > 0) {
            throwBiz('SALE_NOT_READY_TO_COMPLETE', 'Sale fulfillment not complete', {
              totalActiveOrders: orders.length,
              undeliveredCount,
              unpaidCount,
            })
          }
          const now = db.serverDate()
          await tx.collection('sales').doc(saleId).update({
            data: {
              status: SALE_STATUS.COMPLETED,
              completedAt: now,
              completedByOpenId: openId,
              updatedAt: now,
            },
          })
          try {
            const runtimeCtx = await getOrCreateRuntimeStateTx(tx)
            await runtimeCtx.ref.update({
              data: {
                currentSaleId: null,
                updatedAt: db.serverDate(),
              },
            })
          } catch (err) {
            // Do not fail completion for config cleanup issue.
          }
          return {
            saleId,
            status: SALE_STATUS.COMPLETED,
            summary: {
              totalActiveOrders: orders.length,
              doneOrders: orders.length,
              undeliveredCount: 0,
              unpaidCount: 0,
            },
          }
        })
        return ok(txRes || {})
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Complete sale failed', err.detail)
        return fail('TX_FAILED', 'Complete sale failed', String(err && err.message))
      }
    },
  }
}

module.exports = {
  createFulfillmentWriteService,
}


