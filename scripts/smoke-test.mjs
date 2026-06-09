import { spawn } from "node:child_process";

const PORT = 3137;
const base = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, AI_PROVIDER: "demo", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const meetingText = [
  "【UI设计师 小明 15:30】导航栏展开动画缺失，需要增加 300ms ease-in-out 过渡动效。",
  "【设计主管 15:50】背景色太刺眼，主色需要改成 #1A3DB8。",
  "【前端 小李 16:10】主操作按钮没有完全居中，偏了 2px，我来修复 justify-content。"
].join("\n");

try {
  await waitForServer();
  const project = await json("/api/projects", { method: "POST" });
  await json("/api/uploads", {
    method: "POST",
    body: {
      projectId: project.project.id,
      imageName: "tiny.png",
      imageDataUrl: tinyPng,
      meetingText
    }
  });
  const analyze = await json("/api/analyze", {
    method: "POST",
    body: { projectId: project.project.id }
  });

  let job;
  do {
    await wait(700);
    job = await json(`/api/jobs/${analyze.jobId}`);
  } while (["queued", "processing"].includes(job.job.status));

  const result = await json(`/api/projects/${project.project.id}`);
  const chat = await json("/api/chat", {
    method: "POST",
    body: { projectId: project.project.id, message: "背景色的色值是多少？" }
  });

  console.log(JSON.stringify({
    status: job.job.status,
    taskCount: result.project.tasks.length,
    titles: result.project.tasks.map((task) => task.title),
    chatAnswer: chat.answer
  }, null, 2));

  if (job.job.status !== "done") throw new Error("Analysis job did not finish");
  if (result.project.tasks.length !== 3) throw new Error(`Expected 3 dynamic tasks, got ${result.project.tasks.length}`);
  if (!chat.answer) throw new Error("Chat answer is empty");
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
