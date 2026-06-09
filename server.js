import http from "node:http";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnv();

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const EMBEDDINGS_DIR = path.join(DATA_DIR, "embeddings");
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 3000);
const APP_USERNAME = process.env.APP_USERNAME || "designnote";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const AIHUBMIX_BASE_URL = (process.env.AIHUBMIX_BASE_URL || "https://aihubmix.com/v1").replace(/\/$/, "");
const AIHUBMIX_MODEL = process.env.AIHUBMIX_MODEL || "gpt-5.5";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const jobs = new Map();

await ensureDirs();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (!authorizeRequest(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      return serveFile(res, path.join(UPLOADS_DIR, path.basename(url.pathname)), contentType(url.pathname));
    }

    if (req.method === "GET" && url.pathname.startsWith("/samples/")) {
      return serveFile(res, path.join(PUBLIC_DIR, "samples", path.basename(url.pathname)), contentType(url.pathname));
    }

    if (req.method === "GET" && ["/app.js", "/style.css"].includes(url.pathname)) {
      return serveFile(res, path.join(PUBLIC_DIR, url.pathname.slice(1)), contentType(url.pathname));
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, res, url);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`DesignNote AI MVP is running at http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      aihubmixConfigured: Boolean(process.env.AIHUBMIX_API_KEY),
      deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
      provider: getActiveProvider(),
      model: getActiveModel()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const project = await createProject();
    return sendJson(res, 201, { project });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (req.method === "GET" && projectMatch) {
    const project = await readProject(projectMatch[1]);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    return sendJson(res, 200, { project });
  }

  if (req.method === "POST" && url.pathname === "/api/uploads") {
    const body = await readJsonBody(req);
    const result = await saveUpload(body);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    const body = await readJsonBody(req);
    if (!body.projectId) return sendJson(res, 400, { error: "projectId is required" });
    const project = await readProject(body.projectId);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    if (!project.meetingText?.trim()) return sendJson(res, 400, { error: "请先粘贴会议讨论记录" });
    if (!project.imageUrl) return sendJson(res, 400, { error: "请先上传 UI 设计图" });

    const jobId = createId("job");
    jobs.set(jobId, {
      id: jobId,
      projectId: project.id,
      status: "queued",
      progress: 8,
      message: "已加入解析队列",
      result: null,
      error: null,
      createdAt: new Date().toISOString()
    });
    runAnalysis(jobId);
    return sendJson(res, 202, { jobId });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });
    return sendJson(res, 200, { job });
  }

  const taskCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
  if (req.method === "POST" && taskCollectionMatch) {
    const body = await readJsonBody(req);
    const project = await readProject(taskCollectionMatch[1]);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    const task = createManualTask(body, project.tasks.length);
    project.tasks.push(task);
    await refreshProjectTaskArtifacts(project);
    await writeProject(project);
    return sendJson(res, 201, { project, task });
  }

  const taskMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  if (req.method === "PATCH" && taskMatch) {
    const body = await readJsonBody(req);
    const project = await readProject(taskMatch[1]);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    const taskIndex = project.tasks.findIndex((item) => item.id === taskMatch[2]);
    const task = project.tasks[taskIndex];
    if (!task) return sendJson(res, 404, { error: "Task not found" });
    applyTaskFieldPatch(task, body);
    if (typeof body.status === "string") {
      task.status = body.status === "done" ? "done" : "todo";
    }
    if (body.positionSource === "ai") {
      task.position = normalizeManualPosition(task.originalPosition || task.position || fallbackPosition(taskIndex));
      task.positionSource = "ai";
      task.positionUpdatedAt = new Date().toISOString();
    } else if (body.position) {
      task.originalPosition = normalizeManualPosition(task.originalPosition || task.position || fallbackPosition(taskIndex));
      task.position = normalizeManualPosition(body.position);
      task.positionSource = "manual";
      task.positionUpdatedAt = new Date().toISOString();
    }
    task.updatedAt = new Date().toISOString();
    await refreshProjectTaskArtifacts(project);
    await writeProject(project);
    return sendJson(res, 200, { project, task });
  }

  if (req.method === "DELETE" && taskMatch) {
    const project = await readProject(taskMatch[1]);
    if (!project) return sendJson(res, 404, { error: "Project not found" });
    const taskIndex = project.tasks.findIndex((item) => item.id === taskMatch[2]);
    if (taskIndex < 0) return sendJson(res, 404, { error: "Task not found" });
    const [task] = project.tasks.splice(taskIndex, 1);
    await refreshProjectTaskArtifacts(project);
    await writeProject(project);
    return sendJson(res, 200, { project, task });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJsonBody(req);
    const answer = await answerQuestion(body.projectId, body.message);
    return sendJson(res, 200, answer);
  }

  sendJson(res, 404, { error: "API not found" });
}

async function runAnalysis(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    updateJob(jobId, { status: "processing", progress: 24, message: "正在读取会议文本和设计图" });
    await wait(600);
    const project = await readProject(job.projectId);
    updateJob(jobId, { progress: 52, message: "正在识别待办修改事项" });

    const imageDataUrl = await readImageAsDataUrl(project);
    const aiResult = await analyzeWithAI(project, imageDataUrl).catch((error) => {
      console.warn("AI analyze failed, falling back to demo parser:", error.message);
      return null;
    });

    updateJob(jobId, { progress: 78, message: "正在生成画布标注和任务表" });
    await wait(500);

    const parsed = normalizeAnalysis(aiResult || analyzeLocally(project.meetingText), project.meetingText);
    project.tasks = parsed.tasks;
    project.markers = parsed.tasks.map((task) => ({
      id: task.markerId,
      taskId: task.id,
      x: task.position.x,
      y: task.position.y,
      positionSource: task.positionSource || "ai",
      status: task.status
    }));
    project.designTokens = parsed.designTokens;
    project.summary = parsed.summary;
    project.chunks = buildChunks(project.meetingText, project.tasks);
    project.provider = aiResult?.provider || "demo";
    project.updatedAt = new Date().toISOString();

    await writeProject(project);
    await writeEmbeddings(project);
    updateJob(jobId, {
      status: "done",
      progress: 100,
      message: `解析完成，识别出 ${project.tasks.length} 条待办修改任务`,
      result: { projectId: project.id, taskCount: project.tasks.length, provider: project.provider }
    });
  } catch (error) {
    updateJob(jobId, { status: "failed", progress: 100, message: "解析失败", error: error.message });
  }
}

async function analyzeWithAI(project, imageDataUrl) {
  const provider = getActiveProvider();
  if (provider === "openai") {
    const result = await analyzeWithOpenAI(project, imageDataUrl);
    return { ...result, provider: "openai" };
  }
  if (provider === "aihubmix") {
    const result = await analyzeWithOpenAICompatible(project, {
      apiKey: process.env.AIHUBMIX_API_KEY,
      baseUrl: AIHUBMIX_BASE_URL,
      model: AIHUBMIX_MODEL,
      providerLabel: "AihubMix"
    }, imageDataUrl);
    return { ...result, provider: "aihubmix" };
  }
  if (provider === "deepseek") {
    const result = await analyzeWithDeepSeek(project);
    return { ...result, provider: "deepseek" };
  }
  return null;
}

async function analyzeWithOpenAI(project, imageDataUrl) {
  if (!process.env.OPENAI_API_KEY) return null;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "designTokens", "tasks"],
    properties: {
      summary: { type: "string" },
      designTokens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "value", "usage"],
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            usage: { type: "string" }
          }
        }
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail", "owner", "dueDate", "meetingSource", "position", "designToken", "confidenceLevel", "confidenceScore", "confidenceReason"],
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            owner: { type: "string" },
            dueDate: { type: "string" },
            meetingSource: { type: "string" },
            confidenceLevel: { type: "string", enum: ["explicit", "suggested", "low"] },
            confidenceScore: { type: "number", minimum: 0, maximum: 100 },
            confidenceReason: { type: "string" },
            position: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y"],
              properties: {
                x: { type: "number", minimum: 8, maximum: 92 },
                y: { type: "number", minimum: 8, maximum: 92 }
              }
            },
            designToken: {
              type: "object",
              additionalProperties: false,
              required: ["name", "value"],
              properties: {
                name: { type: "string" },
                value: { type: "string" }
              }
            }
          }
        }
      }
    }
  };

  const prompt = [
    "你是 DesignNote AI，负责把互联网设计评审会转成结构化设计修改任务。",
    "请根据会议文本和 UI 图片真实识别待办事项。不要固定任务数量；只有会议中明确需要修改、跟进、安排或修复的内容才生成任务。",
    "不要把开场介绍、背景总结、问题数量说明、单纯的“收到/好的/今天下班前改好”生成任务；这类确认语只能用来补充上一条相关任务的负责人或截止日期。",
    "如果一句话里包含两个独立修改点，例如“加状态列”和“导航新增设置”，必须拆成两条任务；如果后文只是确认前文建议，不要重复生成。",
    "标注坐标必须先按以下思考顺序完成，但最终只返回 JSON：1. 识别页面类型；2. 拆解主要布局区域、卡片、表格、时间轴、目录树、按钮、标签、条形块等 UI 元素；3. 判断每条会议任务涉及的具体 UI 元素；4. 将 position 标到该元素中心或任务指定的锚点位置。",
    "每条任务都要能映射到画布坐标，坐标使用百分比 x/y。若图片中无法精确定位，请根据描述给出最合理区域。",
    "后台表格页定位要求：新增用户按钮标在右上角按钮中心；新增状态列标在表格表头中“系统角色”和“操作”之间；导航新增设置标在左侧“系统操作日志”下方将要出现的位置。",
    "甘特图页定位要求：负责人头像任务标在对应任务行的负责人圆点；缩短排期任务标在对应彩色横条的目标截止位置；里程碑任务标在目标日期列右侧空白处。",
    "CRM 三栏详情页定位要求：标签任务标在左侧客户画像标签；跟进记录筛选任务标在中间面板标题右侧；关联商机新建按钮任务标在右侧面板标题右侧。",
    "B2B 商机详情页定位要求：阶段进度任务标在对应阶段圆形节点；金额格式任务标在指标卡片内的金额数字上；Tabs 选中态任务标在对应页签文字或下划线位置。",
    "API 密钥配置页定位要求：密钥脱敏任务标在密钥字符串区域；复制按钮任务标在密钥框右侧；安全提醒横幅任务标在顶部提示条左侧图标或横幅主体。",
    "流程画布页定位要求：触发器任务标在触发器节点头部图标；断线闭环任务标在断掉连线末端将新增的结束节点位置；执行动作文案任务标在执行动作节点正文。",
    "知识库目录页定位要求：展开文件夹图标任务标在对应目录项左侧文件夹图标；新建快捷入口任务标在左侧目录面板顶部表头右侧；新增目录行任务标在目标父级目录下方将新增的目录行位置。",
    "负责人从会议发言人或内容中推断；截止日期没有明确日期时可写“待定”。",
    "每条任务必须判断可信度：confidenceLevel 只能是 explicit、suggested、low。explicit 表示会议中有明确修改动作、UI 对象、负责人或截止时间；suggested 表示有修改方向但执行口径不完整；low 表示更像讨论、感受或 AI 推测。",
    "confidenceScore 使用 0-100，confidenceReason 用一句话解释判断依据，避免长篇依据。",
    "会议文本如下：",
    project.meetingText
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "designnote_analysis",
          schema,
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI analyze request failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  return JSON.parse(text);
}

async function analyzeWithDeepSeek(project) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  return analyzeWithOpenAICompatible(project, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: "https://api.deepseek.com",
    model: DEEPSEEK_MODEL,
    providerLabel: "DeepSeek"
  });
}

async function analyzeWithOpenAICompatible(project, config, imageDataUrl = "") {
  if (!config.apiKey) return null;
  const prompt = [
    "你是 DesignNote AI，负责把互联网设计评审会转成结构化设计修改任务。",
    "请只根据会议文本识别明确待办事项，不要固定任务数量。会议里有几条明确修改/跟进事项，就生成几条任务。",
    "严格排除：开场介绍、背景总结、问题数量说明、单纯的“收到/好的/今天下班前改好”。这些句子不能单独成为任务，只能用于补充上一条相关任务的截止日期。",
    "如果一句话里包含多个独立 UI 修改点，请拆成多条任务；如果后文只是确认前文建议，不要重复生成。",
    "标注坐标必须先按以下思考顺序完成，但最终只返回 JSON：1. 识别页面类型；2. 拆解主要布局区域、卡片、表格、时间轴、目录树、按钮、标签、条形块等 UI 元素；3. 判断每条会议任务涉及的具体 UI 元素；4. 将 position 标到该元素中心或任务指定的锚点位置。",
    "返回严格 JSON，不要 Markdown，不要解释。JSON 字段：summary, designTokens, tasks。",
    "tasks 每一项字段：title, detail, owner, dueDate, meetingSource, position, designToken, confidenceLevel, confidenceScore, confidenceReason。",
    "confidenceLevel 只能是 explicit、suggested、low。explicit=会议中有明确修改动作、UI 对象、负责人或截止时间；suggested=有修改方向但负责人、截止时间或具体执行口径不完整；low=更像讨论、感受或 AI 推测。confidenceScore 为 0-100，confidenceReason 用一句话说明判断依据。",
    "position 使用 UI 截图内部百分比坐标 {x,y}，必须标在具体 UI 元素中心点上，不能标到截图外或深色画布外。头像任务标在右上角头像中心，导航任务标在左侧选中菜单项中心，图表筛选器任务标在访问趋势卡片右上角控件位置。",
    "后台表格页定位要求：新增用户按钮标在右上角按钮中心；新增状态列标在表格表头中“系统角色”和“操作”之间；导航新增设置标在左侧“系统操作日志”下方将要出现的位置。",
    "甘特图页定位要求：负责人头像任务标在对应任务行的负责人圆点；缩短排期任务标在对应彩色横条的目标截止位置；里程碑任务标在目标日期列右侧空白处。",
    "CRM 三栏详情页定位要求：标签任务标在左侧客户画像标签；跟进记录筛选任务标在中间面板标题右侧；关联商机新建按钮任务标在右侧面板标题右侧。",
    "B2B 商机详情页定位要求：阶段进度任务标在对应阶段圆形节点；金额格式任务标在指标卡片内的金额数字上；Tabs 选中态任务标在对应页签文字或下划线位置。",
    "API 密钥配置页定位要求：密钥脱敏任务标在密钥字符串区域；复制按钮任务标在密钥框右侧；安全提醒横幅任务标在顶部提示条左侧图标或横幅主体。",
    "流程画布页定位要求：触发器任务标在触发器节点头部图标；断线闭环任务标在断掉连线末端将新增的结束节点位置；执行动作文案任务标在执行动作节点正文。",
    "知识库目录页定位要求：展开文件夹图标任务标在对应目录项左侧文件夹图标；新建快捷入口任务标在左侧目录面板顶部表头右侧；新增目录行任务标在目标父级目录下方将新增的目录行位置。",
    "designTokens 每一项字段：name, value, usage。",
    "会议文本：",
    project.meetingText
  ].join("\n");

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "你是严谨的 B 端 AI 产品助手，输出必须是可解析 JSON。"
        },
        {
          role: "user",
          content: imageDataUrl
            ? [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageDataUrl } }
              ]
            : prompt
        }
      ],
      response_format: { type: "json_object" },
      stream: false
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${config.providerLabel} analyze request failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  return parseJsonObject(payload.choices?.[0]?.message?.content || "");
}

async function answerQuestion(projectId, message) {
  if (!projectId || !message?.trim()) return { answer: "请先输入一个问题。", citations: [] };
  const project = await readProject(projectId);
  if (!project) return { answer: "没有找到当前项目，请刷新页面后重试。", citations: [] };
  if (!project.tasks?.length) return { answer: "还没有解析结果。请先上传 UI 图和会议文本，并点击“开始智能解析”。", citations: [] };

  const context = retrieveContext(project, message);
  const local = answerLocally(project, message, context);
  const confidenceAnswer = answerConfidenceQuery(project, message);
  if (confidenceAnswer) {
    await appendMessage(project, message, confidenceAnswer.answer, context);
    return { ...confidenceAnswer, citations: context };
  }
  const structured = answerStructuredTaskQuery(project, message);
  if (structured) {
    await appendMessage(project, message, structured.answer, context);
    return { ...structured, citations: context };
  }

  const provider = getActiveProvider();
  if (provider === "demo") {
    await appendMessage(project, message, local.answer, context);
    return local;
  }

  try {
    const answer = await answerWithAI(provider, message, context);
    await appendMessage(project, message, answer, context);
    return { answer, citations: context };
  } catch (error) {
    console.warn("AI chat failed, falling back to local answer:", error.message);
    await appendMessage(project, message, local.answer, context);
    return local;
  }
}

async function answerWithAI(provider, message, context) {
  const contextText = context.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
  const system = [
    "你是 DesignNote AI 的空间问答助手，只能基于给定会议上下文、任务和设计 token 回答，不要编造。",
    "回答必须简洁明了，不展示完整依据，不写长篇解释。",
    "当回答涉及具体任务、修改意见或 UI 元素时，必须使用精简的无序列表。",
    "如果提到的任务在上下文中有任务编号，必须严格使用 [Task-ID] 格式标记，例如 [Task-1]、[Task-2]。",
    "如果用户询问可信度、推测或需要确认的任务，优先返回 suggested 和 low 可信度任务，并写明一句原因。",
    "每个列表项只写动作和结果，最多 2 行。",
    "回答最后只补一行：会议节点溯源：时间1、时间2。不要展开解释依据。",
    "如果没有找到明确时间，最后写：会议节点溯源：会议记录。"
  ].join("\n");
  const user = `问题：${message}\n\n相关上下文：\n${contextText}\n\n请按上述格式直接回答。`;

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    return extractResponseText(payload);
  }

  if (provider === "deepseek") {
    return answerWithChatCompletions({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: "https://api.deepseek.com",
      model: DEEPSEEK_MODEL,
      providerLabel: "DeepSeek",
      system,
      user
    });
  }

  if (provider === "aihubmix") {
    return answerWithChatCompletions({
      apiKey: process.env.AIHUBMIX_API_KEY,
      baseUrl: AIHUBMIX_BASE_URL,
      model: AIHUBMIX_MODEL,
      providerLabel: "AihubMix",
      system,
      user
    });
  }

  return "";
}

async function answerWithChatCompletions(config) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: config.system },
          { role: "user", content: config.user }
        ],
        stream: false
      })
    });
  if (!response.ok) throw new Error(`${config.providerLabel} chat request failed: ${await response.text()}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "";
}

