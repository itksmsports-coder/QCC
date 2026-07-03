# QCC
Quality Control Center for defective production monitoring.
# QC Control Center 🏭

A simple, self-hosted dashboard for tracking quality-control defects on the production. QC log defects per employee/department, and the system automatically builds daily, weekly, monthly, and annual reports — no external database required.

Built with a **Flask** backend and a **single-file HTML/JS** frontend. All data is stored as plain JSON files on disk, so there's nothing to install besides Python.

---

## What it does

- **Live dashboard** — an overview page showing today's defect totals, a chart of activity throughout the day, and per-department KPI cards.
- **Per-department detail view** — see and edit each employee's defect counts, broken down by defect category (e.g. wrong color, wrong size, low quality).
- **Automatic daily reset & archiving** — every day at **6:00 AM**, the server snapshots the day's data into an archive and starts a fresh log. Those snapshots are automatically rolled up into weekly, monthly, and annual reports.
- **Report browser** — a calendar UI lets you pick any past date, week, month, or year and view the archived report.
- **Excel export** — download any department's current defect data as a formatted `.xlsx` file.
- **Audit log** — every update or reset is recorded with a timestamp, the user who made it, and what changed.
- **Simple login** — a basic username/password gate backed by a `users.json` file (see [Authentication](#authentication) below).

---

## How it's built

| Piece         | File                               | What it is                                                                               |
|---------------|------------------------------------|------------------------------------------------------------------------------------------|
| Backend / API | `admin_server.py`                  | A Flask app that serves the dashboard and exposes a JSON API for reading/writing data    |
| Frontend      | `admin_dashboard.html`             | A single HTML file containing all the UI, styling, and JavaScript — no build step needed |
| Data          | JSON files (created automatically) | See [Data & Folder Structure](#data--folder-structure) below                             |

There's no database — everything is stored as JSON files that the server reads and writes directly. This keeps the project easy to run, back up, and inspect by hand.

---

## Getting started

### 1. Requirements

- Python 3.9+
- The following Python packages:
  ```bash
  pip install flask openpyxl
  ```
  (`openpyxl` is only needed for the Excel export feature.)

### 2. Project layout

Put these two files in the same folder:
```
your-project/
├── admin_server.py
└── admin_dashboard.html
```

### 3. Run it

```bash
python admin_server.py
```

On first run, the server automatically creates all the folders and starter data files it needs (see below). Then open your browser to:

```
http://localhost:5050
```

### 4. Log in

The dashboard is protected by a simple login screen. A default account ships out of the box:

```
username: admin
password: admin123
```

**Change this before using the dashboard for real work** — see [Authentication](#authentication).

---

## Data & Folder Structure

The first time you run the server, it builds this folder tree for you:

```
your-project/
├── admin_server.py
├── admin_dashboard.html
├── users.json                  ← login accounts
├── audit_log.json              ← history of every change made
├── CUTTING/
│   └── data.json               ← live employee/defect data for "CUTTING"
├── EMBRO/
│   └── data.json               ← live employee/defect data for "EMBRO"
└── reports/
    ├── active/
    │   └── current.json        ← today's in-progress activity log
    ├── daily/
    │   └── 2026-07-03.json     ← one file per finished day
    ├── weekly/
    │   └── 2026-week-27.json   ← one file per ISO week
    ├── monthly/
    │   └── 2026-07.json        ← one file per month
    └── annual/
        └── 2026.json           ← one file per year
```

**Departments** are defined near the top of `admin_server.py`:

```python
DEPARTMENTS = {
    "CUTTING": os.path.join(BASE_DIR, "CUTTING", "data.json"),
    "EMBRO":   os.path.join(BASE_DIR, "EMBRO",   "data.json"),
}
```

To add a new department, add an entry here (and a matching set of default defect categories) and restart the server.

### How the daily reset works

- Every "day" runs from **6:00 AM to 6:00 AM** (not midnight to midnight), which matches a typical factory shift.
- When the server notices the 6 AM boundary has passed, it:
  1. Saves a snapshot of the day into `reports/daily/`
  2. Adds that day's totals into the current week's, month's, and year's report files
  3. Clears `reports/active/current.json` so the new day starts at zero
- You can also trigger this manually (useful for testing) by calling `POST /api/report/archive-now`.

---

## Authentication

Login accounts live in `users.json`, served as a plain array:

```json
[
  { "username": "admin", "password": "admin123" }
]
```

To add or change accounts, just edit this file and add more `{ "username": ..., "password": ... }` entries.

> ⚠️ **Heads up:** this is a lightweight login meant to keep casual users out — passwords are stored in plain text and checked in the browser, not verified securely on the server. It's fine for an internal, trusted network, but **don't expose this dashboard to the public internet as-is.** If you need real security (hashed passwords, server-side sessions, HTTPS), that would need to be added.

---

## API Reference (backend routes)

All routes return JSON, except the ones serving the dashboard's static files.

### Live data
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/departments` | Get current employee/defect data for every department |
| `GET` | `/api/chart-log` | Get today's raw activity log (used to draw the chart) |
| `GET` | `/api/audit-log` | Get the history of changes, most recent first |
| `POST` | `/api/update` | Save updated employee/defect data for one department |
| `POST` | `/api/reset` | Zero out all defect counts for one department |
| `POST` | `/api/export` | Download a department's data as an Excel file |

### Reports (archives)
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/report/available-dates` | List every date that has a saved daily report |
| `GET` | `/api/report/daily/<date>` | Get a report for one day (`YYYY-MM-DD`, or `today` for live data) |
| `GET` | `/api/report/weekly/<week>` | Get a report for one week (`YYYY-week-WW`, or `current`) |
| `GET` | `/api/report/monthly/<month>` | Get a report for one month (`YYYY-MM`, or `current`) |
| `GET` | `/api/report/annual/<year>` | Get a report for one year (`YYYY`, or `current`) |
| `POST` | `/api/report/archive-now` | Manually run the day-end archive (for testing) |

---

## Frontend overview (`admin_dashboard.html`)

Everything the user sees lives in this one file: HTML markup, CSS styling, and JavaScript logic, all together. It has three main views, switched between using tabs:

1. **Overview** — KPI cards, today's activity chart, and a per-department comparison
2. **Review Reports** — a calendar and quick-view buttons (week/month/year) for browsing archived reports
3. **Department Detail** — a table for viewing and editing one department's employee defect counts, plus Reset/Export/Update buttons

The frontend talks to the backend purely through `fetch()` calls to the `/api/...` routes listed above — there's no separate frontend framework or build tool involved.

---

## Customizing defect categories

Each department has its own set of defect categories with default values. These live in `admin_server.py`:

```python
DEFAULT_DEFECTS_CUTTING = {
    "WRONG_COLOR": 0, "WRONG_SIZE": 0, "WRONG_CUT": 0,
    "OFF_SHADE": 0, "LOW_QUALITY": 0, "WRONG_MATERIAL": 0, "OTHERS": 0,
}
```

Edit these dictionaries (or add a new one for a new department) to change what categories show up for new employees. Existing saved data isn't affected until an employee's data is reset or rebuilt.

---

## Troubleshooting

- **"openpyxl not installed" error on export** → run `pip install openpyxl`
- **Dashboard shows no data** → make sure you're running the server from the folder containing `admin_dashboard.html`, and check the terminal for `[BOOTSTRAP]` messages confirming folders were created
- **Report for a date is missing** → reports only exist for days that have finished (passed the 6 AM boundary); today's data always shows live instead

---

## License

License
Copyright © 2026 KSM Sports - K.Calantog . All rights reserved.

This software is proprietary. It is intended for internal use only.

No part of this software may be copied, modified, distributed, sublicensed, or used outside the organization without prior written permission.
