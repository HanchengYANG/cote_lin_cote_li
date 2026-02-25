function createProfileService(deps) {
  const {
    db,
    ok,
    fail,
    ensureCustomerDoc,
    getOrCreateAdminConfig,
    attachMinOrderInfo,
    toProfileOutput,
    buildDeliveryMinRule,
    sanitizeProfileNickname,
    normalizePhone,
    isPhoneValid,
    getCustomerDocTx,
    normalizeStoredAddresses,
    normalizeProfilePhone,
    saveCustomerDocTx,
  } = deps

  return {
    async getMyProfile(_event, ctx) {
      const profileDoc = await ensureCustomerDoc(ctx.openId)
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(toProfileOutput(profileDoc), buildDeliveryMinRule(cfg)) })
    },

    async updateMyNickname(event, ctx) {
      const nickname = sanitizeProfileNickname(event.nickname)
      const hasProfilePhone = Object.prototype.hasOwnProperty.call(event || {}, 'profilePhone')
      const requestedProfilePhone = normalizePhone(event && event.profilePhone)
      if (!nickname) return fail('BAD_REQUEST', '缺少昵称')
      if (hasProfilePhone && requestedProfilePhone && !isPhoneValid(requestedProfilePhone)) {
        return fail('INVALID_PHONE', '电话格式不正确')
      }
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, ctx.openId)
          const addresses = normalizeStoredAddresses(customer && customer.addresses)
          let defaultAddressId = String((customer && customer.defaultAddressId) || '').trim()
          if (!addresses.some((x) => x.id === defaultAddressId)) {
            defaultAddressId = addresses[0] ? addresses[0].id : ''
          }
          let profilePhone = normalizeProfilePhone(customer && customer.profilePhone)
          if (hasProfilePhone) profilePhone = requestedProfilePhone || ''
          const saveData = {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId,
            updatedAt: db.serverDate(),
          }
          await saveCustomerDocTx(tx, ctx.openId, saveData)
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId })
        })
      } catch (err) {
        return fail('TX_FAILED', '保存昵称失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },
  }
}

module.exports = {
  createProfileService,
}