function answerConfidenceQuery(project, message) {
  const asksConfirmation = /确认|待确认|可信|置信|推测|明确|低置信|不确定|哪些.*需要/.test(message);
  if (!asksConfirmation) return null;

  const tasks = project.tasks.filter((task) => ["suggested", "low"].includes(task.confidenceLevel || "suggested"));
  if (!tasks.length) {
    return {
      answer: "当前没有识别到需要额外确认的任务。\n- 所有待办都属于明确任务，可直接进入执行确认。\n会议节点溯源：会议记录"
    };
  }

  const lines = [`当前有 ${tasks.length} 个任务需要人工确认：`];
  for (const task of tasks) {
    lines.push(`- [Task-${task.markerId}] ${shortTaskTitle(task.title)}`);
    lines.push(`原因：${task.confidenceReason || "会议依据不够完整，需要人工确认。"}`);
    lines.push(`会议节点溯源：${extractTaskMeetingNode(task)}`);
  }
  return { answer: lines.join("\n") };
}

function answerStructuredTaskQuery(project, message) {
  const owner = message.match(/小[\u4e00-\u9fa5]|张[\u4e00-\u9fa5]|李[\u4e00-\u9fa5]|王[\u4e00-\u9fa5]/)?.[0];
  const asksTasks = /任务|待办|处理|负责|有哪些|什么/.test(message);
  if (!owner || !asksTasks) return null;

  const tasks = project.tasks.filter((task) => task.owner?.includes(owner));
  if (!tasks.length) {
    return {
      answer: `${owner}当前没有识别到待处理任务。\n会议节点溯源：会议记录`
    };
  }

  const lines = [`${owner}当前需要处理的任务共有 ${tasks.length} 个：`];
  for (const task of tasks) {
    lines.push(`- [Task-${task.markerId}] ${shortTaskTitle(task.title)}`);
    lines.push(`要求：${buildTaskRequirement(task)}`);
    lines.push(`会议节点溯源：${extractTaskMeetingNode(task)}`);
  }
  return { answer: lines.join("\n") };
}

