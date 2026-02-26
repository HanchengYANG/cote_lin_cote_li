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
const { ok, fail } = require('./lib/result')
const { getAllByPaging } = require('./lib/db-paging')
const { createConfigHandlers } = require('./handlers/config')
const { createDashboardHandlers } = require('./handlers/dashboard')
const { createFulfillmentReadHandlers } = require('./handlers/fulfillment-read')
const { createFulfillmentWriteHandlers } = require('./handlers/fulfillment-write')
const { createAdminReadHandlers } = require('./handlers/read-admin')
const { createOrderLabelExportHandlers } = require('./handlers/order-label-export')
const { createManualOrderReadHandlers } = require('./handlers/manual-order-read')
const { createSaleHandlers } = require('./handlers/sale')
const { createDishHandlers } = require('./handlers/dish')
const { createOrderWriteHandlers } = require('./handlers/order-write')
const { createManualOrderWriteHandlers } = require('./handlers/manual-order-write')
const { createAdminSystemConfigRepo } = require('./repos/system-config-repo')
const { createAdminSaleItemsRepo } = require('./repos/sale-items-repo')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const {
  getOrCreateSystemAdmins,
  getOrCreateRuntimeState,
  getOrCreateDeliveryRulesDoc,
  getOrCreateAdminConfig,
  getOrCreateRuntimeStateTx,
} = createAdminSystemConfigRepo({ db })
const {
  listSaleItemRowsBySaleId,
  saleItemRowsToDishConfigs,
  hydrateSaleWithSaleItems,
  getSaleTx,
  replaceSaleItemsForSaleTx,
  replaceSaleItemsForSale,
} = createAdminSaleItemsRepo({
  db,
  getAllByPaging,
  toSafeInt,
  normalizeDishConfigs,
})

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

async function requireAdmin(openId) {
  if (BYPASS_ADMIN_AUTH) return await getOrCreateSystemAdmins()
  const cfg = await getOrCreateSystemAdmins()
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

async function getSaleRaw(saleId) {
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
      const r = await db.collection('customer_profiles').where({ _id: _.in(chunk) }).get()
      out.push(...(r.data || []))
    } catch (err) {
      // Ignore missing/invalid customers collection and fallback to anonymous display.
    }
  }
  return out
}

async function getSale(saleId) {
  const sale = await getSaleRaw(saleId)
  return hydrateSaleWithSaleItems(sale)
}

