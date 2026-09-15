# 古法蓝晒工作室

零依赖 Node.js 应用，包含两个子系统：

- **底片整理室**（`/`）：底片任务、工艺步骤、缺陷与入盒交付。
- **配方试验与质量评估台**（`/lab`）：配方版本、随机区组试验、重复测量复核、质量统计与配方定版。

## 运行

```bash
npm start        # http://localhost:3040
npm test         # node --test lab/test/lab.test.js（20+ 项端到端/单元测试）
```

数据：

- `data/cyanotype-negative-room.json` —— 底片室
- `data/cyanotype-lab.json` —— 试验台（首次启动自动创建）

## 配方试验台

### 工作流（页面五个视图）

1. **设计**：建立配方版本（草稿，可派生新版），选择 ≥2 个配方与涂布/曝光/显影/水洗
   因子水平，生成全因子 × 随机区组（RCBD）运行表。区组内用种子伪随机洗牌
   （mulberry32），处理与区组/先后次序正交、不混杂；同种子可复现顺序。
2. **录入**：记录员按任意顺序（乱序）、并发提交密度 D、色差 ΔE、缺陷与温湿度条件；
   同一试样可多次重复测量，原始数据全部保留。
3. **复核**：复核员从重复测量中选出唯一有效值（其余标记 redundant 留痕），可驳回单条
   读数（须写原因）；整样异常排除必须写原因并留痕，系统自动在同区组补同因子组合
   的替补试样以维持平衡；可凭原因退回已复核试样。
4. **比较**：按配方计算质量分组均值、极差、95% t 置信区间；计算四因子主效应与二阶
   交互（DID）。闸门：样本量达标、区组平衡、无空缺格子、每配方有有效数据——任一
   不满足即 `inconclusive`，不得定论（拒绝封存定论；仅可“无结论封存”）。
5. **定版**：封存批次时固化分析快照与配方版本快照；只有结论性批次的优胜配方可定版；
   定版后配方不可修改、派生、删除、再参试，批次可从快照回溯当时全部有效数据。

### 权限（请求头）

| 角色 | 能力 |
|---|---|
| `viewer`（缺省） | 只读 |
| `recorder` | 录入测量 |
| `reviewer` | 录入、复核、退回、封存 |
| `technologist` | 设计批次、配方版本、封存、定版 |
| `admin` | 全部（含删除草稿） |

请求头 `x-lab-role` 指定角色，`x-lab-user` 指定署名（URL 编码），所有关键操作写入
`GET /api/lab/audit` 留痕。

### 并发与一致性

- 单写队列串行化所有事务；业务校验失败回滚，不落盘。
- 落盘采用“临时文件 + rename”原子替换；落盘失败时内存状态整体回滚，失败提交不
  污染后续统计。
- `Idempotency-Key` 头去重：同键并发/重试双发只生效一次，回放首次响应（含状态码）。
- 乱序提交不改变设计顺序；统计只读取“复核有效值”，重复/驳回/作废读数永不进入统计。

### 主要接口

```
GET/POST   /api/lab/formulas
GET        /api/lab/formulas/:id
POST       /api/lab/formulas/:id/revise | /finalize
DELETE     /api/lab/formulas/:id            # 仅草稿、未被批次引用
POST       /api/lab/batches
GET        /api/lab/batches | /batches/:id
POST       /api/lab/batches/:id/runs/:runId/readings
POST       /api/lab/batches/:id/review       # valid | reject-reading | exclude
POST       /api/lab/batches/:id/runs/:runId/reopen
GET        /api/lab/batches/:id/analysis
POST       /api/lab/batches/:id/close        # force:true 为无结论封存
GET        /api/lab/audit · /api/lab/state
```
