function createAdminSaleItemsRepo(deps) {
  const {
    db,
    getAllByPaging,
    toSafeInt,
    normalizeDishConfigs,
  } = deps

  function normalizeSaleItemRows(input) {
    const arr = Array.isArray(input) ? input : []
    const seen = new Set()
    const out = []
    for (const raw of arr) {
      const dishId = String((raw && raw.dishId) || '').trim()
      if (!dishId || seen.has(dishId)) continue
      const limitQty = Math.max(0, toSafeInt(raw && raw.limitQty, 0))
      const soldQty = Math.max(0, Math.min(limitQty, toSafeInt(raw && raw.soldQty, 0)))
      const sortOrder = Math.max(0, toSafeInt(raw && raw.sortOrder, out.length))
      out.push({ dishId, limitQty, soldQty, sortOrder })
      seen.add(dishId)
    }
    out.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return String(a.dishId || '').localeCompare(String(b.dishId || ''))
    })
    return out
  }

  async function listSaleItemRowsBySaleId(saleId, options = {}) {
    const id = String(saleId || '').trim()
    if (!id) return []
    const tx = options.tx || null
    const col = tx ? tx.collection('sale_items') : db.collection('sale_items')
    try {
      const rows = await getAllByPaging(
        (skip, limit) => col.where({ saleId: id }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
      return normalizeSaleItemRows(rows)
    } catch (err) {
      return []
    }
  }

  function saleItemRowsToDishConfigs(rows) {
    return normalizeSaleItemRows(rows).map((x) => ({ dishId: x.dishId, limitQty: x.limitQty, soldQty: x.soldQty }))
  }

  async function hydrateSaleWithSaleItems(sale, options = {}) {
    if (!sale || !sale._id) return sale || null
    const rows = await listSaleItemRowsBySaleId(sale._id, options)
    const dishConfigs = saleItemRowsToDishConfigs(rows || [])
    return {
      ...sale,
      dishIds: dishConfigs.map((x) => x.dishId),
      dishConfigs,
    }
  }

  async function getSaleTx(tx, saleId) {
    const id = String(saleId || '').trim()
    if (!id) return null
    let sale = null
    try {
      const r = await tx.collection('sales').doc(id).get()
      sale = r && r.data ? r.data : null
    } catch (err) {
      sale = null
    }
    return hydrateSaleWithSaleItems(sale, { tx })
  }

  async function replaceSaleItemsForSaleTx(tx, saleId, dishConfigs, options = {}) {
    const id = String(saleId || '').trim()
    if (!id) return
    const items = normalizeDishConfigs(dishConfigs)
    const byDishId = new Map()
    let dishSnapshotMap = options.dishSnapshotMap instanceof Map ? options.dishSnapshotMap : null
    if (!dishSnapshotMap && Array.isArray(options.dishes)) {
      dishSnapshotMap = new Map(
        options.dishes.map((d) => [
          String((d && d._id) || '').trim(),
          {
            name: String((d && d.name) || '').trim(),
            priceCents: Math.max(0, toSafeInt(d && d.priceCents, 0)),
          },
        ])
      )
    }
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      const snap = dishSnapshotMap ? dishSnapshotMap.get(it.dishId) : null
      byDishId.set(it.dishId, {
        saleId: id,
        dishId: it.dishId,
        limitQty: Math.max(0, toSafeInt(it.limitQty, 0)),
        soldQty: Math.max(0, Math.min(Math.max(0, toSafeInt(it.limitQty, 0)), toSafeInt(it.soldQty, 0))),
        sortOrder: i,
        updatedAt: db.serverDate(),
        ...(snap
          ? {
              dishNameSnapshot: String((snap && snap.name) || ''),
              priceCentsSnapshot: Math.max(0, toSafeInt(snap && snap.priceCents, 0)),
            }
          : {}),
      })
    }

    const existingRows = await listSaleItemRowsBySaleId(id, { tx })
    const existingIds = new Set(existingRows.map((x) => x.dishId))
    const nextIds = new Set(items.map((x) => x.dishId))

    for (const dishId of existingIds) {
      if (!nextIds.has(dishId)) {
        await tx.collection('sale_items').where({ saleId: id, dishId }).remove()
      }
    }

    for (const dishId of nextIds) {
      const payload = byDishId.get(dishId)
      if (!payload) continue
      if (existingIds.has(dishId)) {
        await tx.collection('sale_items').where({ saleId: id, dishId }).update({ data: payload })
      } else {
        await tx.collection('sale_items').add({
          data: {
            ...payload,
            createdAt: db.serverDate(),
          },
        })
      }
    }
  }

  async function replaceSaleItemsForSale(saleId, dishConfigs, options = {}) {
    const id = String(saleId || '').trim()
    if (!id) return
    const items = normalizeDishConfigs(dishConfigs)
    let dishSnapshotMap = options.dishSnapshotMap instanceof Map ? options.dishSnapshotMap : null
    if (!dishSnapshotMap && Array.isArray(options.dishes)) {
      dishSnapshotMap = new Map(
        options.dishes.map((d) => [
          String((d && d._id) || '').trim(),
          {
            name: String((d && d.name) || '').trim(),
            priceCents: Math.max(0, toSafeInt(d && d.priceCents, 0)),
          },
        ])
      )
    }
    const existingRows = await listSaleItemRowsBySaleId(id)
    const existingIds = new Set(existingRows.map((x) => x.dishId))
    const nextIds = new Set(items.map((x) => x.dishId))

    for (const dishId of existingIds) {
      if (!nextIds.has(dishId)) {
        await db.collection('sale_items').where({ saleId: id, dishId }).remove()
      }
    }
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      const snap = dishSnapshotMap ? dishSnapshotMap.get(it.dishId) : null
      const payload = {
        saleId: id,
        dishId: it.dishId,
        limitQty: Math.max(0, toSafeInt(it.limitQty, 0)),
        soldQty: Math.max(0, Math.min(Math.max(0, toSafeInt(it.limitQty, 0)), toSafeInt(it.soldQty, 0))),
        sortOrder: i,
        updatedAt: db.serverDate(),
        ...(snap
          ? {
              dishNameSnapshot: String((snap && snap.name) || ''),
              priceCentsSnapshot: Math.max(0, toSafeInt(snap && snap.priceCents, 0)),
            }
          : {}),
      }
      if (existingIds.has(it.dishId)) {
        await db.collection('sale_items').where({ saleId: id, dishId: it.dishId }).update({ data: payload })
      } else {
        await db.collection('sale_items').add({
          data: {
            ...payload,
            createdAt: db.serverDate(),
          },
        })
      }
    }
  }

  return {
    normalizeSaleItemRows,
    listSaleItemRowsBySaleId,
    saleItemRowsToDishConfigs,
    hydrateSaleWithSaleItems,
    getSaleTx,
    replaceSaleItemsForSaleTx,
    replaceSaleItemsForSale,
  }
}

module.exports = {
  createAdminSaleItemsRepo,
}
