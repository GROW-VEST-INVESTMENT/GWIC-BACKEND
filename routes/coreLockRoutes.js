const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { getCoreLock } = require('../controllers/coreLockController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getCoreLock);

module.exports = router;
