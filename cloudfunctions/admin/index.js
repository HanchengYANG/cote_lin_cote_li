const cloud = require('wx-server-sdk')
const {
  toSafeInt,
  normalizeDeliveryMinByCity,
  buildOrderId,
  parseAndValidateDeliverySlot,
  normalizePhone,
  isPhoneValid,
  normalizeAddressPayload,
  normalizeStoredAddresses,
  extractOrderAddressSnapshot,
  formatOrderAddress,
  normalizeDishConfigs,
  dishConfigMap,
  normalizeOrderItems,
} = require('./lib/shared')

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
const SALE_STATUS = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  FULFILLING: 'FULFILLING',
  COMPLETED: 'COMPLETED',
}
const HANDOFF_STATUS = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
}
const PAID_STATUS = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
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
        currentSaleId: null,
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

function throwBiz(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  throw err
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

function toEpochMs(input) {
  if (!input) return 0
  if (typeof input === 'number' && Number.isFinite(input)) return input
  const d = new Date(input)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}

async function getCustomersByOpenIds(openIds) {
  const ids = Array.from(new Set((openIds || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (ids.length === 0) return []
  const chunkSize = 50
  const out = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    try {
      const r = await db.collection('customers').where({ _id: _.in(chunk) }).get()
      out.push(...(r.data || []))
    } catch (err) {
      // Ignore missing/invalid customers collection and fallback to anonymous display.
    }
  }
  return out
}

function pickDefaultPhone(addresses, defaultAddressId) {
  const arr = normalizeStoredAddresses(addresses)
  const defaultId = String(defaultAddressId || '').trim()
  const picked = arr.find((x) => String((x && x.id) || '').trim() === defaultId) || arr[0] || null
  return normalizePhone(picked && picked.phone)
}

function normalizeHandoffStatus(input) {
  return String(input || '').trim() === HANDOFF_STATUS.DELIVERED ? HANDOFF_STATUS.DELIVERED : HANDOFF_STATUS.PENDING
}

function normalizePaidStatus(input) {
  return String(input || '').trim() === PAID_STATUS.PAID ? PAID_STATUS.PAID : PAID_STATUS.UNPAID
}

function normalizePaymentMethodForAdmin(input) {
  const v = String(input || '').trim()
  if (v === 'cash') return 'cash'
  if (v === 'wechat_transfer' || v === 'transfer' || v === 'bank') return 'wechat_transfer'
  return ''
}

function normalizeSaleStatusForForceSet(input) {
  const v = String(input || '').trim()
  if (v === SALE_STATUS.DRAFT) return SALE_STATUS.DRAFT
  if (v === SALE_STATUS.OPEN) return SALE_STATUS.OPEN
  if (v === SALE_STATUS.CLOSED) return SALE_STATUS.CLOSED
  if (v === SALE_STATUS.FULFILLING) return SALE_STATUS.FULFILLING
  if (v === SALE_STATUS.COMPLETED) return SALE_STATUS.COMPLETED
  return ''
}

function formatFulfillmentAddressText(order) {
  if (!order || String(order.fulfillmentType || '') !== 'delivery') return ''
  return formatOrderAddress(order.address)
}

async function getSaleFulfillmentPlan(saleId) {
  const id = String(saleId || '').trim()
  if (!id) return null
  try {
    const r = await db.collection('saleFulfillmentPlans').doc(id).get()
    const data = r && r.data ? r.data : null
    if (!data) return null
    return {
      ...data,
      orderIds: Array.from(new Set((Array.isArray(data.orderIds) ? data.orderIds : []).map((x) => String(x || '').trim()).filter(Boolean))),
    }
  } catch (err) {
    return null
  }
}

async function saveSaleFulfillmentPlan(saleId, orderIds, openId) {
  const id = String(saleId || '').trim()
  const nextOrderIds = Array.from(new Set((Array.isArray(orderIds) ? orderIds : []).map((x) => String(x || '').trim()).filter(Boolean)))
  const now = db.serverDate()
  const existing = await getSaleFulfillmentPlan(id)
  const payload = {
    saleId: id,
    orderIds: nextOrderIds,
    updatedAt: now,
    updatedByOpenId: openId,
  }
  if (existing) {
    await db.collection('saleFulfillmentPlans').doc(id).update({ data: payload })
    return { ...existing, ...payload }
  }
  await db.collection('saleFulfillmentPlans').doc(id).set({
    data: {
      createdAt: now,
      createdByOpenId: openId,
      ...payload,
    },
  })
  return { _id: id, createdAt: now, createdByOpenId: openId, ...payload }
}

async function getActiveOrdersBySaleWithNicknames(saleId) {
  const r = await db.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).limit(500).get()
  const orders = r.data || []
  const customerOpenIds = Array.from(
    new Set(
      orders
        .map((o) => String((o && o.customerOpenId) || '').trim())
        .filter(Boolean)
    )
  )
  const customers = await getCustomersByOpenIds(customerOpenIds)
  const nicknameByOpenId = new Map()
  for (const c of customers) {
    const id = String((c && c._id) || '').trim()
    if (!id) continue
    nicknameByOpenId.set(id, String((c && c.nickname) || '').trim())
  }
  return orders.map((o) => ({
    ...o,
    customerNickname: nicknameByOpenId.get(String((o && o.customerOpenId) || '').trim()) || '',
  }))
}

function buildFulfillmentOrderedOrders(rawOrders, planOrderIds) {
  const activeOrders = Array.isArray(rawOrders) ? rawOrders.slice() : []
  const byId = new Map()
  for (const o of activeOrders) {
    const id = String((o && o._id) || '').trim()
    if (!id) continue
    byId.set(id, o)
  }
  const result = []
  const seen = new Set()
  const orderedIds = Array.isArray(planOrderIds) ? planOrderIds : []
  for (const idRaw of orderedIds) {
    const id = String(idRaw || '').trim()
    if (!id || seen.has(id)) continue
    const order = byId.get(id)
    if (!order) continue
    seen.add(id)
    result.push(order)
  }
  const appended = activeOrders
    .filter((o) => {
      const id = String((o && o._id) || '').trim()
      return !!id && !seen.has(id)
    })
    .sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))
  for (const o of appended) {
    const id = String((o && o._id) || '').trim()
    seen.add(id)
    result.push(o)
  }
  return {
    orders: result,
    appendedOrderIds: appended.map((o) => String((o && o._id) || '').trim()).filter(Boolean),
  }
}

