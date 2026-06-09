const state = {
  project: null,
  imageDataUrl: "",
  imageName: "",
  selectedTaskId: "",
  activeMarkerTaskId: "",
  markersVisible: true,
  statusFilter: "all",
  ownerFilter: "all",
  polling: null,
  dragMarker: null,
  resolvedPositions: {},
  taskFormMode: "create",
  editingTaskId: ""
};

const els = {
  imageInput: document.querySelector("#imageInput"),
  imagePreview: document.querySelector("#imagePreview"),
  canvasImage: document.querySelector("#canvasImage"),
  emptyPreview: document.querySelector("#emptyPreview"),
  uploadStatus: document.querySelector("#uploadStatus"),
  meetingText: document.querySelector("#meetingText"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  markersLayer: document.querySelector("#markersLayer"),
  markerCard: document.querySelector("#markerCard"),
  taskRows: document.querySelector("#taskRows"),
  taskProgress: document.querySelector("#taskProgress"),
  taskConfidenceStats: document.querySelector("#taskConfidenceStats"),
  taskProgressBar: document.querySelector("#taskProgressBar"),
  statusFilter: document.querySelector("#statusFilter"),
  ownerFilter: document.querySelector("#ownerFilter"),
  jobOverlay: document.querySelector("#jobOverlay"),
  jobTitle: document.querySelector("#jobTitle"),
  jobMessage: document.querySelector("#jobMessage"),
  progressBar: document.querySelector("#progressBar"),
  canvasEmpty: document.querySelector("#canvasEmpty"),
  toggleMarkersBtn: document.querySelector("#toggleMarkersBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  chatMessages: document.querySelector("#chatMessages"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  providerHint: document.querySelector("#providerHint"),
  addTaskBtn: document.querySelector("#addTaskBtn"),
  taskFormOverlay: document.querySelector("#taskFormOverlay"),
  taskForm: document.querySelector("#taskForm"),
  taskFormTitle: document.querySelector("#taskFormTitle"),
  closeTaskFormBtn: document.querySelector("#closeTaskFormBtn"),
  cancelTaskFormBtn: document.querySelector("#cancelTaskFormBtn")
};

const demoText = [
  "【会议主持人 小明 15:30】大家看一下新版的首页设计。首先，左侧导航栏的交互有点生硬，展开的时候缺了动效，老王这块你补一个 300ms 的过渡动画。",
  "【产品经理 15:45】我觉得整个界面的颜色，尤其是背景的品牌蓝在深色模式下太刺眼了，对比度不够。",
  "【设计主管 15:50】同意，小明你把主色调加深一下，色值改成 #1A3DB8，符合无障碍标准。",
  "【前端 小李 16:10】我发现中间那个主操作按钮好像没有完全居中对齐，按钮偏了大概 2px，小李我来调一下 justify-content 属性。"
].join("\n\n");

init();

async function init() {
  bindEvents();
  const savedId = localStorage.getItem("designnote_project_id");
  if (savedId) {
    const loaded = await fetchJson(`/api/projects/${savedId}`).catch(() => null);
    if (loaded?.project) {
      state.project = loaded.project;
      hydrateProject();
      return;
    }
  }
  const { project } = await fetchJson("/api/projects", { method: "POST" });
  state.project = project;
  localStorage.setItem("designnote_project_id", project.id);
  els.meetingText.value = "";
  updateWorkflowState();
  updateChatAvailability();
}

function bindEvents() {
  els.imageInput.addEventListener("change", handleImage);
  els.meetingText.addEventListener("input", updateWorkflowState);
  els.canvasImage.addEventListener("load", () => {
    syncMarkersFrame();
    renderMarkers();
  });
  window.addEventListener("resize", () => {
    syncMarkersFrame();
    renderMarkers();
    renderMarkerCard();
  });
  document.querySelector("#canvas").addEventListener("click", (event) => {
    if (!event.target.closest(".marker") && !event.target.closest(".marker-card")) {
      closeMarkerCard();
    }
  });
  els.analyzeBtn.addEventListener("click", analyze);
  els.statusFilter.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.statusFilter = button.dataset.status;
      els.statusFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
      renderTasks();
    });
  });
  els.ownerFilter.addEventListener("change", () => {
    state.ownerFilter = els.ownerFilter.value;
    renderTasks();
  });
  els.addTaskBtn.addEventListener("click", () => openTaskForm());
  els.closeTaskFormBtn.addEventListener("click", closeTaskForm);
  els.cancelTaskFormBtn.addEventListener("click", closeTaskForm);
  els.taskFormOverlay.addEventListener("click", (event) => {
    if (event.target === els.taskFormOverlay) closeTaskForm();
  });
  els.taskForm.addEventListener("submit", saveTaskForm);
  els.toggleMarkersBtn.addEventListener("click", () => {
    state.markersVisible = !state.markersVisible;
    els.markersLayer.classList.toggle("hidden", !state.markersVisible);
    els.toggleMarkersBtn.textContent = state.markersVisible ? "隐藏标注" : "显示标注";
  });
  els.resetBtn.addEventListener("click", () => {
    localStorage.removeItem("designnote_project_id");
    location.reload();
  });
  els.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = els.chatInput.value.trim();
    if (!message) return;
    els.chatInput.value = "";
    await ask(message);
  });
  document.querySelectorAll(".prompt").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.project?.tasks?.length) return;
      ask(button.textContent.trim());
    });
  });
  updateWorkflowState();
}

