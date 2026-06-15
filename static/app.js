/* ============================================================
   TaskFlow – app.js
   All interactions with the FastAPI backend (/api/todos)
   ============================================================ */

const API = '/api/todos';

// ── State ────────────────────────────────────────────────────
let state = {
  filter: 'all',
  category: 'all',
  search: '',
  editingId: null,
  expandedTodoIds: new Set(),
  view: 'tasks',
};

// ── DOM refs ─────────────────────────────────────────────────
const todoList          = document.getElementById('todo-list');
const emptyState        = document.getElementById('empty-state');
const modalOverlay      = document.getElementById('modal-overlay');
const modalTitle        = document.getElementById('modal-title');
const taskTitleInput    = document.getElementById('task-title');
const taskDescInput     = document.getElementById('task-description');
const taskPriorityInput = document.getElementById('task-priority');
const taskCategoryInput = document.getElementById('task-category');
const taskDueInput      = document.getElementById('task-due');
const editIdInput       = document.getElementById('edit-id');
const searchInput       = document.getElementById('search-input');
const progressFill      = document.getElementById('progress-fill');
const progressPercent   = document.getElementById('progress-percent');
const countTotal        = document.getElementById('count-total');
const countActive       = document.getElementById('count-active');
const countDone         = document.getElementById('count-done');

// ── Chart instances (destroyed & recreated on each render) ────
let chartDaily    = null;
let chartPriority = null;
let chartCategory = null;

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setHeaderDate();
  fetchAndRender();
  bindEvents();
});

