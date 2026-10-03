# 航电维护脚本 · 隔离令牌离线穷尽复核

维护脚本在中止（abort）或提前返回（return）时若遗漏释放隔离令牌，后续维修
会在错误的硬件隔离状态下继续。本工具提供一个**完全离线、零外部依赖**的复核
页与复核引擎，对脚本的全部控制路径做穷尽展开，追踪每条路径的持有令牌与待
执行清理续体，并给出最短违规见证或穷尽安全结论。

## 能力概览

- 录入 **1–8 个令牌**、**至多 96 条**结构化指令。
- 指令集：
  - `acquire T` 获取、`act T` 操作、`release T` 释放
  - `if T` 条件分支（可配 `else`，以 `end` 闭合）
  - `loop n` 有限次数循环（以 `end` 闭合，上界 ≤ 64）
  - `cleanup … end` 清理块（可嵌套）
  - `return` 返回、`abort` 中止
- **穷尽复核**：每个条件按两种结果展开（结果①成立 / 结果②不成立）；
  循环按上界逐轮展开；所有路径的持有令牌集合与待执行清理续体栈均被追踪。
- **违规判定**：
  - 操作 / 释放只能作用于当前持有令牌；
  - 重复获取即违规（循环体内未释放会在第二轮暴露）；
  - 任何 return / abort / 隐式结束离开脚本前，已注册清理续体必须按
    LIFO 全部展开，且清理结束后不得残留持有令牌；
  - return / abort 出现在清理块内部属于“非法跳出清理作用域”，直接报错。
- **见证输出**：按最短指令步数给出完整逐步路径；同长度时保持源序
  （THEN 分支先于 ELSE、循环体先于退出），逐步展示令牌变化与清理展开。
- **安全输出**：已穷尽的规范状态数、迁移数与每个出口（返回 / 中止 / 隐式
  结束）的清理释放结果。
- **结构性错误**：未知令牌、循环上界越限、块未闭合、非法跳出清理作用域等
  直接报错，页面同步移除旧结论（旧证据）。

## 目录结构

```
src/instr.js       指令解析与结构校验
src/verify.js      穷尽状态展开 / 最短违规见证 / 出口清理汇总
src/server.js      零依赖 HTTP 服务（复核页 + /api/review + /health）
web-src/           复核页源码（原生 HTML/CSS/JS，无构建框架）
scripts/build.js   页面构建：拷贝并语法校验 -> public/
scripts/verify.js  一次性验收服务 verify
tests/             node:test 代码测试（20 项，含三大必测场景与三层 64 回归）
```

## 本地运行（无需 Docker）

要求 Node.js ≥ 18，无需 `npm install`。

```bash
# 启动复核服务（宿主端口可用 PORT 配置）
PORT=8080 node src/server.js
#   复核页  http://localhost:8080/
#   健康地址 http://localhost:8080/health
```

构建页面、运行测试：

```bash
npm run build     # web-src -> public
npm test          # node --test tests/
```

## 一次性验收服务 `verify`

`verify` 执行后即退出，以退出码报告验收结果，依次完成：

1. 运行代码测试（`node --test tests/`，含分支遗漏释放、中止触发嵌套清理、
   循环重复获取三类场景）；
2. 构建复核页；
3. HTTP 冒烟：请求健康地址 `/health` 与静态页面 `/`、`/styles.css`、
   `/app.js`；
4. 通过 `/api/review` 跑通三大必测场景及反例 / 结构错误用例。

```bash
# 自启本地服务完成全部验收（退出码 0 = 通过）
node scripts/verify.js

# 对已在运行的服务（如 Compose 中的 review）做验收
node scripts/verify.js --base http://127.0.0.1:8080
```

## Docker Compose

```bash
# 以可配置宿主端口启动复核页（默认 8080）
REVIEW_PORT=9090 docker compose up --build review

# 执行一次性验收（自动等待 review 健康后做 HTTP 冒烟与场景复核）
docker compose run --rm verify
# 或：docker compose up --build verify
```

- `review`：长驻复核服务（复核页 + 健康地址）。
- `verify`：一次性验收服务，`restart: "no"`，结束后以退出码报告
  测试 / 构建 / HTTP 冒烟结果。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/`、`/styles.css`、`/app.js` | 复核页静态资源 |
| GET | `/health` | 健康检查，返回 `{status:"ok",...}` |
| POST | `/api/review` | 提交复核，body：`{"tokens":[...], "instructions":[...]}` |

`/api/review` 响应：

- 结构错误：`{"ok":false,"error":{"code","message","line"}}`；
- 发现违规：`{"ok":true,"result":{"safe":false,"violation":{...},"pathLength","steps":[...逐步...]}}`；
- 安全：`{"ok":true,"result":{"safe":true,"stats":{规范状态数...},"exits":[各出口清理结果...]}}`。

## 语义约定（摘要）

- 条件 `if T` 双结果展开：**结果①成立**——该路径确认 T 持有，THEN 臂内
  可直接操作 / 释放 T；**结果②不成立**——跳过 THEN（进入 ELSE 或越过
  END），此前获取的令牌保持持有，因此“仅在 THEN 释放”会在结果②路径的
  出口以泄漏检出。
- `loop n` 循环体逐轮展开；轮内获取的令牌若未释放，第二轮头部之后的获取
  即构成重复获取违规。
- `cleanup` 的主体在正常流中不执行，只注册续体；出口（含 abort / return /
  脚本结束）按后进先出展开全部续体，嵌套清理块以此顺序执行。
