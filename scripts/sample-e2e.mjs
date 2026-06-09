import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PORT = 3147;
const base = `http://localhost:${PORT}`;
const repoRoot = new URL("..", import.meta.url);
const sampleDir = "F:\\B端AI产品项目\\DesignNote AI 项目\\2026.5.27 尝试\\模拟的UI和会议记录";
const imagePath = path.join(sampleDir, "Gemini_Generated_Image_2srp982srp982srp.png");
const meetingPath = path.join(sampleDir, "会议记录.txt");

const server = spawn(process.execPath, ["server.js"], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForServer();
  const [image, meetingText] = await Promise.all([
    readFile(imagePath),
    readFile(meetingPath, "utf8")
  ]);
  const imageDataUrl = `data:image/png;base64,${image.toString("base64")}`;

  const project = await json("/api/projects", { method: "POST" });
  await json("/api/uploads", {
    method: "POST",
    body: {
      projectId: project.project.id,
      imageName: path.basename(imagePath),
      imageDataUrl,
      meetingText
    }
  });

  const analyze = await json("/api/analyze", {
    method: "POST",
    body: { projectId: project.project.id }
  });

  let job;
  do {
    await wait(900);
    job = await json(`/api/jobs/${analyze.jobId}`);
  } while (["queued", "processing"].includes(job.job.status));

  const result = await json(`/api/projects/${project.project.id}`);
  const chat = await json("/api/chat", {
    method: "POST",
    body: {
      projectId: project.project.id,
      message: "这次会议一共有哪些待办？右上角头像和图表区域分别要改什么？"
    }
  });

  const payload = {
    provider: result.project.provider,
    status: job.job.status,
    taskCount: result.project.tasks.length,
    titles: result.project.tasks.map((task) => task.title),
    owners: result.project.tasks.map((task) => task.owner),
    answer: chat.answer
  };
  console.log(JSON.stringify(payload, null, 2));

  if (job.job.status !== "done") throw new Error("Analysis job did not finish");
  if (!["deepseek", "aihubmix", "openai"].includes(result.project.provider)) {
    throw new Error(`Expected real AI provider, got ${result.project.provider}`);
  }
  if (result.project.tasks.length < 3) throw new Error(`Expected at least 3 tasks, got ${result.project.tasks.length}`);
  if (!chat.answer?.trim()) throw new Error("Chat answer is empty");
} finally {
  server.kill();
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      await json("/api/health");
      return;
    } catch {
      await wait(300);
    }
  }
  throw new Error("Server did not start");
}

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
