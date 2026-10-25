const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { getDashboard, createSavingsGoal } = require('../controllers/dashboardController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getDashboard);
router.post('/goals', createSavingsGoal);

module.exports = router;