function setHeaderDate() {
  const el = document.getElementById('header-date');
  const now = new Date();
  el.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ── View Switching ───────────────────────────────────────────
function switchView(view) {
  state.view = view;
  const tasksView     = document.getElementById('tasks-view');
  const analyticsView = document.getElementById('analytics-view');
  const tasksBtn      = document.getElementById('view-tasks-btn');
  const analyticsBtn  = document.getElementById('view-analytics-btn');
  const filterNav     = document.getElementById('filter-nav');
  const categoryList  = document.getElementById('category-list').parentElement;

  if (view === 'analytics') {
    tasksView.classList.add('hidden');
    analyticsView.classList.remove('hidden');
    tasksBtn.classList.remove('active');
    analyticsBtn.classList.add('active');
    filterNav.style.opacity    = '0.4';
    filterNav.style.pointerEvents = 'none';
    categoryList.style.opacity = '0.4';
    categoryList.style.pointerEvents = 'none';
    fetchAnalytics();
  } else {
    analyticsView.classList.add('hidden');
    tasksView.classList.remove('hidden');
    analyticsBtn.classList.remove('active');
    tasksBtn.classList.add('active');
    filterNav.style.opacity    = '';
    filterNav.style.pointerEvents = '';
    categoryList.style.opacity = '';
    categoryList.style.pointerEvents = '';
  }
}

// ── Fetch & Render ───────────────────────────────────────────
async function fetchAndRender() {
  const params = new URLSearchParams({
    filter:   state.filter,
    category: state.category,
    search:   state.search,
  });

  try {
    const res  = await fetch(`${API}?${params}`);
    const data = await res.json();
    renderTodos(data.todos);
    renderStats(data.stats);
    renderCategories(data.categories);
  } catch (err) {
    showToast('Failed to load tasks', 'error');
  }
}

function renderTodos(todos) {
  todoList.innerHTML = '';

  if (!todos.length) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  todos.forEach(t => {
    const el = createTodoElement(t);
    todoList.appendChild(el);
  });
}

function createTodoElement(t) {
  const div = document.createElement('div');
  div.className = `todo-item priority-${t.priority} ${t.completed ? 'completed-item' : ''}`;
  div.dataset.id = t.id;

  // Due date badge
  let dueBadge = '';
  if (t.due_date) {
    const today   = new Date(); today.setHours(0,0,0,0);
    const dueDate = new Date(t.due_date);
    const overdue = !t.completed && dueDate < today;
    dueBadge = `<span class="badge badge-due ${overdue ? 'overdue' : ''}">
      📅 ${formatDate(t.due_date)}${overdue ? ' · Overdue' : ''}
    </span>`;
  }

  // Subtasks progress stats
  const subtasks = t.subtasks || [];
  const totalSubtasks = subtasks.length;
  const completedSubtasks = subtasks.filter(s => s.completed).length;
  const subtasksPercent = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

  let progressHtml = '';
  if (totalSubtasks > 0) {
    progressHtml = `
      <div class="todo-progress-container">
        <div class="mini-progress-bar">
          <div class="mini-progress-fill" style="width: ${subtasksPercent}%"></div>
        </div>
        <span class="mini-progress-text">${completedSubtasks}/${totalSubtasks} subtasks</span>
      </div>
    `;
  }

  div.innerHTML = `
    <div class="todo-checkbox ${t.completed ? 'checked' : ''}" data-id="${t.id}"></div>
    <div class="todo-body">
      <div class="todo-title">${escapeHtml(t.title)}</div>
      ${t.description ? `<div class="todo-desc">${escapeHtml(t.description)}</div>` : ''}
      ${progressHtml}
      <div class="todo-meta">
        <span class="badge badge-priority-${t.priority}">${priorityLabel(t.priority)}</span>
        <span class="badge badge-category">⬡ ${escapeHtml(t.category)}</span>
        ${dueBadge}
        <button class="subtask-toggle-btn" data-id="${t.id}">
          ${state.expandedTodoIds.has(t.id) ? '▴' : '▾'} Subtasks (${completedSubtasks}/${totalSubtasks})
        </button>
      </div>
      
      <div class="todo-subtasks-container ${state.expandedTodoIds.has(t.id) ? 'open' : ''}">
        <div class="subtask-list">
          ${subtasks.map(s => `
            <div class="subtask-item ${s.completed ? 'completed-subtask' : ''}">
              <div class="subtask-checkbox ${s.completed ? 'checked' : ''}" data-subtask-id="${s.id}"></div>
              <span class="subtask-title">${escapeHtml(s.title)}</span>
              <button class="subtask-delete-btn" data-subtask-id="${s.id}">✕</button>
            </div>
          `).join('')}
        </div>
        <div class="add-subtask-form">
          <input type="text" class="subtask-input" placeholder="Add subtask..." value="">
          <button class="subtask-add-btn">Add</button>
        </div>
      </div>
    </div>
    <div class="todo-actions">
      <button class="action-btn edit-btn" data-id="${t.id}" title="Edit">✎</button>
      <button class="action-btn del-btn"  data-id="${t.id}" title="Delete">✕</button>
    </div>
  `;

  // Checkbox toggle
  div.querySelector('.todo-checkbox').addEventListener('click', () => toggleComplete(t));

  // Edit
  div.querySelector('.edit-btn').addEventListener('click', () => openEditModal(t));

  // Delete
  div.querySelector('.del-btn').addEventListener('click', () => deleteTodo(t.id));

  // Subtasks expand toggle
  const toggleBtn = div.querySelector('.subtask-toggle-btn');
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const container = div.querySelector('.todo-subtasks-container');
    if (state.expandedTodoIds.has(t.id)) {
      state.expandedTodoIds.delete(t.id);
      container.classList.remove('open');
      toggleBtn.innerHTML = `▾ Subtasks (${completedSubtasks}/${totalSubtasks})`;
    } else {
      state.expandedTodoIds.add(t.id);
      container.classList.add('open');
      toggleBtn.innerHTML = `▴ Subtasks (${completedSubtasks}/${totalSubtasks})`;
      // Focus on subtask input
      setTimeout(() => {
        const input = div.querySelector('.subtask-input');
        if (input) input.focus();
      }, 50);
    }
  });

  // Subtask checkbox toggling
  div.querySelectorAll('.subtask-checkbox').forEach(cb => {
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      const subtaskId = parseInt(cb.dataset.subtaskId);
      const subtask = subtasks.find(s => s.id === subtaskId);
      if (subtask) {
        try {
          await toggleSubtaskComplete(subtask);
        } catch (err) {
          showToast('Failed to update subtask', 'error');
        }
      }
    });
  });

  // Subtask deleting
  div.querySelectorAll('.subtask-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const subtaskId = parseInt(btn.dataset.subtaskId);
      try {
        await deleteSubtask(subtaskId);
      } catch (err) {
        showToast('Failed to delete subtask', 'error');
      }
    });
  });

  // Subtask inline form addition
  const subtaskInput = div.querySelector('.subtask-input');
  const subtaskAddBtn = div.querySelector('.subtask-add-btn');

  const submitSubtask = async () => {
    const text = subtaskInput.value.trim();
    if (!text) return;
    try {
      await addSubtask(t.id, text);
      subtaskInput.value = '';
    } catch (err) {
      showToast('Failed to add subtask', 'error');
    }
  };

  subtaskAddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    submitSubtask();
  });
  
  subtaskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      submitSubtask();
    }
  });

  return div;
}

