function createDishService(deps) {
  const {
    cloud,
    db,
    ok,
    fail,
    getAllByPaging,
    normalizeImageIds,
    getTempUrlMap,
    stripMarkdownToPlain,
  } = deps

  const _ = db.command
  const ACTIVE_SALE_STATUSES = ['OPEN', 'CLOSED', 'FULFILLING']
  const EDITABLE_ORDER_STATUSES = ['ACTIVE', 'PENDING_REVIEW']

  function normalizePiecesPerOrderQty(input) {
    const n = Number(input)
    if (!Number.isFinite(n) || n <= 0) return 1
    return Math.max(1, Math.floor(n))
  }

  async function applyPiecesPerOrderQtyToUnfinishedOrders(dishId, piecesPerOrderQty) {
    const targetDishId = String(dishId || '').trim()
    if (!targetDishId) {
      return { applied: true, failed: false, updatedOrderCount: 0, updatedItemCount: 0, affectedSaleCount: 0 }
    }
    const saleRows = await getAllByPaging(
      (skip, limit) =>
        db
          .collection('sales')
          .where({ status: _.in(ACTIVE_SALE_STATUSES) })
          .skip(skip)
          .limit(limit),
      { pageSize: 100 }
    )
    const saleIds = Array.from(new Set((saleRows || []).map((row) => String((row && row._id) || '').trim()).filter(Boolean)))
    if (!saleIds.length) {
      return { applied: true, failed: false, updatedOrderCount: 0, updatedItemCount: 0, affectedSaleCount: 0 }
    }

    let updatedOrderCount = 0
    let updatedItemCount = 0
    const saleIdChunkSize = 10

    for (let i = 0; i < saleIds.length; i += saleIdChunkSize) {
      const chunk = saleIds.slice(i, i + saleIdChunkSize)
      const orderRows = await getAllByPaging(
        (skip, limit) =>
          db
            .collection('orders')
            .where({
              saleId: _.in(chunk),
              status: _.in(EDITABLE_ORDER_STATUSES),
            })
            .skip(skip)
            .limit(limit),
        { pageSize: 100 }
      )

      for (const order of orderRows || []) {
        const orderId = String((order && order._id) || '').trim()
        const items = Array.isArray(order && order.items) ? order.items : []
        if (!orderId || !items.length) continue
        let orderChanged = false
        let changedItemsForOrder = 0
        const nextItems = items.map((item) => {
          if (String((item && item.dishId) || '').trim() !== targetDishId) return item
          const currentSnapshot = normalizePiecesPerOrderQty(item && item.piecesPerOrderQtySnapshot)
          if (currentSnapshot === piecesPerOrderQty) return item
          orderChanged = true
          changedItemsForOrder += 1
          return {
            ...item,
            piecesPerOrderQtySnapshot: piecesPerOrderQty,
          }
        })
        if (!orderChanged) continue
        try {
          await db.collection('orders').doc(orderId).update({
            data: {
              items: nextItems,
              updatedAt: db.serverDate(),
            },
          })
          updatedOrderCount += 1
          updatedItemCount += changedItemsForOrder
        } catch (err) {
          const message = String((err && (err.errMsg || err.message)) || 'Sync unfinished orders failed')
          return {
            applied: true,
            failed: true,
            updatedOrderCount,
            updatedItemCount,
            affectedSaleCount: saleIds.length,
            message,
          }
        }
      }
    }

    return {
      applied: true,
      failed: false,
      updatedOrderCount,
      updatedItemCount,
      affectedSaleCount: saleIds.length,
    }
  }

  return {
    async listDishes() {
      const dishRows = await getAllByPaging(
        (skip, limit) => db.collection('dishes').orderBy('updatedAt', 'desc').skip(skip).limit(limit),
        { pageSize: 100 }
      )
      const dishes = dishRows.map((d) => ({
        ...d,
        images: normalizeImageIds(d.images),
        piecesPerOrderQty: normalizePiecesPerOrderQty(d && d.piecesPerOrderQty),
      }))
      const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
      const urlMap = await getTempUrlMap(firstIds)
      const out = dishes.map((d) => ({
        ...d,
        thumbUrl: urlMap.get(d.images[0] || '') || '',
      }))
      return ok({ dishes: out })
    },

    async getDish(event) {
      const { dishId } = event
      if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
      try {
        const r = await db.collection('dishes').doc(dishId).get()
        const dish = r.data
        const imageIds = normalizeImageIds(dish.images)
        const urlMap = await getTempUrlMap(imageIds)
        const imageUrls = imageIds.map((id) => urlMap.get(id) || '')
        return ok({
          dish: {
            ...dish,
            images: imageIds,
            imageUrls,
            piecesPerOrderQty: normalizePiecesPerOrderQty(dish && dish.piecesPerOrderQty),
          },
        })
      } catch (err) {
        return fail('NOT_FOUND', 'Dish not found')
      }
    },

    async upsertDish(event) {
      const dishId = event.dishId
      const name = String(event.name || '').trim()
      const priceCents = Number(event.priceCents || 0)
      const isActive = !!event.isActive
      const images = normalizeImageIds(event.images)
      const descMd = String(event.descMd || '')
      const piecesPerOrderQty = normalizePiecesPerOrderQty(event.piecesPerOrderQty)
      const applyPiecesPerOrderQtyToActiveOrders = !!event.applyPiecesPerOrderQtyToActiveOrders
      const descPlain = stripMarkdownToPlain(descMd).slice(0, 120)
      if (!name) return fail('BAD_REQUEST', 'Missing name')
      if (!Number.isFinite(priceCents) || priceCents <= 0) return fail('BAD_REQUEST', 'Invalid price')
      const now = db.serverDate()
      if (dishId) {
        let oldDish
        try {
          const oldRes = await db.collection('dishes').doc(dishId).get()
          oldDish = oldRes.data
        } catch (err) {
          return fail('NOT_FOUND', 'Dish not found')
        }
        const oldImages = normalizeImageIds(oldDish && oldDish.images)
        const oldPiecesPerOrderQty = normalizePiecesPerOrderQty(oldDish && oldDish.piecesPerOrderQty)
        await db.collection('dishes').doc(dishId).update({
          data: { name, priceCents, isActive, images, descMd, descPlain, piecesPerOrderQty, updatedAt: now },
        })
        let activeOrderSync = null
        if (oldPiecesPerOrderQty !== piecesPerOrderQty && applyPiecesPerOrderQtyToActiveOrders) {
          activeOrderSync = await applyPiecesPerOrderQtyToUnfinishedOrders(dishId, piecesPerOrderQty)
        }
        const removedImageIds = oldImages.filter((id) => !images.includes(id))
        let deletedImageCount = 0
        let deleteError = null
        if (removedImageIds.length > 0) {
          try {
            await cloud.deleteFile({ fileList: removedImageIds })
            deletedImageCount = removedImageIds.length
          } catch (err) {
            deleteError = String((err && (err.errMsg || err.message)) || 'Delete file failed')
          }
        }
        return ok({
          dishId,
          removedImageCount: removedImageIds.length,
          deletedImageCount,
          deleteError,
          activeOrderSync,
        })
      }
      const addRes = await db.collection('dishes').add({
        data: { name, priceCents, isActive, images, descMd, descPlain, piecesPerOrderQty, createdAt: now, updatedAt: now },
      })
      return ok({ dishId: addRes._id, removedImageCount: 0, deletedImageCount: 0, deleteError: null, activeOrderSync: null })
    },

    async toggleDishActive(event) {
      const { dishId, isActive } = event
      if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
      await db.collection('dishes').doc(dishId).update({
        data: { isActive: !!isActive, updatedAt: db.serverDate() },
      })
      return ok({})
    },
  }
}

module.exports = {
  createDishService,
}
