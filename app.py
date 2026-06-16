from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import Optional
import sqlite3
from datetime import datetime, date, timedelta
import os

# Resolve paths relative to this file so they work in Vercel's Lambda env
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@asynccontextmanager
async def lifespan(app: FastAPI):
    # /tmp is writable on both Vercel and Cloud Run; use it for the database
    try:
        os.makedirs("/tmp", exist_ok=True)
    except OSError:
        pass
    init_db()
    yield

app = FastAPI(title="TaskFlow", description="Premium Todo List App", lifespan=lifespan)

# On Vercel, /static/* is served by the CDN (vercel.json routes it directly).
# Only mount StaticFiles locally so uvicorn can serve them in dev mode.
if not os.environ.get("VERCEL"):
    app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# /tmp is the only writable directory on Vercel; fall back to project root for local dev
DATABASE = os.path.join("/tmp", "todos.db") if os.environ.get("VERCEL") else os.path.join(BASE_DIR, "todos.db")


# ── Database helpers ─────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS todos (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                description TEXT,
                priority    TEXT    DEFAULT 'medium',
                category    TEXT    DEFAULT 'General',
                completed   BOOLEAN DEFAULT 0,
                created_at  TEXT    NOT NULL,
                due_date    TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subtasks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                todo_id     INTEGER NOT NULL,
                title       TEXT    NOT NULL,
                completed   BOOLEAN DEFAULT 0,
                created_at  TEXT    NOT NULL,
                FOREIGN KEY (todo_id) REFERENCES todos (id) ON DELETE CASCADE
            )
        """)
        conn.commit()




# ── Pydantic models ───────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    priority: Optional[str] = "medium"
    category: Optional[str] = "General"
    due_date: Optional[str] = None


class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    category: Optional[str] = None
    completed: Optional[bool] = None
    due_date: Optional[str] = None


class SubtaskCreate(BaseModel):
    title: str


class SubtaskUpdate(BaseModel):
    title: Optional[str] = None
    completed: Optional[bool] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/todos")
def get_todos(
    filter: str = "all",
    category: str = "all",
    search: str = "",
):
    with get_db() as conn:
        query = "SELECT * FROM todos WHERE 1=1"
        params: list = []

        if filter == "active":
            query += " AND completed = 0"
        elif filter == "completed":
            query += " AND completed = 1"

        if category != "all":
            query += " AND category = ?"
            params.append(category)

        if search:
            query += " AND (title LIKE ? OR description LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])

        query += (
            " ORDER BY completed ASC,"
            " CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,"
            " created_at DESC"
        )

        todos = [dict(t) for t in conn.execute(query, params).fetchall()]

        if todos:
            todo_ids = [t["id"] for t in todos]
            placeholders = ",".join("?" for _ in todo_ids)
            subtask_rows = conn.execute(
                f"SELECT * FROM subtasks WHERE todo_id IN ({placeholders}) ORDER BY created_at ASC",
                todo_ids
            ).fetchall()
            
            subtasks_map = {}
            for row in subtask_rows:
                subtasks_map.setdefault(row["todo_id"], []).append({
                    "id": row["id"],
                    "todo_id": row["todo_id"],
                    "title": row["title"],
                    "completed": bool(row["completed"]),
                    "created_at": row["created_at"]
                })
            
            for t in todos:
                t["subtasks"] = subtasks_map.get(t["id"], [])
        else:
            for t in todos:
                t["subtasks"] = []

        total     = conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]
        active    = conn.execute("SELECT COUNT(*) FROM todos WHERE completed = 0").fetchone()[0]
        completed = conn.execute("SELECT COUNT(*) FROM todos WHERE completed = 1").fetchone()[0]
        categories = [
            r["category"]
            for r in conn.execute("SELECT DISTINCT category FROM todos").fetchall()
        ]

    return {
        "todos": todos,
        "stats": {"total": total, "active": active, "completed": completed},
        "categories": categories,
    }


@app.post("/api/todos", status_code=201)
def create_todo(todo: TodoCreate):
    title = todo.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")

    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO todos (title, description, priority, category, created_at, due_date)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                title,
                todo.description,
                todo.priority,
                todo.category,
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                todo.due_date,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (cursor.lastrowid,)).fetchone()

    res = dict(row)
    res["subtasks"] = []
    return res


@app.put("/api/todos/{todo_id}")
def update_todo(todo_id: int, todo: TodoUpdate):
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Todo not found")

        fields, params = [], []
        update_data = todo.model_dump(exclude_none=True)

        for key, value in update_data.items():
            fields.append(f"{key} = ?")
            params.append(1 if (key == "completed" and value is True) else
                          0 if (key == "completed" and value is False) else value)

        if fields:
            params.append(todo_id)
            conn.execute(f"UPDATE todos SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()

        updated = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        subtask_rows = conn.execute("SELECT * FROM subtasks WHERE todo_id = ? ORDER BY created_at ASC", (todo_id,)).fetchall()

    res = dict(updated)
    res["subtasks"] = [{
        "id": r["id"],
        "todo_id": r["todo_id"],
        "title": r["title"],
        "completed": bool(r["completed"]),
        "created_at": r["created_at"]
    } for r in subtask_rows]
    return res


@app.delete("/api/todos/clear-completed")
def clear_completed():
    with get_db() as conn:
        conn.execute("DELETE FROM todos WHERE completed = 1")
        conn.commit()
    return {"message": "Cleared completed todos"}


@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: int):
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Todo not found")
        conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        conn.commit()
    return {"message": "Deleted successfully"}


@app.post("/api/todos/{todo_id}/subtasks", status_code=201)
def create_subtask(todo_id: int, subtask: SubtaskCreate):
    title = subtask.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Subtask title is required")
    with get_db() as conn:
        todo = conn.execute("SELECT 1 FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not todo:
            raise HTTPException(status_code=404, detail="Todo not found")
        cursor = conn.execute(
            "INSERT INTO subtasks (todo_id, title, completed, created_at) VALUES (?, ?, 0, ?)",
            (todo_id, title, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        )
        conn.commit()
        row = conn.execute("SELECT * FROM subtasks WHERE id = ?", (cursor.lastrowid,)).fetchone()
    res = dict(row)
    res["completed"] = bool(res["completed"])
    return res


@app.put("/api/subtasks/{subtask_id}")
def update_subtask(subtask_id: int, subtask: SubtaskUpdate):
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM subtasks WHERE id = ?", (subtask_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Subtask not found")
        fields, params = [], []
        update_data = subtask.model_dump(exclude_none=True)
        for key, value in update_data.items():
            fields.append(f"{key} = ?")
            params.append(1 if (key == "completed" and value is True) else
                          0 if (key == "completed" and value is False) else value)
        if fields:
            params.append(subtask_id)
            conn.execute(f"UPDATE subtasks SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        updated = conn.execute("SELECT * FROM subtasks WHERE id = ?", (subtask_id,)).fetchone()
    res = dict(updated)
    res["completed"] = bool(res["completed"])
    return res


@app.delete("/api/subtasks/{subtask_id}")
def delete_subtask(subtask_id: int):
    with get_db() as conn:
        existing = conn.execute("SELECT 1 FROM subtasks WHERE id = ?", (subtask_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Subtask not found")
        conn.execute("DELETE FROM subtasks WHERE id = ?", (subtask_id,))
        conn.commit()
    return {"message": "Subtask deleted successfully"}


# ── Analytics ────────────────────────────────────────────────────────────

@app.get("/api/analytics")
def get_analytics():
    with get_db() as conn:
        total     = conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]
        active    = conn.execute("SELECT COUNT(*) FROM todos WHERE completed=0").fetchone()[0]
        completed = conn.execute("SELECT COUNT(*) FROM todos WHERE completed=1").fetchone()[0]
        overdue   = conn.execute(
            "SELECT COUNT(*) FROM todos WHERE completed=0 AND due_date IS NOT NULL AND due_date < date('now')"
        ).fetchone()[0]
        high_active = conn.execute(
            "SELECT COUNT(*) FROM todos WHERE priority='high' AND completed=0"
        ).fetchone()[0]

        priority_rows = conn.execute(
            "SELECT priority, COUNT(*) as count, "
            "SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as done "
            "FROM todos GROUP BY priority"
        ).fetchall()

        category_rows = conn.execute(
            "SELECT category, COUNT(*) as count, "
            "SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as done "
            "FROM todos GROUP BY category ORDER BY count DESC LIMIT 8"
        ).fetchall()

        daily_rows = conn.execute("""
            SELECT date(created_at) as day, COUNT(*) as created
            FROM todos
            WHERE date(created_at) >= date('now', '-13 days')
            GROUP BY day ORDER BY day
        """).fetchall()

        subtask_total = conn.execute("SELECT COUNT(*) FROM subtasks").fetchone()[0]
        subtask_done  = conn.execute("SELECT COUNT(*) FROM subtasks WHERE completed=1").fetchone()[0]

    # Fill in missing days so chart always shows 14 data points
    daily_map = {r["day"]: r["created"] for r in daily_rows}
    today = date.today()
    daily_data = [
        {"day": (today - timedelta(days=i)).isoformat(),
         "created": daily_map.get((today - timedelta(days=i)).isoformat(), 0)}
        for i in range(13, -1, -1)
    ]

    return {
        "overview": {
            "total": total,
            "active": active,
            "completed": completed,
            "completion_rate": round(completed / total * 100, 1) if total > 0 else 0,
            "overdue": overdue,
            "high_priority_active": high_active,
        },
        "by_priority": [dict(r) for r in priority_rows],
        "by_category": [dict(r) for r in category_rows],
        "daily_created": daily_data,
        "subtasks": {
            "total": subtask_total,
            "completed": subtask_done,
            "rate": round(subtask_done / subtask_total * 100, 1) if subtask_total > 0 else 0,
        },
    }


# ── Entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=(port == 8000))

