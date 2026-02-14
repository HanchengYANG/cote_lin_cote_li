const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// Admin whitelist enforcement.
const BYPASS_ADMIN_AUTH = false
const ORDER_STATUS = {
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  REJECTED: 'REJECTED',
}

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

function normalizeDeliveryMinByCity(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(raw)) {
    const city = String(key || '')
    if (!city.trim()) continue
    const cents = toSafeInt(raw[key], NaN)
    if (!Number.isFinite(cents) || cents <= 0) continue
    out[city] = cents
  }
  return out
}

function buildOrderId(saleId, openId) {
  return crypto.createHash('md5').update(`${String(saleId || '')}:${String(openId || '')}`).digest('hex')
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

function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/[.\-\s]/g, '')
}

function isPhoneValid(phone) {
  const s = String(phone || '').trim()
  return /^(\+?\d{6,20})$/.test(s)
}

function normalizeAddressPayload(input) {
  const source = input || {}
  const line1 = String(source.line1 || '').trim()
  const line2 = String(source.line2 || '').trim()
  const postalCode = String(source.postalCode || '').trim()
  const city = String(source.city || '').trim()
  const country = String(source.country || 'FR')
    .trim()
    .toUpperCase()
  const label = String(source.label || '').trim().slice(0, 40)
  if (!line1 || !city) return null
  if (!/^\d{5}$/.test(postalCode)) return null
  if ((country || 'FR') !== 'FR') return null
  return {
    label,
    line1,
    line2,
    postalCode,
    city,
    country: 'FR',
  }
}

function normalizeStoredAddresses(input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const raw of arr) {
    const normalized = normalizeAddressPayload(raw)
    if (!normalized) continue
    const id = String((raw && raw.id) || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      ...normalized,
      phone: normalizePhone(raw && raw.phone),
    })
  }
  return out
}

