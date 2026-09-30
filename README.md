# 露营营地选址评估器（gbcampsite）

面向营地规划者与户外领队：把候选营位的地形、补给与隐患折算成综合得分。地图选点登记营位，录入坡度、水源距离、风向、信号等因子，配置权重后实时重排名次并给出 A/B/C 等级。联合勘察队可分头离线编录，归队后导入勘察包，按营位编号做字段级三路核对（本队 / 分包 / 冲突确认），通过营地容量校验后再写库。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21826>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21826 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`siteStore` / `profileStore` / `uiStore` / `capacityStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`），未配置时自动降级为本地 SVG 网格视图 |
| 本地数据 | IndexedDB（Dexie，`gbcampsite-db`，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Campsite 营位 | `frontend/src/types/campsite.ts` | 营位编号、名称、所属营地、经纬度、海拔、坡度、坡向、地表类型、可容帐篷数、平整度评分、进出方式、默认方案 |
| FactorAssessment 因子评估 | `frontend/src/types/factor.ts` | 所属营位、水源距离、风向与风力等级、信号强度、日照时长、落石落枝风险、植被遮蔽度、离车距离、离步道距离、评估人、评估日期 |
| ScoreProfile 权重方案 | `frontend/src/types/score.ts` | 方案名、各因子权重（0-100）、归一化方式（极差归一 / 阈值分段）、A/B/C 等级阈值、适用季节、是否启用 |
| RiskVeto 风险否决项 | `frontend/src/types/veto.ts` | 营位 id、否决类型（河道内 / 山洪沟 / 孤树下 / 崖底落石区 / 陡坡）、说明、判定人、判定日期 |
| CampCapacity 营地容量 | `frontend/src/types/campCapacity.ts` | 营地名称（主键）、可接待帐篷总数、备注；合并勘察包前做容量硬校验 |

### IndexedDB 版本与升级迁移

库名 `gbcampsite-db`（Dexie），共 5 张表：`sites`、`factors`、`profiles`、`vetos`、`capacities`。

- **v1**：建立 `sites`（营位）与 `factors`（因子评估）两张表。
- **v2**：新增 `profiles`（权重方案）表，并为 `factors` 补 `siteId` 索引，让「按营位取因子」走索引；同时为存量因子补齐 `shade`、`distanceToCar`、`distanceToTrail` 缺省值。
- **v3**：新增 `vetos`（风险否决）表，并为存量营位回填 `defaultProfileId`（取当前启用方案的 id）与新增字段缺省值。
- **v4**：新增 `capacities`（营地容量，主键 `campName`）表；存量库迁移时按各营地现有营位帐篷数之和给出保守上限，供人工核对。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 营位名次表（按综合得分降序，展示坡度、水源距离、信号与等级，可按营地/地表/进出方式筛选，命中否决项整行标红） | Campsite、FactorAssessment、RiskVeto |
| `/sites/new` | 新增营位（地图点选或手填经纬度，录入海拔、坡度、坡向与容量，支持草稿保存） | Campsite、FactorAssessment |
| `/sites/:id` | 营位详情（上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核） | 四个模型 |
| `/scoring` | 权重与评分（拖动各因子权重条，名次实时刷新，可另存为季节方案） | ScoreProfile、Campsite |
| `/map` | 营位地图（高德 JS API 标记按等级着色，未配置 `VITE_AMAP_KEY` 时退化为本地 SVG 网格视图） | Campsite、RiskVeto |
| `/veto` | 风险否决登记（选营位与否决类型、填说明，提交后名次表与地图同步更新） | RiskVeto、Campsite |
| `/merge` | 勘察包合并（导出 / 导入离线分包，按营位编号并排核对基础信息、最新因子、权重方案与否决，容量校验通过后事务写库） | 四个模型 + CampCapacity |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `MapPanel.vue`（高德 + SVG 网格双模式）、`FactorScoreBar.vue`（原始值 / 归一化得分 / 权重占比）、`GradeBadge.vue`（A/B/C 等级与得分气泡）、`EmptyState.vue`（空态与新建入口）、`WeightEditor.vue`（权重条编辑器）
- hooks：`frontend/src/hooks/useAmapLoader.ts`（按需注入高德 JS API，key 缺省或加载失败返回降级标记）、`useRanking.ts`（归一化得分与名次）、`useLocalDraft.ts`（表单草稿）
- utils：`frontend/src/utils/score.ts`（极差归一、阈值分段、加权求和、等级阈值、否决短路）、`geo.ts`（经纬度距离与网格坐标换算）、`format.ts`（数值与日期格式化、流水编号）、`db.ts`（Dexie 封装与样例数据）、`draft.ts`（localStorage 草稿）、`package.ts`（勘察包导出 / 解析校验）、`merge.ts`（按业务键的字段级两路合并、容量校验、事务提交）、`demoPackage.ts`（演示用离线分包）

