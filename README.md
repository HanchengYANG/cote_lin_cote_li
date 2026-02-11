# 微信小程序：接龙替代（V1.1）

## V1.1 规则（已实现）
- 只有店主“开单”后顾客才能下单；店主可手动“截单”。
- 下单支持：配送 / 自取（顾客在结算页选择）。
- 配送订单：
  - 必须填写电话 + 法国地址（street line1/line2、postal code、city）
  - 系统展示本次开单的“配送时间段”（店主在开单草稿里填写的唯一文案）
  - 必须勾选“我接受该时间段”才能提交订单
- 自取订单：不展示时间段，也不需要勾选接受。
- 地址 suggestion：使用法国官方 Adresse API（云函数代理请求）。
- 菜品支持：多图（最多 10 张）+ Markdown 描述（仅详情页渲染）。
- 计价单位：EUR（数据库按 cents 整数存储）。
- 不做地址匹配与 Google Maps API（后续再加）。

## 后端实现
使用腾讯云开发 CloudBase（云数据库 + 云函数）：
- `cloudfunctions/auth`
- `cloudfunctions/customer`
- `cloudfunctions/admin`

## 店主端鉴权（已恢复）
店主端接口已恢复 `openid` 白名单校验：
- `cloudfunctions/auth/index.js` 会按 `adminConfig/main.adminOpenIds` 判断 `isAdmin`
- `cloudfunctions/admin/index.js` 会拒绝非管理员调用（返回 `NOT_ADMIN`）

## 本地运行（微信开发者工具）
1. 在微信开发者工具中启用云开发并选择一个环境。
2. 在每个云函数目录执行依赖安装并部署（开发者工具有入口）：
   - `cloudfunctions/auth`
   - `cloudfunctions/customer`
   - `cloudfunctions/admin`
   注意：`cloudfunctions/customer` 依赖包含 `markdown-it`，请用“上传并部署：云端安装依赖”。
3. 获取自己的 `openid`：
   - 运行云函数 `auth` 的 `getMyOpenId`（前端已在店主端页面显示“复制我的 openid”）
4. 在云数据库创建/修改 `adminConfig/main` 文档，填入：
   - `adminOpenIds: ["你的openid", "..."]`
    - `activeSaleId: null`

## 店主端入口
菜单页右上角提供“店主端”入口。若当前用户不在管理员白名单，将显示“无权限”并可复制自己的 `openid` 用于配置白名单。
