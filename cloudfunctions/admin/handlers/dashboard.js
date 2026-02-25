const { createDashboardService } = require('../services/dashboard-service.js')

function createDashboardHandlers(deps) {
  return createDashboardService(deps)
}

module.exports = {
  createDashboardHandlers,
}