async function loadSample() {
  const [meetingResponse, imageResponse] = await Promise.all([
    fetch("/samples/customer-dashboard-meeting.txt"),
    fetch("/samples/customer-dashboard.png")
  ]);
  const meetingText = await meetingResponse.text();
  const imageBlob = await imageResponse.blob();
  const imageDataUrl = await blobToDataUrl(imageBlob);
  state.imageName = "customer-dashboard.png";
  state.imageDataUrl = imageDataUrl;
  els.meetingText.value = meetingText.trim();
  showImage(imageDataUrl);
  els.uploadStatus.textContent = "已载入样例";
}

function handleImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  state.imageName = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    state.imageDataUrl = reader.result;
    showImage(state.imageDataUrl);
    els.uploadStatus.textContent = "已上传";
    updateWorkflowState();
  };
  reader.readAsDataURL(file);
}

async function analyze() {
  const meetingText = els.meetingText.value.trim();
  if (!state.imageDataUrl && !state.project?.imageUrl) {
    alert("请先上传一张 UI 设计稿。");
    return;
  }
  if (!meetingText) {
    alert("请先粘贴会议讨论记录。");
    return;
  }

  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "解析中...";
  showJob({ progress: 6, message: "正在上传会议材料" });

  try {
    const upload = await fetchJson("/api/uploads", {
      method: "POST",
      body: {
        projectId: state.project.id,
        imageName: state.imageName || state.project.imageName || "design.png",
        imageDataUrl: state.imageDataUrl || await imageUrlToDataUrl(state.project.imageUrl),
        meetingText
      }
    });
    state.project = upload.project;
    const { jobId } = await fetchJson("/api/analyze", {
      method: "POST",
      body: { projectId: state.project.id }
    });
    pollJob(jobId);
  } catch (error) {
    hideJob();
    alert(error.message || "解析失败，请检查输入。");
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "开始智能解析";
  }
}

function pollJob(jobId) {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    const { job } = await fetchJson(`/api/jobs/${jobId}`);
    showJob(job);
    if (job.status === "done") {
      clearInterval(state.polling);
      const { project } = await fetchJson(`/api/projects/${job.projectId}`);
      state.project = project;
      hydrateProject();
      hideJob();
      addAiMessage(`解析完成，我根据会议文本实际识别出 ${project.tasks.length} 条待办修改任务，并已映射到设计画布。`);
      els.analyzeBtn.disabled = false;
      els.analyzeBtn.textContent = "重新智能解析";
    }
    if (job.status === "failed") {
      clearInterval(state.polling);
      hideJob();
      alert(job.error || "解析失败");
      els.analyzeBtn.disabled = false;
      els.analyzeBtn.textContent = "开始智能解析";
    }
  }, 700);
}

function hydrateProject() {
  localStorage.setItem("designnote_project_id", state.project.id);
  els.meetingText.value = state.project.meetingText || els.meetingText.value || "";
  if (state.project.imageUrl) {
    els.imagePreview.src = state.project.imageUrl;
    els.imagePreview.style.display = "block";
    els.emptyPreview.style.display = "none";
    els.canvasImage.src = state.project.imageUrl;
    els.canvasImage.style.display = "block";
    els.canvasEmpty.style.display = "none";
    els.uploadStatus.textContent = "已上传";
    requestAnimationFrame(() => {
      syncMarkersFrame();
      renderMarkers();
    });
  }
  els.providerHint.textContent = state.project.provider === "openai" ? "GPT 实时解析" : state.project.provider === "aihubmix" ? "GPT-5.5 实时解析" : state.project.provider === "deepseek" ? "DeepSeek 实时解析" : state.project.provider === "demo" ? "演示兜底解析" : "等待解析当前会议材料";
  updateOwnerFilter();
  updateWorkflowState();
  updateChatAvailability();
  renderTasks();
  renderMarkers();
}

function showImage(src) {
  els.imagePreview.src = src;
  els.imagePreview.style.display = "block";
  els.emptyPreview.style.display = "none";
  els.canvasImage.src = src;
  els.canvasImage.style.display = "block";
  els.canvasEmpty.style.display = "none";
  updateWorkflowState();
  requestAnimationFrame(() => {
    syncMarkersFrame();
    renderMarkers();
  });
}

