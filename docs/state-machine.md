# 状态机说明

## 1. Sale 生命周期

状态流：

`DRAFT -> OPEN -> CLOSED -> FULFILLING -> COMPLETED`

说明：

- `DRAFT`
  - 店主编辑开单草稿
  - 顾客不可下单
- `OPEN`
  - 顾客可下单 / 追加 / 修改（受订单锁定规则约束）
- `CLOSED`
  - 截单后进入生产阶段
  - 顾客不可再下单
  - 店主可更新生产进度、保存配送排序
- `FULFILLING`
  - 履约执行阶段（配送执行 / 自取执行）
  - 店主可更新交付/收款状态
- `COMPLETED`
  - 当前开单完成
  - `system_runtime_state.currentSaleId` 应清空

## 2. 当前开单指针

- 系统唯一当前开单指针：`system_runtime_state/main.currentSaleId`
- 客人是否可下单：
  - 读取 `currentSaleId` 指向的 `sales` 文档
  - 仅当 `sale.status === OPEN` 时允许下单

## 3. 订单业务状态（`order.status`）

- `ACTIVE`
- `CANCELLED`
- `PENDING_REVIEW`
- `REJECTED`

说明：
- 复盘统计、履约完成校验均以 `ACTIVE` 为口径（除非页面明确说明）

## 4. 订单履约与收款状态

订单业务状态之外，另有两个并行状态：

- `handoffStatus`：`PENDING | DELIVERED`
- `payment.paidStatus`：`UNPAID | PAID`

完成某次开单（`completeSaleFulfillment`）的条件：

- 该 sale 下所有 `ACTIVE` 订单均满足：
  - `handoffStatus === DELIVERED`
  - `payment.paidStatus === PAID`

## 5. 配送 / 自取执行的 sale 状态限制

- 配送执行（配送单）：
  - 允许 `CLOSED` / `FULFILLING`
  - `COMPLETED` 只读
- 自取执行（自取单）：
  - 允许 `OPEN` / `CLOSED` / `FULFILLING`
  - `COMPLETED` 只读