function renderStats(stats) {
  countTotal.textContent  = stats.total;
  countActive.textContent = stats.active;
  countDone.textContent   = stats.completed;

  const pct = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressPercent.textContent = pct + '%';
}

function renderCategories(categories) {
  const container = document.getElementById('category-list');
  const allBtn = container.querySelector('[data-category="all"]') ||
    (() => {
      const b = document.createElement('button');
      b.className = 'nav-btn';
      b.dataset.category = 'all';
      b.innerHTML = '<span class="nav-icon">⬡</span> All Categories';
      container.appendChild(b);
      return b;
    })();

  // Remove old dynamic buttons
  [...container.querySelectorAll('[data-category]:not([data-category="all"])')].forEach(b => b.remove());

  categories.forEach(cat => {
    const b = document.createElement('button');
    b.className = 'nav-btn' + (state.category === cat ? ' active' : '');
    b.dataset.category = cat;
    b.innerHTML = `<span class="nav-icon">⬡</span> ${escapeHtml(cat)}`;
    b.addEventListener('click', () => setCategory(cat));
    container.appendChild(b);
  });

  // Sync active state
  [...container.querySelectorAll('[data-category]')].forEach(b => {
    b.classList.toggle('active', b.dataset.category === state.category);
  });
}

// ── CRUD ─────────────────────────────────────────────────────
async function addSubtask(todoId, title) {
  const res = await fetch(`${API}/${todoId}/subtasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error((await res.json()).detail);
  showToast('Subtask added', 'success');
  fetchAndRender();
}

async function toggleSubtaskComplete(subtask) {
  const res = await fetch(`/api/subtasks/${subtask.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: !subtask.completed }),
  });
  if (!res.ok) throw new Error((await res.json()).detail);
  showToast(subtask.completed ? 'Subtask marked active' : 'Subtask completed! 🎉', 'success');
  fetchAndRender();
}

async function deleteSubtask(id) {
  const res = await fetch(`/api/subtasks/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error((await res.json()).detail);
  showToast('Subtask deleted', 'success');
  fetchAndRender();
}

async function createTodo(data) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).detail);
  return res.json();
}

async function updateTodo(id, data) {
  const res = await fetch(`${API}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).detail);
  return res.json();
}

async function deleteTodo(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await fetch(`${API}/${id}`, { method: 'DELETE' });
    showToast('Task deleted', 'success');
    fetchAndRender();
  } catch {
    showToast('Delete failed', 'error');
  }
}

async function toggleComplete(todo) {
  try {
    await updateTodo(todo.id, { completed: !todo.completed });
    showToast(todo.completed ? 'Marked as active' : 'Task completed! 🎉', 'success');
    fetchAndRender();
  } catch {
    showToast('Update failed', 'error');
  }
}

// ── Modal ─────────────────────────────────────────────────────
function openModal() {
  modalOverlay.classList.add('open');
  taskTitleInput.focus();
}

function closeModal() {
  modalOverlay.classList.remove('open');
  resetForm();
}

function resetForm() {
  state.editingId = null;
  modalTitle.textContent  = 'New Task';
  taskTitleInput.value    = '';
  taskDescInput.value     = '';
  taskPriorityInput.value = 'medium';
  taskCategoryInput.value = 'General';
  taskDueInput.value      = '';
  editIdInput.value       = '';
}

function openEditModal(todo) {
  state.editingId = todo.id;
  modalTitle.textContent    = 'Edit Task';
  taskTitleInput.value      = todo.title;
  taskDescInput.value       = todo.description || '';
  taskPriorityInput.value   = todo.priority;
  taskCategoryInput.value   = todo.category;
  taskDueInput.value        = todo.due_date || '';
  editIdInput.value         = todo.id;
  openModal();
}

