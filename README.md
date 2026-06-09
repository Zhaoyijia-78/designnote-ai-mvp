# DesignNote AI MVP

DesignNote AI 是一个面向互联网设计团队的多模态会议协作 MVP。它围绕「上传 UI 设计稿 + 粘贴设计评审会议记录」这一场景，自动生成设计修改待办，并在设计画布上完成任务标注、任务管理和 AI 会议问答。

这个项目主要用于 B 端 AI 产品经理作品集展示，重点体现从业务流程、AI 解析、人工校准、可信度判断到演示闭环的完整产品思考。

## 核心功能

- 上传 UI 设计稿和会议讨论记录。
- 异步解析会议内容，动态生成待办事项。
- 根据任务涉及的 UI 元素，在设计画布上生成编号标注。
- 支持拖拽标注点，保存人工校准坐标。
- 支持新增、编辑、删除待办事项。
- 支持任务完成状态、负责人、截止日期和会议节点溯源。
- 支持任务可信度：明确任务、待确认建议、低置信度。
- 支持 AI 会议助手，基于当前会议材料和任务列表追问。
- API 调用失败时保留本地兜底逻辑，保证演示不断档。

## 本地启动

安装 Node.js 20 后，在项目目录运行：

```powershell
npm install
npm start
```

浏览器打开：

```text
http://localhost:3000
```

如果使用当前项目自带的启动脚本，也可以运行：

```powershell
.\start-designnote.ps1
```

## AI 配置

复制 `.env.example` 为 `.env`，然后填写自己的 Key。

AihubMix / GPT-5.5 示例：

```text
AI_PROVIDER=aihubmix
AIHUBMIX_API_KEY=你的 AihubMix Key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
AIHUBMIX_MODEL=gpt-5.5
```

也可以按 `.env.example` 配置 OpenAI 或 DeepSeek。

注意：真实 API Key 只放在本地 `.env` 或部署平台环境变量里，不要提交到 GitHub。

## 部署上线

推荐使用 Render 部署为 Node.js Web Service。详细步骤见 [DEPLOY.md](DEPLOY.md)。

免费演示版建议配置：

```text
AI_PROVIDER=aihubmix
AIHUBMIX_API_KEY=你的 AihubMix Key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
AIHUBMIX_MODEL=gpt-5.5
APP_USERNAME=designnote
APP_PASSWORD=设置一个访问密码
DATA_DIR=/tmp/designnote-data
NODE_VERSION=20
```

`APP_PASSWORD` 会启用简单访问保护，避免公开链接被陌生人消耗 API 额度。

免费演示版不使用持久化磁盘，Render 重启或重新部署后历史上传记录可能会丢失。用于作品集在线演示通常已经足够；如果后续要长期保存数据，可以再升级为带 Persistent Disk 的配置。

## 部署前验证

```powershell
node --check server.js
node --check public/app.js
npm run test:smoke
```

## 项目结构

```text
server.js          后端接口、AI 调用、本地数据存储
public/            前端工作台页面
scripts/           冒烟测试和样例测试脚本
data/              本地运行产生的数据，已被 .gitignore 排除
render.yaml        Render 部署配置
DEPLOY.md          部署说明
```
