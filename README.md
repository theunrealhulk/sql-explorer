# SQL Explorer

A lightweight, browser-based SQL Server explorer. Connect with a connection string, browse databases, schemas, tables, views and objects, inspect columns and relationships, view and edit data, and run ad‑hoc SQL queries — all from a clean web UI.

## Features

- Connect to Microsoft SQL Server using a standard connection string
- Browse databases, schemas, tables, views and other objects
- Inspect table columns, foreign keys and relationships
- Visualize database relations (D3-powered diagrams)
- View and page through table data
- Run ad‑hoc SQL queries with a CodeMirror-based editor (SQL syntax + linting)
- View definitions of views
- Auto-detects the database engine from the connection string and updates the header branding
- Modern UI built with Tailwind CSS + daisyUI

## Tech Stack

- **Backend:** Node.js, Express 5, TypeScript
- **Database driver:** `mssql`
- **Frontend:** Static HTML + vanilla JS, Tailwind CSS, daisyUI, D3.js, CodeMirror, JSONEditor
- **SQL parsing:** `node-sql-parser`

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (includes npm)
- A reachable Microsoft SQL Server instance and credentials

## Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/theunrealhulk/sql-explorer.git
   cd sql-explorer
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file in the project root:

   ```env
   # Port the web server listens on (defaults to 3000 if omitted)
   PORT=3000

   # Optional: pre-fills the connection string field in the UI
   DEFAULT_CONNECTION_STRING=Server=localhost,1433;User Id=sa;Password=YourPassword;TrustServerCertificate=True;
   ```

   > `DEFAULT_CONNECTION_STRING` is optional. If set, it is served to the UI as the default connection string so you don't have to type it each time. Never commit real credentials.

4. Build the project (compiles TypeScript, bundles the editor, and builds CSS):

   ```bash
   npm run build
   npm run build:css
   ```

## Running

### Production / one-off

```bash
npm start
```

Then open <http://localhost:3000> (or whatever `PORT` you configured).

### Development (auto-reload)

Runs the server with `nodemon`, rebuilding `dist/` from `src/` on changes:

```bash
npm run dev
```

To rebuild Tailwind CSS on changes in a separate terminal:

```bash
npm run watch:css
```

## Usage

1. Start the server and open the app in your browser.
2. Paste (or confirm the pre-filled) SQL Server **connection string** and click **Connect**.
3. Use the sidebar to browse databases, then drill into schemas, tables and views.
4. Select a table to view its columns, relationships and data.
5. Open a SQL tab to write and run ad‑hoc queries against the selected database.

Example connection string:

```text
Server=localhost,1433;User Id=sa;Password=YourPassword;TrustServerCertificate=True;
```

## npm Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Compile TypeScript (`tsc`) and bundle the CodeMirror editor |
| `npm run build:css` | Build minified Tailwind/daisyUI CSS into `views/output.css` |
| `npm run build:editor` | Bundle the CodeMirror editor with esbuild |
| `npm start` | Run the compiled server from `dist/server.js` |
| `npm run dev` | Run the server with `nodemon` for development |
| `npm run watch:css` | Rebuild CSS on change |

## Project Structure

```text
src/
  server.ts                 # Express app: static assets, views, API routes
  routes/apiRoutes.ts       # REST endpoints (POST /api/*)
  controllers/              # Request handlers
  models/SqlServerModel.ts  # SQL Server data access logic
  config/db.ts              # Database connection helpers
  editor/                   # CodeMirror editor entry (bundled to views/vendor)
  input.css                 # Tailwind input stylesheet
views/                      # index.html + client JS + built assets
assets/                     # Database engine logos (SVG)
dist/                       # Compiled JS output (generated)
```

## API Overview

All endpoints are served under `/api` and accept `POST` (unless noted). They generally take a `connectionString` (and often `database`, `schema`, `table`) in the JSON body.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/connect` | Connect and list databases |
| `POST /api/db-stats` | Database statistics |
| `POST /api/objects` | List object categories |
| `POST /api/tables` | List tables |
| `POST /api/columns` | List columns for a table |
| `POST /api/data` | Fetch table data |
| `POST /api/relations` | Table relationships |
| `POST /api/db-relations` | Database-wide relationships |
| `POST /api/view-definition` | View definition |
| `POST /api/schema` | Database schema |
| `POST /api/query` | Run an ad‑hoc SQL query |
| `POST /api/edit-meta` | Metadata for editing rows |
| `GET  /api/config` | Returns the default connection string (from `.env`) |

## Troubleshooting

- **Logos or assets return 404 / not visible:** you're likely running a stale build. Stop the old server, then `npm run build` and restart with `npm start`. Hard-refresh the browser (`Ctrl+F5`).
- **Port already in use:** another process is on your `PORT`. Stop it or change `PORT` in `.env`.
- **Connection errors:** verify the SQL Server host/port, credentials, and that `TrustServerCertificate=True` is set if using a self-signed certificate.
