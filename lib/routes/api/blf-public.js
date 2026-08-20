const router = require('express').Router();
const sysError = require('../error');
const BlfConfiguration = require('../../models/blf-configuration');
const BlfMonitor = require('../../models/blf-monitor');
const {hashToken} = require('../../utils/blf-tokens');
const {buildAvailabilityResponse, parseExtensionQuery} = require('../../utils/blf-availability');

const handleAvailability = async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const token = req.params.token;
    if (!token) return res.sendStatus(404);
    const rows = await BlfConfiguration.retrieveByTokenHash(hashToken(token));
    if (!rows.length) return res.sendStatus(401);
    const cfg = rows[0];
    if (!cfg.is_enabled) return res.status(403).json({message: 'BLF configuration is disabled'});

    const monitors = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
    const filter = parseExtensionQuery(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(buildAvailabilityResponse(cfg, monitors, filter.length ? filter : null));
  } catch (err) {
    sysError(logger, res, err);
  }
};

router.get('/:token', handleAvailability);
router.post('/:token', handleAvailability);

module.exports = router;
