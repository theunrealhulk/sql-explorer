import 'dotenv/config';
import express from 'express';
import path from 'path';
import apiRoutes from './routes/apiRoutes';

const app = express();
app.use(express.json());

// Static assets and views live at the project root, one level above the compiled dist/ dir.
const viewsDir = path.join(__dirname, '..', 'views');
app.use(express.static(viewsDir));

// Database engine logo assets (svg files under assets/).
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Third-party browser assets (Lucide icons UMD bundle)
app.use(
  '/vendor/lucide',
  express.static(path.join(__dirname, '..', 'node_modules', 'lucide', 'dist', 'umd'))
);

// Third-party browser assets (D3.js UMD bundle)
app.use(
  '/vendor/d3',
  express.static(path.join(__dirname, '..', 'node_modules', 'd3', 'dist'))
);

// Third-party browser assets (JSONEditor)
app.use(
  '/vendor/jsoneditor',
  express.static(path.join(__dirname, '..', 'node_modules', 'jsoneditor', 'dist'))
);

// View
app.get('/', (_req, res) => res.sendFile(path.join(viewsDir, 'index.html')));

// API routes -> controllers
app.use('/api', apiRoutes);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