function renderTasks() {
  const tasks = state.project?.tasks || [];
  const done = tasks.filter((task) => task.status === "done").length;
  const total = tasks.length;
  const percent = total ? Math.round(done / total * 100) : 0;
  els.taskProgress.textContent = `进度：${done} / ${tasks.length}`;
  els.taskProgressBar.style.width = `${percent}%`;
  renderConfidenceStats(tasks);

  const filteredTasks = filterTasks(tasks);
  if (!tasks.length) {
    els.taskRows.innerHTML = `<div class="task-row empty-task-row"><span></span><span></span><div><h3>等待解析</h3><p>上传设计稿和会议记录后，AI 会根据实际待办数量生成任务。</p></div></div>`;
    return;
  }
  if (!filteredTasks.length) {
    els.taskRows.innerHTML = `<div class="task-row empty-task-row"><span></span><span></span><div><h3>暂无匹配待办</h3><p>调整状态或负责人筛选后再查看。</p></div></div>`;
    return;
  }
  els.taskRows.innerHTML = "";

  for (const task of filteredTasks) {
    const row = document.createElement("div");
    row.className = `task-row ${task.status === "done" ? "done-row" : ""} ${state.selectedTaskId === task.id ? "selected" : ""}`;
    row.innerHTML = `
      <span><input type="checkbox" ${task.status === "done" ? "checked" : ""} aria-label="完成状态" /></span>
      <span><i class="marker-pill">${task.markerId}</i></span>
      <div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.detail)}</p></div>
      <span class="owner">${escapeHtml(task.owner)}</span>
      <span class="owner">${escapeHtml(formatDueDate(task))}</span>
      <span>${renderConfidenceBadge(task)}</span>
      ${renderMeetingSourceChip(task)}
      <span class="task-row-actions">
        <button type="button" data-action="edit">编辑</button>
        <button type="button" data-action="delete">删除</button>
      </span>
    `;
    row.addEventListener("click", () => selectTask(task.id));
    row.querySelector("input").addEventListener("click", async (event) => {
      event.stopPropagation();
      await toggleTask(task.id, event.target.checked);
    });
    row.querySelector('[data-action="edit"]').addEventListener("click", (event) => {
      event.stopPropagation();
      openTaskForm(task);
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteTask(task.id);
    });
    els.taskRows.appendChild(row);
  }
}

function openTaskForm(task = null) {
  state.taskFormMode = task ? "edit" : "create";
  state.editingTaskId = task?.id || "";
  els.taskFormTitle.textContent = task ? "编辑任务" : "新增任务";
  els.taskForm.reset();
  els.taskForm.elements.title.value = task?.title || "";
  els.taskForm.elements.detail.value = task?.detail || "";
  els.taskForm.elements.owner.value = task?.owner || "";
  els.taskForm.elements.dueDate.value = task ? formatDueDate(task) : "";
  els.taskForm.elements.meetingSource.value = task?.meetingSource === "人工补充" ? "" : task?.meetingSource || "";
  els.taskForm.elements.confidenceLevel.value = task?.confidenceLevel || "explicit";
  els.taskFormOverlay.classList.remove("hidden");
  els.taskForm.elements.title.focus();
}

function closeTaskForm() {
  state.taskFormMode = "create";
  state.editingTaskId = "";
  els.taskFormOverlay.classList.add("hidden");
}

async function saveTaskForm(event) {
  event.preventDefault();
  if (!state.project?.id) return;
  const payload = {
    title: els.taskForm.elements.title.value.trim(),
    detail: els.taskForm.elements.detail.value.trim(),
    owner: els.taskForm.elements.owner.value.trim() || "待定",
    dueDate: els.taskForm.elements.dueDate.value.trim() || "待定",
    meetingSource: els.taskForm.elements.meetingSource.value.trim() || "人工补充",
    confidenceLevel: els.taskForm.elements.confidenceLevel.value,
    confidenceScore: els.taskForm.elements.confidenceLevel.value === "explicit" ? 95 : els.taskForm.elements.confidenceLevel.value === "suggested" ? 70 : 45,
    confidenceReason: state.taskFormMode === "create" ? "用户手动补充任务。" : "用户手动编辑任务信息。"
  };
  if (!payload.title || !payload.detail) return;

  const isEdit = state.taskFormMode === "edit" && state.editingTaskId;
  const url = isEdit ? `/api/projects/${state.project.id}/tasks/${state.editingTaskId}` : `/api/projects/${state.project.id}/tasks`;
  const { project, task } = await fetchJson(url, {
    method: isEdit ? "PATCH" : "POST",
    body: payload
  });
  state.project = project;
  state.selectedTaskId = task.id;
  state.activeMarkerTaskId = task.id;
  closeTaskForm();
  refreshTaskViews();
  showToast(isEdit ? "已保存任务修改" : "已新增任务");
}

async function deleteTask(taskId) {
  if (!confirm("确定删除这条待办吗？删除后对应画布标注也会移除。")) return;
  const { project } = await fetchJson(`/api/projects/${state.project.id}/tasks/${taskId}`, { method: "DELETE" });
  state.project = project;
  if (state.selectedTaskId === taskId) state.selectedTaskId = "";
  if (state.activeMarkerTaskId === taskId) {
    state.activeMarkerTaskId = "";
    closeMarkerCard();
  }
  refreshTaskViews();
  showToast("已删除任务");
}