function shortTaskTitle(title) {
  return String(title || "处理设计修改任务")
    .replace(/至\s*\d+px/g, "")
    .replace(/调整为.*/g, "")
    .replace(/在访问趋势图表右上角/, "")
    .trim();
}

function buildTaskRequirement(task) {
  const text = `${task.title || ""} ${task.detail || ""} ${task.meetingSource || ""}`;
  if (/头像|32px|24px/.test(text)) return "从当前的 24px 调整至 32px。";
  if (/时间筛选|近7天|近30天|访问趋势/.test(text)) return "在“访问趋势”图表内部右上角添加，支持切换“近7天/近30天”。";
  if (/品牌|#1677FF|导航|选中态/.test(text)) return "将左侧导航选中态文字背景调整为品牌主色调蓝色 #1677FF。";
  return summarizeTaskDetail(task.detail);
}

function extractTaskMeetingNode(task) {
  return extractMeetingNodeText(task.meetingSource || "") || "会议记录";
}

function analyzeLocally(meetingText) {
  const lines = meetingText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionableLines = lines.flatMap((line) => expandActionableMeetingLine(line));
  const tasks = actionableLines.map((line, index) => {
    const owner = extractOwner(line);
    const title = buildTitle(line, index);
    const token = extractToken(line);
    const dueDate = inferDueDateFromNearbyLines(line, lines);
    const confidence = assessTaskConfidence({ title, detail: line, owner, dueDate, meetingSource: line });
    return {
      title,
      detail: cleanupDetail(line),
      owner,
      dueDate,
      meetingSource: line.slice(0, 180),
      position: fallbackPosition(index),
      designToken: token,
      confidenceLevel: confidence.level,
      confidenceScore: confidence.score,
      confidenceReason: confidence.reason
    };
  });

  const deduped = [];
  const seen = new Set();
  for (const task of tasks) {
    const key = semanticTaskKey(task);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(task);
    }
  }

  if (!deduped.length && meetingText.trim()) {
    deduped.push({
      title: "整理会议中的设计修改点",
      detail: "会议文本中没有识别到明确待办，请人工确认是否需要补充修改任务。",
      owner: "待定",
      dueDate: "待定",
      meetingSource: meetingText.slice(0, 120),
      position: fallbackPosition(0),
      designToken: { name: "待确认", value: "待确认" },
      confidenceLevel: "low",
      confidenceScore: 38,
      confidenceReason: "会议文本中没有识别到明确执行动作，需要人工确认。"
    });
  }

  return {
    summary: `基于会议文本识别出 ${deduped.length} 条待办修改任务。`,
    designTokens: Array.from(new Map(deduped.map((task) => [task.designToken.name, task.designToken])).values())
      .filter((token) => token.name !== "待确认"),
    tasks: deduped
  };
}

function expandActionableMeetingLine(line) {
  if (isNonTaskMeetingLine(line)) return [];
  const speaker = line.match(/^[【\[].*?[】\]]/)?.[0] || "";
  const content = line.replace(/^[【\[].*?[】\]]\s*/, "");
  const segments = splitMeetingContent(content)
    .map((segment) => `${speaker}${segment}`.trim())
    .filter((segment) => isActionableMeetingLine(segment));
  if (segments.length) return segments;
  return isActionableMeetingLine(line) ? [line] : [];
}

