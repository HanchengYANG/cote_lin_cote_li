const { createAdminReadService } = require('../services/admin-read-service.js')

function createAdminReadHandlers(deps) {
  return createAdminReadService(deps)
}

module.exports = {
  createAdminReadHandlers,
}
