const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// Admin whitelist enforcement.
const BYPASS_ADMIN_AUTH = false

async function getOrCreateAdminConfig() {
  const ref = db.collection('adminConfig').doc('main')
  try {
    const r = await ref.get()
    return r.data
  } catch (err) {
    // If not found, create default config.
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

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, detail) {
  return { ok: false, code, message, detail }
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (action === 'getMyOpenId') {
    return ok({ openId })
  }

  if (action === 'isAdmin') {
    if (BYPASS_ADMIN_AUTH) return ok({ isAdmin: true })
    const cfg = await getOrCreateAdminConfig()
    const list = cfg.adminOpenIds || []
    return ok({ isAdmin: list.includes(openId) })
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
