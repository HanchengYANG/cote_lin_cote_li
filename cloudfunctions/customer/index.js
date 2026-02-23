const cloud = require('wx-server-sdk')
const {
  buildAddressId,
  toSafeInt,
  pickLatestOrder,
  normalizeCityKey,
  normalizePhone,
  isPhoneValid,
  isAddressValid,
  normalizeAddressPayload,
  normalizeStoredAddresses,
  sanitizeProfileNickname,
  normalizeProfilePhone,
  toProfileOutput,
  toProfileSummary,
  buildDeliveryMinRule,
  attachMinOrderInfo,
} = require('./lib/shared')
const { ok, fail } = require('./lib/result')
const { getAllByPaging } = require('./lib/db-paging')
const { createProfileHandlers } = require('./handlers/profile')
const { createAddressHandlers } = require('./handlers/addresses')
const { createReadHandlers } = require('./handlers/read')
const { createOrderHandlers } = require('./handlers/orders')
const { createCustomerRuntimeConfigRepo } = require('./repos/runtime-config-repo')
const { createCustomerProfileRepo } = require('./repos/customer-profile-repo')
const { createCustomerSaleItemsRepo } = require('./repos/sale-items-repo')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const {
  getOrCreateRuntimeState,
  getOrCreateDeliveryRulesDoc,
  getOrCreateAdminConfig,
} = createCustomerRuntimeConfigRepo({ db })

const ORDER_STATUS = {
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  REJECTED: 'REJECTED',
}

function normalizePaymentMethod(input) {
  const v = String(input || '').trim()
  if (v === 'cash') return 'cash'
  if (v === 'wechat_transfer') return 'wechat_transfer'
  return ''
}

const {
  getCustomerProfileDoc,
  listCustomerAddressRows,
  composeCustomerDoc,
  getCustomerDoc,
  ensureCustomerDoc,
  getCustomerDocTx,
  saveCustomerDocTx,
} = createCustomerProfileRepo({
  db,
  _,
  getAllByPaging,
  normalizeStoredAddresses,
  sanitizeProfileNickname,
  normalizeProfilePhone,
  normalizePhone,
  toSafeInt,
})
const {
  listSaleItemRowsBySaleId,
  hydrateSaleWithSaleItems,
  getSaleDocTxHydrated,
  replaceSaleItemsForSaleTx,
} = createCustomerSaleItemsRepo({
  db,
  getAllByPaging,
  toSafeInt,
  normalizeSaleDishConfigs,
})

async function getCurrentSaleDoc() {
  const cfg = await getOrCreateAdminConfig()
  const currentSaleId = String((cfg && cfg.currentSaleId) || '').trim()
  if (!currentSaleId) return null
  try {
    const r = await db.collection('sales').doc(currentSaleId).get()
    return hydrateSaleWithSaleItems(r && r.data ? r.data : null)
  } catch (err) {
    return null
  }
}

async function getOrderableSale() {
  const sale = await getCurrentSaleDoc()
  if (!sale) return null
  return String((sale && sale.status) || '').trim() === 'OPEN' ? sale : null
}

function normalizeSaleDishConfigs(sale) {
  const raw = Array.isArray(sale && sale.dishConfigs) ? sale.dishConfigs : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const dishId = String((item && item.dishId) || '').trim()
    if (!dishId || seen.has(dishId)) continue
    const limitQty = Math.max(0, toSafeInt(item && item.limitQty, 0))
    const soldQty = Math.max(0, Math.min(limitQty, toSafeInt(item && item.soldQty, 0)))
    out.push({ dishId, limitQty, soldQty })
    seen.add(dishId)
  }
  return out
}

function validateSaleDishConfigs(sale, normalizedConfigs) {
  const cfg = Array.isArray(normalizedConfigs) ? normalizedConfigs : normalizeSaleDishConfigs(sale)
  const cfgSet = new Set(cfg.map((x) => x.dishId))
  if (cfgSet.size === 0) return { ok: false, message: 'Sale has no dishConfigs' }
  return { ok: true }
}

