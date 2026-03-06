const { getSnapshot, hasSnapshot, setSnapshot, ensureFresh, refreshSnapshot } = require('./app-snapshot')

const STARTUP_METHOD_NAMES = ['reload', 'init', 'bootstrap']

function stableStringify(input) {
  const value = input && typeof input === 'object' ? input : {}
  const keys = Object.keys(value).sort()
  const normalized = {}
  keys.forEach((key) => {
    const raw = value[key]
    if (raw === undefined) return
    normalized[key] = raw
  })
  return JSON.stringify(normalized)
}

function buildDefaultSnapshotKey(page, query) {
  const route = String((page && page.route) || '').trim()
  const suffix = stableStringify(query)
  return suffix && suffix !== '{}' ? `${route}?${suffix}` : route
}

function deepClone(input) {
  if (input == null) return input
  try {
    return JSON.parse(JSON.stringify(input))
  } catch (err) {
    return input
  }
}

function sanitizeAutoSnapshotPayload(data) {
  const payload = deepClone(data && typeof data === 'object' ? data : {}) || {}
  delete payload.isReady
  delete payload.syncError
  return payload
}

function isPromiseLike(input) {
  return !!input && typeof input.then === 'function'
}

function createTrackedMethodWrapper(name, original, snapshotMode, usesCustomSnapshotLoad) {
  return async function trackedMethodWrapper(...args) {
    this.__cancelWriteFailureSnapshotRefresh()
    if (snapshotMode !== 'none' && this.__suppressTrackedStartupMethods) {
      return this.__lastRestoredSnapshotPayload || null
    }

    const promise = Promise.resolve().then(() => original.apply(this, args))
    if (this.__collectingStartupPromises) {
      this.__startupTrackedCount = Number(this.__startupTrackedCount || 0) + 1
      this.__startupPromises.push(promise)
    } else if (snapshotMode !== 'none' && !usesCustomSnapshotLoad) {
      promise.then(() => this.__captureCurrentPageSnapshot()).catch(() => {})
    }
    return promise
  }
}