function refreshTaskViews() {
  updateOwnerFilter();
  updateWorkflowState();
  updateChatAvailability();
  renderTasks();
  renderMarkers();
  renderMarkerCard();
}

function filterTasks(tasks) {
  return tasks.filter((task) => {
    const statusMatched = state.statusFilter === "all" || task.status === state.statusFilter;
    const ownerMatched = state.ownerFilter === "all" || task.owner === state.ownerFilter;
    return statusMatched && ownerMatched;
  });
}

function renderConfidenceStats(tasks) {
  if (!els.taskConfidenceStats) return;
  const counts = tasks.reduce((result, task) => {
    result[getConfidenceMeta(task).level] += 1;
    return result;
  }, { explicit: 0, suggested: 0, low: 0 });
  els.taskConfidenceStats.innerHTML = `
    <span class="confidence-chip explicit">明确任务 ${counts.explicit}</span>
    <span class="confidence-chip suggested">待确认建议 ${counts.suggested}</span>
    <span class="confidence-chip low">低置信度 ${counts.low}</span>
  `;
}

function getConfidenceMeta(task) {
  const level = ["explicit", "suggested", "low"].includes(task.confidenceLevel) ? task.confidenceLevel : "suggested";
  const labels = {
    explicit: "明确任务",
    suggested: "待确认建议",
    low: "低置信度"
  };
  return {
    level,
    label: labels[level],
    score: Number.isFinite(Number(task.confidenceScore)) ? Math.round(Number(task.confidenceScore)) : 70,
    reason: task.confidenceReason || "AI 已生成任务，但仍建议人工确认会议依据。"
  };
}

function getPositionMeta(task) {
  const source = task.positionSource === "manual" ? "manual" : "ai";
  return {
    source,
    label: source === "manual" ? "人工校准" : "AI 初始定位"
  };
}

function renderConfidenceBadge(task) {
  const confidence = getConfidenceMeta(task);
  return `<i class="confidence-badge ${confidence.level}" title="${escapeHtml(confidence.reason)}">${escapeHtml(confidence.label)} · ${confidence.score}</i>`;
}

function updateOwnerFilter() {
  const owners = Array.from(new Set((state.project?.tasks || []).map((task) => task.owner).filter(Boolean)));
  const current = state.ownerFilter;
  els.ownerFilter.innerHTML = `<option value="all">全部负责人</option>${owners.map((owner) => `<option value="${escapeHtml(owner)}">${escapeHtml(owner)}</option>`).join("")}`;
  state.ownerFilter = owners.includes(current) ? current : "all";
  els.ownerFilter.value = state.ownerFilter;
}

function renderMarkers() {
  const tasks = state.project?.tasks || [];
  syncMarkersFrame();
  els.markersLayer.innerHTML = "";
  state.resolvedPositions = resolveVisualPositions(tasks);
  for (const task of tasks) {
    const position = state.resolvedPositions[task.id] || getVisualPosition(task);
    const marker = document.createElement("button");
    marker.className = `marker ${task.status === "done" ? "done" : ""} ${state.selectedTaskId === task.id ? "selected" : ""}`;
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    marker.textContent = task.markerId;
    marker.dataset.title = `${task.title}${task.positionSource === "manual" ? " · 已人工校准" : ""}`;
    marker.dataset.markerId = task.markerId;
    marker.classList.toggle("manual", task.positionSource === "manual");
    marker.addEventListener("pointerdown", (event) => startMarkerDrag(event, task, marker));
    marker.addEventListener("click", (event) => {
      if (event.detail === 0) openMarkerCard(task.id);
    });
    els.markersLayer.appendChild(marker);
  }
  renderMarkerCard();
}

function getVisualPosition(task) {
  if (task.positionSource === "manual") {
    return clampVisualPosition(task.position || { x: 50, y: 50 });
  }
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
  return clampVisualPosition(task.position || { x: 50, y: 50 });
}

function resolveVisualPositions(tasks) {
  const resolved = {};
  const placed = [];
  for (const task of tasks) {
    const base = getVisualPosition(task);
    const position = { ...base };
    if (task.positionSource !== "manual") {
      let overlaps = placed.filter((item) => distance(position, item.position) < 3.2).length;
      if (overlaps) {
        position.x = Math.max(4, Math.min(96, position.x + overlaps * 2.2));
        position.y = Math.max(4, Math.min(96, position.y + overlaps * 4.2));
      }
    }
    resolved[task.id] = position;
    placed.push({ task, position });
  }
  return resolved;
}

function distance(a, b) {
  return Math.hypot((Number(a.x) || 0) - (Number(b.x) || 0), (Number(a.y) || 0) - (Number(b.y) || 0));
}

function clampVisualPosition(position) {
  return {
    x: Math.max(4, Math.min(96, Number(position.x) || 50)),
    y: Math.max(4, Math.min(96, Number(position.y) || 50))
  };
}

