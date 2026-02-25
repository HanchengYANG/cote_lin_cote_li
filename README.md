# 微信小程序：接龙替代（V1.1）

一个基于微信小程序 + 腾讯云开发（CloudBase）的“开单/下单”系统，适用于小型门店订单收集场景。

## 功能概览（V1.1 已实现）

### 订单流程
- 只有店主“开单”后顾客才能下单，店主可手动“截单”。
- 顾客下单支持两种方式：配送 / 自取（结算页选择）。

### 配送规则
- 必填信息：电话 + 法国地址（street line1/line2、postal code、city）。
- 页面会展示本次开单配置的配送时间段文案。
- 顾客必须勾选“我接受该时间段”才能提交配送订单。

### 自取规则
- 不展示配送时间段，也无需勾选接受时间段。

### 商品与计价
- 商品支持多图（最多 10 张）。
- 商品描述支持 Markdown（仅详情页渲染）。
- 金额单位为 EUR，数据库内以 `cents` 整数存储。

### 地址能力
- 地址建议（suggestion）通过法国官方 Adresse API（由云函数代理请求）。
- 当前不做地址匹配与 Google Maps API 集成（后续可扩展）。

## 项目结构

后端使用腾讯云开发 CloudBase（云数据库 + 云函数）：
- `cloudfunctions/auth`：身份信息、管理员判断。
- `cloudfunctions/customer`：顾客端下单、地址建议等能力。
- `cloudfunctions/admin`：店主端管理接口（开单/截单等）。

## 店主端鉴权

店主端接口使用 `openid` 白名单鉴权：
- `cloudfunctions/auth/index.js` 按 `system_admins/main.adminOpenIds` 判断 `isAdmin`。
- `cloudfunctions/admin/index.js` 拒绝非管理员调用（返回 `NOT_ADMIN`）。

## 本地运行（微信开发者工具）

1. 在微信开发者工具中启用云开发，并选择目标环境。
2. 在以下云函数目录安装依赖并部署：
   - `cloudfunctions/auth`
   - `cloudfunctions/customer`
   - `cloudfunctions/admin`

   > 注意：`cloudfunctions/customer` 依赖 `markdown-it`，建议使用“上传并部署：云端安装依赖”。

3. 获取当前账号 `openid`：
   - 运行 `auth` 云函数的 `getMyOpenId`。
   - 前端店主端页面也提供“复制我的 openid”。

4. 初始化云数据库文档：
   - `system_admins/main`
     - `adminOpenIds: ["你的openid", "..."]`
   - `system_runtime_state/main`
     - `currentSaleId: null`
   - `delivery_rules/main`
     - 可先使用空规则或默认值。

## 店主端入口

菜单页右上角提供“店主端”入口。

若当前用户不在管理员白名单，将显示“无权限”，并支持复制当前 `openid` 用于后续配置。