function extractOrderAddressSnapshot(input) {
  const normalized = normalizeAddressPayload(input)
  if (!normalized) return null
  return {
    label: normalized.label,
    line1: normalized.line1,
    line2: normalized.line2,
    postalCode: normalized.postalCode,
    city: normalized.city,
    country: 'FR',
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

function normalizeOrderItems(items) {
  const arr = Array.isArray(items) ? items : []
  const out = []
  for (const it of arr) {
    const dishId = String((it && it.dishId) || '').trim()
    const qty = toSafeInt(it && it.qty, 0)
    if (!dishId || qty <= 0) continue
    out.push({ dishId, qty })
  }
  return out
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

  if (action === 'getDeliveryRules') {
    const cfg = await getOrCreateAdminConfig()
    const deliveryMinByCity = normalizeDeliveryMinByCity(cfg && cfg.deliveryMinByCity)
    const deliveryMinDefaultCents = toSafeInt(cfg && cfg.deliveryMinDefaultCents, 0)
    return ok({
      deliveryMinByCity,
      deliveryMinDefaultCents: deliveryMinDefaultCents > 0 ? deliveryMinDefaultCents : 0,
    })
  }

  if (action === 'updateDeliveryRules') {
    const incomingMap = normalizeDeliveryMinByCity(event && event.deliveryMinByCity)
    const defaultCentsRaw = toSafeInt(event && event.deliveryMinDefaultCents, 0)
    const deliveryMinDefaultCents = defaultCentsRaw > 0 ? defaultCentsRaw : 0
    const cfg = await getOrCreateAdminConfig()
    const nextCfg = {
      ...cfg,
      deliveryMinByCity: incomingMap,
      deliveryMinDefaultCents,
      updatedAt: db.serverDate(),
    }
    delete nextCfg._id
    await db.collection('adminConfig').doc('main').set({
      data: nextCfg,
    })
    return ok({})
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
        orderCount = (o.data || []).filter((x) => x.status === ORDER_STATUS.ACTIVE).length
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

        await cfgRef.update({ data: { activeSaleId: saleId, updatedAt: db.serverDate() } })
        await tx.collection('sales').doc(saleId).update({
          data: {
            status: 'OPEN',
            dishIds: draftConfigs.map((x) => x.dishId),
            dishConfigs: openedConfigs,
            saleConfigVersion: 1,
            openedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })

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
            deliveryTimeSlotLabelSnapshot:
              order.fulfillmentType === 'delivery' ? String(sale.deliveryTimeSlotLabel || '').trim() : null,
            acceptDeliverySlot: order.fulfillmentType === 'delivery' ? true : false,
            saleConfigVersionSnapshot: 1,
            approvedAt: now,
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
                deliveryTimeSlotLabelSnapshot: nextData.deliveryTimeSlotLabelSnapshot,
                acceptDeliverySlot: nextData.acceptDeliverySlot,
                saleConfigVersionSnapshot: nextData.saleConfigVersionSnapshot,
                pendingReason: _.remove,
                pendingDetail: _.remove,
                pendingAt: _.remove,
                approvedAt: now,
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
      if (txRes && txRes.blocked) return fail('ACTIVE_SALE_EXISTS', '已有开单中开单，请先截单', { activeSaleId: txRes.activeSaleId })
      return ok({ deferredApprovedCount: toSafeInt(txRes && txRes.deferredApprovedCount, 0) })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Open sale failed', err.detail)
      return fail('TX_FAILED', 'Open sale failed', String(err && err.message))
    }
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

  if (action === 'listPendingOrders') {
    const saleId = String(event.saleId || '').trim()
    const where = { status: ORDER_STATUS.PENDING_REVIEW }
    if (saleId) where.saleId = saleId
    const r = await db.collection('orders').where(where).limit(200).get()
    return ok({ orders: r.data || [] })
  }

  if (action === 'approvePendingOrderNow') {
    const orderId = String(event.orderId || '').trim()
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    const slotLabelInput = String(event.deliveryTimeSlotLabel || '').trim()
    try {
      await db.runTransaction(async (tx) => {
        let order
        try {
          const got = await tx.collection('orders').doc(orderId).get()
          order = got.data
        } catch (err) {
          throwBiz('ORDER_NOT_FOUND', 'Order not found')
        }
        if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
        if (order.status !== ORDER_STATUS.PENDING_REVIEW) throwBiz('ORDER_NOT_PENDING', 'Order is not pending')
        if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

        let sale = null
        try {
          const saleGet = await tx.collection('sales').doc(order.saleId).get()
          sale = saleGet.data
        } catch (err) {
          sale = null
        }
        if (!sale || sale.status !== 'OPEN') throwBiz('ORDER_LOCKED', '当前无法立即确认，请在下次开单时勾选延后确认')

        const normalizedConfigs = normalizeDishConfigs(sale.dishConfigs)
        if (normalizedConfigs.length === 0) throwBiz('SALE_CONFIG_INVALID', 'Sale has no dishConfigs')
        const cfgMap = dishConfigMap(normalizedConfigs)
        const outOfStock = []
        const orderItems = normalizeOrderItems(order.items)
        if (orderItems.length === 0) throwBiz('BAD_REQUEST', 'Order has no items')
        for (const it of orderItems) {
          const cfgItem = cfgMap.get(it.dishId)
          if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
          if (it.qty > remain) {
            outOfStock.push({
              dishId: it.dishId,
              requiredQty: it.qty,
              remainingQty: remain,
            })
          }
        }
        if (outOfStock.length > 0) throwBiz('OUT_OF_STOCK', 'Out of stock', { items: outOfStock })

        for (const it of orderItems) {
          const cfgItem = cfgMap.get(it.dishId)
          cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + it.qty)
          cfgMap.set(it.dishId, cfgItem)
        }
        const nextConfigs = normalizedConfigs.map((x) => {
          const cur = cfgMap.get(x.dishId)
          return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
        })
        await tx.collection('sales').doc(order.saleId).update({
          data: {
            dishConfigs: nextConfigs,
            updatedAt: db.serverDate(),
          },
        })

        let deliveryTimeSlotLabelSnapshot = order.deliveryTimeSlotLabelSnapshot || null
        if (order.fulfillmentType === 'delivery') {
          deliveryTimeSlotLabelSnapshot = slotLabelInput || String(sale.deliveryTimeSlotLabel || '').trim()
          if (!deliveryTimeSlotLabelSnapshot) throwBiz('BAD_REQUEST', 'Missing delivery slot')
        }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: {
            status: ORDER_STATUS.ACTIVE,
            deliveryTimeSlotLabelSnapshot,
            pendingReason: _.remove,
            pendingDetail: _.remove,
            pendingAt: _.remove,
            approvedAt: now,
            saleConfigVersionSnapshot: toSafeInt(sale.saleConfigVersion, 0),
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId,
            action: 'ADMIN_APPROVE_PENDING',
            byOpenId: openId,
            at: now,
          },
        })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Approve failed', err.detail)
      return fail('TX_FAILED', 'Approve failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'rejectPendingOrder') {
    const orderId = String(event.orderId || '').trim()
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    const rejectedReason = String(event.rejectedReason || '').trim().slice(0, 200)
    try {
      await db.runTransaction(async (tx) => {
        let order = null
        try {
          const got = await tx.collection('orders').doc(orderId).get()
          order = got.data
        } catch (err) {
          order = null
        }
        if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
        if (order.status !== ORDER_STATUS.PENDING_REVIEW) throwBiz('ORDER_NOT_PENDING', 'Order is not pending')

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: {
            status: ORDER_STATUS.REJECTED,
            rejectedReason,
            rejectedAt: now,
            rejectedByOpenId: openId,
            pendingReason: _.remove,
            pendingDetail: _.remove,
            pendingAt: _.remove,
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId,
            action: 'ADMIN_REJECT_PENDING',
            byOpenId: openId,
            at: now,
          },
        })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Reject failed', err.detail)
      return fail('TX_FAILED', 'Reject failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'updateOrderDeliverySlot') {
    const orderId = String(event.orderId || '').trim()
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    let slotLabel = String(event.deliveryTimeSlotLabel || '').trim()
    if (!slotLabel) {
      const slot = parseAndValidateDeliverySlot(event)
      if (!slot.ok) return fail('BAD_REQUEST', slot.message)
      slotLabel = slot.deliveryTimeSlotLabel
    }
    try {
      const r = await db.collection('orders').doc(orderId).get()
      const order = r.data
      if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
      if (order.fulfillmentType !== 'delivery') return fail('BAD_REQUEST', 'Only delivery order can update slot')
      if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
        return fail('ORDER_NOT_EDITABLE', 'Order is not editable')
      }
      const now = db.serverDate()
      await db.collection('orders').doc(orderId).update({
        data: {
          deliveryTimeSlotLabelSnapshot: slotLabel,
          updatedAt: now,
        },
      })
      await db.collection('orderAuditLogs').add({
        data: {
          orderId,
          action: 'ADMIN_UPDATE_SLOT',
          byOpenId: openId,
          at: now,
        },
      })
    } catch (err) {
      return fail('TX_FAILED', 'Update delivery slot failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'updateOrderFulfillment') {
    const orderId = String(event.orderId || '').trim()
    const fulfillmentType = String(event.fulfillmentType || '').trim()
    const requestedAddressId = String(event.addressId || '').trim()
    const hasManualAddressInput = !!(event && event.address)
    const hasPhoneInput = Object.prototype.hasOwnProperty.call(event || {}, 'phone')
    const requestedPhone = hasPhoneInput ? normalizePhone(event.phone) : ''
    const requestedManualAddress = event && event.address ? normalizeAddressPayload(event.address) : null
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    if (fulfillmentType !== 'delivery' && fulfillmentType !== 'pickup') return fail('BAD_REQUEST', 'Invalid fulfillmentType')
    if (hasManualAddressInput && !requestedManualAddress) return fail('INVALID_ADDRESS', '手动地址格式不正确')
    let slotLabel = String(event.deliveryTimeSlotLabel || '').trim()
    if (!slotLabel && fulfillmentType === 'delivery') {
      const slot = parseAndValidateDeliverySlot(event)
      if (slot.ok) slotLabel = slot.deliveryTimeSlotLabel
    }
    try {
      const r = await db.collection('orders').doc(orderId).get()
      const order = r.data
      if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
      if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
        return fail('ORDER_NOT_EDITABLE', 'Order is not editable')
      }

      let customerAddresses = []
      if (order.customerOpenId) {
        try {
          const customerRes = await db.collection('customers').doc(order.customerOpenId).get()
          customerAddresses = normalizeStoredAddresses(customerRes && customerRes.data && customerRes.data.addresses)
        } catch (err) {
          customerAddresses = []
        }
      }

      const currentPhone = normalizePhone(order.contact && order.contact.phone)
      const nextData = {
        fulfillmentType,
        contact: {
          phone: hasPhoneInput ? requestedPhone : currentPhone,
        },
        updatedAt: db.serverDate(),
      }
      let addressSource = 'unchanged'

      if (fulfillmentType === 'delivery') {
        let nextAddress = null
        let nextAddressId = null

        const selectedSaved = requestedAddressId ? customerAddresses.find((x) => x.id === requestedAddressId) || null : null
        if (requestedAddressId && !selectedSaved) return fail('BAD_REQUEST', '所选客户地址不存在')
        if (selectedSaved) {
          nextAddress = {
            label: selectedSaved.label,
            line1: selectedSaved.line1,
            line2: selectedSaved.line2,
            postalCode: selectedSaved.postalCode,
            city: selectedSaved.city,
            country: 'FR',
          }
          nextAddressId = selectedSaved.id
          addressSource = 'addressId'
          if (!nextData.contact.phone && isPhoneValid(selectedSaved.phone)) nextData.contact.phone = selectedSaved.phone
        } else if (requestedManualAddress) {
          nextAddress = {
            label: requestedManualAddress.label,
            line1: requestedManualAddress.line1,
            line2: requestedManualAddress.line2,
            postalCode: requestedManualAddress.postalCode,
            city: requestedManualAddress.city,
            country: 'FR',
          }
          nextAddressId = null
          addressSource = 'manual'
        } else {
          const existingAddress = extractOrderAddressSnapshot(order.address)
          if (existingAddress) {
            nextAddress = existingAddress
            const oldAddressId = String(order.addressId || '').trim()
            nextAddressId = oldAddressId || null
          }
        }
        if (!nextAddress) return fail('BAD_REQUEST', '配送订单缺少有效地址')
        if (!isPhoneValid(nextData.contact.phone)) return fail('INVALID_PHONE', '请填写有效电话')
        nextData.address = nextAddress
        nextData.addressId = nextAddressId

        if (!slotLabel) slotLabel = String(order.deliveryTimeSlotLabelSnapshot || '').trim()
        if (!slotLabel && order.saleId) {
          try {
            const saleRes = await db.collection('sales').doc(order.saleId).get()
            const sale = saleRes.data
            slotLabel = String((sale && sale.deliveryTimeSlotLabel) || '').trim()
          } catch (err) {
            slotLabel = ''
          }
        }
        if (!slotLabel) return fail('BAD_REQUEST', '配送需要时间段')
        nextData.deliveryTimeSlotLabelSnapshot = slotLabel
        nextData.acceptDeliverySlot = true
      } else {
        if (hasPhoneInput && requestedPhone && !isPhoneValid(requestedPhone)) return fail('INVALID_PHONE', '请填写有效电话')
        nextData.address = null
        nextData.addressId = null
        nextData.deliveryTimeSlotLabelSnapshot = null
        nextData.acceptDeliverySlot = false
      }

      await db.collection('orders').doc(orderId).update({ data: nextData })
      await db.collection('orderAuditLogs').add({
        data: {
          orderId,
          action: 'ADMIN_UPDATE_FULFILLMENT',
          byOpenId: openId,
          at: db.serverDate(),
          detail: {
            from: String(order.fulfillmentType || ''),
            to: fulfillmentType,
            addressSource,
            phoneChanged: nextData.contact.phone !== currentPhone,
          },
        },
      })
    } catch (err) {
      return fail('TX_FAILED', 'Update fulfillment failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'listOrders') {
    const saleId = event.saleId
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const fulfillmentType = event.fulfillmentType
    const status = String(event.status || '').trim()
    const where = { saleId }
    if (fulfillmentType === 'delivery' || fulfillmentType === 'pickup') where.fulfillmentType = fulfillmentType
    if (
      status === ORDER_STATUS.ACTIVE ||
      status === ORDER_STATUS.CANCELLED ||
      status === ORDER_STATUS.PENDING_REVIEW ||
      status === ORDER_STATUS.REJECTED
    ) {
      where.status = status
    }
    const r = await db.collection('orders').where(where).limit(200).get()
    const orders = r.data || []
    const openIds = Array.from(
      new Set(
        orders
          .map((o) => String((o && o.customerOpenId) || '').trim())
          .filter(Boolean)
      )
    )
    const nicknameByOpenId = {}
    const chunkSize = 50
    for (let i = 0; i < openIds.length; i += chunkSize) {
      const chunk = openIds.slice(i, i + chunkSize)
      try {
        const customerRes = await db
          .collection('customers')
          .where({ _id: _.in(chunk) })
          .get()
        for (const c of customerRes.data || []) {
          const id = String((c && c._id) || '').trim()
          if (!id) continue
          nicknameByOpenId[id] = String((c && c.nickname) || '').trim()
        }
      } catch (err) {
        // Ignore missing/invalid customers collection and fallback to anonymous display.
      }
    }
    const withCustomer = orders.map((o) => {
      const id = String((o && o.customerOpenId) || '').trim()
      return {
        ...o,
        customerNickname: nicknameByOpenId[id] || '',
      }
    })
    return ok({ orders: withCustomer })
  }

  if (action === 'getOrderDetail') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      const r = await db.collection('orders').doc(orderId).get()
      const order = r.data || null
      if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
      let customerAddresses = []
      if (order.customerOpenId) {
        try {
          const customerRes = await db.collection('customers').doc(order.customerOpenId).get()
          customerAddresses = normalizeStoredAddresses(customerRes && customerRes.data && customerRes.data.addresses)
        } catch (err) {
          customerAddresses = []
        }
      }
      return ok({ order, customerAddresses })
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
        if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
          throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
        }

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
        if (order.status === ORDER_STATUS.ACTIVE && order.saleId) {
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
            action: order.status === ORDER_STATUS.ACTIVE ? 'ADMIN_UPDATE_ITEMS' : 'ADMIN_UPDATE_PENDING_ITEMS',
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
        if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REJECTED) return { alreadyCancelled: true }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: { status: ORDER_STATUS.CANCELLED, cancelledAt: now, cancelledByOpenId: openId, updatedAt: now },
        })

        if (order.status === ORDER_STATUS.ACTIVE && order.saleId) {
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
    if (!includeCancelled) where.status = ORDER_STATUS.ACTIVE
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
