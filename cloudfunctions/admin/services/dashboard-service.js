function createDashboardService(deps) {
  const {
    db,
    ok,
    getAllByPaging,
    getOrCreateAdminConfig,
    listSales,
    getSale,
    ORDER_STATUS,
    SALE_STATUS,
    toFulfillmentOrderRow,
    sumRevenueCentsFromRows,
    normalizeDishConfigs,
    getDishesByIds,
    toSafeInt,
    buildSaleProductionBoardBySale,
    buildFulfillingOpsSummaryFromRows,
  } = deps

  return {
    async getDashboard() {
      const cfg = await getOrCreateAdminConfig()
      let currentSaleId = String((cfg && cfg.currentSaleId) || '').trim()
      let activeSale = null
      let orderCount = 0
      let activeSaleRevenueCents = 0
      let activeSaleRevenueEuro = '0.00'
      let activeSaleDishStats = []
      let activeSaleOpsSummary = null
      let canCompleteActiveSale = false
      let activeSaleIncompleteReason = null
      if (!currentSaleId) {
        try {
          const fallbackSales = await listSales(20)
          const fallbackSale = (fallbackSales || []).find((s) => {
            const status = String((s && s.status) || '').trim()
            return status === SALE_STATUS.OPEN || status === SALE_STATUS.CLOSED || status === SALE_STATUS.FULFILLING
          })
          currentSaleId = String((fallbackSale && fallbackSale._id) || '').trim()
        } catch (err) {
          currentSaleId = ''
        }
      }

      if (currentSaleId) {
        try {
          activeSale = await getSale(currentSaleId)
          if (activeSale && String(activeSale.status || '').trim() === SALE_STATUS.COMPLETED) {
            activeSale = null
          } else if (activeSale) {
            const allOrders = await getAllByPaging(
              (skip, limit) => db.collection('orders').where({ saleId: currentSaleId }).skip(skip).limit(limit),
              { pageSize: 100 }
            )
            const activeOrders = allOrders.filter((x) => String((x && x.status) || '').trim() === ORDER_STATUS.ACTIVE)
            orderCount = activeOrders.length
            const activeRows = activeOrders.map(toFulfillmentOrderRow)
            activeSaleRevenueCents = sumRevenueCentsFromRows(activeRows)
            activeSaleRevenueEuro = (Number(activeSaleRevenueCents || 0) / 100).toFixed(2)
            const saleStatus = String((activeSale && activeSale.status) || '').trim()

            if (saleStatus === SALE_STATUS.OPEN) {
              const dishConfigs = normalizeDishConfigs(activeSale && activeSale.dishConfigs)
              if (dishConfigs.length > 0) {
                const dishes = await getDishesByIds(dishConfigs.map((x) => x.dishId))
                const dishNameMap = new Map((dishes || []).map((d) => [String(d._id || ''), String(d.name || d._id || '')]))
                activeSaleDishStats = dishConfigs
                  .map((cfgItem) => {
                    const dishId = String(cfgItem.dishId || '')
                    const soldQty = toSafeInt(cfgItem.soldQty, 0)
                    const limitQty = toSafeInt(cfgItem.limitQty, 0)
                    return {
                      dishId,
                      dishName: dishNameMap.get(dishId) || dishId || '未知菜品',
                      soldQty,
                      limitQty,
                      remainingQty: Math.max(0, limitQty - soldQty),
                    }
                  })
                  .sort((a, b) => {
                    if (b.soldQty !== a.soldQty) return b.soldQty - a.soldQty
                    return String(a.dishName || '').localeCompare(String(b.dishName || ''))
                  })
              }
              activeSaleOpsSummary = {
                saleStatus,
                open: {
                  orderCount,
                },
              }
            }

            if (saleStatus === SALE_STATUS.CLOSED) {
              const production = await buildSaleProductionBoardBySale(activeSale)
              activeSaleOpsSummary = {
                saleStatus,
                closed: {
                  production: {
                    totalNeedQty: production.totalNeedQty,
                    totalPreparedQty: production.totalPreparedQty,
                    completionPercent: production.completionPercent,
                    items: production.items.map((it) => ({
                      dishId: it.dishId,
                      dishName: it.dishNameSnapshot,
                      needQty: it.needQty,
                      preparedQty: it.preparedQty,
                    })),
                  },
                },
              }
            }

            if (saleStatus === SALE_STATUS.FULFILLING) {
              const ops = buildFulfillingOpsSummaryFromRows(activeRows)
              let production = null
              try {
                const productionBoard = await buildSaleProductionBoardBySale(activeSale)
                production = {
                  totalNeedQty: productionBoard.totalNeedQty,
                  totalPreparedQty: productionBoard.totalPreparedQty,
                  completionPercent: productionBoard.completionPercent,
                  items: (productionBoard.items || []).map((it) => ({
                    dishId: it.dishId,
                    dishName: it.dishNameSnapshot,
                    needQty: it.needQty,
                    preparedQty: it.preparedQty,
                  })),
                }
              } catch (err) {
                production = null
              }
              activeSaleOpsSummary = {
                saleStatus,
                fulfilling: ops,
              }
              if (production) activeSaleOpsSummary.fulfilling.production = production
              canCompleteActiveSale = ops.remainingOrders === 0
              if (!canCompleteActiveSale) {
                activeSaleIncompleteReason = {
                  undeliveredCount: Math.max(0, ops.totalActiveOrders - ops.deliveredOrders),
                  unpaidCount: Math.max(0, ops.totalActiveOrders - ops.paidOrders),
                }
              }
            }
          }
        } catch (err) {
          activeSale = null
          activeSaleDishStats = []
          activeSaleRevenueCents = 0
          activeSaleRevenueEuro = '0.00'
          activeSaleOpsSummary = null
          canCompleteActiveSale = false
          activeSaleIncompleteReason = null
        }
      }
      return ok({
        activeSale,
        stats: { orderCount },
        activeSaleRevenueCents,
        activeSaleRevenueEuro,
        activeSaleDishStats,
        activeSaleOpsSummary,
        canCompleteActiveSale,
        activeSaleIncompleteReason,
      })
    },
  }
}

module.exports = {
  createDashboardService,
}
