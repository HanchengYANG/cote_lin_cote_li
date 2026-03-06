function createReadService(deps) {
  const {
    db,
    ok,
    fail,
    getAllByPaging,
    ORDER_STATUS,
    pickLatestOrder,
    normalizePhone,
    normalizeImageIds,
    getTempUrlMap,
    getCurrentSaleDoc,
    getOrderableSale,
    normalizeSaleDishConfigs,
    validateSaleDishConfigs,
    getDishesByIds,
    ensureCustomerDoc,
    toProfileSummary,
    mdToSafeHtml,
  } = deps

  return {
    async listActiveDishesForBrowse() {
      const rows = await getAllByPaging(
        (skip, limit) =>
          db
            .collection('dishes')
            .where({ isActive: true })
            .orderBy('updatedAt', 'desc')
            .skip(skip)
            .limit(limit),
        { pageSize: 100 }
      )
      const dishes = rows.map((d) => ({
        ...d,
        piecesPerOrderQty: Math.max(1, Number(d.piecesPerOrderQty) || 1),
        images: normalizeImageIds(d.images),
        descPlain: String(d.descPlain || ''),
      }))
      const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
      const urlMap = await getTempUrlMap(firstIds)
      const out = dishes.map((d) => ({
        _id: d._id,
        name: d.name,
        priceCents: d.priceCents || 0,
        piecesPerOrderQty: Math.max(1, Number(d.piecesPerOrderQty) || 1),
        descPlain: d.descPlain,
        images: d.images,
        thumbUrl: urlMap.get(d.images[0] || '') || '',
      }))
      return ok({ dishes: out })
    },

    async bootstrapHome(_event, ctx) {
      const openId = ctx && ctx.openId
      const sale = await getCurrentSaleDoc()
      const profileDoc = await ensureCustomerDoc(openId)
      let myCurrentSaleOrder = null
      if (sale && sale._id && openId) {
        let activeOrder = null
        try {
          const activeRes = await db
            .collection('orders')
            .where({
              saleId: String(sale._id),
              customerOpenId: openId,
              status: ORDER_STATUS.ACTIVE,
            })
            .limit(20)
            .get()
          activeOrder = pickLatestOrder(activeRes.data || [])
        } catch (err) {
          activeOrder = null
        }
        myCurrentSaleOrder = {
          hasActiveOrder: !!activeOrder,
          fulfillmentType: activeOrder ? String(activeOrder.fulfillmentType || '').trim() : '',
        }
      }
      const rows = await getAllByPaging(
        (skip, limit) =>
          db
            .collection('dishes')
            .where({ isActive: true })
            .orderBy('updatedAt', 'desc')
            .skip(skip)
            .limit(limit),
        { pageSize: 100 }
      )
      const dishes = rows.map((d) => ({
        ...d,
        images: normalizeImageIds(d.images),
        descPlain: String(d.descPlain || ''),
      }))
      const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
      const urlMap = await getTempUrlMap(firstIds)

      const saleStatus = String((sale && sale.status) || '').trim()
      let saleInfo = {
        saleId: String((sale && sale._id) || ''),
        status: saleStatus || '',
        deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
        note: String((sale && sale.note) || '').trim(),
      }
      let cfgMap = new Map()
      if (sale && saleStatus === 'OPEN') {
        const normalizedConfigs = normalizeSaleDishConfigs(sale)
        const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
        if (!configCheck.ok) return fail('SALE_CONFIG_INVALID', configCheck.message)
        cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
      }

      const out = dishes.map((d) => {
        const cfg = cfgMap.get(d._id) || null
        const limitQty = cfg ? cfg.limitQty : 0
        const soldQty = cfg ? cfg.soldQty : 0
        const remainingQty = cfg ? Math.max(0, limitQty - soldQty) : 0
        return {
          _id: d._id,
          name: d.name,
          priceCents: d.priceCents || 0,
          piecesPerOrderQty: Math.max(1, Number(d.piecesPerOrderQty) || 1),
          descPlain: d.descPlain,
          images: d.images,
          thumbUrl: urlMap.get(d.images[0] || '') || '',
          inSale: !!cfg,
          limitQty,
          soldQty,
          remainingQty,
          isSoldOut: !!cfg && soldQty >= limitQty,
        }
      })
      return ok({
        sale: saleInfo,
        dishes: out,
        profile: toProfileSummary(profileDoc),
        myCurrentSaleOrder,
      })
    },

    async getCurrentSale() {
      const sale = await getOrderableSale()
      if (!sale) return ok({ sale: null, dishes: [] })
      const normalizedConfigs = normalizeSaleDishConfigs(sale)
      const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
      if (!configCheck.ok) return fail('SALE_CONFIG_INVALID', configCheck.message)
      const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
      const dishes = (await getDishesByIds(normalizedConfigs.map((x) => x.dishId))).map((d) => ({
        ...d,
        images: normalizeImageIds(d.images),
      }))
      const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
      const urlMap = await getTempUrlMap(firstIds)
      const out = dishes.map((d) => ({
        ...d,
        thumbUrl: urlMap.get(d.images[0] || '') || '',
        limitQty: cfgMap.has(d._id) ? cfgMap.get(d._id).limitQty : 0,
        soldQty: cfgMap.has(d._id) ? cfgMap.get(d._id).soldQty : 0,
        remainingQty: cfgMap.has(d._id) ? Math.max(0, cfgMap.get(d._id).limitQty - cfgMap.get(d._id).soldQty) : 0,
        isSoldOut: cfgMap.has(d._id) ? cfgMap.get(d._id).soldQty >= cfgMap.get(d._id).limitQty : true,
      }))
      return ok({ sale: { ...sale, dishConfigs: normalizedConfigs }, dishes: out })
    },

    async getDishDetail(event) {
      const { dishId } = event
      if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
      let r
      try {
        r = await db.collection('dishes').doc(dishId).get()
      } catch (err) {
        return fail('NOT_FOUND', 'Dish not found')
      }
      const dish = r.data
      if (!dish || !dish.isActive) return ok({ dish: null })
      const imageIds = normalizeImageIds(dish.images)
      const descMd = String(dish.descMd || '')
      let descHtml = ''
      if (descMd.trim()) {
        try {
          descHtml = mdToSafeHtml(descMd)
        } catch (err) {
          descHtml = ''
        }
      }
      const urlMap = await getTempUrlMap(imageIds)
      const imageUrls = imageIds.map((id) => urlMap.get(id) || '')
      return ok({
        dish: {
          _id: dish._id,
          name: dish.name,
          priceCents: dish.priceCents || 0,
          piecesPerOrderQty: Math.max(1, Number(dish.piecesPerOrderQty) || 1),
          images: imageIds,
          imageUrls,
          descMd,
          descHtml,
        },
      })
    },

    async listMyOrders(_event, ctx) {
      const openId = ctx && ctx.openId
      const orders = await getAllByPaging(
        (skip, limit) => db.collection('orders').where({ customerOpenId: openId }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
      return ok({ orders })
    },

    async getMySaleOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const saleId = String(event.saleId || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      let order = null
      try {
        // Priority: pending order (cross-sale) > active order in current sale.
        const pendingRes = await db
          .collection('orders')
          .where({
            customerOpenId: openId,
            status: ORDER_STATUS.PENDING_REVIEW,
          })
          .limit(20)
          .get()
        order = pickLatestOrder(pendingRes.data || [])
        if (!order) {
          const activeRes = await db
            .collection('orders')
            .where({
              saleId,
              customerOpenId: openId,
              status: ORDER_STATUS.ACTIVE,
            })
            .limit(20)
            .get()
          order = pickLatestOrder(activeRes.data || [])
        }
      } catch (err) {
        order = null
      }
      return ok({ order })
    },

    async getMyOrderDetail(event, ctx) {
      const openId = ctx && ctx.openId
      const { orderId } = event
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      let r
      try {
        r = await db.collection('orders').doc(orderId).get()
      } catch (err) {
        return fail('ORDER_NOT_FOUND', 'Order not found')
      }
      const order = r.data
      if (!order || order.customerOpenId !== openId) return fail('FORBIDDEN', 'Forbidden')
      return ok({ order })
    },
  }
}

module.exports = {
  createReadService,
}
