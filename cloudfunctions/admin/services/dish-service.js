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

  return {
    async listDishes() {
      const dishRows = await getAllByPaging(
        (skip, limit) => db.collection('dishes').orderBy('updatedAt', 'desc').skip(skip).limit(limit),
        { pageSize: 100 }
      )
      const dishes = dishRows.map((d) => ({
        ...d,
        images: normalizeImageIds(d.images),
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
        return ok({ dish: { ...dish, images: imageIds, imageUrls } })
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
        await db.collection('dishes').doc(dishId).update({
          data: { name, priceCents, isActive, images, descMd, descPlain, updatedAt: now },
        })
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
        return ok({ dishId, removedImageCount: removedImageIds.length, deletedImageCount, deleteError })
      }
      const addRes = await db.collection('dishes').add({
        data: { name, priceCents, isActive, images, descMd, descPlain, createdAt: now, updatedAt: now },
      })
      return ok({ dishId: addRes._id, removedImageCount: 0, deletedImageCount: 0, deleteError: null })
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
