Component({
  properties: {
    order: {
      type: Object,
      value: null,
    },
    editableItems: {
      type: Array,
      value: [],
    },
    editableTotals: {
      type: Object,
      value: { qty: 0, amountEuro: '0.00' },
    },
    canEditItems: {
      type: Boolean,
      value: false,
    },
    canCancelOrder: {
      type: Boolean,
      value: false,
    },
    saving: {
      type: Boolean,
      value: false,
    },
    cancelling: {
      type: Boolean,
      value: false,
    },
    showPaymentStatus: {
      type: Boolean,
      value: false,
    },
    showPayment: {
      type: Boolean,
      value: true,
    },
    showFulfillment: {
      type: Boolean,
      value: true,
    },
    showContact: {
      type: Boolean,
      value: true,
    },
    editHint: {
      type: String,
      value: '',
    },
    lockHint: {
      type: String,
      value: '该订单当前不可修改。',
    },
  },

  methods: {
    onQtyTap(e) {
      const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
      const delta = Number(e.currentTarget.dataset && e.currentTarget.dataset.delta)
      if (!dishId || !Number.isFinite(delta)) return
      this.triggerEvent('qtychange', { dishId, delta })
    },

    onRemoveTap(e) {
      const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
      if (!dishId) return
      this.triggerEvent('removeitem', { dishId })
    },

    onSaveTap() {
      this.triggerEvent('save')
    },

    onCancelTap() {
      this.triggerEvent('cancelorder')
    },
  },
})
