# FIT 轨迹生成工具

一个基于 Web 的 FIT 跑步活动文件生成工具。在地图上自动生成足球场跑道轨迹，设置运动参数后一键导出 `.fit` 文件，可直接导入 Garmin Connect、Keep、Strava 等主流运动平台。

> **使用声明**：本项目仅用于技术学习、FIT 格式研究、前端地图交互演示及合法个人数据处理场景。严禁用于伪造运动记录、作弊打卡或规避任何平台规则。

在线体验：[FIT-Tool](https://fit-tool.hshoe.cn)
无需安装，打开即用

## 功能特性

- **自动跑道生成** — 无需手动画点，自动生成由两条直线和两个半圆组成的标准足球场跑道轨迹。
- **跑道模板系统** — 内置 SYSU 大学城跑道模板，支持一键切换跑道位置，亦可点击地图自定义中心点。
- **高德地图瓦片** — 采用高德地图瓦片替代 OpenStreetMap，国内访问速度更快，并自动处理 WGS-84 与 GCJ-02 坐标系转换。
- **多圈轨迹模拟** — 支持小数圈数，轨迹起点随机、每圈独立扰动，终点对齐跑道确保轨迹连续。
- **真实天气注入** — 根据活动时间和轨迹位置查询 Open-Meteo 天气数据，写入 FIT 文件中的天气消息与逐点温度。
- **运动指标模拟** — 基于速度曲线实时模拟步频、步幅、跑步功率和热量消耗，并在 FIT 文件中写入完整记录字段。
- **批量导出** — 支持一次导出 1–10 份 FIT 文件，每份独立设置开始时间、配速、心率、圈数和扰动参数，支持一键随机化。
- **响应式 UI** — 顶部状态栏 + 左侧控制面板 + 右侧地图 + 底部摘要栏布局，适配桌面与移动端。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript |
| 地图 | Leaflet 1.9 + 高德地图瓦片 (GCJ-02) |
| 后端 | Node.js + Express |
| FIT 生成 | @garmin/fitsdk |
| 天气数据 | Open-Meteo API |
| 部署 | Docker / Docker Compose / Nginx 反向代理 |

## 项目结构

```text
.
├── public/
│   ├── index.html          # 前端页面
│   ├── main.js             # 地图交互、轨迹生成、坐标系转换、导出逻辑
│   ├── style.css           # 页面样式
│   └── config.json         # 前端配置（模板、限制、参数默认值、天气等）
├── server.js               # Express 服务 + FIT 文件生成 + 天气查询
├── package.json
├── package-lock.json
├── Dockerfile              # 多阶段构建，Alpine 基础镜像
├── docker-compose.yml      # Docker Compose 一键启动
├── .dockerignore
├── run-fit-tool.cmd        # Windows 一键启动脚本
└── README.md
```

## 环境要求

- Node.js 18+
- npm（随 Node.js 安装）
- 现代浏览器（Chrome / Edge / Firefox / Safari）
- 可访问外部网络（前端加载 Leaflet CDN 和高德瓦片，后端查询天气 API）

## 快速开始

### 方式一：npm 启动

```bash
npm install
npm start
```

浏览器访问 `http://localhost:3000`。

### 方式二：Docker

**从 Docker Hub 拉取（推荐）：**

```bash
docker pull eltsen00/fit-tool
docker run -d -p 3000:3000 --name fit-tool eltsen00/fit-tool
```

**本地构建：**

```bash
docker build -t fit-tool .
docker run -d -p 3000:3000 --name fit-tool fit-tool

# 或使用 Docker Compose
docker compose up -d
```

可通过 `PORT` 环境变量修改监听端口：

```bash
docker run -d -p 8080:8080 -e PORT=8080 --name fit-tool eltsen00/fit-tool
```

### 方式三：Windows 一键启动

双击 `run-fit-tool.cmd`，自动安装依赖并启动服务。

## 使用方法

1. 启动服务后打开 `http://localhost:3000`。
2. 页面自动在地图上生成跑道轨迹，默认定位到 SYSU 大学城。
3. 在左侧面板选择跑道模板，或点击地图移动跑道中心。
4. 调整跑道方向角、长边、宽度和扰动强度。
5. 设置默认运动参数（心率、圈数、配速）。
6. 在"多份导出"区域为每份文件设置开始时间和参数，或使用"重新随机全部参数"。
7. 点击"生成 FIT 文件"，浏览器自动下载。

## 坐标系说明

本工具内部统一使用 **WGS-84** 坐标（标准 GPS 坐标），仅在 Leaflet 地图渲染层将 WGS-84 转换为 **GCJ-02**（火星坐标系）以匹配高德地图瓦片。用户在地图上的点击、拖动等操作会自动将 GCJ-02 还原为 WGS-84 存储。

```
config.json (WGS-84)
    │
    ├── 高德显示: WGS-84 → GCJ-02
    ├── 用户交互: GCJ-02 → WGS-84
    └── FIT 文件: WGS-84 直接输出
```

如需切换回 OpenStreetMap 瓦片，修改 `public/config.json` 中 `map.tileLayer` 和 `map.coordSystem` 字段即可。

## 配置文件

`public/config.json` 为主要配置入口，包含以下模块：

| 模块 | 说明 |
|---|---|
| `map` | 默认地图中心、缩放级别、坐标系、瓦片源 |
| `track` | 跑道模板列表、默认尺寸、点间距、限制范围 |
| `motionDefaults` | 默认静息/最大心率、圈数、配速 |
| `motionLimits` | 各项运动参数的输入限制 |
| `export` | 导出份数限制、时间随机化范围 |
| `weather` | 天气查询开关、API 地址、超时设置 |
| `runMetrics` | 步频/步幅/功率/消耗模拟参数 |

## 天气功能

默认使用**和风天气 (QWeather)** API，查询活动时间对应的逐小时天气数据，写入 FIT 的 `WEATHER_CONDITIONS` 消息以及每个记录点的温度字段。

### 配置 API Key

使用和风天气需要 API Key（免费注册，每天 1000 次请求）：

1. 前往 [和风天气开发平台](https://dev.qweather.com/) 注册账号
2. 创建项目获取 API Key
3. 配置 Key（任选其一）：
   - 环境变量：`QWEATHER_KEY=your_key npm start`
   - config.json：设置 `weather.qweather.key` 字段

```json
"weather": {
  "qweather": {
    "key": "你的API_KEY"
  }
}
```

若未配置 Key 或 API 不可用，默认**静默跳过**天气写入，不影响 FIT 文件生成。

### 切换回 Open-Meteo

将 `weather.provider` 改为 `"openMeteo"` 即可。Open-Meteo 无需 API Key，支持过去 92 天至未来 16 天的历史/预报数据，但国内访问可能较慢。

## Docker 部署 + Nginx 反向代理

Docker 镜像已发布至 Docker Hub：[`eltsen00/fit-tool`](https://hub.docker.com/r/eltsen00/fit-tool)。

```bash
docker pull eltsen00/fit-tool
docker run -d -p 3000:3000 --name fit-tool eltsen00/fit-tool
```

```nginx
# 示例 Nginx 配置
location /fit/ {
    proxy_pass http://127.0.0.1:3000/;
}
```

## 常见问题

### 地图加载不出来？

地图依赖高德瓦片和 Leaflet CDN。请检查网络连接，确认浏览器未拦截外部资源。若高德瓦片不可用，可在 `config.json` 中将 `coordSystem` 改为 `"wgs84"` 并切换 `tileLayer.url` 为 OpenStreetMap。

### 生成的数据和真实运动不一致？

本项目生成的数据是基于用户参数和随机算法的模拟数据，不代表真实 GPS 记录或生理测量。不同平台对 FIT 扩展字段（步频、功率、天气等）的解析策略不同，即使文件已写入字段也可能不会在 App 中展示。

### 默认跑道位置不准确？

在高德地图上直接点击目标跑道位置，左侧面板会显示对应的 WGS-84 经纬度。将该值更新到 `config.json` 对应模板的 `center` 字段中，下次启动即可使用精确位置。

## 免责声明

本项目仅用于技术学习、FIT 文件格式研究、前端地图交互演示、本地开发测试和个人合法数据处理。严禁将本项目或生成的任何文件用于：

- 冒充真实运动记录上传至任何第三方平台
- 作弊、规避审核、绕过风控或欺骗学校/单位/平台
- 违反任何法律法规或平台用户协议

详细声明见 README 完整版本。任何不当使用造成的全部后果由使用者自行承担。