function startMarkerDrag(event, task, marker) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  marker.setPointerCapture?.(event.pointerId);
  const startPosition = getVisualPosition(task);
  state.dragMarker = {
    taskId: task.id,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    position: startPosition,
    moved: false
  };
  marker.classList.add("dragging");

  const onMove = (moveEvent) => {
    if (!state.dragMarker || state.dragMarker.pointerId !== moveEvent.pointerId) return;
    const delta = Math.hypot(moveEvent.clientX - state.dragMarker.startClientX, moveEvent.clientY - state.dragMarker.startClientY);
    if (delta > 4) state.dragMarker.moved = true;
    const position = getPositionFromPointer(moveEvent);
    state.dragMarker.position = position;
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    if (state.activeMarkerTaskId === task.id) renderMarkerCardPreview(position);
  };

  const onEnd = async (endEvent) => {
    if (!state.dragMarker || state.dragMarker.pointerId !== endEvent.pointerId) return;
    marker.releasePointerCapture?.(endEvent.pointerId);
    marker.classList.remove("dragging");
    marker.removeEventListener("pointermove", onMove);
    marker.removeEventListener("pointerup", onEnd);
    marker.removeEventListener("pointercancel", onEnd);
    const drag = state.dragMarker;
    state.dragMarker = null;
    if (drag.moved) {
      await saveMarkerPosition(task.id, drag.position);
    } else {
      openMarkerCard(task.id);
    }
  };

  marker.addEventListener("pointermove", onMove);
  marker.addEventListener("pointerup", onEnd);
  marker.addEventListener("pointercancel", onEnd);
}

function getPositionFromPointer(event) {
  const rect = els.markersLayer.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 50, y: 50 };
  return clampVisualPosition({
    x: (event.clientX - rect.left) / rect.width * 100,
    y: (event.clientY - rect.top) / rect.height * 100
  });
}

function renderMarkerCardPreview(position) {
  const cardPosition = getMarkerCardPosition(position);
  els.markerCard.style.left = `${cardPosition.x}px`;
  els.markerCard.style.top = `${cardPosition.y}px`;
}

async function saveMarkerPosition(taskId, position) {
  const { project } = await fetchJson(`/api/projects/${state.project.id}/tasks/${taskId}`, {
    method: "PATCH",
    body: { position }
  });
  state.project = project;
  state.activeMarkerTaskId = taskId;
  renderTasks();
  renderMarkers();
  renderMarkerCard();
  showToast("已保存人工修正位置");
}

async function resetMarkerPosition(taskId) {
  const { project } = await fetchJson(`/api/projects/${state.project.id}/tasks/${taskId}`, {
    method: "PATCH",
    body: { positionSource: "ai" }
  });
  state.project = project;
  state.activeMarkerTaskId = taskId;
  renderTasks();
  renderMarkers();
  renderMarkerCard();
  showToast("已恢复 AI 初始位置");
}

function syncMarkersFrame() {
  const target = getMarkerTarget();
  const canvas = document.querySelector("#canvas");
  if (!target || !canvas) return;

  const targetRect = target.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (!targetRect.width || !targetRect.height) return;

  els.markersLayer.style.left = `${targetRect.left - canvasRect.left}px`;
  els.markersLayer.style.top = `${targetRect.top - canvasRect.top}px`;
  els.markersLayer.style.width = `${targetRect.width}px`;
  els.markersLayer.style.height = `${targetRect.height}px`;
}

function getMarkerTarget() {
  const imageVisible = els.canvasImage.style.display !== "none" && els.canvasImage.getBoundingClientRect().width > 0;
  if (imageVisible) return els.canvasImage;
  return null;
}

function selectTask(taskId) {
  state.selectedTaskId = taskId;
  renderTasks();
  renderMarkers();
}

function openMarkerCard(taskId) {
  state.selectedTaskId = taskId;
  state.activeMarkerTaskId = taskId;
  renderTasks();
  renderMarkers();
  renderMarkerCard();
}

function closeMarkerCard() {
  state.activeMarkerTaskId = "";
  els.markerCard.classList.add("hidden");
  els.markerCard.innerHTML = "";
}

