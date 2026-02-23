# 枚举清单（前后端统一）

本文件作为当前开发阶段的单一枚举约定。前后端代码应保持一致。

## Sale 状态

- `DRAFT`：草稿
- `OPEN`：开单中（顾客可下单）
- `CLOSED`：已截单（生产阶段）
- `FULFILLING`：履约中（配送/自取执行）
- `COMPLETED`：完成

## Order 状态

- `ACTIVE`：有效订单
- `CANCELLED`：已取消
- `PENDING_REVIEW`：待店主确认（例如未命中起送价规则）
- `REJECTED`：店主拒绝

## 履约状态（订单）

- `PENDING`：未交付
- `DELIVERED`：已交付（配送或自取完成交货）

## 支付方式（`order.payment.method`）

- `cash`：现金
- `wechat_transfer`：转账（微信/银行转账统一用此枚举）

说明：
- 不再使用 `pickup_pay` 枚举。
- “到店付款”只是前端文案，可映射到 `cash`。

## 收款状态（`order.payment.paidStatus`）

- `UNPAID`：未收款
- `PAID`：已收款

## 交货方式（`order.fulfillmentType`）

- `delivery`：配送
- `pickup`：自取

