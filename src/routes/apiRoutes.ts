import { Router } from 'express';
import { DatabaseController } from '../controllers/DatabaseController';

const router = Router();

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

export default router;
