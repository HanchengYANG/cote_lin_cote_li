const { call } = require('./api')
const { getSession } = require('./session')

function getStore() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app) {
    if (!getStore._fallback) {
      getStore._fallback = {
        valid: false,
        payload: null,
      }
    }
    return getStore._fallback
  }
  if (!app.globalData) app.globalData = {}
  if (!app.globalData.appSnapshot) {
    app.globalData.appSnapshot = {
      valid: false,
      payload: null,
    }
  }
  return app.globalData.appSnapshot
}

function normalizeSale(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      isOpen: false,
      saleId: '',
      deliveryTimeSlotLabel: '',
      _id: '',
    }
  }
  return {
    isOpen: !!raw.isOpen,
    saleId: String(raw.saleId || raw._id || '').trim(),
    deliveryTimeSlotLabel: String(raw.deliveryTimeSlotLabel || '').trim(),
    _id: String(raw._id || raw.saleId || '').trim(),
  }
}

function normalizePayload(raw) {
  const sale = normalizeSale(raw && raw.sale)
  const dishes = Array.isArray(raw && raw.dishes) ? raw.dishes : []
  const profile = raw && raw.profile && typeof raw.profile === 'object' ? raw.profile : null
  const admin = raw && raw.admin && typeof raw.admin === 'object' ? raw.admin : null
  return {
    sale,
    dishes,
    profile,
    admin,
    updatedAt: Date.now(),
  }
}

function getSnapshot() {
  const store = getStore()
  return store.valid ? store.payload : null
}

function isSnapshotValid() {
  const store = getStore()
  return !!(store.valid && store.payload)
}

function setSnapshot(input) {
  const store = getStore()
  store.payload = normalizePayload(input)
  store.valid = true
  return store.payload
}

function invalidateSnapshot() {
  const store = getStore()
  store.valid = false
  store.payload = null
}

async function ensureFresh(options = {}) {
  const force = !!options.force
  const includeAdmin = !!options.includeAdmin
  const store = getStore()
  if (!force && store.valid && store.payload) return store.payload

  const homeRes = await call('customer', 'bootstrapHome')
  if (!homeRes.ok || !homeRes.data) {
    throw new Error((homeRes && homeRes.message) || '同步失败，请重试')
  }

  let admin = null
  if (includeAdmin) {
    const sess = await getSession()
    if (sess && sess.isAdmin) {
      const dashRes = await call('admin', 'getDashboard')
      if (!dashRes.ok) {
        throw new Error(dashRes.message || '同步失败，请重试')
      }
      admin = {
        activeSale: (dashRes.data && dashRes.data.activeSale) || null,
        stats: (dashRes.data && dashRes.data.stats) || { orderCount: 0 },
      }
    }
  }

  return setSnapshot({
    sale: homeRes.data.sale,
    dishes: homeRes.data.dishes,
    profile: homeRes.data.profile,
    admin,
  })
}

module.exports = {
  getSnapshot,
  isSnapshotValid,
  setSnapshot,
  invalidateSnapshot,
  ensureFresh,
}