async function saveTask() {
  const title = taskTitleInput.value.trim();
  if (!title) {
    taskTitleInput.classList.add('shake');
    setTimeout(() => taskTitleInput.classList.remove('shake'), 400);
    showToast('Please enter a task title', 'error');
    return;
  }

  const payload = {
    title,
    description: taskDescInput.value.trim(),
    priority:    taskPriorityInput.value,
    category:    taskCategoryInput.value.trim() || 'General',
    due_date:    taskDueInput.value || null,
  };

  try {
    if (state.editingId) {
      await updateTodo(state.editingId, payload);
      showToast('Task updated ✓', 'success');
    } else {
      await createTodo(payload);
      showToast('Task added ✓', 'success');
    }
    closeModal();
    fetchAndRender();
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

// ── Filters ───────────────────────────────────────────────────
function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('[data-filter]').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === filter)
  );
  const titles = { all: 'All Tasks', active: 'Active Tasks', completed: 'Completed Tasks' };
  document.getElementById('page-title').textContent = titles[filter];
  fetchAndRender();
}

function setCategory(cat) {
  state.category = cat;
  fetchAndRender();
}

// ── Clear completed ────────────────────────────────────────────
async function clearCompleted() {
  if (!confirm('Remove all completed tasks?')) return;
  try {
    await fetch(`${API}/clear-completed`, { method: 'DELETE' });
    showToast('Cleared completed tasks', 'success');
    fetchAndRender();
  } catch {
    showToast('Failed to clear', 'error');
  }
}

// ── Analytics ─────────────────────────────────────────────────
async function fetchAnalytics() {
  const dateEl = document.getElementById('analytics-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }
  try {
    const res  = await fetch('/api/analytics');
    const data = await res.json();
    renderAnalytics(data);
  } catch (err) {
    showToast('Failed to load analytics', 'error');
  }
}

function renderAnalytics(data) {
  const { overview, by_priority, by_category, daily_created, subtasks } = data;

  // KPI cards
  document.getElementById('kpi-completion').textContent = overview.completion_rate + '%';
  document.getElementById('kpi-total').textContent      = overview.total;
  document.getElementById('kpi-overdue').textContent    = overview.overdue;
  document.getElementById('kpi-highpri').textContent    = overview.high_priority_active;

  renderDailyChart(daily_created);
  renderPriorityChart(by_priority);
  renderCategoryChart(by_category);
  renderSubtaskRing(subtasks);
}

function renderDailyChart(dailyData) {
  if (chartDaily) { chartDaily.destroy(); chartDaily = null; }

  const labels = dailyData.map(d => {
    const dt = new Date(d.day + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const values = dailyData.map(d => d.created);

  const canvas = document.getElementById('chart-daily');
  const ctx    = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, 'rgba(139,92,246,0.48)');
  gradient.addColorStop(1, 'rgba(139,92,246,0.0)');

  chartDaily = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Tasks Created',
        data: values,
        borderColor: '#8b5cf6',
        backgroundColor: gradient,
        borderWidth: 2.5,
        pointBackgroundColor: '#8b5cf6',
        pointBorderColor: '#0d0f14',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#13161e',
          borderColor: 'rgba(139,92,246,0.35)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y} task${ctx.parsed.y !== 1 ? 's' : ''} created`,
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#475569', font: { family: 'Inter', size: 11 } },
          border: { display: false },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#475569', font: { family: 'Inter', size: 11 }, precision: 0 },
          border: { display: false },
          beginAtZero: true,
        }
      }
    }
  });
}