async function getCustomerAddressesByOpenIds(openIds) {
  const ids = Array.from(new Set((openIds || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (ids.length === 0) return []
  const chunkSize = 50
  const out = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    try {
      const r = await db.collection('customer_addresses').where({ customerOpenId: _.in(chunk) }).get()
      out.push(...(r.data || []))
    } catch (err) {
      // ignore missing collection or query issue for admin display fallback
    }
  }
  return out
}

function buildAddressMapByOpenId(addressRows) {
  const grouped = new Map()
  for (const row of Array.isArray(addressRows) ? addressRows : []) {
    const openId = String((row && row.customerOpenId) || '').trim()
    if (!openId) continue
    const arr = grouped.get(openId) || []
    arr.push(row)
    grouped.set(openId, arr)
  }
  const out = new Map()
  for (const [openId, rows] of grouped.entries()) {
    out.set(openId, normalizeStoredAddresses(rows))
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
  if (v === 'wechat_transfer') return 'wechat_transfer'
  if (v === 'alipay_transfer') return 'alipay_transfer'
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
    const r = await db.collection('sale_fulfillment_plans').doc(id).get()
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
    await db.collection('sale_fulfillment_plans').doc(id).update({ data: payload })
    return { ...existing, ...payload }
  }
  await db.collection('sale_fulfillment_plans').doc(id).set({
    data: {
      createdAt: now,
      createdByOpenId: openId,
      ...payload,
    },
  })
  return { _id: id, createdAt: now, createdByOpenId: openId, ...payload }
}

async function getActiveOrdersBySaleWithNicknames(saleId) {
  const orders = await getAllByPaging(
    (skip, limit) => db.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).skip(skip).limit(limit),
    { pageSize: 100 }
  )
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
    const r = await db.collection('sale_production_progress').doc(id).get()
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
    await db.collection('sale_production_progress').doc(id).update({ data: payload })
    return { ...existing, ...payload }
  }
  await db.collection('sale_production_progress').doc(id).set({
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

  const configHandlers = createConfigHandlers({
    db,
    ok,
    normalizeDeliveryMinByCity,
    toSafeInt,
    getOrCreateAdminConfig,
  })
  if (configHandlers[action]) {
    return configHandlers[action](event, { openId })
  }

  const dashboardHandlers = createDashboardHandlers({
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
  })
  if (dashboardHandlers[action]) {
    return dashboardHandlers[action](event, { openId })
  }

  const fulfillmentReadHandlers = createFulfillmentReadHandlers({
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
  })
  if (fulfillmentReadHandlers[action]) {
    return fulfillmentReadHandlers[action](event, { openId })
  }

  const fulfillmentWriteHandlers = createFulfillmentWriteHandlers({
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
  })
  if (fulfillmentWriteHandlers[action]) {
    return fulfillmentWriteHandlers[action](event, { openId })
  }

  const adminReadHandlers = createAdminReadHandlers({
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    ORDER_STATUS,
    getCustomersByOpenIds,
    getCustomerAddressesByOpenIds,
    buildAddressMapByOpenId,
    pickDefaultPhone,
    getSale,
    toEpochMs,
    toSafeInt,
    normalizePhone,
    formatOrderAddress,
    normalizeStoredAddresses,
  })
  if (adminReadHandlers[action]) {
    return adminReadHandlers[action](event, { openId })
  }

  const orderLabelExportHandlers = createOrderLabelExportHandlers({
    cloud,
    db,
    ok,
    fail,
    ORDER_STATUS,
    getSale,
    getCustomersByOpenIds,
    getActiveOrdersBySaleWithNicknames,
    filterOrdersByFulfillmentType,
    getSaleFulfillmentPlan,
    buildFulfillmentOrderedOrders,
    toEpochMs,
    normalizePhone,
    formatOrderAddress,
    getTempUrlMap,
  })
  if (orderLabelExportHandlers[action]) {
    return orderLabelExportHandlers[action](event, { openId })
  }

  const manualOrderReadHandlers = createManualOrderReadHandlers({
    db,
    getAllByPaging,
    ok,
    fail,
    getSale,
    getCustomerAddressesByOpenIds,
    buildAddressMapByOpenId,
    pickDefaultPhone,
    normalizePhone,
  })
  if (manualOrderReadHandlers[action]) {
    return manualOrderReadHandlers[action](event, { openId })
  }

  const saleHandlers = createSaleHandlers({
    cloud,
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    listSalesFn: listSales,
    getSale,
    getSaleTx,
    getOrCreateAdminConfig,
    getOrCreateRuntimeStateTx,
    parseAndValidateDeliverySlot,
    normalizeDishConfigs,
    dishConfigMap,
    getDishesByIds,
    toSafeInt,
    normalizeImageIds,
    getTempUrlMap,
    replaceSaleItemsForSale,
    replaceSaleItemsForSaleTx,
    buildOrderId,
    normalizeOrderItems,
    throwBiz,
    normalizeSaleStatusForForceSet,
    ORDER_STATUS,
    SALE_STATUS,
    HANDOFF_STATUS,
  })
  if (saleHandlers[action]) {
    return saleHandlers[action](event, { openId })
  }

  const dishHandlers = createDishHandlers({
    cloud,
    db,
    ok,
    fail,
    getAllByPaging,
    normalizeImageIds,
    getTempUrlMap,
    stripMarkdownToPlain,
  })
  if (dishHandlers[action]) {
    return dishHandlers[action](event, { openId })
  }

  const orderWriteHandlers = createOrderWriteHandlers({
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    ORDER_STATUS,
    HANDOFF_STATUS,
    throwBiz,
    getSaleTx,
    normalizeDishConfigs,
    dishConfigMap,
    toSafeInt,
    normalizeOrderItems,
    replaceSaleItemsForSaleTx,
    parseAndValidateDeliverySlot,
    normalizePhone,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    isPhoneValid,
    extractOrderAddressSnapshot,
  })
  if (orderWriteHandlers[action]) {
    return orderWriteHandlers[action](event, { openId })
  }

  const manualOrderWriteHandlers = createManualOrderWriteHandlers({
    db,
    _,
    ok,
    fail,
    ORDER_STATUS,
    HANDOFF_STATUS,
    throwBiz,
    getSaleTx,
    normalizeDishConfigs,
    toSafeInt,
    normalizeOrderItems,
    replaceSaleItemsForSaleTx,
    normalizePhone,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    isPhoneValid,
    extractOrderAddressSnapshot,
  })
  if (manualOrderWriteHandlers[action]) {
    return manualOrderWriteHandlers[action](event, { openId })
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