## 六、地图降级说明

`VITE_AMAP_KEY` 为空时，`useAmapLoader()` **不会**请求 `webapi.amap.com`，而是立即返回降级标记；
`MapPanel` 随即渲染本地 SVG 网格视图（可点选、可查看详情），因此**构建与运行都不依赖该 key**。
若配置了 key，则注入脚本时带 `onerror` 与 8 秒超时双兜底，失败同样降级，不会产生 console error。

## 七、勘察包合并工作流（离线分头编录）

联合勘察队分头离线作业时，各队在自己浏览器里照常登记，归队后在 `/merge` 完成合并：

1. **导出分包**：本队页内点「导出本队勘察包」，下载 JSON（含营位、因子评估、权重方案、否决记录与容量参考）。
2. **导入分包**：另一队在「勘察包合并」页选择 JSON；页内也提供「二队演示分包」按钮，可一键体验完整冲突场景。
3. **按业务键对齐，绝不按主键 id 对齐**（id 仅在导出设备内有效）：
   - 营位基础信息按**营位编号**（`CS-xxxx`）逐字段并排，权重方案按**方案名**逐字段并排；
   - 同一字段两边都改出差异时标红并必须由人在「本队 / 分包」间二选一，只有一方有值时自动并入；
   - **最新因子评估**两边不一致时整项二选一；分包带回的其余历史轮次自动追加，**旧勘察记录一律保留**；
   - **风险否决**按「营位编号 + 否决类型」判重，同类型记录不同则并排二选一（选分包会新增一条，不覆盖本队记录）。
4. **营地容量硬校验**：合并后同营地各营位帐篷数之和，对照营地容量表（`capacities`）：超过上限或容量未登记时**整体拒绝写入**（事务开启前判定，库内数据不触碰），可在页内直接维护容量后重试；分包自带容量仅作对照参考，不会覆盖本队容量。
5. **确认写入**：单事务落库；确认结果与分包自动存为 localStorage 草稿（`gbcampsite:draft:merge-package`），写入被拒或关闭页面后可恢复。
6. **写入即重算**：名次表 / 详情 / 地图都由 Pinia + `useRanking` 响应式派生，写库并重新加载后名次、A/B/C 等级与地图标记自动刷新；当启用方案的权重发生变化时结果弹层会明确提示已按新权重重算。

> 冲突判定口径：离线分包没有共同祖先快照，因此「两边都有值且内容不同」即视为双方都改过、需要人确认（宁可多确认，不静默覆盖）。

## 八、目录结构

```
sologsb-1126/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{campsite,factor,score,veto,campCapacity}.ts
        ├── stores/{siteStore,profileStore,uiStore,capacityStore}.ts
        ├── components/common/{MapPanel,FactorScoreBar,GradeBadge,EmptyState,WeightEditor}.vue
        ├── hooks/{useAmapLoader,useRanking,useLocalDraft}.ts
        ├── pages/{Ranking,SiteNew,SiteDetail,Scoring,MapView,Veto,Merge}.vue
        ├── router/index.ts
        ├── utils/{score,geo,format,db,draft,package,merge,demoPackage}.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 九、数据存储说明

- 全部数据只存在浏览器本地：营位、因子评估、权重方案、否决记录、营地容量存 **IndexedDB**（Dexie，库名 `gbcampsite-db`）。
- 表单草稿（新增营位、否决登记、勘察包合并确认）存 **localStorage**，键前缀 `gbcampsite:draft:`，刷新或误关页面后可恢复。
- 容器完全无状态：不使用数据库服务、不挂载命名卷，清除浏览器站点数据即回到首次运行的样例营地。
