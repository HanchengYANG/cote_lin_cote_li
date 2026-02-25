const { createManualOrderWriteService } = require('../services/manual-order-write-service.js')

function createManualOrderWriteHandlers(deps) {
  return createManualOrderWriteService(deps)
}

module.exports = {
  createManualOrderWriteHandlers,
}
