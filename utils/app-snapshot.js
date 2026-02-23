const { call } = require('./api')
const { getSession } = require('./session')

const SNAPSHOT_TTL_MS = 15 * 1000

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
      saleId: '',
      status: '',
      deliveryTimeSlotLabel: '',
      note: '',
      _id: '',
    }
  }
  return {
    saleId: String(raw.saleId || raw._id || '').trim(),
    status: String(raw.status || '').trim(),
    deliveryTimeSlotLabel: String(raw.deliveryTimeSlotLabel || '').trim(),
    note: String(raw.note || '').trim(),
    _id: String(raw._id || raw.saleId || '').trim(),
  }
}

function normalizePayload(raw) {
  const sale = normalizeSale(raw && raw.sale)
  const dishes = Array.isArray(raw && raw.dishes) ? raw.dishes : []
  const profile = raw && raw.profile && typeof raw.profile === 'object' ? raw.profile : null
  const admin = raw && raw.admin && typeof raw.admin === 'object' ? raw.admin : null
  const session =
    raw && raw.session && typeof raw.session === 'object'
      ? {
          openId: String(raw.session.openId || '').trim(),
          isAdmin: !!raw.session.isAdmin,
        }
      : null
  return {
    sale,
    dishes,
    profile,
    admin,
    session,
    updatedAt: Date.now(),
  }
}

function getSnapshot() {
  const store = getStore()
  if (!store.valid || !store.payload) return null
  if (!isPayloadFresh(store.payload)) {
    store.valid = false
    store.payload = null
    return null
  }
  return store.payload
}

function isSnapshotValid() {
  const store = getStore()
  return !!(store.valid && store.payload && isPayloadFresh(store.payload))
}

function isPayloadFresh(payload) {
  const updatedAt = Number(payload && payload.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  return Date.now() - updatedAt < SNAPSHOT_TTL_MS
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
  if (!force && store.valid && store.payload && isPayloadFresh(store.payload)) return store.payload

  const [homeRes, sess] = await Promise.all([call('customer', 'bootstrapHome'), getSession()])
  if (!homeRes.ok || !homeRes.data) {
    throw new Error((homeRes && homeRes.message) || '同步失败，请重试')
  }
  if (!sess || !sess.ready) {
    throw new Error('同步失败，请重试')
  }

  let admin = null
  if (includeAdmin) {
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
    session: {
      openId: String(sess.openId || '').trim(),
      isAdmin: !!sess.isAdmin,
    },
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
