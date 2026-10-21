const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// The official launcher uses the existing Bedragoth distribution.
// Use BEDRAGOTH_DISTRO_URL only when validating a separate distribution locally.
exports.REMOTE_DISTRO_URL = process.env.BEDRAGOTH_DISTRO_URL
    || 'https://bedragoth.strator.gg/nebula/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
