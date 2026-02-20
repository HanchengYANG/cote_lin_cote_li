const { ensureFresh, isSnapshotValid } = require('./app-snapshot')

function createPage(definition = {}) {
  const opts = { ...definition }
  const userOnLoad = opts.onLoad
  const userOnShow = opts.onShow
  const userOnUnload = opts.onUnload
  const includeAdminSnapshot = !!opts.includeAdminSnapshot
  const requiresSnapshot = opts.requiresSnapshot !== false
  delete opts.includeAdminSnapshot
  delete opts.requiresSnapshot

  const userData = opts.data && typeof opts.data === 'object' ? opts.data : {}
  opts.data = {
    isReady: requiresSnapshot ? false : true,
    syncError: '',
    ...userData,
  }

  opts.__ensureSnapshot = async function __ensureSnapshot() {
    if (!requiresSnapshot) return true
    if (this.__syncing) return false
    this.__syncing = true
    this.setData({ isReady: false, syncError: '' })
    try {
      await ensureFresh({ includeAdmin: includeAdminSnapshot })
      this.setData({ isReady: true, syncError: '' })
      return true
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '同步失败，请重试'
      this.setData({ isReady: false, syncError: msg })
      // eslint-disable-next-line no-console
      console.error('[sync]', msg, err)
      return false
    } finally {
      this.__syncing = false
    }
  }

  opts.__flushPendingShow = async function __flushPendingShow() {
    if (!this.__pendingShowArgs) return
    const args = this.__pendingShowArgs
    this.__pendingShowArgs = null
    await opts.onShow.apply(this, args)
  }

  opts.onSyncRetry = async function onSyncRetry() {
    const ok = await this.__ensureSnapshot()
    if (!ok) return
    if (!this.__didUserOnLoad) {
      if (typeof userOnLoad === 'function') {
        await userOnLoad.call(this, this.__initialQuery || {})
      }
      this.__didUserOnLoad = true
      await this.__flushPendingShow()
      return
    }
    if (this.__didUserOnLoad && typeof userOnShow === 'function') {
      await userOnShow.call(this)
      return
    }
    if (this.__didUserOnLoad && typeof userOnShow !== 'function' && typeof this.reload === 'function') {
      await this.reload()
    }
  }

  opts.onLoad = async function onLoad(query) {
    this.__initialQuery = query || {}
    this.__didUserOnLoad = false
    this.__pendingShowArgs = null

    const ok = await this.__ensureSnapshot()
    if (!ok) return

    if (typeof userOnLoad === 'function') {
      await userOnLoad.call(this, this.__initialQuery)
    }
    this.__didUserOnLoad = true
    await this.__flushPendingShow()
  }

  opts.onShow = async function onShow(...args) {
    if (!this.__didUserOnLoad) {
      this.__pendingShowArgs = args
      return
    }

    const needsResync = requiresSnapshot && this.__didUserOnLoad && !isSnapshotValid()
    if (needsResync) {
      const ok = await this.__ensureSnapshot()
      if (!ok) return
      if (typeof userOnShow !== 'function' && typeof this.reload === 'function') {
        await this.reload()
        return
      }
    }

    if (typeof userOnShow === 'function') {
      await userOnShow.apply(this, args)
    }
  }

  opts.onUnload = function onUnload(...args) {
    this.__syncing = false
    this.__pendingShowArgs = null
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
