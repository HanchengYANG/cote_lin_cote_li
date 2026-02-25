const { createReadService } = require('../services/read-service.js')

function createReadHandlers(deps) {
  return createReadService(deps)
}

module.exports = {
  createReadHandlers,
}