function toFulfillmentOrderRow(order) {
  const totals = order && order.totals ? order.totals : {}
  const payment = order && order.payment ? order.payment : {}
  return {
    _id: String((order && order._id) || ''),
    saleId: String((order && order.saleId) || ''),
    status: String((order && order.status) || ''),
    createdAt: (order && order.createdAt) || null,
    customerOpenId: String((order && order.customerOpenId) || ''),
    customerNickname: String((order && order.customerNickname) || '').trim() || '匿名客户',
    fulfillmentType: String((order && order.fulfillmentType) || 'pickup'),
    contact: { phone: normalizePhone(order && order.contact && order.contact.phone) },
    addressText: formatFulfillmentAddressText(order),
    totals: {
      qty: toSafeInt(totals.qty, 0),
      amountCents: toSafeInt(totals.amountCents, 0),
    },
    payment: {
      method: normalizePaymentMethodForAdmin(payment.method) || String(payment.method || 'cash'),
      paidStatus: normalizePaidStatus(payment.paidStatus),
    },
    handoffStatus: normalizeHandoffStatus(order && order.handoffStatus),
    handedOffAt: (order && order.handedOffAt) || null,
    deliveryTimeSlotLabelSnapshot: String((order && order.deliveryTimeSlotLabelSnapshot) || ''),
  }
}

function filterOrdersByFulfillmentType(orders, type) {
  const target = String(type || '').trim()
  return (Array.isArray(orders) ? orders : []).filter((o) => String((o && o.fulfillmentType) || '').trim() === target)
}

function buildProgressSummaryFromRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  let deliveredOrders = 0
  let paidOrders = 0
  let doneOrders = 0
  for (const o of list) {
    const delivered = normalizeHandoffStatus(o && o.handoffStatus) === HANDOFF_STATUS.DELIVERED
    const paid = normalizePaidStatus(o && o.payment && o.payment.paidStatus) === PAID_STATUS.PAID
    if (delivered) deliveredOrders += 1
    if (paid) paidOrders += 1
    if (delivered && paid) doneOrders += 1
  }
  const totalActiveOrders = list.length
  const remainingOrders = Math.max(0, totalActiveOrders - doneOrders)
  const completionPercent = totalActiveOrders > 0 ? Math.max(0, Math.min(100, Math.round((doneOrders * 100) / totalActiveOrders))) : 0
  return {
    totalActiveOrders,
    deliveredOrders,
    paidOrders,
    doneOrders,
    remainingOrders,
    completionPercent,
  }
}

function sumRevenueCentsFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    return sum + Math.max(0, toSafeInt(row && row.totals && row.totals.amountCents, 0))
  }, 0)
}

function buildFulfillingOpsSummaryFromRows(rows) {
  const allRows = Array.isArray(rows) ? rows : []
  const deliveryRows = filterOrdersByFulfillmentType(allRows, 'delivery')
  const pickupRows = filterOrdersByFulfillmentType(allRows, 'pickup')
  const overall = buildProgressSummaryFromRows(allRows)
  const delivery = buildProgressSummaryFromRows(deliveryRows)
  const pickup = buildProgressSummaryFromRows(pickupRows)
  return {
    ...overall,
    delivery: {
      total: delivery.totalActiveOrders,
      done: delivery.doneOrders,
      delivered: delivery.deliveredOrders,
      paid: delivery.paidOrders,
      remaining: delivery.remainingOrders,
    },
    pickup: {
      total: pickup.totalActiveOrders,
      done: pickup.doneOrders,
      delivered: pickup.deliveredOrders,
      paid: pickup.paidOrders,
      remaining: pickup.remainingOrders,
    },
  }
}

function normalizeProductionProgressItems(input) {
  const arr = Array.isArray(input) ? input : []
  return arr
    .map((it) => ({
      dishId: String((it && it.dishId) || '').trim(),
      dishNameSnapshot: String((it && it.dishNameSnapshot) || '').trim(),
      needQty: Math.max(0, toSafeInt(it && it.needQty, 0)),
      preparedQty: Math.max(0, toSafeInt(it && it.preparedQty, 0)),
    }))
    .filter((it) => it.dishId)
}

async function getSaleProductionProgress(saleId) {
  const id = String(saleId || '').trim()
  if (!id) return null
  try {
    const r = await db.collection('saleProductionProgress').doc(id).get()
    const data = r && r.data ? r.data : null
    if (!data) return null
    return {
      ...data,
      items: normalizeProductionProgressItems(data.items),
    }
  } catch (err) {
    return null
  }
}

function computeProductionSummary(items) {
  const list = Array.isArray(items) ? items : []
  let totalNeedQty = 0
  let totalPreparedQty = 0
  let totalPreparedCapped = 0
  for (const it of list) {
    const needQty = Math.max(0, toSafeInt(it && it.needQty, 0))
    const preparedQty = Math.max(0, toSafeInt(it && it.preparedQty, 0))
    totalNeedQty += needQty
    totalPreparedQty += preparedQty
    totalPreparedCapped += Math.min(needQty, preparedQty)
  }
  const completionPercent = totalNeedQty > 0 ? Math.max(0, Math.min(100, Math.round((totalPreparedCapped * 100) / totalNeedQty))) : 0
  return {
    totalNeedQty,
    totalPreparedQty,
    completionPercent,
  }
}

async function buildSaleProductionBoardBySale(sale) {
  const saleId = String((sale && sale._id) || '').trim()
  const dishConfigs = normalizeDishConfigs(sale && sale.dishConfigs)
  const dishIds = dishConfigs.map((x) => String(x.dishId || '').trim()).filter(Boolean)
  const dishes = await getDishesByIds(dishIds)
  const dishNameMap = new Map((dishes || []).map((d) => [String(d._id || '').trim(), String(d.name || d._id || '').trim()]))
  const existing = await getSaleProductionProgress(saleId)
  const preparedMap = new Map(
    normalizeProductionProgressItems(existing && existing.items).map((it) => [String(it.dishId || '').trim(), Math.max(0, toSafeInt(it.preparedQty, 0))])
  )
  const items = dishConfigs
    .map((cfg) => {
      const dishId = String(cfg.dishId || '').trim()
      const needQty = Math.max(0, toSafeInt(cfg.soldQty, 0))
      const preparedQty = Math.max(0, toSafeInt(preparedMap.get(dishId), 0))
      return {
        dishId,
        dishNameSnapshot: dishNameMap.get(dishId) || dishId || '未知菜品',
        needQty,
        preparedQty,
      }
    })
    .filter((it) => it.needQty > 0 || it.preparedQty > 0)
    .sort((a, b) => {
      if (b.needQty !== a.needQty) return b.needQty - a.needQty
      return String(a.dishNameSnapshot || '').localeCompare(String(b.dishNameSnapshot || ''))
    })
  const summary = computeProductionSummary(items)
  return {
    items,
    ...summary,
    docMeta: existing
      ? {
          updatedAt: existing.updatedAt || null,
          updatedByOpenId: String(existing.updatedByOpenId || ''),
        }
      : {
          updatedAt: null,
          updatedByOpenId: '',
        },
  }
}

