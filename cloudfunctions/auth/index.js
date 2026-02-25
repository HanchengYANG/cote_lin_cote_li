const cloud = require('wx-server-sdk')
const { ok, fail } = require('./lib/result')
const { createAuthSystemAdminsRepo } = require('./repos/system-admins-repo')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// Admin whitelist enforcement.
const BYPASS_ADMIN_AUTH = false

const { getOrCreateSystemAdmins } = createAuthSystemAdminsRepo({ db })

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const handlers = {
    getMyOpenId: async () => ok({ openId }),
    isAdmin: async () => {
      if (BYPASS_ADMIN_AUTH) return ok({ isAdmin: true })
      const cfg = await getOrCreateSystemAdmins()
      const list = cfg.adminOpenIds || []
      return ok({ isAdmin: list.includes(openId) })
    },
  }
  const handler = handlers[action]
  if (!handler) return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
  return handler()
}