function renderMarkerCard() {
  const task = state.project?.tasks?.find((item) => item.id === state.activeMarkerTaskId);
  if (!task) {
    closeMarkerCard();
    return;
  }
  syncMarkersFrame();
  if (!state.resolvedPositions[task.id]) {
    state.resolvedPositions = resolveVisualPositions(state.project?.tasks || []);
  }
  const position = state.resolvedPositions[task.id] || getVisualPosition(task);
  const confidence = getConfidenceMeta(task);
  const positionMeta = getPositionMeta(task);
  els.markerCard.classList.remove("hidden");
  els.markerCard.innerHTML = `
    <div class="marker-card-head">
      <strong>${escapeHtml(task.markerId)}. ${escapeHtml(task.title)}</strong>
      <button type="button" class="marker-card-close" aria-label="关闭">×</button>
    </div>
    <div class="marker-card-section">
      <span>修改内容</span>
      <p>${escapeHtml(task.detail)}</p>
    </div>
    <div class="marker-card-grid">
      <div><span>负责人</span><strong>${escapeHtml(task.owner)}</strong></div>
      <div><span>截止日期</span><strong>${escapeHtml(formatDueDate(task))}</strong></div>
    </div>
    <div class="marker-card-position ${positionMeta.source}">
      <div>
        <span>定位来源</span>
        <strong>${escapeHtml(positionMeta.label)}</strong>
      </div>
      ${task.positionSource === "manual" ? `<button type="button" class="reset-marker-position">恢复 AI 位置</button>` : ""}
    </div>
    <div class="marker-card-confidence ${confidence.level}">
      <div>
        <span>任务可信度</span>
        <strong>${escapeHtml(confidence.label)} · ${confidence.score}</strong>
      </div>
      <p>${escapeHtml(confidence.reason)}</p>
    </div>
    <div class="marker-card-source">
      <span>会议节点溯源</span>
      ${renderMeetingSourceChip(task)}
    </div>
    <details class="marker-card-evidence">
      <summary>原始会议片段</summary>
      <p>${escapeHtml(task.meetingSource || "暂无原始片段")}</p>
    </details>
    <div class="marker-card-actions">
      <button type="button" class="edit-marker-task">编辑任务</button>
      <button type="button" class="delete-marker-task">删除任务</button>
    </div>
    <label class="marker-card-check">
      <input type="checkbox" ${task.status === "done" ? "checked" : ""} />
      <span>标记完成</span>
    </label>
  `;
  const cardPosition = getMarkerCardPosition(position);
  els.markerCard.style.left = `${cardPosition.x}px`;
  els.markerCard.style.top = `${cardPosition.y}px`;
  els.markerCard.querySelector(".marker-card-close").addEventListener("click", closeMarkerCard);
  els.markerCard.querySelector(".reset-marker-position")?.addEventListener("click", async () => {
    await resetMarkerPosition(task.id);
  });
  els.markerCard.querySelector(".edit-marker-task").addEventListener("click", () => {
    openTaskForm(task);
  });
  els.markerCard.querySelector(".delete-marker-task").addEventListener("click", async () => {
    await deleteTask(task.id);
  });
  els.markerCard.querySelector("input").addEventListener("change", async (event) => {
    await toggleTask(task.id, event.target.checked);
    state.activeMarkerTaskId = task.id;
    renderMarkerCard();
  });
}

function getMarkerCardPosition(position) {
  const layerRect = els.markersLayer.getBoundingClientRect();
  const canvasRect = document.querySelector("#canvas").getBoundingClientRect();
  const markerX = layerRect.left - canvasRect.left + layerRect.width * position.x / 100;
  const markerY = layerRect.top - canvasRect.top + layerRect.height * position.y / 100;
  const cardWidth = 360;
  const cardHeight = Math.min(els.markerCard.offsetHeight || 520, canvasRect.height - 24);
  const gap = 18;
  let x = markerX + gap;
  let y = markerY - 28;
  if (x + cardWidth > canvasRect.width - 12) x = markerX - cardWidth - gap;
  if (x < 12) x = 12;
  if (y + cardHeight > canvasRect.height - 12) y = canvasRect.height - cardHeight - 12;
  if (y < 12) y = 12;
  return { x, y };
}

function extractMeetingNode(task) {
  return normalizeMeetingNode(getTaskMeetingSource(task)) || "会议记录";
}

function renderMeetingSourceChip(task) {
  return `
    <span class="source-chip source-chip-stack">
      <strong>${escapeHtml(extractSpeaker(task))}</strong>
      <em>${escapeHtml(extractMeetingNode(task))}</em>
    </span>
  `;
}

function extractSpeaker(task) {
  const source = getTaskMeetingSource(task);
  const bracket = source.match(/[【\[]([^】\]]+)[】\]]/)?.[1] || "";
  const sourceHead = bracket || source.slice(0, 40);
  if (!sourceHead) return task.owner || "会议发言人";
  const withoutDate = sourceHead
    .replace(/20\d{2}年\d{1,2}月\d{1,2}日/g, "")
    .replace(/\d{1,2}:\d{2}/g, "")
    .replace(/[【】\[\]]/g, "")
    .trim();
  return withoutDate || task.owner || "会议发言人";
}