function splitMeetingContent(content) {
  const normalized = String(content || "")
    .replace(/(最后说一下|最后看|最后一点|最后，|最后|另外|首先是|首先|其次|然后|同时|还有)/g, "。$1")
    .replace(/(一定要加上。)(?=[^。]*左边导航栏)/g, "$1。");
  return normalized
    .split(/[。；;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !isAckOnlyContent(segment));
}

function isActionableMeetingLine(line) {
  if (isNonTaskMeetingLine(line)) return false;
  const text = line.replace(/^[【\[].*?[】\]]\s*/, "");
  if (/金额格式确实必须严谨/.test(text) && !/(补上|加一条|选中态|下划线)/.test(text)) return false;
  const actionText = text.replace(/新增用户/g, "用户");
  const hasAction = /(把|将|给|需要|请|改成|改为|换成|替换|定义|调整|优化|增加|新增|添加|补充|补上|统一|修复|对齐|降低|提高|加一列|加一行|加一条|加一个|加上)/.test(actionText);
  const hasUiObject = /(按钮|新增用户|状态|账号状态|系统角色|操作列|导航|菜单|设置|系统操作日志|头像|图表|筛选|背景|颜色|色值|卡片|指标卡片|金额|人民币|符号|阶段|进度条|商务谈判|Tabs?|页签|报价明细|密钥|Secret\s*Key|Key|复制|横幅|警告|三角形|触发器|Trigger|节点|流程|虚线|执行动作|Action|菱形|里程碑|时间轴|文件夹|目录|列表|表格|列|行|入口|文案|间距|动效|页面|UI|界面)/i.test(text);
  return hasAction && hasUiObject;
}

function isNonTaskMeetingLine(line) {
  const text = String(line || "").replace(/^[【\[].*?[】\]]\s*/, "").trim();
  if (!text) return true;
  if (isAckOnlyContent(text)) return true;
  if (/大家看一下|大家来对一下|大家来看一下|大家过一下|整体.*出来了|整体.*但有|核心体验问题|今天.*主要|本次.*主要|先看一下|几个细节没对齐|几个地方要改/.test(text)) return true;
  return false;
}

function isAckOnlyContent(text) {
  const content = String(text || "").trim();
  if (!/^(收到|好的|好|明白|了解|OK|ok)[，,。.\s]/.test(content)) return false;
  return !/(按钮|状态|账号状态|系统角色|操作列|导航|菜单|设置|系统操作日志|头像|图表|筛选|背景|颜色|卡片|列表|表格|列|行|入口|文案|间距|动效|页面|UI|界面)/i.test(content);
}

function inferDueDateFromNearbyLines(line, allLines) {
  const direct = extractDueDate(line);
  if (direct !== "待定") return direct;
  const owner = extractOwner(line);
  const index = allLines.findIndex((item) => item.includes(line.replace(/^[【\[].*?[】\]]\s*/, "").slice(0, 16)));
  const nearby = index >= 0 ? allLines.slice(index + 1, index + 3) : [];
  const ownerFamily = owner.match(/[\u4e00-\u9fa5]$/)?.[0];
  const followup = nearby.find((item) => {
    if (!/(今天|明天|本周|周[一二三四五六日天])/.test(item)) return false;
    if (!/(改好|完成|处理好|负责|跟进|加上)/.test(item)) return false;
    if (!ownerFamily || owner === "待定") return true;
    return item.includes(owner) || item.includes(`小${ownerFamily}`) || item.includes(ownerFamily);
  });
  if (followup) return extractDueDate(followup);
  const confirmation = nearby.find((item) => {
    if (!isAckOnlyContent(item.replace(/^[【\[].*?[】\]]\s*/, ""))) return false;
    if (!ownerFamily || owner === "待定") return true;
    return item.includes(owner) || item.includes(`小${ownerFamily}`) || item.includes(ownerFamily);
  });
  return confirmation ? extractDueDate(confirmation) : "待定";
}

function semanticTaskKey(task) {
  const text = `${task.title || ""} ${task.detail || ""} ${task.meetingSource || ""}`;
  if (/补充密钥一键复制入口/.test(task.title || "")) return "api-secret-copy";
  if (/补充结束流程节点/.test(task.title || "")) return "flow-end-node";
  if (/修正执行动作节点文案/.test(task.title || "")) return "flow-action-copy";
  if (/补充知识库新建快捷入口|新建.*全局快捷入口|\+\s*新建.*快捷入口/.test(task.title || "")) return "knowledge-create-shortcut";
  if (/新增后续运营目录行/.test(task.title || "")) return "knowledge-followup-folder";
  if (/后续运营|市场与销售支持/.test(text) && /新增|补充|加一行|再加一行|目录行|下面/.test(text)) return "knowledge-followup-folder";
  if (/商务谈判|第三阶段|数字\s*3|当前阶段|阶段进度|进度条|圆形图标/.test(text)) return "deal-stage-current";
  if (/报价明细|Tabs?|页签|Tab\s*栏|选中态.*下划线|下划线.*选中态/.test(text)) return "deal-tabs-active";
  if (/预计销售金额|450,?000|人民币|¥|金额|指标卡片|补上.*符号/.test(text)) return "deal-amount-currency";
  if (/API.*泄露|高危|提示横幅|警告三角|视觉警示|浅红|浅橙/.test(text)) return "api-warning-banner";
  if (/一键复制|复制.*icon|复制按钮|Key.*复制|密钥框.*右侧/.test(text)) return "api-secret-copy";
  if (/Secret\s*Key|默认应用密钥|密钥字符串|脱敏|星号|小眼睛|明文/.test(text)) return "api-secret-mask";
  if (/触发器|Trigger/.test(text) && /图标|紫色|#722ED1|源头/.test(text)) return "flow-trigger-icon";
  if (/执行动作|Action|系统更新通知|新人大礼包邮件|文案写错/.test(text)) return "flow-action-copy";
  if (/结束流程|断掉|虚线末端|死胡同|闭环|右下方空白/.test(text)) return "flow-end-node";
  if (/新增用户|主按钮|按钮|#1677FF|品牌主色|实心按钮/.test(text)) return "primary-button";
  if (/账号状态|状态.*列|系统角色.*操作|加一列.*状态|状态字段/.test(text)) return "status-column";
  if (/设置|系统操作日志|左边导航|左侧导航|导航栏/.test(text)) return "settings-nav";
  return String(task.title || text).slice(0, 24);
}

function normalizeTaskConfidence(task) {
  const fallback = assessTaskConfidence(task);
  const level = ["explicit", "suggested", "low"].includes(task.confidenceLevel)
    ? task.confidenceLevel
    : fallback.level;
  const score = Number.isFinite(Number(task.confidenceScore))
    ? Math.max(0, Math.min(100, Math.round(Number(task.confidenceScore))))
    : fallback.score;
  const reason = String(task.confidenceReason || fallback.reason).slice(0, 120);
  return { level, score, reason };
}

function assessTaskConfidence(task) {
  const text = `${task.title || ""} ${task.detail || ""} ${task.meetingSource || ""}`;
  const hasAction = /(需要|必须|请|把|改|调整|补充|统一|优化|增加|降低|提高|修复|对齐|处理|跟进|完成)/.test(text);
  const hasUiObject = /(头像|按钮|导航|菜单|图表|筛选器|背景|色值|颜色|卡片|列表|表格|组件|文案|间距|动效|状态|图标|布局|UI|界面)/i.test(text);
  const isVague = /(感觉|建议|可以|可能|似乎|大概|后面|看一下|再看看|不太|有点|考虑)/.test(text);
  const hasOwner = task.owner && task.owner !== "待定";
  const hasDueDate = task.dueDate && task.dueDate !== "待定";

  if (hasAction && hasUiObject && (hasOwner || hasDueDate) && !isVague) {
    return {
      level: "explicit",
      score: 92,
      reason: "会议中包含明确修改动作、UI 对象和责任信息。"
    };
  }
  if (hasAction && hasUiObject) {
    return {
      level: "suggested",
      score: isVague ? 68 : 76,
      reason: isVague ? "会议中有修改方向，但表达较模糊，需要人工确认执行口径。" : "会议中有明确修改方向，但责任人或截止时间不完整。"
    };
  }
  return {
    level: "low",
    score: 42,
    reason: "缺少明确 UI 对象或执行动作，更像讨论内容或 AI 推测。"
  };
}

function createManualTask(body, index) {
  const now = new Date().toISOString();
  const position = normalizeManualPosition(body.position || { x: 50, y: 50 });
  const task = {
    id: createId("task"),
    markerId: String(index + 1),
    status: body.status === "done" ? "done" : "todo",
    title: "",
    detail: "",
    owner: "",
    dueDate: "",
    meetingSource: "",
    confidenceLevel: "explicit",
    confidenceScore: 95,
    confidenceReason: "用户手动补充任务。",
    position,
    originalPosition: position,
    positionSource: "manual",
    positionUpdatedAt: now,
    designToken: { name: "待确认", value: "待确认" },
    createdAt: now,
    updatedAt: now
  };
  applyTaskFieldPatch(task, body);
  if (!task.title) task.title = "人工补充设计任务";
  if (!task.detail) task.detail = "请补充详细修改说明。";
  if (!task.owner) task.owner = "待定";
  if (!task.dueDate) task.dueDate = "待定";
  if (!task.meetingSource) task.meetingSource = "人工补充";
  return task;
}

function applyTaskFieldPatch(task, body) {
  if (!body || typeof body !== "object") return;
  if (Object.hasOwn(body, "title")) task.title = cleanText(body.title, 80);
  if (Object.hasOwn(body, "detail")) task.detail = cleanText(body.detail, 500);
  if (Object.hasOwn(body, "owner")) task.owner = cleanText(body.owner, 30) || "待定";
  if (Object.hasOwn(body, "dueDate")) task.dueDate = cleanText(body.dueDate, 30) || "待定";
  if (Object.hasOwn(body, "meetingSource")) task.meetingSource = cleanText(body.meetingSource, 300) || "人工补充";
  if (Object.hasOwn(body, "confidenceLevel")) {
    task.confidenceLevel = ["explicit", "suggested", "low"].includes(body.confidenceLevel) ? body.confidenceLevel : "explicit";
  }
  if (Object.hasOwn(body, "confidenceScore")) {
    task.confidenceScore = clamp(Math.round(Number(body.confidenceScore) || 95), 0, 100);
  }
  if (Object.hasOwn(body, "confidenceReason")) {
    task.confidenceReason = cleanText(body.confidenceReason, 120) || "用户手动补充任务。";
  }
  if (Object.hasOwn(body, "designToken") || Object.hasOwn(body, "designTokenName") || Object.hasOwn(body, "designTokenValue")) {
    task.designToken = normalizeEditableDesignToken(body, task.designToken);
  }
}

function normalizeEditableDesignToken(body, current = {}) {
  const token = body.designToken && typeof body.designToken === "object" ? body.designToken : {};
  return {
    name: cleanText(token.name ?? body.designTokenName ?? current.name ?? "待确认", 40) || "待确认",
    value: cleanText(token.value ?? body.designTokenValue ?? current.value ?? "待确认", 40) || "待确认"
  };
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function refreshProjectTaskArtifacts(project) {
  reindexTasks(project);
  project.markers = project.tasks.map((task) => ({
    id: task.markerId,
    taskId: task.id,
    x: task.position?.x,
    y: task.position?.y,
    positionSource: task.positionSource || "ai",
    status: task.status
  }));
  project.designTokens = Array.from(new Map([
    ...(project.designTokens || []),
    ...project.tasks.map((task) => task.designToken).filter(Boolean)
  ].map((token) => [token.name, token])).values())
    .filter((token) => token.name && token.name !== "待确认");
  project.chunks = buildChunks(project.meetingText || "", project.tasks);
  project.updatedAt = new Date().toISOString();
  await writeEmbeddings(project);
}

function reindexTasks(project) {
  project.tasks.forEach((task, index) => {
    task.markerId = String(index + 1);
  });
}

function normalizeMeetingSource(task, meetingText) {
  const source = String(task.meetingSource || "").trim();
  const lines = String(meetingText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return source.slice(0, 300);

  const exact = source && lines.find((line) => line.includes(source) || source.includes(line.slice(0, 40)));
  if (exact) return exact.slice(0, 300);

  const searchText = `${task.title || ""} ${task.detail || ""} ${source}`;
  const candidates = lines
    .map((line) => ({ line, score: scoreMeetingLine(searchText, line) }))
    .sort((a, b) => b.score - a.score);
  if (candidates[0]?.score > 0) return candidates[0].line.slice(0, 300);
  return (source || lines[0]).slice(0, 300);
}

function scoreMeetingLine(taskText, line) {
  const tokens = Array.from(new Set(String(taskText || "")
    .match(/#[0-9a-fA-F]{3,8}|[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_-]{2,}/g) || []))
    .filter((token) => !/会议|任务|修改|设计|需要|建议|这个|一下|当前/.test(token));
  return tokens.reduce((score, token) => score + (line.includes(token) ? token.length : 0), 0);
}

function normalizeDueDate(value, meetingSource = "") {
  const text = String(value || "");
  const iso = text.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/)?.[0];
  if (iso) return formatDateValue(iso);
  const chinese = text.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  if (chinese) return formatDateValue(chinese);

  const sourceDate = String(meetingSource || "").match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  if (/今天/.test(text) && sourceDate) return formatDateValue(sourceDate);
  if (/明天/.test(text) && sourceDate) return addDays(formatDateValue(sourceDate), 1);
  return text ? text.replace(/(下班前|之前|前|完成|改好|处理好).*/, "").trim() || "待定" : "待定";
}

function formatDateValue(value) {
  const parts = String(value).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/) || [];
  if (!parts.length) return String(value).slice(0, 10);
  return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function normalizeAnalysis(raw, meetingText) {
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const normalizedTasks = tasks.map((task, index) => {
    const markerId = String(index + 1);
    const confidence = normalizeTaskConfidence(task);
    const meetingSource = normalizeMeetingSource(task, meetingText);
    const dueDate = normalizeDueDate(task.dueDate, meetingSource);
    const normalizedTask = {
      id: createId("task"),
      markerId,
      status: "todo",
      title: String(task.title || `设计修改任务 ${index + 1}`).slice(0, 80),
      detail: String(task.detail || task.meetingSource || "待补充修改说明").slice(0, 500),
      owner: String(task.owner || "待定").slice(0, 30),
      dueDate,
      meetingSource,
      confidenceLevel: confidence.level,
      confidenceScore: confidence.score,
      confidenceReason: confidence.reason,
      position: normalizePosition(task.position, index),
      originalPosition: normalizePosition(task.originalPosition || task.position, index),
      positionSource: task.positionSource === "manual" ? "manual" : "ai",
      positionUpdatedAt: task.positionUpdatedAt || "",
      designToken: {
        name: String(task.designToken?.name || "待确认").slice(0, 40),
        value: String(task.designToken?.value || "待确认").slice(0, 40)
      },
      createdAt: new Date().toISOString()
    };
    normalizedTask.position = refinePositionBySemantics(normalizedTask, index);
    normalizedTask.originalPosition = normalizedTask.position;
    normalizedTask.positionSource = "ai";
    return normalizedTask;
  });
  const sanitizedTasks = sanitizeNormalizedTasks(normalizedTasks, meetingText);

  return {
    summary: `识别出 ${sanitizedTasks.length} 条待办修改任务。`,
    designTokens: Array.isArray(raw.designTokens) ? raw.designTokens : [],
    tasks: sanitizedTasks
  };
}

function sanitizeNormalizedTasks(tasks, meetingText) {
  const lines = String(meetingText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const clean = [];
  const seen = new Set();
  for (const task of tasks) {
    const text = `${task.title || ""} ${task.detail || ""} ${task.meetingSource || ""}`;
    if (isNonTaskMeetingLine(task.meetingSource || task.detail || task.title)) continue;
    if (!isActionableTaskText(text)) continue;
    const key = semanticTaskKey(task);
    if (seen.has(key)) continue;
    seen.add(key);
    const index = clean.length;
    const ownerSource = key === "status-column"
      ? `${task.meetingSource || ""} ${task.detail || ""}`
      : `${task.detail || ""} ${task.meetingSource || ""}`;
    task.owner = key === "status-column"
      ? extractOwner(ownerSource)
      : normalizeTaskOwner(task.owner, ownerSource);
    const dueDate = normalizeDueDate(task.dueDate, task.meetingSource);
    const inferredDueDate = inferDueDateFromNearbyLines(task.meetingSource || task.detail || "", lines);
    const speakerAckDueDate = inferSpeakerAckDueDate(task.owner, task.meetingSource || task.detail || "", lines);
    const commitmentDueDate = inferCommitmentDueDate(task, lines);
    const meetingNodeDate = task.meetingSource?.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
    const meetingNodeDateValue = meetingNodeDate ? formatDateValue(meetingNodeDate) : "";
    task.markerId = String(index + 1);
    task.dueDate = speakerAckDueDate !== "待定"
      ? speakerAckDueDate
      : commitmentDueDate !== "待定"
      ? commitmentDueDate
      : dueDate === "待定" || (dueDate === meetingNodeDateValue && inferredDueDate !== "待定")
        ? inferredDueDate
      : dueDate;
    task.position = refinePositionBySemantics(task, index);
    task.originalPosition = task.position;
    task.positionSource = "ai";
    clean.push(task);
  }
  addSupplementalTasks(clean, lines);
  clean.forEach((task, index) => {
    task.markerId = String(index + 1);
    task.position = refinePositionBySemantics(task, index);
    task.originalPosition = task.position;
    task.positionSource = "ai";
  });
  return clean;
}

function addSupplementalTasks(tasks, lines) {
  const specs = [
    {
      key: "api-secret-copy",
      pattern: /一键复制|复制.*icon|复制按钮|频繁复制/,
      title: "补充密钥一键复制入口"
    },
    {
      key: "flow-action-copy",
      pattern: /执行动作|系统更新通知|新人大礼包邮件|文案写错/,
      title: "修正执行动作节点文案"
    },
    {
      key: "knowledge-followup-folder",
      pattern: /后续运营|市场与销售支持/,
      title: "新增后续运营目录行"
    }
  ];
  for (const spec of specs) {
    if (tasks.some((task) => semanticTaskKey(task) === spec.key)) continue;
    const line = lines.find((item) => spec.pattern.test(item));
    if (!line || !isActionableMeetingLine(line)) continue;
    const index = tasks.length;
    const task = {
      id: createId("task"),
      markerId: String(index + 1),
      status: "todo",
      title: spec.title,
      detail: cleanupDetail(line),
      owner: normalizeTaskOwner(extractOwner(line), line),
      dueDate: inferDueDateFromNearbyLines(line, lines),
      meetingSource: line.slice(0, 300),
      confidenceLevel: "explicit",
      confidenceScore: 90,
      confidenceReason: "会议中包含明确 UI 对象和修改动作。",
      position: fallbackPosition(index),
      originalPosition: fallbackPosition(index),
      positionSource: "ai",
      positionUpdatedAt: "",
      designToken: extractToken(line),
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
  }
}

function inferSpeakerAckDueDate(owner, source, lines) {
  if (!owner || owner === "待定") return "待定";
  const needle = String(source || "").replace(/^[【\[].*?[】\]]\s*/, "").slice(0, 16);
  const sourceIndex = lines.findIndex((line) => needle && line.includes(needle));
  const candidates = sourceIndex >= 0 ? lines.slice(sourceIndex + 1, sourceIndex + 4) : lines;
  const ack = candidates.find((line) => {
    const content = line.replace(/^[【\[].*?[】\]]\s*/, "");
    return line.includes(owner)
      && /^收到[，,。.\s]/.test(content)
      && /(今天|明天|本周|周[一二三四五六日天])/.test(content)
      && /(改好|完成|处理好|跟进|负责)/.test(content);
  });
  return ack ? extractDueDate(ack) : "待定";
}

function inferCommitmentDueDate(task, lines) {
  const owner = normalizeTaskOwner(task.owner, `${task.detail || ""} ${task.meetingSource || ""}`);
  const ownerFamily = owner.match(/[\u4e00-\u9fa5]$/)?.[0];
  if (!ownerFamily || owner === "待定") return "待定";
  const sourceIndex = lines.findIndex((line) => {
    const needle = String(task.meetingSource || task.detail || "").replace(/^[【\[].*?[】\]]\s*/, "").slice(0, 16);
    return needle && line.includes(needle);
  });
  const candidates = sourceIndex >= 0 ? lines.slice(sourceIndex, sourceIndex + 4) : lines;
  const speakerCommitment = candidates.find((line) => {
    if (!line.includes(owner) && !line.includes(`小${ownerFamily}`) && !line.includes(ownerFamily)) return false;
    const content = line.replace(/^[【\[].*?[】\]]\s*/, "");
    return extractOwner(line) === owner
      && isAckOnlyContent(content)
      && /(今天|明天|本周|周[一二三四五六日天])/.test(content)
      && /(改好|完成|处理好|跟进|负责)/.test(content);
  });
  if (speakerCommitment) return extractDueDate(speakerCommitment);
  const commitment = candidates.find((line) => {
    if (!line.includes(owner) && !line.includes(`小${ownerFamily}`) && !line.includes(ownerFamily)) return false;
    const content = line.replace(/^[【\[].*?[】\]]\s*/, "");
    const ownerNearDate = new RegExp(`${escapeRegExp(owner)}[\\s，,]*(你|负责|来|把|去)?[^。；\\n]{0,16}(今天|明天|本周|周[一二三四五六日天])`).test(content);
    return ownerNearDate && /(改好|完成|处理好|跟进|负责)/.test(content);
  });
  return commitment ? extractDueDate(commitment) : "待定";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isActionableTaskText(text) {
  const value = String(text || "");
  if (/金额格式确实必须严谨/.test(value) && !/(补上|加一条|选中态|下划线)/.test(value)) return false;
  const hasAction = /(把|将|给|需要|请|改成|改为|换成|替换|定义|调整|优化|增加|新增|添加|补充|补上|统一|修复|对齐|降低|提高|加一列|加一行|加一条|加一个|加上)/.test(value);
  const hasUiObject = /(按钮|新增用户|状态|账号状态|系统角色|操作列|导航|菜单|设置|系统操作日志|头像|图表|筛选|背景|颜色|色值|卡片|指标卡片|金额|人民币|符号|阶段|进度条|商务谈判|Tabs?|页签|报价明细|密钥|Secret\s*Key|Key|复制|横幅|警告|三角形|触发器|Trigger|节点|流程|虚线|执行动作|Action|菱形|里程碑|时间轴|文件夹|目录|列表|表格|列|行|入口|文案|间距|动效|页面|UI|界面)/i.test(value);
  return hasAction && hasUiObject;
}

function retrieveContext(project, message) {
  const query = tokenize(message);
  const pool = [
    ...(project.chunks || []),
    ...project.tasks.map((task) => ({
      type: "task",
      id: task.id,
      text: `任务 ${task.markerId}：${task.title}。${task.detail}。负责人：${task.owner}。截止日期：${task.dueDate}。可信度：${task.confidenceLevel || "suggested"} ${task.confidenceScore || ""}。判断原因：${task.confidenceReason || ""}。设计 token：${task.designToken?.name || ""} ${task.designToken?.value || ""}`
    }))
  ];
  return pool
    .map((item) => ({ ...item, score: scoreText(query, item.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function answerLocally(project, message, context) {
  const text = message.toLowerCase();
  const contextTasks = context
    .filter((item) => item.type === "task")
    .map((item) => project.tasks.find((task) => task.id === item.id))
    .filter(Boolean);
  const ownerMatch = message.match(/小[\u4e00-\u9fa5]|张[\u4e00-\u9fa5]|李[\u4e00-\u9fa5]|王[\u4e00-\u9fa5]/)?.[0];
  const ownerTasks = ownerMatch ? project.tasks.filter((task) => task.owner?.includes(ownerMatch)) : [];
  const relatedTasks = ownerTasks.length ? ownerTasks : contextTasks;
  const colorToken = project.designTokens?.find((token) => /色|颜色|背景|color|hex|#[0-9a-f]{3,6}/i.test(`${message} ${token.name} ${token.value}`));

  if (/色|颜色|背景|color|hex/.test(text) && colorToken) {
    return {
      answer: [
        `- [Task-${relatedTasks[0]?.markerId || 1}] 将相关颜色调整为 **${colorToken.value}**。`,
        `- 结果：提升对比度，降低深色模式下的视觉疲劳。`,
        `会议节点溯源：${extractMeetingTimes(relatedTasks, context)}`
      ].join("\n"),
      citations: context
    };
  }

  if (relatedTasks.length) {
    const ownerPrefix = ownerMatch ? `${ownerMatch}当前需要处理的任务共有 ${relatedTasks.length} 个：` : `当前相关待办共有 ${relatedTasks.length} 个：`;
    const lines = [ownerPrefix];
    for (const task of relatedTasks) {
      lines.push(`- [Task-${task.markerId}] ${task.title}：${summarizeTaskDetail(task.detail)}`);
    }
    lines.push(`会议节点溯源：${extractMeetingTimes(relatedTasks, context)}`);
    return {
      answer: lines.join("\n"),
      citations: context
    };
  }

  return {
    answer: [
      "- 暂未找到直接对应的任务。",
      "- 建议先查看待办事项列表中的相关 UI 元素。",
      `会议节点溯源：${extractMeetingTimes([], context)}`
    ].join("\n"),
    citations: context
  };
}

function summarizeTaskDetail(detail) {
  return String(detail || "按会议要求处理。")
    .replace(/^要求[:：]\s*/, "")
    .slice(0, 80);
}

function extractMeetingTimes(tasks, context) {
  const text = [
    ...tasks.map((task) => task.meetingSource || ""),
    ...context.map((item) => item.text || "")
  ].join("\n");
  const times = Array.from(new Set(extractMeetingNodes(text)));
  return times.length ? times.slice(0, 4).join("、") : "会议记录";
}

function extractMeetingNodes(text) {
  const source = String(text || "");
  const full = source.match(/20\d{2}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/g) || [];
  if (full.length) return full;
  const date = source.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  const times = source.match(/\d{1,2}:\d{2}/g) || [];
  if (date && times.length) return times.map((time) => `${date} ${time}`);
  return times;
}

function extractMeetingNodeText(text) {
  return extractMeetingNodes(text)[0] || "";
}

async function saveUpload(body) {
  const projectId = body.projectId || createId("project");
  let project = await readProject(projectId);
  if (!project) project = await createProject(projectId);

  if (!body.meetingText?.trim()) {
    const error = new Error("meetingText is required");
    error.status = 400;
    throw error;
  }
  if (!body.imageDataUrl?.startsWith("data:image/")) {
    const error = new Error("imageDataUrl is required");
    error.status = 400;
    throw error;
  }
  if (body.imageDataUrl.length > 10 * 1024 * 1024) {
    const error = new Error("图片过大，请控制在 8MB 左右");
    error.status = 413;
    throw error;
  }

  const match = body.imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Invalid image data url");
    error.status = 400;
    throw error;
  }

  const ext = mimeToExt(match[1]);
  const fileName = `${project.id}.${ext}`;
  await fs.writeFile(path.join(UPLOADS_DIR, fileName), Buffer.from(match[2], "base64"));

  project.imageName = body.imageName || fileName;
  project.imageUrl = `/uploads/${fileName}`;
  project.imageMime = match[1];
  project.meetingText = body.meetingText;
  project.tasks = [];
  project.markers = [];
  project.messages = [];
  project.updatedAt = new Date().toISOString();
  await writeProject(project);
  return { project };
}

async function createProject(existingId) {
  const project = {
    id: existingId || createId("project"),
    name: "DesignNote AI MVP 演示项目",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    imageName: "",
    imageUrl: "",
    imageMime: "",
    meetingText: "",
    summary: "",
    provider: "",
    designTokens: [],
    tasks: [],
    markers: [],
    chunks: [],
    messages: []
  };
  await writeProject(project);
  return project;
}

async function appendMessage(project, user, assistant, citations) {
  const latest = await readProject(project.id);
  latest.messages.push({
    id: createId("msg"),
    user,
    assistant,
    citations,
    createdAt: new Date().toISOString()
  });
  await writeProject(latest);
}

function buildChunks(meetingText, tasks) {
  const chunks = meetingText
    .split(/\r?\n+/)
    .map((line, index) => line.trim() && ({ type: "meeting", id: `meeting-${index + 1}`, text: line.trim() }))
    .filter(Boolean);
  for (const task of tasks) {
    chunks.push({ type: "task", id: task.id, text: `${task.title}：${task.detail} 来源：${task.meetingSource}` });
  }
  return chunks;
}

async function writeEmbeddings(project) {
  await fs.writeFile(path.join(EMBEDDINGS_DIR, `${project.id}.json`), JSON.stringify({
    projectId: project.id,
    model: getActiveProvider() === "openai" ? OPENAI_EMBEDDING_MODEL : "local-keyword",
    chunks: project.chunks
  }, null, 2), "utf8");
}

async function readImageAsDataUrl(project) {
  const filePath = path.join(UPLOADS_DIR, path.basename(project.imageUrl));
  const buffer = await fs.readFile(filePath);
  return `data:${project.imageMime || contentType(filePath)};base64,${buffer.toString("base64")}`;
}

async function readProject(projectId) {
  try {
    const file = await fs.readFile(path.join(PROJECTS_DIR, `${projectId}.json`), "utf8");
    return JSON.parse(file);
  } catch {
    return null;
  }
}

async function writeProject(project) {
  await fs.writeFile(path.join(PROJECTS_DIR, `${project.id}.json`), JSON.stringify(project, null, 2), "utf8");
}

async function ensureDirs() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(EMBEDDINGS_DIR, { recursive: true });
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.set(jobId, { ...job, ...patch, updatedAt: new Date().toISOString() });
}

function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    return;
  }
}

async function serveFile(res, filePath, type) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

function sendJson(res, status, payload) {
  const code = payload?.error && payload.status ? payload.status : status;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function mimeToExt(mime) {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function getActiveProvider() {
  const preferred = (process.env.AI_PROVIDER || "").toLowerCase();
  if (preferred === "demo") return "demo";
  if (preferred === "aihubmix" && process.env.AIHUBMIX_API_KEY) return "aihubmix";
  if (preferred === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (preferred === "deepseek" && process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.AIHUBMIX_API_KEY) return "aihubmix";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  return "demo";
}

function getActiveModel() {
  const provider = getActiveProvider();
  if (provider === "openai") return OPENAI_MODEL;
  if (provider === "aihubmix") return AIHUBMIX_MODEL;
  if (provider === "deepseek") return DEEPSEEK_MODEL;
  return "local-demo";
}

function authorizeRequest(req, res, url) {
  if (!APP_PASSWORD) return true;
  if (url.pathname === "/api/health") return true;

  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Basic" && token) {
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const username = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      if (username === APP_USERNAME && password === APP_PASSWORD) return true;
    } catch {
      // Fall through to auth challenge.
    }
  }

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="DesignNote AI"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("请输入 DesignNote AI 访问账号和密码。");
  return false;
}

function parseJsonObject(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AI response is not valid JSON");
  }
}

function extractOwner(line) {
  const assignee = String(line || "").match(/(小[\u4e00-\u9fa5]|张[\u4e00-\u9fa5]|李[\u4e00-\u9fa5]|王[\u4e00-\u9fa5])[\s，,。]*(你|负责|来|把|去)/);
  if (assignee) return assignee[1];
  const bracket = line.match(/[【\[]([^】\]]+)[】\]]/);
  if (bracket) return bracket[1].replace(/20\d{2}年\d{1,2}月\d{1,2}日.*$/, "").replace(/会议|设计|产品|前端|工程|经理|主管|负责人|发言人/g, "").trim() || bracket[1].trim();
  const owner = line.match(/(小[\u4e00-\u9fa5]|张[\u4e00-\u9fa5]|李[\u4e00-\u9fa5]|王[\u4e00-\u9fa5]|前端工程师|UI设计师|产品经理|设计主管)/);
  return owner ? owner[1] : "待定";
}

function normalizeTaskOwner(owner, text) {
  if (/^(小[\u4e00-\u9fa5]|张[\u4e00-\u9fa5]|李[\u4e00-\u9fa5]|王[\u4e00-\u9fa5])$/.test(String(owner || ""))) {
    return owner;
  }
  const inferred = extractOwner(text);
  if (inferred && inferred !== "待定") return inferred;
  return String(owner || "待定").slice(0, 30);
}

function extractDueDate(line) {
  const content = String(line || "").replace(/^[【\[].*?[】\]]\s*/, "");
  const explicitDate = content.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/);
  if (explicitDate) return formatDateValue(explicitDate[0]);
  const sourceDate = line.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  if (/今天/.test(content) && sourceDate) return formatDateValue(sourceDate);
  if (/明天/.test(content) && sourceDate) return addDays(formatDateValue(sourceDate), 1);
  if (/今天/.test(content)) return "今天";
  if (/明天/.test(content)) return "明天";
  if (/本周|周五|周四|周三|周二|周一/.test(content)) return content.match(/本周|周五|周四|周三|周二|周一/)?.[0] || "本周";
  return "待定";
}

function extractToken(line) {
  const hex = line.match(/#[0-9a-fA-F]{3,8}/);
  if (hex) return { name: /背景/.test(line) ? "背景色" : "颜色 token", value: hex[0] };
  if (/圆角/.test(line)) return { name: "圆角", value: "待确认" };
  if (/间距|偏移|px/.test(line)) {
    const px = line.match(/\d+\s*px/i);
    return { name: "间距/偏移", value: px ? px[0].replace(/\s+/g, "") : "待确认" };
  }
  if (/按钮|CTA/.test(line)) return { name: "按钮样式", value: "待确认" };
  return { name: "待确认", value: "待确认" };
}

function buildTitle(line, index) {
  const clean = line.replace(/[【\[].*?[】\]]/g, "").trim();
  if (/商务谈判|第三阶段|数字\s*3|阶段进度|进度条|圆形图标/.test(clean)) return "突出当前商务谈判阶段";
  if (/报价明细|Tabs?|页签|Tab\s*栏|选中态.*下划线|下划线.*选中态/.test(clean)) return "补齐报价明细页签选中态";
  if (/预计销售金额|450,?000|人民币|¥|指标卡片|补上.*符号/.test(clean)) return "补充预计销售金额人民币符号";
  if (/文件夹|V3\.0|商业化重构/.test(clean) && /展开|打开|替换|图标/.test(clean)) return "修正展开态文件夹图标";
  if (/后续运营|市场与销售支持/.test(clean) && /新增|补充|加一行|再加一行|目录行|下面/.test(clean)) return "新增后续运营目录行";
  if (/内部知识库/.test(clean) && /新建|快捷入口|表头|\+/.test(clean)) return "补充知识库新建快捷入口";
  if (/Secret\s*Key|默认应用密钥|密钥字符串|脱敏|星号|小眼睛|明文/.test(clean)) return "密钥默认脱敏并补充查看入口";
  if (/一键复制|复制.*icon|复制按钮|Key.*复制|密钥框.*右侧|频繁复制/.test(clean)) return "补充密钥一键复制入口";
  if (/API.*泄露|高危|提示横幅|警告三角|视觉警示|浅红|浅橙/.test(clean)) return "强化 API 泄露风险提示";
  if (/触发器|Trigger/.test(clean) && /图标|紫色|#722ED1|源头/.test(clean)) return "调整触发器节点图标颜色";
  if (/结束流程|断掉|虚线末端|死胡同|闭环|右下方空白/.test(clean)) return "补充结束流程节点";
  if (/执行动作|Action|系统更新通知|新人大礼包邮件|文案写错/.test(clean)) return "修正执行动作节点文案";
  if (/新增用户|主按钮|按钮|CTA/.test(clean)) return /新增用户/.test(clean) ? "新增用户按钮样式调整" : "主按钮样式与位置调整";
  if (/账号状态|状态.*列|系统角色.*操作|加一列.*状态/.test(clean)) return "补充账号状态列";
  if (/设置/.test(clean) && /系统操作日志|导航|左边|左侧/.test(clean)) return "左侧导航新增设置入口";
  if (/背景|颜色|色值/.test(clean)) return "背景颜色与对比度优化";
  if (/导航|动效|展开/.test(clean)) return "导航栏展开动效补齐";
  if (/对齐|偏移/.test(clean)) return "界面对齐问题修复";
  return clean.slice(0, 18) || `设计修改任务 ${index + 1}`;
}

function cleanupDetail(line) {
  return line.replace(/\s+/g, " ").slice(0, 240);
}

function fallbackPosition(index) {
  const positions = [
    { x: 24, y: 22 },
    { x: 45, y: 34 },
    { x: 58, y: 61 },
    { x: 71, y: 42 },
    { x: 36, y: 72 },
    { x: 64, y: 24 }
  ];
  return positions[index % positions.length];
}

function normalizePosition(position, index) {
  return {
    x: clamp(Number(position?.x) || fallbackPosition(index).x, 8, 92),
    y: clamp(Number(position?.y) || fallbackPosition(index).y, 8, 92)
  };
}

function normalizeManualPosition(position) {
  return {
    x: clamp(Number(position?.x) || 50, 4, 96),
    y: clamp(Number(position?.y) || 50, 4, 96)
  };
}

function syncProjectMarker(project, task) {
  if (!Array.isArray(project.markers)) project.markers = [];
  const marker = project.markers.find((item) => item.taskId === task.id || item.id === task.markerId);
  const payload = {
    id: task.markerId,
    taskId: task.id,
    x: task.position?.x,
    y: task.position?.y,
    positionSource: task.positionSource || "ai",
    status: task.status
  };
  if (marker) {
    Object.assign(marker, payload);
  } else {
    project.markers.push(payload);
  }
}

function refinePositionBySemantics(task, index) {
  const text = `${task.title || ""} ${task.detail || ""} ${task.meetingSource || ""}`;
  if (/补充密钥一键复制入口/.test(task.title || "")) {
    return { x: 31.6, y: 48.8 };
  }
  if (/补充结束流程节点/.test(task.title || "")) {
    return { x: 61.8, y: 48.0 };
  }
  if (/修正执行动作节点文案/.test(task.title || "")) {
    return { x: 74.2, y: 21.6 };
  }
  if (/补充知识库新建快捷入口|新建.*全局快捷入口|\+\s*新建.*快捷入口/.test(task.title || "")) {
    return { x: 24.6, y: 5.8 };
  }
  if (/新增后续运营目录行/.test(task.title || "") || (/后续运营|市场与销售支持/.test(text) && /新增|补充|加一行|再加一行|目录行|下面/.test(text))) {
    return { x: 7.4, y: 52.8 };
  }
  if (/API.*泄露|高危|提示横幅|警告三角|视觉警示|浅红|浅橙/.test(text)) {
    return { x: 21.6, y: 16.4 };
  }
  if (/一键复制|复制.*icon|复制按钮|Key.*复制|密钥框.*右侧/.test(text)) {
    return { x: 31.6, y: 48.8 };
  }
  if (/Secret\s*Key|默认应用密钥|密钥字符串|脱敏|星号|小眼睛|明文/.test(text)) {
    return { x: 20.4, y: 48.8 };
  }
  if (/触发器|Trigger/.test(text) && /图标|紫色|#722ED1|源头/.test(text)) {
    return { x: 14.9, y: 28.2 };
  }
  if (/执行动作|Action|系统更新通知|新人大礼包邮件|文案写错/.test(text)) {
    return { x: 74.2, y: 21.6 };
  }
  if (/结束流程|断掉|虚线末端|死胡同|闭环|右下方空白/.test(text)) {
    return { x: 61.8, y: 48.0 };
  }
  if (/商务谈判|第三阶段|数字\s*3|带数字\s*3|当前阶段|阶段进度|进度条|圆形图标/.test(text)) {
    return { x: 50.9, y: 24.0 };
  }
  if (/报价明细|Tabs?|页签|Tab\s*栏|选中态.*下划线|下划线.*选中态/.test(text)) {
    return { x: 24.0, y: 57.9 };
  }
  if (/预计销售金额|450,?000|人民币|¥|金额格式|指标卡片|漏了.*符号|补上.*符号/.test(text)) {
    return { x: 8.2, y: 45.8 };
  }
  if (/后端\s*API\s*开发|老赵|问号|虚线圈/.test(text) && /头像|负责人|指派|分配/.test(text)) {
    return { x: 21.4, y: 35.6 };
  }
  if (/UI\s*界面设计|蓝条|横条|6月5|6 月 5|截止时间|往左缩短/.test(text) && /甘特|时间轴|排期|缩短|截止/.test(text)) {
    return { x: 62.5, y: 26.8 };
  }
  if (/Beta|准入|里程碑|菱形|6月10|6 月 10/.test(text)) {
    return { x: 75.2, y: 11.3 };
  }
  if (/(VIP|战略客户|亮金|深橙)/.test(text) && /标签/.test(text)) {
    return { x: 6.4, y: 31.6 };
  }
  if (/跟进记录/.test(text) && /筛选|下拉|电话|会议|邮件|过滤/.test(text)) {
    return { x: 36.9, y: 15.1 };
  }
  if (/关联商机|Deals/.test(text) && /新建商机|\+ 新建|文字按钮|快捷操作/.test(text)) {
    return { x: 95.4, y: 15.1 };
  }
  if (/V3\.0|商业化重构/.test(text) && /展开|打开的文件夹|文件夹图标|图标状态/.test(text)) {
    return { x: 7.3, y: 29.8 };
  }
  if (/内部知识库/.test(text) && /新建|快捷入口|表头|右侧|\+/.test(text)) {
    return { x: 24.6, y: 5.8 };
  }
  if (/新增用户|主按钮|按钮/.test(text) && /品牌主色|#1677FF|实心按钮|线框|层级/.test(text)) {
    return { x: 93.2, y: 17.6 };
  }
  if (/账号状态|状态.*列|系统角色.*操作|状态字段|加一列.*状态/.test(text)) {
    return { x: 73.2, y: 24.7 };
  }
  if (/设置/.test(text) && /系统操作日志|操作日志|日志|左边导航栏|左侧导航|导航栏/.test(text)) {
    return { x: 5.8, y: 43.4 };
  }
  if (/已完成|Done/.test(text) && /背景|浅绿|浅灰|#EBECF0|列/.test(text)) {
    return { x: 91.2, y: 16.2 };
  }
  if (/待处理|To Do/.test(text) && /快捷|创建|添加|\+|入口|表头/.test(text)) {
    return { x: 27.2, y: 16.2 };
  }
  if (/任务卡片|白色.*卡片|卡片/.test(text) && /负责人|头像|20px|右下角/.test(text)) {
    return { x: 27.2, y: 28.7 };
  }
  if (/筛选|近7天|近30天|图表|折线|访问趋势|时间/i.test(text)) {
    return { x: 78, y: 31 };
  }
  if (/头像|用户头像|个人头像|avatar/i.test(text)) {
    return { x: 91, y: 8.5 };
  }
  if (/导航|菜单|选中态|客户数据看板|侧边栏|左侧/i.test(text)) {
    return { x: 16, y: 21 };
  }
  return normalizePosition(task.position, index);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[\u4e00-\u9fa5]{1,2}|[a-z0-9#]+/g) || [];
}

function scoreText(query, text) {
  const haystack = String(text).toLowerCase();
  return query.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}
