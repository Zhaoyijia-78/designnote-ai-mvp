# DesignNote AI MVP 部署说明

推荐使用 Render 部署本项目。当前项目是一个 Node.js Web Service，会保存上传图片、项目记录、任务列表和聊天记录，因此线上环境建议开启 Persistent Disk。

## 1. 上线前检查

不要提交以下内容到 GitHub：

- `.env`
- `data/`
- `node_modules/`
- 真实 API Key

项目已经在 `.gitignore` 中排除了这些内容。AihubMix Key 只需要填写到部署平台的环境变量里。

## 2. Render 环境变量

在 Render 的 Environment 页面添加：

```text
AI_PROVIDER=aihubmix
AIHUBMIX_API_KEY=你的 AihubMix Key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
AIHUBMIX_MODEL=gpt-5.5
APP_USERNAME=designnote
APP_PASSWORD=设置一个访问密码
DATA_DIR=/opt/render/project/src/data
NODE_VERSION=20
```

注意：`AIHUBMIX_API_KEY` 和 `APP_PASSWORD` 只放在 Render 环境变量中，不要写入代码仓库。

## 3. Render Web Service 配置

如果使用仓库里的 `render.yaml`，可以通过 Render Blueprint 自动读取配置。

如果手动创建 Web Service，填写：

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

Persistent Disk 建议配置：

```text
Mount Path: /opt/render/project/src/data
Size: 1 GB
```

## 4. 访问方式

部署完成后打开 Render 提供的 URL。浏览器会弹出访问账号密码：

```text
Username: designnote
Password: 你在 APP_PASSWORD 设置的密码
```

## 5. 常见问题

如果解析失败，检查：

- `AIHUBMIX_API_KEY` 是否填写正确。
- `AI_PROVIDER` 是否为 `aihubmix`。
- `AIHUBMIX_MODEL` 是否为中转平台可用的模型名。

如果上传记录丢失，检查：

- Render Persistent Disk 是否已经创建。
- `DATA_DIR` 是否为 `/opt/render/project/src/data`。

如果打开页面提示输入密码：

- 这是 `APP_PASSWORD` 启用后的正常行为，用于保护作品集 Demo 和 API 额度。