function throwBiz(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  throw err
}

function isCustomerLocked(order) {
  return !!(order && order.customerLocked)
}

async function getDishesByIds(ids, options = {}) {
  const onlyActive = options.onlyActive !== false
  const dishIds = Array.from(new Set((ids || []).filter(Boolean)))
  if (dishIds.length === 0) return []
  // `in` query has size limits; keep chunks small for compatibility.
  const chunkSize = 10
  const out = []
  for (let i = 0; i < dishIds.length; i += chunkSize) {
    const chunk = dishIds.slice(i, i + chunkSize)
    const r = await db
      .collection('dishes')
      .where({
        _id: _.in(chunk),
      })
      .get()
    out.push(...(r.data || []).filter((d) => d && (!onlyActive || d.isActive)))
  }
  return out
}

function normalizeImageIds(input) {
  return Array.isArray(input) ? input.filter(Boolean).map((x) => String(x).trim()).slice(0, 10) : []
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

function mdToSafeHtml(md) {
  // Lazy-load dependency; requires `markdown-it` in package.json.
  // eslint-disable-next-line global-require
  const MarkdownIt = require('markdown-it')
  const it = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: true,
    typographer: false,
  })

  // Disallow images.
  it.renderer.rules.image = () => ''

  // Map headings to strong paragraphs (rich-text tag support is limited).
  it.renderer.rules.heading_open = () => '<p><strong>'
  it.renderer.rules.heading_close = () => '</strong></p>'

  // Preprocess: remove images + downgrade links to plain text.
  let s = String(md || '')
  s = s.replace(/!\[[^\]]*?\]\([^)]+\)/g, '')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `${text} (${url})`)
  s = s.replace(/<((https?:\/\/)[^>]+)>/g, (_m, url) => url)

  return it.render(s)
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  const profileHandlers = createProfileHandlers({
    db,
    ok,
    fail,
    ensureCustomerDoc,
    getOrCreateAdminConfig,
    attachMinOrderInfo,
    toProfileOutput,
    buildDeliveryMinRule,
    sanitizeProfileNickname,
    normalizePhone,
    isPhoneValid,
    getCustomerDocTx,
    normalizeStoredAddresses,
    normalizeProfilePhone,
    saveCustomerDocTx,
  })
  if (profileHandlers[action]) {
    return profileHandlers[action](event, { openId })
  }

  const addressHandlers = createAddressHandlers({
    db,
    ok,
    fail,
    buildAddressId,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    sanitizeProfileNickname,
    normalizeProfilePhone,
    toProfileOutput,
    buildDeliveryMinRule,
    attachMinOrderInfo,
    getOrCreateAdminConfig,
    getCustomerDocTx,
    saveCustomerDocTx,
    throwBiz,
  })
  if (addressHandlers[action]) {
    return addressHandlers[action](event, { openId })
  }

  const readHandlers = createReadHandlers({
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
  })
  if (readHandlers[action]) {
    return readHandlers[action](event, { openId })
  }

  const orderHandlers = createOrderHandlers({
    db,
    _,
    ok,
    fail,
    ORDER_STATUS,
    HANDOFF_STATUS,
    toSafeInt,
    pickLatestOrder,
    normalizeCityKey,
    normalizePhone,
    isPhoneValid,
    isAddressValid,
    normalizeStoredAddresses,
    sanitizeProfileNickname,
    normalizeProfilePhone,
    buildDeliveryMinRule,
    getOrCreateAdminConfig,
    getOrderableSale,
    getSaleDocTxHydrated,
    normalizeSaleDishConfigs,
    validateSaleDishConfigs,
    getCustomerDocTx,
    replaceSaleItemsForSaleTx,
    throwBiz,
    isCustomerLocked,
    normalizePaymentMethod,
  })
  if (orderHandlers[action]) {
    return orderHandlers[action](event, { openId })
  }


  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
