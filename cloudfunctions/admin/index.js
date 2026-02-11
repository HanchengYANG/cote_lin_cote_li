const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// Admin whitelist enforcement.
const BYPASS_ADMIN_AUTH = false

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, detail) {
  return { ok: false, code, message, detail }
}

async function getOrCreateAdminConfig() {
  const ref = db.collection('adminConfig').doc('main')
  try {
    const r = await ref.get()
    return r.data
  } catch (err) {
    await ref.set({
      data: {
        adminOpenIds: [],
        activeSaleId: null,
        updatedAt: db.serverDate(),
      },
    })
    const r2 = await ref.get()
    return r2.data
  }
}

async function requireAdmin(openId) {
  if (BYPASS_ADMIN_AUTH) return await getOrCreateAdminConfig()
  const cfg = await getOrCreateAdminConfig()
  const list = cfg.adminOpenIds || []
  if (!list.includes(openId)) throw Object.assign(new Error('NOT_ADMIN'), { code: 'NOT_ADMIN' })
  return cfg
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function asExcelHtml(title, rows) {
  const head = `<tr>${rows.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
  const body = rows.rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title></head><body><table border="1">${head}${body}</table></body></html>`
}

async function getTempUrlMap(fileIDs) {
  const ids = Array.from(new Set((fileIDs || []).filter(Boolean)))
  if (ids.length === 0) return new Map()
  const r = await cloud.getTempFileURL({ fileList: ids })
  const out = new Map()
  for (const it of (r.fileList || [])) {
    if (it && it.fileID && it.tempFileURL) out.set(it.fileID, it.tempFileURL)
  }
  return out
}

function stripMarkdownToPlain(md) {
  let s = String(md || '')
  // Drop images.
  s = s.replace(/!\[[^\]]*?\]\([^)]+\)/g, '')
  // Replace links with text + url.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `${text} (${url})`)
  // Remove code fences and inline code markers.
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
  s = s.replace(/`([^`]+)`/g, '$1')
  // Remove emphasis markers.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(\*|_)(.*?)\1/g, '$2')
  // Remove headings markers.
  s = s.replace(/^#{1,6}\s+/gm, '')
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function normalizeImageIds(input) {
  return Array.isArray(input) ? input.filter(Boolean).map((x) => String(x).trim()).slice(0, 10) : []
}

function formatOrderAddress(a) {
  if (!a) return ''
  const parts = [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean)
  return parts.join(' ')
}

function toSafeInt(v, fallback = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function parseAndValidateDeliverySlot(event) {
  const deliverySlotDate = event.deliverySlotDate ? String(event.deliverySlotDate).trim() : ''
  const deliverySlotStartTime = event.deliverySlotStartTime ? String(event.deliverySlotStartTime).trim() : ''
  const deliverySlotEndTime = event.deliverySlotEndTime ? String(event.deliverySlotEndTime).trim() : ''
  if (!(deliverySlotDate && deliverySlotStartTime && deliverySlotEndTime)) {
    return { ok: false, message: 'Missing structured slot fields' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliverySlotDate)) return { ok: false, message: 'Invalid slot date' }
  if (!/^\d{2}:\d{2}$/.test(deliverySlotStartTime)) return { ok: false, message: 'Invalid slot start time' }
  if (!/^\d{2}:\d{2}$/.test(deliverySlotEndTime)) return { ok: false, message: 'Invalid slot end time' }
  if (deliverySlotStartTime >= deliverySlotEndTime) return { ok: false, message: 'Invalid slot time range' }
  return {
    ok: true,
    deliverySlotDate,
    deliverySlotStartTime,
    deliverySlotEndTime,
    deliveryTimeSlotLabel: `${deliverySlotDate} ${deliverySlotStartTime}-${deliverySlotEndTime}`,
  }
}

function throwBiz(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  throw err
}

function normalizeDishConfigs(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    const dishId = String((raw && raw.dishId) || '').trim()
    if (!dishId || seen.has(dishId)) continue
    const limitQty = toSafeInt(raw && raw.limitQty, NaN)
    if (!Number.isFinite(limitQty) || limitQty < 0) continue
    const soldRaw = toSafeInt(raw && raw.soldQty, 0)
    const soldQty = Math.max(0, Math.min(limitQty, soldRaw))
    out.push({ dishId, limitQty, soldQty })
    seen.add(dishId)
  }
  return out
}

function dishConfigMap(dishConfigs) {
  const m = new Map()
  for (const cfg of normalizeDishConfigs(dishConfigs)) {
    m.set(cfg.dishId, cfg)
  }
  return m
}

async function listSales(limit = 20) {
  const r = await db.collection('sales').orderBy('createdAt', 'desc').limit(limit).get()
  return r.data || []
}

async function getSale(saleId) {
  const r = await db.collection('sales').doc(saleId).get()
  return r.data
}

async function getDishesByIds(ids) {
  const dishIds = Array.from(new Set((ids || []).filter(Boolean)))
  if (dishIds.length === 0) return []
  const chunkSize = 10
  const out = []
  for (let i = 0; i < dishIds.length; i += chunkSize) {
    const chunk = dishIds.slice(i, i + chunkSize)
    const r = await db.collection('dishes').where({ _id: _.in(chunk) }).get()
    out.push(...(r.data || []))
  }
  return out
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  try {
    await requireAdmin(openId)
  } catch (err) {
    const code = err && err.code
    if (code === 'NOT_ADMIN') return fail('NOT_ADMIN', 'Not admin')
    return fail('NOT_ADMIN', 'Not admin')
  }

  if (action === 'listDishes') {
    const r = await db.collection('dishes').orderBy('updatedAt', 'desc').limit(200).get()
    const dishes = (r.data || []).map((d) => ({
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
  }

  if (action === 'getDish') {
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
  }

  if (action === 'upsertDish') {
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
  }

  if (action === 'toggleDishActive') {
    const { dishId, isActive } = event
    if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
    await db.collection('dishes').doc(dishId).update({
      data: { isActive: !!isActive, updatedAt: db.serverDate() },
    })
    return ok({})
  }

  if (action === 'listSales') {
    const limit = Math.min(50, Math.max(1, Number(event.limit || 20)))
    const sales = await listSales(limit)
    return ok({ sales })
  }

  if (action === 'getDashboard') {
    const cfg = await getOrCreateAdminConfig()
    const activeSaleId = cfg.activeSaleId
    let activeSale = null
    let orderCount = 0
    if (activeSaleId) {
      try {
        activeSale = await getSale(activeSaleId)
        const o = await db.collection('orders').where({ saleId: activeSaleId }).limit(500).get()
        orderCount = (o.data || []).filter((x) => x.status === 'ACTIVE').length
      } catch (err) {
        activeSale = null
      }
    }
    return ok({ activeSale, stats: { orderCount } })
  }

  if (action === 'getActiveSaleEditor') {
    const cfg = await getOrCreateAdminConfig()
    const activeSaleId = String((cfg && cfg.activeSaleId) || '').trim()
    if (!activeSaleId) return ok({ sale: null, dishes: [] })
    let sale = null
    try {
      sale = await getSale(activeSaleId)
    } catch (err) {
      sale = null
    }
    if (!sale || sale.status !== 'OPEN') return ok({ sale: null, dishes: [] })
    const r = await db.collection('dishes').orderBy('updatedAt', 'desc').limit(200).get()
    const dishes = (r.data || []).map((d) => ({
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
  }

  if (action === 'updateActiveSaleConfig') {
    const cfg = await getOrCreateAdminConfig()
    const saleId = String(event.saleId || cfg.activeSaleId || '').trim()
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
        dishIds: nextConfigs.map((x) => x.dishId),
        dishConfigs: nextConfigs,
        saleConfigVersion: nextVersion,
        updatedAt: db.serverDate(),
      },
    })
    return ok({ saleId, addedDishIds, saleConfigVersion: nextVersion })
  }

  if (action === 'getOrCreateDraft') {
    const sales = await listSales(50)
    const draft = (sales || []).find((s) => s.status === 'DRAFT')
    if (draft) return ok({ sale: draft })
    const now = db.serverDate()
    const addRes = await db.collection('sales').add({
      data: {
        status: 'DRAFT',
        dishIds: [],
        dishConfigs: [],
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
  }

  if (action === 'updateSaleDraft') {
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
        dishIds,
        dishConfigs: incomingConfigs.map((x) => ({ dishId: x.dishId, limitQty: x.limitQty, soldQty: 0 })),
        saleConfigVersion: 0,
        updatedAt: db.serverDate(),
      },
    })
    return ok({})
  }

  if (action === 'openSale') {
    const { saleId } = event
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const sale = await getSale(saleId)
    if (!sale || sale.status !== 'DRAFT') return fail('BAD_REQUEST', 'Sale is not draft')
    if (!String(sale.deliveryTimeSlotLabel || '').trim()) return fail('BAD_REQUEST', 'Missing deliveryTimeSlotLabel')
    if (!(sale.deliverySlotDate && sale.deliverySlotStartTime && sale.deliverySlotEndTime)) {
      return fail('BAD_REQUEST', 'Missing structured slot fields')
    }
    if (!sale.dishIds || sale.dishIds.length === 0) return fail('BAD_REQUEST', 'Missing dishIds')
    const draftConfigs = normalizeDishConfigs(sale.dishConfigs)
    if (draftConfigs.length === 0) return fail('BAD_REQUEST', 'Missing dishConfigs')
    const draftSet = new Set(draftConfigs.map((x) => x.dishId))
    const saleSet = new Set((sale.dishIds || []).filter(Boolean))
    if (draftSet.size !== saleSet.size) return fail('BAD_REQUEST', 'dishIds and dishConfigs mismatch')
    for (const dishId of saleSet) {
      if (!draftSet.has(dishId)) return fail('BAD_REQUEST', 'dishIds and dishConfigs mismatch')
    }

    try {
      const txRes = await db.runTransaction(async (tx) => {
        const cfgRef = tx.collection('adminConfig').doc('main')
        let cfg
        try {
          const cfgGet = await cfgRef.get()
          cfg = cfgGet.data
        } catch (err) {
          await cfgRef.set({
            data: { adminOpenIds: [], activeSaleId: null, updatedAt: db.serverDate() },
          })
          const cfgGet2 = await cfgRef.get()
          cfg = cfgGet2.data
        }
        if (cfg.activeSaleId) {
          let cfgActiveSale = null
          try {
            const cfgActiveSaleGet = await tx.collection('sales').doc(cfg.activeSaleId).get()
            cfgActiveSale = cfgActiveSaleGet.data
          } catch (err) {
            cfgActiveSale = null
          }
          if (cfgActiveSale && cfgActiveSale.status === 'OPEN') {
            return { blocked: true, activeSaleId: cfg.activeSaleId }
          }
          // Heal stale activeSaleId so opening logic only blocks real OPEN sales.
          await cfgRef.update({ data: { activeSaleId: null, updatedAt: db.serverDate() } })
        }

        // Safety net: if config is missing activeSaleId but there is an OPEN sale, block opening.
        const openSales = await tx.collection('sales').where({ status: 'OPEN' }).limit(1).get()
        const existingOpen = (openSales.data && openSales.data[0]) || null
        if (existingOpen && existingOpen._id) {
          // Heal config so later reads are consistent.
          await cfgRef.update({ data: { activeSaleId: existingOpen._id, updatedAt: db.serverDate() } })
          return { blocked: true, activeSaleId: existingOpen._id }
        }

        await cfgRef.update({ data: { activeSaleId: saleId, updatedAt: db.serverDate() } })
        await tx.collection('sales').doc(saleId).update({
          data: {
            status: 'OPEN',
            dishIds: draftConfigs.map((x) => x.dishId),
            dishConfigs: draftConfigs.map((x) => ({ dishId: x.dishId, limitQty: x.limitQty, soldQty: 0 })),
            saleConfigVersion: 1,
            openedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
        return { blocked: false }
      })
      if (txRes && txRes.blocked) return fail('ACTIVE_SALE_EXISTS', '已有开单中开单，请先截单', { activeSaleId: txRes.activeSaleId })
    } catch (err) {
      return fail('TX_FAILED', 'Open sale failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'closeSale') {
    const { saleId } = event
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    try {
      await db.runTransaction(async (tx) => {
        const cfgRef = tx.collection('adminConfig').doc('main')
        const cfgGet = await cfgRef.get()
        const cfg = cfgGet.data
        if (!cfg.activeSaleId || cfg.activeSaleId !== saleId) {
          throw Object.assign(new Error('NOT_ACTIVE'), { code: 'NOT_ACTIVE' })
        }
        await cfgRef.update({ data: { activeSaleId: null, updatedAt: db.serverDate() } })
        await tx.collection('sales').doc(saleId).update({
          data: { status: 'CLOSED', closedAt: db.serverDate(), updatedAt: db.serverDate() },
        })
      })
    } catch (err) {
      return fail('TX_FAILED', 'Close sale failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'listOrders') {
    const saleId = event.saleId
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const fulfillmentType = event.fulfillmentType
    const where = { saleId }
    if (fulfillmentType === 'delivery' || fulfillmentType === 'pickup') where.fulfillmentType = fulfillmentType
    const r = await db.collection('orders').where(where).limit(200).get()
    return ok({ orders: r.data || [] })
  }

  if (action === 'getOrderDetail') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      const r = await db.collection('orders').doc(orderId).get()
      return ok({ order: r.data })
    } catch (err) {
      return fail('ORDER_NOT_FOUND', 'Order not found')
    }
  }

  if (action === 'updateOrderItems') {
    const { orderId } = event
    const incomingItems = Array.isArray(event.items) ? event.items : []
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    let txRes
    try {
      txRes = await db.runTransaction(async (tx) => {
        let order
        try {
          const orderGet = await tx.collection('orders').doc(orderId).get()
          order = orderGet.data
        } catch (err) {
          throwBiz('ORDER_NOT_FOUND', 'Order not found')
        }
        if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
        if (order.status !== 'ACTIVE') throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')

        const oldItems = Array.isArray(order.items) ? order.items : []
        if (oldItems.length === 0) throwBiz('BAD_REQUEST', 'Order has no editable items')

        const oldMap = new Map()
        for (const it of oldItems) {
          const dishId = String((it && it.dishId) || '').trim()
          if (!dishId) continue
          oldMap.set(dishId, it)
        }
        if (oldMap.size === 0) throwBiz('BAD_REQUEST', 'Order has no editable items')

        const nextQtyMap = new Map()
        for (const it of incomingItems) {
          const dishId = String((it && it.dishId) || '').trim()
          const qty = Number(it && it.qty)
          if (!dishId || !Number.isFinite(qty) || qty < 0) throwBiz('BAD_REQUEST', 'Invalid items')
          if (!oldMap.has(dishId)) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          nextQtyMap.set(dishId, Math.floor(qty))
        }
        for (const dishId of oldMap.keys()) {
          if (!nextQtyMap.has(dishId)) nextQtyMap.set(dishId, 0)
        }

        const nextItems = []
        let totalQty = 0
        let totalAmountCents = 0
        for (const [dishId, nextQty] of nextQtyMap.entries()) {
          if (nextQty <= 0) continue
          const old = oldMap.get(dishId)
          const unitPriceCents = toSafeInt(old && old.unitPriceCents, 0)
          const dishName = String((old && old.dishName) || '')
          if (!dishName) throwBiz('BAD_REQUEST', 'Invalid order item')
          const lineTotalCents = unitPriceCents * nextQty
          totalQty += nextQty
          totalAmountCents += lineTotalCents
          nextItems.push({ dishId, dishName, unitPriceCents, qty: nextQty, lineTotalCents })
        }
        if (nextItems.length === 0) throwBiz('BAD_REQUEST', 'Order cannot be empty, cancel it instead')

        const expandedLimits = []
        let saleVersionSnapshot = toSafeInt(order.saleConfigVersionSnapshot, 0)
        if (order.saleId) {
          let sale = null
          try {
            const saleGet = await tx.collection('sales').doc(order.saleId).get()
            sale = saleGet.data
          } catch (err) {
            sale = null
          }
          if (sale && Array.isArray(sale.dishConfigs) && sale.dishConfigs.length > 0) {
            const cfgMap = dishConfigMap(sale.dishConfigs)
            for (const [dishId, nextQty] of nextQtyMap.entries()) {
              const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
              const delta = nextQty - oldQty
              if (delta === 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
              if (delta > 0) {
                const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
                if (delta > remain) {
                  const grow = delta - remain
                  cfgItem.limitQty = Math.max(0, toSafeInt(cfgItem.limitQty, 0) + grow)
                  expandedLimits.push({
                    dishId,
                    increaseBy: grow,
                    newLimitQty: cfgItem.limitQty,
                  })
                }
              }
              cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
              cfgMap.set(dishId, cfgItem)
            }
            const nextConfigs = normalizeDishConfigs(sale.dishConfigs).map((x) => {
              const cur = cfgMap.get(x.dishId)
              return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
            })
            await tx.collection('sales').doc(order.saleId).update({
              data: {
                dishConfigs: nextConfigs,
                updatedAt: db.serverDate(),
              },
            })
          }
          saleVersionSnapshot = toSafeInt(sale && sale.saleConfigVersion, saleVersionSnapshot)
        }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: {
            items: nextItems,
            totals: { qty: totalQty, amountCents: totalAmountCents },
            saleConfigVersionSnapshot: saleVersionSnapshot,
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId,
            action: 'ADMIN_UPDATE_ITEMS',
            byOpenId: openId,
            at: now,
          },
        })
        return { totalQty, totalAmountCents, expandedLimits }
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
      return fail('TX_FAILED', 'Update order failed', String(err && err.message))
    }
    return ok(txRes || {})
  }

  if (action === 'cancelOrder') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    let txRes
    try {
      txRes = await db.runTransaction(async (tx) => {
        let order = null
        try {
          const r = await tx.collection('orders').doc(orderId).get()
          order = r.data
        } catch (err) {
          throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND' })
        }
        if (!order) throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND' })
        if (order.status === 'CANCELLED') return { alreadyCancelled: true }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: { status: 'CANCELLED', cancelledAt: now, cancelledByOpenId: openId, updatedAt: now },
        })

        if (order.saleId) {
          let sale = null
          try {
            const saleGet = await tx.collection('sales').doc(order.saleId).get()
            sale = saleGet.data
          } catch (err) {
            sale = null
          }
          if (sale && Array.isArray(sale.dishConfigs)) {
            const cfgMap = dishConfigMap(sale.dishConfigs)
            for (const it of (order.items || [])) {
              const dishId = String((it && it.dishId) || '').trim()
              const qty = toSafeInt(it && it.qty, 0)
              if (!dishId || qty <= 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) continue
              cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) - qty)
              cfgMap.set(dishId, cfgItem)
            }
            const mergedConfigs = (sale.dishConfigs || []).map((it) => {
              const cfgItem = cfgMap.get(it.dishId)
              return cfgItem || it
            })
            await tx.collection('sales').doc(order.saleId).update({
              data: { dishConfigs: mergedConfigs, updatedAt: db.serverDate() },
            })
          }
        }
        return { alreadyCancelled: false }
      })
    } catch (err) {
      if (err && err.code === 'ORDER_NOT_FOUND') return fail('ORDER_NOT_FOUND', 'Order not found')
      return fail('TX_FAILED', 'Cancel order failed', String(err && err.message))
    }
    if (txRes && txRes.alreadyCancelled) return ok({})
    const now = db.serverDate()
    await db.collection('orderAuditLogs').add({
      data: { orderId, action: 'CANCEL', byOpenId: openId, at: now },
    })
    return ok({})
  }

  if (action === 'export') {
    const { saleId, exportType } = event
    const includeCancelled = !!event.includeCancelled
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    if (!exportType) return fail('BAD_REQUEST', 'Missing exportType')

    let sale
    try {
      sale = await getSale(saleId)
    } catch (err) {
      return fail('NOT_FOUND', 'Sale not found')
    }
    if (!sale) return fail('NOT_FOUND', 'Sale not found')

    const where = { saleId }
    if (!includeCancelled) where.status = 'ACTIVE'
    const orderRes = await db.collection('orders').where(where).limit(500).get()
    const orders = orderRes.data || []
    orders.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return ta - tb
    })

    const title = `${exportType}-${saleId}`
    let table

    if (exportType === 'ORDER_DETAIL') {
      const headers = [
        '订单号',
        '下单时间',
        '类型',
        '时间段',
        '电话',
        '地址行1',
        '地址行2',
        '邮编',
        '城市',
        '国家',
        '备注',
        '付款方式',
        '收款状态',
        '订单状态',
        '菜品明细',
        '总件数',
        '总金额(cents)',
        '总金额(EUR)',
      ]
      const rows = orders.map((o) => {
        const a = o.address || {}
        const itemText = (o.items || []).map((it) => `${it.dishName} x${it.qty}`).join('; ')
        const amountCents = (o.totals && o.totals.amountCents) || 0
        return [
          o._id,
          o.createdAt ? String(o.createdAt) : '',
          o.fulfillmentType,
          o.deliveryTimeSlotLabelSnapshot || '',
          (o.contact && o.contact.phone) || '',
          a.line1 || '',
          a.line2 || '',
          a.postalCode || '',
          a.city || '',
          a.country || '',
          o.remark || '',
          (o.payment && o.payment.method) || '',
          (o.payment && o.payment.paidStatus) || '',
          o.status || '',
          itemText,
          (o.totals && o.totals.qty) || 0,
          amountCents,
          (Number(amountCents) / 100).toFixed(2),
        ]
      })
      table = { headers, rows }
    } else if (exportType === 'DISH_SUMMARY') {
      const map = new Map()
      for (const o of orders) {
        for (const it of o.items || []) {
          const key = it.dishName || it.dishId
          const prev = map.get(key) || 0
          map.set(key, prev + Number(it.qty || 0))
        }
      }
      const headers = ['菜品', '总份数']
      const rows = Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, qty]) => [name, qty])
      table = { headers, rows }
    } else if (exportType === 'CUSTOMER_ADDRESS') {
      const headers = ['订单号', '类型', '时间段', '电话', '地址', '备注', '菜品明细']
      const rows = orders.map((o) => {
        const addr = formatOrderAddress(o.address)
        const itemText = (o.items || []).map((it) => `${it.dishName} x${it.qty}`).join('; ')
        return [
          o._id,
          o.fulfillmentType,
          o.deliveryTimeSlotLabelSnapshot || '',
          (o.contact && o.contact.phone) || '',
          addr,
          o.remark || '',
          itemText,
        ]
      })
      table = { headers, rows }
    } else {
      return fail('BAD_REQUEST', 'Unknown exportType')
    }

    const html = asExcelHtml(title, table)
    const ts = Date.now()
    const filename = `${exportType}-${ts}.xls`
    const cloudPath = `exports/${saleId}/${filename}`
    const up = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from(html, 'utf8'),
    })
    return ok({ fileID: up.fileID, cloudPath, filename })
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
