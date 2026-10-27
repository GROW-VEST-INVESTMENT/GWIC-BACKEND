const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { getPortfolio } = require('../controllers/portfolioController');

const router = express.Router();

router.use(requireAuth);
router.get('/', getPortfolio);

module.exports = router;
