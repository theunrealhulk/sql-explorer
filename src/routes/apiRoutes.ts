import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { DatabaseController } from '../controllers/DatabaseController';

const router = Router();

// Store uploaded SQLite files under uploads/ with their original name preserved.
const uploadDir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

router.post('/connect', DatabaseController.connect);
router.post('/db-stats', DatabaseController.dbStats);
router.post('/objects', DatabaseController.objects);
router.post('/tables', DatabaseController.tables);
router.post('/columns', DatabaseController.columns);
router.post('/data', DatabaseController.data);
router.post('/relations', DatabaseController.relations);
router.post('/db-relations', DatabaseController.dbRelations);
router.post('/view-definition', DatabaseController.viewDefinition);
router.post('/schema', DatabaseController.schema);
router.post('/query', DatabaseController.query);
router.post('/edit-meta', DatabaseController.editMeta);
router.get('/config', DatabaseController.config);
router.post('/upload-sqlite', upload.single('file'), DatabaseController.uploadSqlite);

export default router;