function renderPriorityChart(priorityData) {
  if (chartPriority) { chartPriority.destroy(); chartPriority = null; }

  const colorMap = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
  const labelMap = { high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low' };

  // Ensure consistent order: high → medium → low
  const sorted = ['high', 'medium', 'low'].map(p =>
    priorityData.find(d => d.priority === p) || { priority: p, count: 0, done: 0 }
  );

  const labels = sorted.map(p => labelMap[p.priority]);
  const values = sorted.map(p => p.count);
  const colors = sorted.map(p => colorMap[p.priority]);

  const ctx = document.getElementById('chart-priority').getContext('2d');

  chartPriority = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'bb'),
        borderColor: colors,
        borderWidth: 2,
        hoverOffset: 6,
        hoverBorderWidth: 3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      animation: { duration: 900, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#13161e',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          padding: 12,
          cornerRadius: 8,
        }
      }
    }
  });

  // Custom HTML legend
  const total  = values.reduce((a, b) => a + b, 0);
  const legend = document.getElementById('priority-legend');
  legend.innerHTML = sorted.map((p, i) => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      <span class="legend-label">${labels[i]}</span>
      <span class="legend-count">${p.count}</span>
      <span class="legend-pct">${total > 0 ? Math.round(p.count / total * 100) : 0}%</span>
    </div>
  `).join('');
}

function renderCategoryChart(categoryData) {
  if (chartCategory) { chartCategory.destroy(); chartCategory = null; }
  if (!categoryData.length) return;

  const labels    = categoryData.map(c => c.category);
  const totals    = categoryData.map(c => c.count);
  const completed = categoryData.map(c => c.done);

  // Dynamically adjust height based on row count
  const wrapper = document.querySelector('.chart-category-wrapper');
  if (wrapper) wrapper.style.height = Math.max(200, categoryData.length * 42 + 60) + 'px';

  const ctx = document.getElementById('chart-category').getContext('2d');

  chartCategory = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Total',
          data: totals,
          backgroundColor: 'rgba(6,182,212,0.18)',
          borderColor: 'rgba(6,182,212,0.7)',
          borderWidth: 1.5,
          borderRadius: 5,
          borderSkipped: false,
        },
        {
          label: 'Completed',
          data: completed,
          backgroundColor: 'rgba(139,92,246,0.45)',
          borderColor: '#8b5cf6',
          borderWidth: 1.5,
          borderRadius: 5,
          borderSkipped: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      animation: { duration: 800, easing: 'easeInOutQuart' },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: '#94a3b8',
            font: { family: 'Inter', size: 11 },
            boxWidth: 12, boxHeight: 12, padding: 14,
            usePointStyle: true, pointStyle: 'rectRounded',
          }
        },
        tooltip: {
          backgroundColor: '#13161e',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          padding: 12,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#475569', font: { family: 'Inter', size: 11 }, precision: 0 },
          border: { display: false },
          beginAtZero: true,
        },
        y: {
          grid: { display: false },
          ticks: { color: '#94a3b8', font: { family: 'Inter', size: 12 } },
          border: { display: false },
        }
      }
    }
  });
}

function renderSubtaskRing(subtaskData) {
  const pct          = subtaskData.rate || 0;
  const circumference = 2 * Math.PI * 40; // ≈ 251.2
  const offset       = circumference * (1 - pct / 100);

  const ringFill = document.getElementById('subtask-ring-fill');
  if (ringFill) ringFill.style.strokeDashoffset = offset;

  const ringText = document.getElementById('subtask-ring-text');
  if (ringText) ringText.textContent = Math.round(pct) + '%';

  const doneEl  = document.getElementById('subtask-done-count');
  const totalEl = document.getElementById('subtask-total-count');
  if (doneEl)  doneEl.textContent  = subtaskData.completed;
  if (totalEl) totalEl.textContent = subtaskData.total;
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = type === 'success' ? '✓  ' + msg : '✕  ' + msg;
  toast.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── Event Bindings ─────────────────────────────────────────────
function bindEvents() {
  // Open / close modal
  document.getElementById('open-modal-btn').addEventListener('click', () => { resetForm(); openModal(); });
  document.getElementById('close-modal-btn').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('save-task-btn').addEventListener('click', saveTask);

  // Close on overlay click
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  // Enter to save
  taskTitleInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveTask(); });

  // Filter buttons
  document.querySelectorAll('[data-filter]').forEach(btn =>
    btn.addEventListener('click', () => setFilter(btn.dataset.filter))
  );

  // Category "All" button
  document.querySelector('[data-category="all"]').addEventListener('click', () => setCategory('all'));

  // Clear completed
  document.getElementById('clear-completed-btn').addEventListener('click', clearCompleted);

  // Search (debounced)
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = searchInput.value; fetchAndRender(); }, 300);
  });

  // Analytics view toggle
  document.getElementById('view-tasks-btn').addEventListener('click', () => switchView('tasks'));
  document.getElementById('view-analytics-btn').addEventListener('click', () => switchView('analytics'));
  document.getElementById('refresh-analytics-btn').addEventListener('click', fetchAnalytics);
}

// ── Helpers ───────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function priorityLabel(p) {
  return { high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low' }[p] || p;
}
