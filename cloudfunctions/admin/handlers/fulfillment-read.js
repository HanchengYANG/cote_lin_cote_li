const { createFulfillmentReadService } = require('../services/fulfillment-read-service.js')

function createFulfillmentReadHandlers(deps) {
  return createFulfillmentReadService(deps)
}

module.exports = {
  createFulfillmentReadHandlers,
}
