function createFulfillmentReadService(deps) {
  const {
    ok,
    fail,
    SALE_STATUS,
    getSale,
    listSales,
    buildSaleProductionBoardBySale,
    getActiveOrdersBySaleWithNicknames,
    filterOrdersByFulfillmentType,
    getSaleFulfillmentPlan,
    buildFulfillmentOrderedOrders,
    toFulfillmentOrderRow,
    toEpochMs,
    buildProgressSummaryFromRows,
  } = deps

  return {
    async listFulfillmentSales(event) {
      const limit = Math.min(100, Math.max(1, Number(event.limit || 50)))
      const includeCompleted = event.includeCompleted !== false
      const sales = await listSales(limit)
      const filtered = (sales || []).filter((s) => {
        const status = String((s && s.status) || '').trim()
        if (status === SALE_STATUS.CLOSED) return true
        if (status === SALE_STATUS.FULFILLING) return true
        if (includeCompleted && status === SALE_STATUS.COMPLETED) return true
        return false
      })
      return ok({ sales: filtered })
    },

    async listPickupSales(event) {
      const limit = Math.min(100, Math.max(1, Number(event.limit || 50)))
      const includeCompleted = event.includeCompleted !== false
      const sales = await listSales(limit)
      const filtered = (sales || []).filter((s) => {
        const status = String((s && s.status) || '').trim()
        if (status === SALE_STATUS.OPEN) return true
        if (status === SALE_STATUS.CLOSED) return true
        if (status === SALE_STATUS.FULFILLING) return true
        if (includeCompleted && status === SALE_STATUS.COMPLETED) return true
        return false
      })
      return ok({ sales: filtered })
    },

    async getSaleProductionBoard(event) {
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
      if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING && saleStatus !== SALE_STATUS.COMPLETED) {
        return fail('BAD_REQUEST', 'Sale is not in production/fulfillment stage')
      }
      try {
        const board = await buildSaleProductionBoardBySale(sale)
        return ok({
          sale: {
            _id: String((sale && sale._id) || saleId),
            status: saleStatus,
            createdAt: (sale && sale.createdAt) || null,
            deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
          },
          production: {
            totalNeedQty: board.totalNeedQty,
            totalPreparedQty: board.totalPreparedQty,
            completionPercent: board.completionPercent,
            items: board.items.map((it) => ({
              dishId: it.dishId,
              dishName: it.dishNameSnapshot,
              needQty: it.needQty,
              preparedQty: it.preparedQty,
            })),
          },
          canEdit: saleStatus === SALE_STATUS.CLOSED,
        })
      } catch (err) {
        return fail('TX_FAILED', 'Load production board failed', String(err && err.message))
      }
    },

    async getSaleFulfillmentPrep(event) {
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
      if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING && saleStatus !== SALE_STATUS.COMPLETED) {
        return fail('BAD_REQUEST', 'Sale is not ready for fulfillment')
      }

      const rawOrders = await getActiveOrdersBySaleWithNicknames(saleId)
      const rawDeliveryOrders = filterOrdersByFulfillmentType(rawOrders, 'delivery')
      const rawPickupOrders = filterOrdersByFulfillmentType(rawOrders, 'pickup')
      const plan = await getSaleFulfillmentPlan(saleId)
      const mergedDelivery = buildFulfillmentOrderedOrders(rawDeliveryOrders, plan && plan.orderIds)
      const deliveryOrders = mergedDelivery.orders.map(toFulfillmentOrderRow)
      const pickupOrders = rawPickupOrders
        .slice()
        .sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))
        .map(toFulfillmentOrderRow)

      return ok({
        sale: {
          _id: String((sale && sale._id) || saleId),
          status: saleStatus,
          createdAt: (sale && sale.createdAt) || null,
          deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
          completedAt: (sale && sale.completedAt) || null,
        },
        plan: {
          exists: !!plan,
          orderIds: (plan && plan.orderIds) || [],
          updatedAt: (plan && plan.updatedAt) || null,
          updatedByOpenId: String((plan && plan.updatedByOpenId) || ''),
        },
        delivery: {
          plan: {
            exists: !!plan,
            orderIds: (plan && plan.orderIds) || [],
            updatedAt: (plan && plan.updatedAt) || null,
            updatedByOpenId: String((plan && plan.updatedByOpenId) || ''),
          },
          orders: deliveryOrders,
          appendedOrderIds: mergedDelivery.appendedOrderIds || [],
        },
        pickup: {
          orders: pickupOrders,
        },
        canEdit: saleStatus === SALE_STATUS.CLOSED || saleStatus === SALE_STATUS.FULFILLING,
      })
    },

    async getSaleFulfillmentRun(event) {
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
      if (saleStatus !== SALE_STATUS.CLOSED && saleStatus !== SALE_STATUS.FULFILLING && saleStatus !== SALE_STATUS.COMPLETED) {
        return fail('BAD_REQUEST', 'Sale is not in fulfillment stage')
      }

      const rawOrders = await getActiveOrdersBySaleWithNicknames(saleId)
      const rawDeliveryOrders = filterOrdersByFulfillmentType(rawOrders, 'delivery')
      const plan = await getSaleFulfillmentPlan(saleId)
      const merged = buildFulfillmentOrderedOrders(rawDeliveryOrders, plan && plan.orderIds)
      const orders = merged.orders.map(toFulfillmentOrderRow)
      const summary = buildProgressSummaryFromRows(orders)

      return ok({
        sale: {
          _id: String((sale && sale._id) || saleId),
          status: saleStatus,
          createdAt: (sale && sale.createdAt) || null,
          deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
          completedAt: (sale && sale.completedAt) || null,
        },
        summary: {
          totalActiveOrders: summary.totalActiveOrders,
          deliveredOrders: summary.deliveredOrders,
          paidOrders: summary.paidOrders,
          doneOrders: summary.doneOrders,
          remainingOrders: summary.remainingOrders,
        },
        orders,
        derived: {
          appendedOrderIds: merged.appendedOrderIds || [],
        },
        canOperate: saleStatus === SALE_STATUS.CLOSED || saleStatus === SALE_STATUS.FULFILLING,
      })
    },

    async getPickupRun(event) {
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
      if (
        saleStatus !== SALE_STATUS.OPEN &&
        saleStatus !== SALE_STATUS.CLOSED &&
        saleStatus !== SALE_STATUS.FULFILLING &&
        saleStatus !== SALE_STATUS.COMPLETED
      ) {
        return fail('BAD_REQUEST', 'Sale is not available for pickup run')
      }

      const rawOrders = await getActiveOrdersBySaleWithNicknames(saleId)
      const pickupOrders = filterOrdersByFulfillmentType(rawOrders, 'pickup')
        .slice()
        .sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))
        .map(toFulfillmentOrderRow)
      const summary = buildProgressSummaryFromRows(pickupOrders)

      return ok({
        sale: {
          _id: String((sale && sale._id) || saleId),
          status: saleStatus,
          createdAt: (sale && sale.createdAt) || null,
          deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
          completedAt: (sale && sale.completedAt) || null,
        },
        summary: {
          totalActiveOrders: summary.totalActiveOrders,
          deliveredOrders: summary.deliveredOrders,
          paidOrders: summary.paidOrders,
          doneOrders: summary.doneOrders,
          remainingOrders: summary.remainingOrders,
        },
        orders: pickupOrders,
        canOperate:
          saleStatus === SALE_STATUS.OPEN || saleStatus === SALE_STATUS.CLOSED || saleStatus === SALE_STATUS.FULFILLING,
      })
    },
  }
}

module.exports = {
  createFulfillmentReadService,
}
