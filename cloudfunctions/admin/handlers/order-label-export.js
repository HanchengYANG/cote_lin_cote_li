const { createOrderLabelExportService } = require('../services/order-label-export-service.js')

function createOrderLabelExportHandlers(deps) {
  return createOrderLabelExportService(deps)
}

module.exports = {
  createOrderLabelExportHandlers,
}
