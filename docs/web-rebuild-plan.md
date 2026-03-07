# Nuxt + FastAPI 重建订单系统计划书

## Summary

- 用一套全新的 `Nuxt + FastAPI + SQLAlchemy + PostgreSQL` 系统替代现有微信小程序与 CloudBase 后端。
- 采用单仓单体方案：`frontend/` 放 Nuxt，`backend/` 放 FastAPI，`deploy/` 放 Docker Compose 与环境模板。
- 实施顺序固定为：
  1. Phase 1：店主端 Web 先行
  2. Phase 2：顾客端 Web 再接入
- 第一版认证只做邮箱/密码；数据模型和接口为后续手机号验证码预留扩展位，但第一版不接短信。
- 不迁移任何现有小程序数据；新系统从空库开始。旧小程序继续独立运行，直到 Web 全链路完成之后再切换。

## Key Changes

### 整体架构

- 新项目按单仓组织：
  - `frontend/`：Nuxt
  - `backend/`：FastAPI
  - `deploy/`：Docker Compose 与环境模板
- 后端对所有客户端只暴露一套平台中立 REST API；未来 `Web / App / 小程序` 共用，不允许前端直连数据库。
- 前后端统一使用 JSON over HTTP；后端保留 FastAPI 的 OpenAPI 文档作为联调与后续 App 接口契约。

### 后端与数据模型

- 后端栈固定为 `FastAPI + SQLAlchemy 2.x + Alembic + PostgreSQL`；开发和生产都使用 PostgreSQL，不引入 SQLite 分支。
- 认证模型拆为：
  - `users`
  - `auth_identities`
  - `roles/admin flags`
  - `customers`
- `users` 与 `customers` 不强绑定为同一概念，保证 Phase 1 的店主后台与手动录单、客户资料维护能先落地。
- 第一版认证只启用 `email_password` 身份类型；模型中预留 `phone_otp`，但不实现短信流程。
- 鉴权方案固定为：
  - `access token + refresh token`
  - Web 端使用 `httpOnly refresh cookie + 内存 access token`
  - 后续 App/小程序沿用同一组接口，改为 bearer token 携带
- 业务表围绕以下核心实体展开：
  - `delivery_rules`
  - `dishes`、`dish_images`
  - `sales`、`sale_items`
  - `orders`、`order_items`
  - `customer_addresses`
  - `production_progress`
  - `fulfillment_tasks/events`
- 保持现有业务语义不变：
  - 金额统一以 `cents` 整数存储
  - 订单项与 sale 项分离
  - 地址独立存储，订单引用地址实体
  - 生产相关继续支持“按个统计”的快照语义，例如 `piecesPerOrderQty` 与订单项快照
  - 手动录单可以创建、选择客户并复用地址
- 地址补全继续走法国官方 Adresse API，由后端代理调用；不引入 Google Maps。

### Phase 1：店主端 Web

- 只交付 `/admin` 路径下的店主端，顾客端 UI 不在第一阶段上线。
- 店主端功能范围按当前小程序后台等价重建：
  - 登录
  - 首页 Dashboard
  - 配送规则
  - 菜品 CRUD（含图片、Markdown 描述、每份个数）
  - 开单草稿 / 当前开单编辑 / 开单 / 截单
  - 订单列表 / 待确认 / 订单详情
  - 客户列表 / 客户详情 / 客户地址簿
  - 手动录单
  - 生产管理
  - 交付准备 / 配送执行 / 自取执行
  - 导出
- Phase 1 的目标是把后台业务和共享后端先搭稳，不做生产切换；它是内部验证阶段，不与旧小程序顾客端混跑。
- 第一版店主账户由后端 seed 或管理命令创建，不做开放注册，不做邮箱验证，不做密码找回页面。

### Phase 2：顾客端 Web

- 在同一套后端上补齐顾客端移动网页：
  - 菜单首页
  - 菜品详情
  - 地址簿 / 地址编辑
  - 结算
  - 下单成功
  - 我的订单 / 订单详情
  - 顾客资料页
- 顾客端认证沿用同一用户体系，先做邮箱/密码登录；后续如需手机号验证码，只在认证层扩展，不重做业务表。
- 顾客端接入后才允许从旧小程序做正式业务切换；因为本计划明确不做老数据迁移，也不做双写同步。

### 文件与媒体存储

- 第一阶段图片与导出文件统一使用本地文件存储加独立挂载卷，由后端或反向代理统一暴露访问。
- 存储层实现抽象接口，后续如迁移到 S3 兼容对象存储，不改业务代码与数据库结构。

### 部署与发布

- 部署模式固定为 Docker Compose，服务最小集合为：
  - `frontend`（Nuxt）
  - `backend`（FastAPI）
  - `db`（PostgreSQL）
- 域名、80/443、反向代理公网暴露策略不纳入本计划；当前只保证服务能在目标机器上稳定启动和通过 IP 或内网访问。
- 第一阶段发布流程固定为手动但可复制：
  1. 开发机提交代码
  2. 生产机 `git pull`
  3. `docker compose up -d --build`
  4. `alembic upgrade head`
- 生产机目标可以是家中 VM，也可以是 EC2；部署方式不依赖平台特性。
- 必备运维能力从第一阶段就要有：
  - 数据库卷持久化
  - 夜间 `pg_dump`
  - 应用健康检查
  - 基本结构化日志

## Important APIs / Interfaces

- 后端 API 命名空间固定为：
  - `/api/v1/auth/*`
  - `/api/v1/admin/*`
  - `/api/v1/customer/*`（Phase 2 才启用）
- 认证接口固定包含：
  - 登录
  - 刷新 token
  - 注销
  - 当前用户信息
- 数据迁移接口不做；旧小程序数据不导入新库。
- 所有前端只调用后端 API，不直接访问 PostgreSQL。
- 数据库迁移唯一入口固定为 Alembic。

## Test Plan

### Phase 1 后端

- 邮箱/密码登录、token 刷新、权限拦截
- 菜品 CRUD、图片上传、配送规则修改
- 开单草稿、开单、截单状态流
- 手动录单创建客户、地址、订单
- 订单列表与详情、客户详情与地址维护
- 生产按个统计、交付准备、配送执行、自取执行
- 导出结果与当前后台数据一致

### Phase 1 前端

- 店主端移动宽度下可完整操作核心后台流程
- 页面刷新、重新登录、长时间停留后 token 刷新正常
- 上传图片、保存表单、长列表、错误提示可用

### 部署

- 一台全新生产机可通过 README/部署脚本从零拉起
- `docker compose up -d --build` 后应用与数据库可用
- `alembic upgrade head` 可重复执行
- 备份与恢复至少做一次演练

### Phase 2

- 顾客从浏览菜品到下单、查单全链路通过
- 顾客端与店主端读取同一套订单、sale、生产、配送数据
- 旧小程序停用前做一次完整切换演练

## Assumptions

- 第一阶段的“店主先行”是实现顺序，不是业务双系统并行切换方案。
- 旧小程序与新系统之间不做双写、不做同步、不做迁移；正式切换发生在顾客端 Web 完成之后。
- 第一版登录只做邮箱/密码；手机号验证码仅做架构预留。
- 第一阶段不处理公网域名、80/443 转发、家庭网络暴露策略。
- 第一阶段使用本地文件存储而不是对象存储，以换取更轻量的部署；后续允许替换为对象存储实现。
