function getStore() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app) {
    if (!getStore._fallback) {
      getStore._fallback = {
        entries: {},
        inflightRequests: {},
        epoch: 0,
      }
    }
    return getStore._fallback
  }
  if (!app.globalData) app.globalData = {}
  if (!app.globalData.appSnapshot) {
    app.globalData.appSnapshot = {
      entries: {},
      inflightRequests: {},
      epoch: 0,
    }
  }
  return app.globalData.appSnapshot
}

function normalizeSnapshotKey(input) {
  return String(input || '').trim()
}

function clonePayload(payload) {
  if (payload == null) return payload
  try {
    return JSON.parse(JSON.stringify(payload))
  } catch (err) {
    return payload
  }
}

function buildEntry(payload) {
  return {
    payload: clonePayload(payload),
    updatedAt: Date.now(),
  }
}

async function loadLegacyBootstrap(options = {}) {
  // Lazy require to avoid circular import issues with api -> app-snapshot.
  // eslint-disable-next-line global-require
  const { call } = require('./api')
  // eslint-disable-next-line global-require
  const { getSession } = require('./session')

  const includeAdmin = !!options.includeAdmin
  const [homeRes, sess] = await Promise.all([call('customer', 'bootstrapHome'), getSession()])
  if (!homeRes.ok || !homeRes.data) {
    throw new Error((homeRes && homeRes.message) || '加载失败，请重试')
  }
  if (!sess || !sess.ready) {
    throw new Error('加载失败，请重试')
  }

  let admin = null
  if (includeAdmin && sess && sess.isAdmin) {
    const dashRes = await call('admin', 'getDashboard')
    if (!dashRes.ok) {
      throw new Error(dashRes.message || '加载失败，请重试')
    }
    admin = {
      activeSale: (dashRes.data && dashRes.data.activeSale) || null,
      stats: (dashRes.data && dashRes.data.stats) || { orderCount: 0 },
    }
  }

  return {
    sale: homeRes.data.sale,
    dishes: homeRes.data.dishes,
    profile: homeRes.data.profile,
    myCurrentSaleOrder: homeRes.data.myCurrentSaleOrder,
    session: {
      openId: String(sess.openId || '').trim(),
      isAdmin: !!sess.isAdmin,
    },
    admin,
  }
}

function resolveSnapshotSpec(options = {}) {
  const snapshotKey = normalizeSnapshotKey(options.snapshotKey)
  const loadSnapshotData = options.loadSnapshotData
  if (snapshotKey && typeof loadSnapshotData === 'function') {
    return {
      snapshotKey,
      loadSnapshotData,
    }
  }
  return {
    snapshotKey: '__legacy_app_snapshot__',
    loadSnapshotData: () => loadLegacyBootstrap(options),
  }
}

function getSnapshot(snapshotKey) {
  const key = normalizeSnapshotKey(snapshotKey) || '__legacy_app_snapshot__'
  const store = getStore()
  const entry = store.entries[key]
  return entry ? clonePayload(entry.payload) : null
}

function hasSnapshot(snapshotKey) {
  return !!getSnapshot(snapshotKey)
}

function isSnapshotValid(snapshotKey) {
  return hasSnapshot(snapshotKey)
}

function setSnapshot(snapshotKey, payload) {
  const key = normalizeSnapshotKey(snapshotKey)
  if (!key) return null
  const store = getStore()
  store.entries[key] = buildEntry(payload)
  return clonePayload(store.entries[key].payload)
}

async function ensureFresh(options = {}) {
  const force = !!options.force
  const spec = resolveSnapshotSpec(options)
  const snapshotKey = spec.snapshotKey
  const loadSnapshotData = spec.loadSnapshotData

  const store = getStore()
  if (!force && store.entries[snapshotKey]) {
    return clonePayload(store.entries[snapshotKey].payload)
  }
  if (store.inflightRequests[snapshotKey]) {
    return store.inflightRequests[snapshotKey]
  }

  const promise = (async () => {
    // If the snapshot was invalidated while the request was running, re-run
    // against the current epoch instead of writing back stale data.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const startEpoch = getStore().epoch
      const payload = await loadSnapshotData()
      const latestStore = getStore()
      if (latestStore.epoch !== startEpoch) continue
      return setSnapshot(snapshotKey, payload)
    }
  })()

  store.inflightRequests[snapshotKey] = promise
  try {
    return await promise
  } finally {
    const latestStore = getStore()
    if (latestStore.inflightRequests[snapshotKey] === promise) {
      delete latestStore.inflightRequests[snapshotKey]
    }
  }
}

function refreshSnapshot(options = {}) {
  return ensureFresh({ ...options, force: true })
}

function invalidateSnapshot() {
  const store = getStore()
  store.entries = {}
  store.inflightRequests = {}
  store.epoch = Number(store.epoch || 0) + 1
}

module.exports = {
  getSnapshot,
  hasSnapshot,
  isSnapshotValid,
  setSnapshot,
  ensureFresh,
  refreshSnapshot,
  invalidateSnapshot,
}