function createPage(definition = {}) {
  const opts = { ...definition }
  const userOnLoad = opts.onLoad
  const userOnShow = opts.onShow
  const userOnUnload = opts.onUnload
  const userOnPullDownRefresh = opts.onPullDownRefresh
  const userLoadSnapshotData = typeof opts.loadSnapshotData === 'function' ? opts.loadSnapshotData : null
  const userApplySnapshotData = typeof opts.applySnapshotData === 'function' ? opts.applySnapshotData : null
  const userSnapshotKey = typeof opts.snapshotKey === 'function' ? opts.snapshotKey : null
  const usesCustomSnapshotLoad = !!(userLoadSnapshotData && userApplySnapshotData)
  const snapshotMode = String(opts.snapshotMode || 'cache-first').trim() || 'cache-first'

  delete opts.loadSnapshotData
  delete opts.applySnapshotData
  delete opts.snapshotKey
  delete opts.snapshotMode

  STARTUP_METHOD_NAMES.forEach((name) => {
    if (typeof opts[name] === 'function') {
      opts[name] = createTrackedMethodWrapper(name, opts[name], snapshotMode, usesCustomSnapshotLoad)
    }
  })

  const userData = opts.data && typeof opts.data === 'object' ? opts.data : {}
  opts.data = {
    isReady: snapshotMode === 'none',
    syncError: '',
    ...userData,
  }

  opts.__resolveSnapshotKey = function __resolveSnapshotKey(query) {
    if (userSnapshotKey) {
      return String(userSnapshotKey.call(this, query || {})).trim()
    }
    return buildDefaultSnapshotKey(this, query || {})
  }

  opts.__setReadyState = function __setReadyState(isReady, syncError) {
    this.setData({
      isReady: !!isReady,
      syncError: syncError ? String(syncError) : '',
    })
  }

  opts.__restoreSnapshotFromCache = async function __restoreSnapshotFromCache(snapshotKey, query) {
    if (!snapshotKey || !hasSnapshot(snapshotKey)) return null
    const payload = getSnapshot(snapshotKey)
    this.__lastRestoredSnapshotPayload = payload
    this.__hasRestoredSnapshot = true
    if (usesCustomSnapshotLoad) {
      await userApplySnapshotData.call(this, payload, query || {})
    } else {
      this.setData(sanitizeAutoSnapshotPayload(payload))
    }
    this.__setReadyState(true, '')
    return payload
  }

  opts.__captureCurrentPageSnapshot = async function __captureCurrentPageSnapshot() {
    if (snapshotMode === 'none' || usesCustomSnapshotLoad) return null
    const snapshotKey = this.__currentSnapshotKey || this.__resolveSnapshotKey(this.__initialQuery || {})
    if (!snapshotKey) return null
    const payload = sanitizeAutoSnapshotPayload(this.data)
    this.__lastRestoredSnapshotPayload = payload
    return setSnapshot(snapshotKey, payload)
  }

  opts.__runUserLifecycleHandler = async function __runUserLifecycleHandler(handler, args) {
    const info = {
      invoked: typeof handler === 'function',
      returnedPromise: false,
      trackedCount: 0,
      startedAsyncWork: false,
    }
    if (!info.invoked) return info

    this.__collectingStartupPromises = true
    this.__startupPromises = []
    this.__startupTrackedCount = 0
    try {
      const result = handler.apply(this, args || [])
      info.returnedPromise = isPromiseLike(result)
      await Promise.resolve(result)
      while (this.__startupPromises.length) {
        const pending = this.__startupPromises.splice(0)
        await Promise.all(pending)
      }
      info.trackedCount = Number(this.__startupTrackedCount || 0)
      info.startedAsyncWork = info.returnedPromise || info.trackedCount > 0
      return info
    } finally {
      this.__collectingStartupPromises = false
      this.__startupPromises = []
      this.__startupTrackedCount = 0
    }
  }

  opts.__loadCustomSnapshot = async function __loadCustomSnapshot(options = {}) {
    const query = options.query || this.__initialQuery || {}
    const force = !!options.force
    const guard = options.guard !== false
    const snapshotKey = this.__resolveSnapshotKey(query)
    this.__currentSnapshotKey = snapshotKey
    if (guard) this.__setReadyState(false, '')
    try {
      const payload = await (force
        ? refreshSnapshot({
            snapshotKey,
            loadSnapshotData: () => userLoadSnapshotData.call(this, query),
          })
        : ensureFresh({
            snapshotKey,
            loadSnapshotData: () => userLoadSnapshotData.call(this, query),
          }))
      this.__lastRestoredSnapshotPayload = payload
      this.__hasRestoredSnapshot = true
      await userApplySnapshotData.call(this, payload, query)
      this.__setReadyState(true, '')
      return payload
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '加载失败，请重试'
      if (guard) this.__setReadyState(false, msg)
      throw err
    }
  }

  opts.__cancelWriteFailureSnapshotRefresh = function __cancelWriteFailureSnapshotRefresh() {
    if (this.__writeFailureSnapshotRefreshTimer) {
      clearTimeout(this.__writeFailureSnapshotRefreshTimer)
      this.__writeFailureSnapshotRefreshTimer = null
    }
  }

  opts.__scheduleWriteFailureSnapshotRefresh = function __scheduleWriteFailureSnapshotRefresh() {
    if (snapshotMode === 'none') return
    if (this.__writeFailureSnapshotRefreshTimer) return
    this.__writeFailureSnapshotRefreshTimer = setTimeout(() => {
      this.__writeFailureSnapshotRefreshTimer = null
      Promise.resolve().then(() => this.__refreshStartupSnapshotAfterWriteFailure())
    }, 0)
  }

  opts.__refreshStartupSnapshotAfterWriteFailure = async function __refreshStartupSnapshotAfterWriteFailure() {
    if (snapshotMode === 'none') return
    this.__cancelWriteFailureSnapshotRefresh()
    this.__hasRestoredSnapshot = false
    this.__suppressTrackedStartupMethods = false
    this.__setReadyState(false, '')
    try {
      if (usesCustomSnapshotLoad) {
        await this.__loadCustomSnapshot({
          query: this.__initialQuery || {},
          force: true,
          guard: true,
        })
        return
      }

      const refreshMethodName = STARTUP_METHOD_NAMES.find((name) => typeof this[name] === 'function')
      if (refreshMethodName === 'reload') {
        await this.reload({ silent: true })
      } else if (refreshMethodName) {
        await this[refreshMethodName]()
      } else if (typeof userOnShow === 'function') {
        await this.__runUserLifecycleHandler(userOnShow, [])
      } else if (typeof userOnLoad === 'function') {
        await this.__runUserLifecycleHandler(userOnLoad, [this.__initialQuery || {}])
      }

      await this.__captureCurrentPageSnapshot()
      this.__setReadyState(true, '')
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '加载失败，请重试'
      this.__setReadyState(false, msg)
      // eslint-disable-next-line no-console
      console.error('[snapshot]', msg, err)
    }
  }

  opts.__flushPendingShow = async function __flushPendingShow() {
    if (!this.__pendingShowArgs) return
    const args = this.__pendingShowArgs
    this.__pendingShowArgs = null
    await opts.onShow.apply(this, args)
  }

  opts.onSyncRetry = async function onSyncRetry() {
    await this.__refreshStartupSnapshotAfterWriteFailure()
  }

  opts.onLoad = async function onLoad(query) {
    this.__initialQuery = query || {}
    this.__didUserOnLoad = false
    this.__pendingShowArgs = null
    this.__hasRestoredSnapshot = false
    this.__currentSnapshotKey = snapshotMode === 'none' ? '' : this.__resolveSnapshotKey(this.__initialQuery)

    if (snapshotMode === 'none') {
      await Promise.resolve(typeof userOnLoad === 'function' ? userOnLoad.call(this, this.__initialQuery) : null)
      this.__setReadyState(true, '')
      this.__didUserOnLoad = true
      await this.__flushPendingShow()
      return
    }

    const hasCachedSnapshot = this.__currentSnapshotKey ? hasSnapshot(this.__currentSnapshotKey) : false
    if (hasCachedSnapshot) {
      await this.__restoreSnapshotFromCache(this.__currentSnapshotKey, this.__initialQuery)
    } else {
      this.__setReadyState(false, '')
    }

    this.__suppressTrackedStartupMethods = hasCachedSnapshot
    try {
      const loadInfo = await this.__runUserLifecycleHandler(userOnLoad, [this.__initialQuery])
      this.__suppressTrackedStartupMethods = false

      if (usesCustomSnapshotLoad) {
        if (!hasCachedSnapshot) {
          await this.__loadCustomSnapshot({ query: this.__initialQuery, force: false, guard: true })
        }
      } else if (hasCachedSnapshot) {
        await this.__captureCurrentPageSnapshot()
        this.__setReadyState(true, '')
      } else if (loadInfo.startedAsyncWork || typeof userOnShow !== 'function') {
        await this.__captureCurrentPageSnapshot()
        this.__setReadyState(true, '')
      }
    } catch (err) {
      this.__suppressTrackedStartupMethods = false
      const msg = (err && err.message) ? String(err.message) : '加载失败，请重试'
      this.__setReadyState(false, msg)
      // eslint-disable-next-line no-console
      console.error('[snapshot]', msg, err)
      return
    }

    this.__didUserOnLoad = true
    await this.__flushPendingShow()
  }

  opts.onShow = async function onShow(...args) {
    if (!this.__didUserOnLoad) {
      this.__pendingShowArgs = args
      return
    }

    if (snapshotMode === 'none') {
      if (typeof userOnShow === 'function') {
        await Promise.resolve(userOnShow.apply(this, args))
      }
      return
    }

    const query = this.__initialQuery || {}
    const snapshotKey = this.__resolveSnapshotKey(query)
    this.__currentSnapshotKey = snapshotKey
    const hasCachedSnapshot = snapshotKey ? hasSnapshot(snapshotKey) : false
    this.__hasRestoredSnapshot = false
    if (usesCustomSnapshotLoad) {
      if (hasCachedSnapshot) {
        await this.__restoreSnapshotFromCache(snapshotKey, query)
      } else {
        try {
          await this.__loadCustomSnapshot({ query, force: false, guard: true })
        } catch (err) {
          return
        }
      }
      if (typeof userOnShow === 'function') {
        await Promise.resolve(userOnShow.apply(this, args))
      }
      return
    }

    if (hasCachedSnapshot) {
      await this.__restoreSnapshotFromCache(snapshotKey, query)
    } else {
      this.__setReadyState(false, '')
    }

    this.__suppressTrackedStartupMethods = hasCachedSnapshot
    try {
      await this.__runUserLifecycleHandler(userOnShow, args)
      this.__suppressTrackedStartupMethods = false
      if (!hasCachedSnapshot) {
        await this.__captureCurrentPageSnapshot()
      }
      this.__setReadyState(true, '')
    } catch (err) {
      this.__suppressTrackedStartupMethods = false
      const msg = (err && err.message) ? String(err.message) : '加载失败，请重试'
      this.__setReadyState(false, msg)
      // eslint-disable-next-line no-console
      console.error('[snapshot]', msg, err)
    }
  }

  if (typeof userOnPullDownRefresh === 'function') {
    opts.onPullDownRefresh = async function onPullDownRefresh(...args) {
      this.__cancelWriteFailureSnapshotRefresh()
      return userOnPullDownRefresh.apply(this, args)
    }
  }

  opts.onUnload = function onUnload(...args) {
    this.__suppressTrackedStartupMethods = false
    this.__pendingShowArgs = null
    this.__cancelWriteFailureSnapshotRefresh()
    if (typeof userOnUnload === 'function') {
      return userOnUnload.apply(this, args)
    }
    return undefined
  }

  return Page(opts)
}

module.exports = {
  createPage,
}