function getTaskMeetingSource(task) {
  const source = task.meetingSource || "";
  if (normalizeMeetingNode(source)) return source;
  const lines = (state.project?.meetingText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return source;
  const text = `${task.title || ""} ${task.detail || ""} ${source}`;
  const best = lines
    .map((line) => ({ line, score: scoreMeetingLine(text, line) }))
    .sort((a, b) => b.score - a.score)[0];
  return best?.score > 0 ? best.line : source;
}

function scoreMeetingLine(taskText, line) {
  const tokens = Array.from(new Set(String(taskText || "")
    .match(/#[0-9a-fA-F]{3,8}|[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_-]{2,}/g) || []))
    .filter((token) => !/会议|任务|修改|设计|需要|建议|这个|一下|当前/.test(token));
  return tokens.reduce((score, token) => score + (line.includes(token) ? token.length : 0), 0);
}

function formatDueDate(task) {
  const value = String(task?.dueDate || "");
  const iso = value.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/)?.[0];
  if (iso) return normalizeDateText(iso);
  const chinese = value.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  if (chinese) return normalizeDateText(chinese);
  const sourceDate = getTaskMeetingSource(task).match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  if (/今天/.test(value) && sourceDate) return normalizeDateText(sourceDate);
  if (/明天/.test(value) && sourceDate) return addDateDays(normalizeDateText(sourceDate), 1);
  return value.replace(/(下班前|之前|前|完成|改好|处理好).*/, "").trim() || "待定";
}

function normalizeDateText(value) {
  const parts = String(value).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/) || [];
  if (!parts.length) return String(value).slice(0, 10);
  return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
}

function addDateDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function normalizeMeetingNode(text) {
  const value = String(text || "");
  const full = value.match(/20\d{2}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/)?.[0];
  if (full) return full;
  const date = value.match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
  const time = value.match(/\d{1,2}:\d{2}/)?.[0];
  if (date && time) return `${date} ${time}`;
  return time || "";
}

async function toggleTask(taskId, checked) {
  const { project } = await fetchJson(`/api/projects/${state.project.id}/tasks/${taskId}`, {
    method: "PATCH",
    body: { status: checked ? "done" : "todo" }
  });
  state.project = project;
  updateWorkflowState();
  updateChatAvailability();
  renderTasks();
  renderMarkers();
  renderMarkerCard();
}

function updateWorkflowState() {
  const hasImage = Boolean(state.imageDataUrl || state.project?.imageUrl);
  const hasText = Boolean(els.meetingText.value.trim() || state.project?.meetingText?.trim());
  const hasTasks = Boolean(state.project?.tasks?.length);
  document.querySelectorAll(".workflow-step").forEach((step) => {
    const key = step.dataset.step;
    const complete = key === "image" ? hasImage : key === "text" ? hasText : hasTasks;
    step.classList.toggle("done", complete);
    step.classList.toggle("pending", !complete);
  });
  els.analyzeBtn.disabled = !hasImage || !hasText;
}

function updateChatAvailability() {
  const ready = Boolean(state.project?.tasks?.length);
  els.chatInput.disabled = !ready;
  els.chatInput.placeholder = ready ? "提问关于会议决定、色值、负责人任务..." : "解析完成后可提问会议决定、色值、负责人任务...";
  document.querySelectorAll(".prompt").forEach((button) => {
    button.disabled = !ready;
  });
}

async function ask(message) {
  addUserMessage(message);
  const loading = addAiMessage("正在检索当前会议材料...");
  try {
    const result = await fetchJson("/api/chat", {
      method: "POST",
      body: { projectId: state.project?.id, message }
    });
    loading.innerHTML = `<strong>DesignNote AI：</strong>${renderAiAnswer(result.answer)}`;
    bindTaskRefs(loading);
  } catch (error) {
    loading.textContent = error.message || "问答失败";
  }
}

function addUserMessage(text) {
  const node = document.createElement("div");
  node.className = "message user";
  node.textContent = text;
  els.chatMessages.appendChild(node);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function addAiMessage(text) {
  const node = document.createElement("div");
  node.className = "message ai";
  node.textContent = text;
  els.chatMessages.appendChild(node);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return node;
}

function renderAiAnswer(answer) {
  const lines = String(answer || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "<p>暂无回答。</p>";

  const structured = renderStructuredTaskAnswer(lines);
  if (structured) return structured;

  let html = "";
  let listOpen = false;
  for (const line of lines) {
    if (/^[-•]\s*/.test(line)) {
      if (!listOpen) {
        html += "<ul>";
        listOpen = true;
      }
      html += `<li>${formatAnswerLine(line.replace(/^[-•]\s*/, ""))}</li>`;
      continue;
    }
    if (listOpen) {
      html += "</ul>";
      listOpen = false;
    }
    const className = /^会议节点溯源/.test(line) ? "answer-source" : "answer-line";
    const normalizedLine = className === "answer-source" ? normalizeAnswerSourceLine(line) : line;
    html += `<p class="${className}">${formatAnswerLine(normalizedLine)}</p>`;
  }
  if (listOpen) html += "</ul>";
  html += renderColorAssets(answer);
  return html;
}

function renderStructuredTaskAnswer(lines) {
  const items = [];
  const intro = [];
  let current = null;

  for (const line of lines) {
    const taskMatch = line.match(/^[-•]\s*\[Task-(\d+)\]\s*(.+)$/);
    if (taskMatch) {
      current = {
        markerId: taskMatch[1],
        title: taskMatch[2],
        requirement: "",
        reason: "",
        source: ""
      };
      items.push(current);
      continue;
    }
    if (current && /^要求[:：]/.test(line)) {
      current.requirement = line.replace(/^要求[:：]\s*/, "");
      continue;
    }
    if (current && /^原因[:：]/.test(line)) {
      current.reason = line.replace(/^原因[:：]\s*/, "");
      continue;
    }
    if (current && /^会议节点溯源[:：]/.test(line)) {
      current.source = normalizeAnswerMeetingNode(line.replace(/^会议节点溯源[:：]\s*/, ""), current.markerId);
      continue;
    }
    if (!current) intro.push(line);
  }

  if (!items.length) return "";

  let html = intro.map((line) => `<p class="answer-intro">${formatAnswerLine(line)}</p>`).join("");
  html += '<ul class="answer-task-list">';
  for (const item of items) {
    html += `
      <li class="answer-task-item">
        <div class="answer-task-title">
          <span class="task-ref task-ref-dot" data-marker-id="${escapeHtml(item.markerId)}">${escapeHtml(item.markerId)}</span>
          <strong>${formatAnswerLine(item.title)}</strong>
        </div>
        ${item.requirement ? `<p class="answer-requirement"><span>要求：</span>${formatAnswerLine(item.requirement)}</p>` : ""}
        ${item.reason ? `<p class="answer-requirement"><span>原因：</span>${formatAnswerLine(item.reason)}</p>` : ""}
        ${item.source ? `<p class="answer-source-chip">会议节点溯源：${formatAnswerLine(item.source)}</p>` : ""}
      </li>
    `;
  }
  html += "</ul>";
  html += renderColorAssets(lines.join("\n"));
  return html;
}

function renderColorAssets(answer) {
  const colors = extractAnswerColors(answer);
  if (!colors.length) return "";
  return colors.map((color) => `
    <div class="color-asset-card">
      <span class="color-swatch" style="background:${escapeHtml(color.hex)}"></span>
      <div class="color-asset-copy">
        <strong>${escapeHtml(color.name)}</strong>
        <small>HEX：${escapeHtml(color.hex)}</small>
      </div>
      <button class="copy-color-btn" type="button" data-color="${escapeHtml(color.hex)}" aria-label="复制色号">⧉</button>
    </div>
  `).join("");
}

function extractAnswerColors(answer) {
  const found = new Map();
  const text = String(answer || "");
  for (const hex of text.match(/#[0-9a-fA-F]{6}\b/g) || []) {
    found.set(hex.toUpperCase(), {
      hex: hex.toUpperCase(),
      name: guessColorName(hex, text)
    });
  }
  for (const token of state.project?.designTokens || []) {
    const hex = String(token.value || "").match(/#[0-9a-fA-F]{6}\b/)?.[0];
    if (hex && text.includes(hex)) {
      found.set(hex.toUpperCase(), {
        hex: hex.toUpperCase(),
        name: token.name || guessColorName(hex, text)
      });
    }
  }
  return Array.from(found.values()).slice(0, 3);
}

function guessColorName(hex, text) {
  if (/品牌|主色/.test(text)) return "品牌主色（调整后）";
  if (/背景/.test(text)) return "背景颜色（调整后）";
  return "设计色值";
}

function normalizeAnswerSourceLine(line) {
  const content = line.replace(/^会议节点溯源[:：]\s*/, "");
  return `会议节点溯源：${normalizeAnswerMeetingNode(content)}`;
}

function normalizeAnswerMeetingNode(value, markerId = "") {
  const node = normalizeMeetingNode(value);
  if (node && node !== "会议记录") return node;
  const task = markerId ? state.project?.tasks?.find((item) => item.markerId === markerId) : null;
  if (task) return extractMeetingNode(task);
  return "会议记录";
}

function formatAnswerLine(line) {
  return escapeHtml(line)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[Task-(\d+)\]/g, '<span class="task-ref" data-marker-id="$1">[Task-$1]</span>');
}

function bindTaskRefs(container) {
  container.querySelectorAll(".task-ref").forEach((ref) => {
    ref.addEventListener("mouseenter", () => pulseMarker(ref.dataset.markerId, true));
    ref.addEventListener("mouseleave", () => pulseMarker(ref.dataset.markerId, false));
    ref.addEventListener("click", () => {
      const task = state.project?.tasks?.find((item) => item.markerId === ref.dataset.markerId);
      if (task) openMarkerCard(task.id);
    });
  });
  container.querySelectorAll(".copy-color-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const color = button.dataset.color;
      await navigator.clipboard?.writeText(color).catch(() => {});
      button.textContent = "✓";
      setTimeout(() => {
        button.textContent = "⧉";
      }, 900);
    });
  });
}

function pulseMarker(markerId, active) {
  document.querySelectorAll(`.marker[data-marker-id="${markerId}"]`).forEach((marker) => {
    marker.classList.toggle("pulse", active);
  });
}

function showJob(job) {
  els.jobOverlay.classList.remove("hidden");
  els.jobTitle.textContent = job.status === "done" ? "解析完成" : "多模态大模型解析中";
  els.jobMessage.textContent = job.message || "正在处理会议内容...";
  els.progressBar.style.width = `${job.progress || 0}%`;
}

function hideJob() {
  els.jobOverlay.classList.add("hidden");
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "app-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 180);
  }, 1800);
}

async function imageUrlToDataUrl(url) {
  const response = await fetch(url);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
