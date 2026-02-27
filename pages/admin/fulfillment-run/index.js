const { createRunPage } = require('../run-page-factory')

createRunPage({
  listSalesAction: 'listFulfillmentSales',
  getRunAction: 'getSaleFulfillmentRun',
  enableGoogleNav: true,
  emptySelectorLabel: '暂无可配送执行开单',
  preferredStatuses: ['CLOSED', 'FULFILLING'],
  appendedHintFormatter(count) {
    return `有 ${count} 个新配送单已自动追加到末尾`
  },
})
