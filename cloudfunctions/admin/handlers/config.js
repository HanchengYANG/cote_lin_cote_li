const { createConfigService } = require('../services/config-service.js')

function createConfigHandlers(deps) {
  return createConfigService(deps)
}

module.exports = {
  createConfigHandlers,
}
