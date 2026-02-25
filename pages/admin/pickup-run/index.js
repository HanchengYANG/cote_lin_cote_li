const { createRunPage } = require('../run-page-factory')

createRunPage({
  listSalesAction: 'listPickupSales',
  getRunAction: 'getPickupRun',
  emptySelectorLabel: '暂无可自取执行开单',
  preferredStatuses: ['OPEN', 'CLOSED', 'FULFILLING'],
})
