const { createFulfillmentWriteService } = require('../services/fulfillment-write-service')

function createFulfillmentWriteHandlers(deps) {
  return createFulfillmentWriteService(deps)
}

module.exports = {
  createFulfillmentWriteHandlers,
}
