const { createManualOrderReadService } = require('../services/manual-order-read-service.js')

function createManualOrderReadHandlers(deps) {
  return createManualOrderReadService(deps)
}

module.exports = {
  createManualOrderReadHandlers,
}