async function saveSaleProductionProgressBoard(saleId, items, openId) {
  const id = String(saleId || '').trim()
  const now = db.serverDate()
  const normalizedItems = normalizeProductionProgressItems(items)
  const payload = {
    saleId: id,
    items: normalizedItems,
    updatedAt: now,
    updatedByOpenId: openId,
  }
  const existing = await getSaleProductionProgress(id)
  if (existing) {
    await db.collection('saleProductionProgress').doc(id).update({ data: payload })
    return { ...existing, ...payload }
  }
  await db.collection('saleProductionProgress').doc(id).set({
    data: {
      createdAt: now,
      createdByOpenId: openId,
      ...payload,
    },
  })
  return { _id: id, createdAt: now, createdByOpenId: openId, ...payload }
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
    let activeSaleId = String((cfg && (cfg.currentSaleId || cfg.activeSaleId)) || '').trim()
    let activeSale = null
    let orderCount = 0
    let activeSaleRevenueCents = 0
    let activeSaleRevenueEuro = '0.00'
    let activeSaleDishStats = []
    let activeSaleOpsSummary = null
    let canCompleteActiveSale = false
    let activeSaleIncompleteReason = null
    if (!activeSaleId) {
      try {
        const fallbackSales = await listSales(20)
        const fallbackSale = (fallbackSales || []).find((s) => {
          const status = String((s && s.status) || '').trim()
          return status === SALE_STATUS.OPEN || status === SALE_STATUS.CLOSED || status === SALE_STATUS.FULFILLING
        })
        activeSaleId = String((fallbackSale && fallbackSale._id) || '').trim()
      } catch (err) {
        activeSaleId = ''
      }
    }

    if (activeSaleId) {
      try {
        activeSale = await getSale(activeSaleId)
        if (activeSale && String(activeSale.status || '').trim() === SALE_STATUS.COMPLETED) {
          activeSale = null
        } else if (activeSale) {
          const orderRes = await db.collection('orders').where({ saleId: activeSaleId }).limit(500).get()
          const activeOrders = (orderRes.data || []).filter((x) => String((x && x.status) || '').trim() === ORDER_STATUS.ACTIVE)
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
            data: { adminOpenIds: [], activeSaleId: null, currentSaleId: null, updatedAt: db.serverDate() },
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
          await cfgRef.update({ data: { activeSaleId: existingOpen._id, currentSaleId: existingOpen._id, updatedAt: db.serverDate() } })
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

        await cfgRef.update({ data: { activeSaleId: saleId, currentSaleId: saleId, updatedAt: db.serverDate() } })
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
        await cfgRef.update({ data: { activeSaleId: null, currentSaleId: saleId, updatedAt: db.serverDate() } })
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
            handoffStatus: HANDOFF_STATUS.PENDING,
            handedOffAt: _.remove,
            handedOffByOpenId: _.remove,
            deliveryTimeSlotLabelSnapshot,
            pendingReason: _.remove,
            pendingDetail: _.remove,
            pendingAt: _.remove,
            approvedAt: now,
            customerLocked: true,
            customerLockedAt: now,
            customerLockedReason: 'ADMIN_APPROVED_PENDING',
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
    const customers = await getCustomersByOpenIds(openIds)
    for (const c of customers) {
      const id = String((c && c._id) || '').trim()
      if (!id) continue
      nicknameByOpenId[id] = String((c && c.nickname) || '').trim()
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

  if (action === 'getSaleReview') {
    const saleId = String(event.saleId || '').trim()
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')

    let sale = null
    try {
      sale = await getSale(saleId)
    } catch (err) {
      sale = null
    }
    if (!sale) return fail('NOT_FOUND', 'Sale not found')
    if (String((sale && sale.status) || '').trim() === 'DRAFT') {
      return fail('BAD_REQUEST', 'Draft sale is not reviewable')
    }

    const orderRes = await db.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).limit(500).get()
    const rawOrders = orderRes.data || []
    rawOrders.sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))

    const customerOpenIds = Array.from(
      new Set(
        rawOrders
          .map((o) => String((o && o.customerOpenId) || '').trim())
          .filter(Boolean)
      )
    )
    const customerList = await getCustomersByOpenIds(customerOpenIds)
    const nicknameByOpenId = new Map()
    for (const c of customerList) {
      const id = String((c && c._id) || '').trim()
      if (!id) continue
      nicknameByOpenId.set(id, String((c && c.nickname) || '').trim())
    }

    const dishAgg = new Map()
    let totalQty = 0
    let revenueCents = 0

    const orders = rawOrders.map((o) => {
      const customerOpenId = String((o && o.customerOpenId) || '').trim()

      let orderQty = toSafeInt(o && o.totals && o.totals.qty, 0)
      let orderAmountCents = toSafeInt(o && o.totals && o.totals.amountCents, 0)
      let computedQty = 0
      let computedAmountCents = 0

      const items = (Array.isArray(o && o.items) ? o.items : []).map((it) => {
        const dishId = String((it && it.dishId) || '').trim()
        const dishName = String((it && it.dishName) || '').trim() || dishId || '未知菜品'
        const qty = Math.max(0, toSafeInt(it && it.qty, 0))
        const unitPriceCents = toSafeInt(it && (it.unitPriceCents != null ? it.unitPriceCents : it.priceCents), 0)
        const lineTotalCents = toSafeInt(it && it.lineTotalCents, unitPriceCents * qty)
        computedQty += qty
        computedAmountCents += lineTotalCents

        if (qty > 0) {
          const prev = dishAgg.get(dishId || dishName) || {
            dishId: dishId || '',
            dishName,
            qty: 0,
            amountCents: 0,
          }
          prev.qty += qty
          prev.amountCents += lineTotalCents
          if (!prev.dishName && dishName) prev.dishName = dishName
          if (!prev.dishId && dishId) prev.dishId = dishId
          dishAgg.set(dishId || dishName, prev)
        }

        return {
          dishId,
          dishName,
          qty,
          unitPriceCents,
          lineTotalCents,
        }
      })

      if (orderQty <= 0 && computedQty > 0) orderQty = computedQty
      if (orderAmountCents <= 0 && computedAmountCents > 0) orderAmountCents = computedAmountCents
      totalQty += orderQty
      revenueCents += orderAmountCents

      return {
        _id: String((o && o._id) || ''),
        saleId: String((o && o.saleId) || ''),
        createdAt: (o && o.createdAt) || null,
        status: String((o && o.status) || ''),
        fulfillmentType: String((o && o.fulfillmentType) || 'pickup'),
        deliveryTimeSlotLabelSnapshot: String((o && o.deliveryTimeSlotLabelSnapshot) || ''),
        customerOpenId,
        customerNickname: nicknameByOpenId.get(customerOpenId) || '',
        contact: {
          phone: normalizePhone(o && o.contact && o.contact.phone),
        },
        address: o && o.address ? o.address : null,
        addressText: formatOrderAddress(o && o.address),
        remark: String((o && o.remark) || ''),
        totals: {
          qty: orderQty,
          amountCents: orderAmountCents,
        },
        items,
      }
    })

    const dishSales = Array.from(dishAgg.values()).sort((a, b) => {
      if (b.qty !== a.qty) return b.qty - a.qty
      return String(a.dishName || '').localeCompare(String(b.dishName || ''))
    })

    return ok({
      sale: {
        _id: String((sale && sale._id) || saleId),
        status: String((sale && sale.status) || ''),
        createdAt: (sale && sale.createdAt) || null,
        deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
      },
      summary: {
        orderCount: orders.length,
        totalQty,
        revenueCents,
        revenueEuro: (Number(revenueCents || 0) / 100).toFixed(2),
      },
      dishSales,
      orders,
    })
  }

  if (action === 'listFulfillmentSales') {
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
  }

  if (action === 'listPickupSales') {
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
  }

  if (action === 'getSaleProductionBoard') {
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
  }

  if (action === 'updateSaleProductionProgress') {
    const saleId = String(event.saleId || '').trim()
    const dishId = String(event.dishId || '').trim()
    const preparedQty = Math.max(0, toSafeInt(event.preparedQty, 0))
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
      const nextItems = board.items.map((it, i) => (i === idx ? { ...it, preparedQty } : it))
      await saveSaleProductionProgressBoard(saleId, nextItems, openId)
      const nextSummary = computeProductionSummary(nextItems)
      return ok({
        saleId,
        dishId,
        preparedQty,
        production: {
          totalNeedQty: nextSummary.totalNeedQty,
          totalPreparedQty: nextSummary.totalPreparedQty,
          completionPercent: nextSummary.completionPercent,
          items: nextItems.map((it) => ({
            dishId: it.dishId,
            dishName: it.dishNameSnapshot,
            needQty: it.needQty,
            preparedQty: it.preparedQty,
          })),
        },
      })
    } catch (err) {
      const msg = String((err && (err.errMsg || err.message)) || '')
      if (/collection not exists|Db or Table not exist/i.test(msg)) {
        return fail('COLLECTION_NOT_FOUND', '请先创建数据库集合 saleProductionProgress', msg)
      }
      return fail('TX_FAILED', 'Update production progress failed', msg || String(err))
    }
  }

  if (action === 'getSaleFulfillmentPrep') {
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
  }

  if (action === 'saveSaleFulfillmentOrder') {
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
        return fail('COLLECTION_NOT_FOUND', '请先创建数据库集合 saleFulfillmentPlans', msg)
      }
      return fail('TX_FAILED', 'Save fulfillment order failed', String(err && err.message))
    }

    return ok({
      orderIds: finalOrderIds,
      appendedOrderIds: missingIds,
      saleStatusChanged: null,
    })
  }

  if (action === 'markSalePrepDone') {
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
      await db.collection('adminConfig').doc('main').update({
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
  }

  if (action === 'getSaleFulfillmentRun') {
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
  }

  if (action === 'getPickupRun') {
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
  }

  if (action === 'updateOrderPaymentMethod') {
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
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
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
  }

  if (action === 'updateOrderFulfillmentProgress') {
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
        await tx.collection('orderAuditLogs').add({
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
  }

  if (action === 'completeSaleFulfillment') {
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

        const orderRes = await tx.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).limit(500).get()
        const orders = orderRes.data || []
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
          const cfgRef = tx.collection('adminConfig').doc('main')
          const cfgGet = await cfgRef.get()
          const cfg = cfgGet && cfgGet.data ? cfgGet.data : null
          if (cfg && String((cfg && cfg.activeSaleId) || '').trim() === saleId) {
            await cfgRef.update({
              data: {
                activeSaleId: null,
                currentSaleId: null,
                updatedAt: db.serverDate(),
              },
            })
          } else {
            await cfgRef.update({
              data: {
                currentSaleId: null,
                updatedAt: db.serverDate(),
              },
            })
          }
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
  }

  if (action === 'forceSetCurrentSaleStatus') {
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

        const cfgRef = tx.collection('adminConfig').doc('main')
        let cfg = null
        try {
          const cfgGet = await cfgRef.get()
          cfg = cfgGet && cfgGet.data ? cfgGet.data : null
        } catch (err) {
          cfg = null
        }
        if (!cfg) {
          await cfgRef.set({
            data: {
              adminOpenIds: [],
              activeSaleId: null,
              currentSaleId: null,
              updatedAt: now,
            },
          })
          const cfgGet2 = await cfgRef.get()
          cfg = cfgGet2 && cfgGet2.data ? cfgGet2.data : { adminOpenIds: [] }
        }

        let activeSaleId = String((cfg && cfg.activeSaleId) || '').trim()
        let currentSaleId = String((cfg && cfg.currentSaleId) || '').trim()
        if (nextStatus === SALE_STATUS.OPEN) {
          activeSaleId = saleId
          currentSaleId = saleId
        } else if (nextStatus === SALE_STATUS.CLOSED || nextStatus === SALE_STATUS.FULFILLING) {
          if (activeSaleId === saleId) activeSaleId = ''
          currentSaleId = saleId
        } else {
          if (activeSaleId === saleId) activeSaleId = ''
          if (currentSaleId === saleId) currentSaleId = ''
        }
        await cfgRef.update({
          data: {
            activeSaleId: activeSaleId || null,
            currentSaleId: currentSaleId || null,
            updatedAt: now,
          },
        })

        return {
          saleId,
          fromStatus: prevStatus,
          toStatus: nextStatus,
          activeSaleId: activeSaleId || null,
          currentSaleId: currentSaleId || null,
        }
      })
      return ok(txRes || {})
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Force set sale status failed', err.detail)
      return fail('TX_FAILED', 'Force set sale status failed', String(err && err.message))
    }
  }

  if (action === 'listCustomers') {
    let customers = []
    try {
      const r = await db.collection('customers').limit(500).get()
      customers = r.data || []
    } catch (err) {
      customers = []
    }
    const openIds = Array.from(new Set(customers.map((c) => String((c && c._id) || '').trim()).filter(Boolean)))
    const statsByOpenId = new Map()
    const chunkSize = 20
    for (let i = 0; i < openIds.length; i += chunkSize) {
      const chunk = openIds.slice(i, i + chunkSize)
      let orders = []
      try {
        const r = await db.collection('orders').where({ customerOpenId: _.in(chunk) }).limit(500).get()
        orders = r.data || []
      } catch (err) {
        orders = []
      }
      for (const o of orders) {
        const id = String((o && o.customerOpenId) || '').trim()
        if (!id) continue
        const prev = statsByOpenId.get(id) || { orderCount: 0, lastOrderAtMs: 0, lastOrderAt: null }
        const curMs = toEpochMs(o && o.createdAt)
        const next = {
          orderCount: prev.orderCount + 1,
          lastOrderAtMs: prev.lastOrderAtMs,
          lastOrderAt: prev.lastOrderAt,
        }
        if (curMs >= prev.lastOrderAtMs) {
          next.lastOrderAtMs = curMs
          next.lastOrderAt = o && o.createdAt ? o.createdAt : null
        }
        statsByOpenId.set(id, next)
      }
    }

    const rows = customers.map((c) => {
      const customerOpenId = String((c && c._id) || '').trim()
      const nickname = String((c && c.nickname) || '').trim()
      const addresses = normalizeStoredAddresses(c && c.addresses)
      const defaultAddressId = String((c && c.defaultAddressId) || '').trim()
      const stats = statsByOpenId.get(customerOpenId) || { orderCount: 0, lastOrderAt: null, lastOrderAtMs: 0 }
      return {
        customerOpenId,
        nickname,
        addressCount: addresses.length,
        defaultPhone: pickDefaultPhone(addresses, defaultAddressId),
        orderCount: stats.orderCount,
        lastOrderAt: stats.lastOrderAt || null,
        updatedAt: (c && c.updatedAt) || null,
      }
    })

    rows.sort((a, b) => {
      const ta = toEpochMs(a.lastOrderAt) || toEpochMs(a.updatedAt)
      const tb = toEpochMs(b.lastOrderAt) || toEpochMs(b.updatedAt)
      return tb - ta
    })
    return ok({ customers: rows })
  }

  if (action === 'getCustomerDetail') {
    const customerOpenId = String(event.customerOpenId || '').trim()
    if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
    let customer = null
    try {
      const r = await db.collection('customers').doc(customerOpenId).get()
      customer = r.data || null
    } catch (err) {
      customer = null
    }
    if (!customer) return fail('NOT_FOUND', 'Customer not found')

    let orders = []
    try {
      const r = await db.collection('orders').where({ customerOpenId }).limit(500).get()
      orders = r.data || []
    } catch (err) {
      orders = []
    }
    orders.sort((a, b) => toEpochMs(b && b.createdAt) - toEpochMs(a && a.createdAt))

    const nickname = String((customer && customer.nickname) || '').trim()
    const withCustomer = orders.map((o) => ({
      ...o,
      customerNickname: nickname,
    }))

    return ok({
      customer: {
        customerOpenId,
        nickname,
        defaultAddressId: String((customer && customer.defaultAddressId) || '').trim(),
        addresses: normalizeStoredAddresses(customer && customer.addresses),
        updatedAt: customer && customer.updatedAt ? customer.updatedAt : null,
      },
      orders: withCustomer,
    })
  }

  if (action === 'getOrderDetail') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      const r = await db.collection('orders').doc(orderId).get()
      const order = r.data || null
      if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
      let customerAddresses = []
      let customerNickname = ''
      if (order.customerOpenId) {
        try {
          const customerRes = await db.collection('customers').doc(order.customerOpenId).get()
          customerNickname = String((customerRes && customerRes.data && customerRes.data.nickname) || '').trim()
          customerAddresses = normalizeStoredAddresses(customerRes && customerRes.data && customerRes.data.addresses)
        } catch (err) {
          customerNickname = ''
          customerAddresses = []
        }
      }
      return ok({ order: { ...order, customerNickname }, customerAddresses })
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

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
