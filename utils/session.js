const { call } = require('./api')

function getGlobalSession() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app) {
    // Fallback for unexpected runtime; keep a module-level singleton.
    if (!getGlobalSession._fallback) {
      getGlobalSession._fallback = { openId: '', isAdmin: false, ready: null }
    }
    return getGlobalSession._fallback
  }
  if (!app.globalData) app.globalData = {}
  if (!app.globalData.session) {
    app.globalData.session = {
      openId: '',
      isAdmin: false,
      ready: null,
    }
  }
  return app.globalData.session
}

function initSession() {
  const sess = getGlobalSession()
  if (sess.ready) return sess.ready
  sess.ready = (async () => {
    const [openIdRes, adminRes] = await Promise.all([
      call('auth', 'getMyOpenId'),
      call('auth', 'isAdmin'),
    ])
    sess.openId = (openIdRes.ok && openIdRes.data && openIdRes.data.openId) || ''
    sess.isAdmin = !!(adminRes.ok && adminRes.data && adminRes.data.isAdmin)
    return { openId: sess.openId, isAdmin: sess.isAdmin }
  })()
  return sess.ready
}

async function getSession() {
  const sess = getGlobalSession()
  if (!sess.ready) initSession()
  await sess.ready
  return sess
}

module.exports = {
  initSession,
  getSession,
}
