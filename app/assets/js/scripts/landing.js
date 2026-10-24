/**
 * Script for landing.ejs
 */
// Requirements
const { URL }                 = require('url')
const landingPath                  = require('path')
const landingFs                    = require('fs-extra')
const { shell: landingShell, clipboard: landingClipboard } = require('electron')
const landingRemote = require('@electron/remote')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')
const modernLaunchProgress    = document.getElementById('modernLaunchProgress')
const modernLaunchProgressText = document.getElementById('modernLaunchProgressText')
const modernLaunchProgressPercent = document.getElementById('modernLaunchProgressPercent')
const modernLaunchProgressFill = document.getElementById('modernLaunchProgressFill')
const landingDiagnosticAlert  = document.getElementById('landingDiagnosticAlert')
const landingDiagnosticAlertMessage = document.getElementById('landingDiagnosticAlertMessage')
const landingDiagnosticFixButton = document.getElementById('landingDiagnosticFixButton')
const bedragothServerCapsule = document.getElementById('bedragothServerCapsule')
const bedragothServerStatusState = document.getElementById('bedragothServerStatusState')
const bedragothServerStatusPlayers = document.getElementById('bedragothServerStatusPlayers')
const bedragothServerLatency = document.getElementById('bedragothServerLatency')
const bedragothServerPing = document.getElementById('bedragothServerPing')
const majorOperationOverlay = document.getElementById('majorOperationOverlay')
const majorOperationTitle = document.getElementById('majorOperationTitle')
const majorOperationDetail = document.getElementById('majorOperationDetail')
const majorOperationProgressFill = document.getElementById('majorOperationProgressFill')
const majorOperationPercent = document.getElementById('majorOperationPercent')
const majorOperationAccount = document.getElementById('majorOperationAccount')

const loggerLanding = LoggerUtil.getLogger('Landing')

// Bedragoth remote launcher state (configured through distribution.json).
let bedragothMaintenanceEnabled = false
let bedragothMaintenanceMessage = ''
let bedragothServerMessage = ''
let launchUiBusy = false
let launchUiMode = 'idle'
let diagnosticFixHandler = null
let majorOperationActive = false
let majorOperationKind = null
let majorOperationHideTimer = null

function getSelectedAccountDisplayName(){
    try {
        return ConfigManager.getSelectedAccount()?.displayName || user_text?.textContent || ''
    } catch(_err) {
        return user_text?.textContent || ''
    }
}

function setServerCapsuleState(online, players = null, maxPlayers = null, ping = null){
    if(!bedragothServerCapsule) return

    bedragothServerCapsule.dataset.state = online ? 'online' : 'offline'
    bedragothServerStatusState.textContent = online ? 'EN LIGNE' : 'HORS LIGNE'
    bedragothServerStatusPlayers.textContent = online && players != null ? `${players}${maxPlayers != null ? ` / ${maxPlayers}` : ''} joueur${players === 1 ? '' : 's'}` : '—'

    if(online && Number.isFinite(ping)){
        const roundedPing = Math.max(1, Math.round(ping))
        bedragothServerPing.textContent = `${roundedPing} ms`
        bedragothServerLatency.dataset.quality = roundedPing <= 90 ? 'good' : (roundedPing <= 180 ? 'medium' : 'poor')
    } else {
        bedragothServerPing.textContent = '— ms'
        bedragothServerLatency.dataset.quality = 'offline'
    }
}

function showMajorOperationOverlay(title, detail = '', kind = 'game'){
    if(!majorOperationOverlay) return
    if(majorOperationHideTimer){
        clearTimeout(majorOperationHideTimer)
        majorOperationHideTimer = null
    }

    majorOperationActive = true
    majorOperationKind = kind
    majorOperationTitle.textContent = title || 'PRÉPARATION DE BEDRAGOTH'
    majorOperationDetail.textContent = detail || 'Préparation...'
    majorOperationProgressFill.style.width = '0%'
    majorOperationPercent.textContent = '0%'

    const accountName = getSelectedAccountDisplayName()
    majorOperationAccount.textContent = accountName ? `Connexion en tant que ${accountName}` : 'Préparation du client Bedragoth'

    majorOperationOverlay.classList.add('visible')
    majorOperationOverlay.setAttribute('aria-hidden', 'false')
}

function hideMajorOperationOverlay(delay = 0){
    if(!majorOperationOverlay || !majorOperationActive) return

    const hide = () => {
        majorOperationOverlay.classList.remove('visible')
        majorOperationOverlay.setAttribute('aria-hidden', 'true')
        majorOperationActive = false
        majorOperationKind = null
        majorOperationHideTimer = null
    }

    if(delay > 0){
        if(majorOperationHideTimer) clearTimeout(majorOperationHideTimer)
        majorOperationHideTimer = setTimeout(hide, delay)
    } else {
        hide()
    }
}

function setMajorOperationTitleForMode(mode){
    if(!majorOperationActive || majorOperationKind !== 'game') return
    if(mode === 'updating'){
        majorOperationTitle.textContent = 'MISE À JOUR DE BEDRAGOTH'
    } else if(mode === 'launching'){
        majorOperationTitle.textContent = 'LANCEMENT DE BEDRAGOTH'
    } else if(mode === 'preparing'){
        majorOperationTitle.textContent = 'PRÉPARATION DE BEDRAGOTH'
    }
}

function getBedragothRemoteConfig(distro){
    return distro?.rawDistribution?.bedragoth || {}
}

async function applyBedragothRemoteConfig(distro = null){
    try {
        distro = distro || await DistroAPI.getDistribution()
        const cfg = getBedragothRemoteConfig(distro)
        const maintenance = cfg.maintenance || {}
        bedragothMaintenanceEnabled = maintenance === true || maintenance.enabled === true
        bedragothMaintenanceMessage = typeof maintenance === 'object' ? (maintenance.message || 'Le serveur est actuellement en maintenance.') : 'Le serveur est actuellement en maintenance.'
        bedragothServerMessage = typeof cfg.serverMessage === 'string' ? cfg.serverMessage : (typeof cfg.message === 'string' ? cfg.message : '')

        const launchButton = document.getElementById('launch_button')
        const maintenanceMessage = document.getElementById('maintenance_message')
        const remoteServerMessage = document.getElementById('remote_server_message')
        const selectedServer = ConfigManager.getSelectedServer()

        if(!launchUiBusy){
            launchButton.innerHTML = bedragothMaintenanceEnabled ? 'MAINTENANCE' : 'JOUER'
            launchButton.title = bedragothMaintenanceEnabled ? bedragothMaintenanceMessage : ''
            launchButton.disabled = bedragothMaintenanceEnabled || selectedServer == null
            launchUiMode = 'idle'
            launchButton.removeAttribute('data-mode')
        }

        if(remoteServerMessage != null){
            if(bedragothServerMessage.trim().length > 0){
                remoteServerMessage.textContent = bedragothServerMessage
                remoteServerMessage.style.display = 'block'
            } else {
                remoteServerMessage.style.display = 'none'
                remoteServerMessage.textContent = ''
            }
        }

        if(bedragothMaintenanceEnabled){
            maintenanceMessage.innerHTML = bedragothMaintenanceMessage
            maintenanceMessage.style.display = 'block'
        } else {
            maintenanceMessage.style.display = 'none'
            maintenanceMessage.innerHTML = ''
        }
    } catch(err) {
        loggerLanding.warn('Unable to apply Bedragoth remote launcher configuration.', err)
    }
}

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    const launchButton = document.getElementById('launch_button')
    launchUiBusy = loading

    // Keep the modern PLAY button visible while validation/download work happens.
    // The old launch_details nodes remain updated for compatibility, but are no longer
    // the primary visual progress surface.
    launch_details.style.display = 'none'
    launch_content.style.display = 'inline-flex'
    launch_content.classList.toggle('is-processing', loading)

    if(loading){
        modernLaunchProgress.classList.add('visible')
        modernLaunchProgress.setAttribute('aria-hidden', 'false')
        launchButton.disabled = true
        if(launchUiMode === 'idle'){
            setLaunchUiMode('preparing')
        }
    } else {
        modernLaunchProgress.classList.remove('visible')
        modernLaunchProgress.setAttribute('aria-hidden', 'true')
        if(majorOperationActive){
            hideMajorOperationOverlay(220)
        }
        setLaunchUiMode('idle')
        launchButton.innerHTML = bedragothMaintenanceEnabled ? 'MAINTENANCE' : 'JOUER'
        launchButton.title = bedragothMaintenanceEnabled ? bedragothMaintenanceMessage : ''
        launchButton.disabled = bedragothMaintenanceEnabled || ConfigManager.getSelectedServer() == null
    }
}

function setLaunchUiMode(mode){
    launchUiMode = mode
    const launchButton = document.getElementById('launch_button')
    launchButton.setAttribute('data-mode', mode)
    setMajorOperationTitleForMode(mode)

    switch(mode){
        case 'updating':
            launchButton.innerHTML = 'METTRE À JOUR'
            break
        case 'launching':
            launchButton.innerHTML = 'DÉMARRAGE...'
            break
        case 'preparing':
            launchButton.innerHTML = 'PRÉPARATION...'
            break
        default:
            launchButton.removeAttribute('data-mode')
            launchButton.innerHTML = bedragothMaintenanceEnabled ? 'MAINTENANCE' : 'JOUER'
            break
    }
}

function showLandingDiagnosticAlert(message = 'Un problème a été détecté', fixHandler = null){
    landingDiagnosticAlertMessage.textContent = message
    diagnosticFixHandler = typeof fixHandler === 'function' ? fixHandler : requestRepairInstallation
    landingDiagnosticAlert.classList.add('visible')
    landingDiagnosticAlert.setAttribute('aria-hidden', 'false')
}

function hideLandingDiagnosticAlert(){
    diagnosticFixHandler = null
    landingDiagnosticAlert.classList.remove('visible')
    landingDiagnosticAlert.setAttribute('aria-hidden', 'true')
}

landingDiagnosticFixButton.onclick = () => {
    const handler = diagnosticFixHandler || requestRepairInstallation
    handler()
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
    modernLaunchProgressText.textContent = details
    if(majorOperationActive){
        majorOperationDetail.textContent = String(details).replace(/<[^>]*>/g, '')
    }
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0))
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', safePercent)
    launch_progress_label.innerHTML = safePercent + '%'
    modernLaunchProgressPercent.textContent = safePercent + '%'
    modernLaunchProgressFill.style.width = safePercent + '%'
    if(majorOperationActive){
        majorOperationPercent.textContent = safePercent + '%'
        majorOperationProgressFill.style.width = safePercent + '%'
    }
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    if(bedragothMaintenanceEnabled){
        setOverlayContent('Serveur en maintenance', bedragothMaintenanceMessage, 'Fermer')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
        return
    }
    // Show the branded launch screen on EVERY click, even if all files are current.
    if(launchUiBusy) return
    showMajorOperationOverlay('PRÉPARATION DE BEDRAGOTH', 'Vérification de l’instance sélectionnée...', 'game')
    setLaunchDetails('Préparation du lancement...')
    toggleLaunchArea(true)
    setLaunchPercentage(0)

    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Force file verification/repair without launching Minecraft.
async function repairInstallation(){
    const repairButton = document.getElementById('repair_button')
    const launchButton = document.getElementById('launch_button')
    const oldRepairDisabled = repairButton.disabled
    const oldLaunchDisabled = launchButton.disabled
    let fullRepairModule = null

    try {
        repairButton.disabled = true
        launchButton.disabled = true
        showMajorOperationOverlay('RÉPARATION DE BEDRAGOTH', 'Préparation de la réparation...', 'repair')
        setLaunchDetails('Préparation de la réparation...')
        toggleLaunchArea(true)
        setLaunchPercentage(0)

        const distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)

        fullRepairModule = new FullRepair(
            ConfigManager.getCommonDirectory(),
            ConfigManager.getInstanceDirectory(),
            ConfigManager.getLauncherDirectory(),
            ConfigManager.getSelectedServer(),
            DistroAPI.isDevMode()
        )
        fullRepairModule.spawnReceiver()

        setLaunchDetails('Vérification des fichiers...')
        const invalidFileCount = await fullRepairModule.verifyFiles(percent => setLaunchPercentage(percent))
        setLaunchPercentage(100)

        if(invalidFileCount > 0){
            setLaunchUiMode('updating')
            setLaunchDetails(`Téléchargement de ${invalidFileCount} fichier(s) à réparer...`)
            setLaunchPercentage(0)
            await fullRepairModule.download(percent => setDownloadPercentage(percent))
            setDownloadPercentage(100)
        }

        remote.getCurrentWindow().setProgressBar(-1)
        setLaunchDetails('Réparation terminée')
        toggleLaunchArea(false)

        setOverlayContent(
            'Réparation terminée',
            invalidFileCount > 0
                ? `${invalidFileCount} fichier(s) ont été réparé(s).`
                : 'Tous les fichiers sont déjà intègres.',
            'OK'
        )
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    } catch(err) {
        loggerLanding.error('Repair failed.', err)
        remote.getCurrentWindow().setProgressBar(-1)
        toggleLaunchArea(false)
        setOverlayContent('Échec de la réparation', err.displayable?.desc || err.message || 'Consulte la console pour plus de détails.', 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    } finally {
        if(fullRepairModule != null){
            try { fullRepairModule.destroyReceiver() } catch(_err) { /* Already stopped. */ }
        }
        repairButton.disabled = oldRepairDisabled
        launchButton.disabled = bedragothMaintenanceEnabled ? true : oldLaunchDisabled
        await applyBedragothRemoteConfig().catch(() => {})
    }
}

function requestRepairInstallation(){
    setOverlayContent(
        'Réparer Bedragoth',
        'Cette opération vérifie les fichiers du jeu et du modpack pour le serveur. (mods, bibliothèques et autres fichiers déclarés dans la distribution), puis retélécharge ceux qui sont manquants ou invalides. Elle ne répare pas l\'application du launcher elle-même et ne supprime pas tes fichiers personnels.',
        'Lancer la réparation',
        'Annuler'
    )
    setOverlayHandler(() => {
        toggleOverlay(false)
        repairInstallation()
    })
    setDismissHandler(() => toggleOverlay(false))
    toggleOverlay(true, true)
}

document.getElementById('repair_button').onclick = requestRepairInstallation

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind DevTools / console button.
document.getElementById('devToolsMediaButton').onclick = () => {
    remote.getCurrentWindow().toggleDevTools()
}

// Quick support tools on the landing page.
const landingQuickTools = document.getElementById('landingQuickTools')
const landingQuickToolsButton = document.getElementById('quickToolsMediaButton')

function getLandingSelectedInstancePath(){
    const serverId = ConfigManager.getSelectedServer()
    return serverId != null
        ? landingPath.join(ConfigManager.getInstanceDirectory(), serverId)
        : ConfigManager.getInstanceDirectory()
}

function setLandingQuickToolsOpen(open){
    landingQuickTools.classList.toggle('open', open)
    landingQuickTools.setAttribute('aria-hidden', open ? 'false' : 'true')
    landingQuickToolsButton.classList.toggle('active', open)
}

landingQuickToolsButton.onclick = e => {
    e.stopPropagation()
    setLandingQuickToolsOpen(!landingQuickTools.classList.contains('open'))
}

landingQuickTools.onclick = e => e.stopPropagation()
document.addEventListener('click', () => setLandingQuickToolsOpen(false))

document.getElementById('landingOpenInstanceButton').onclick = async () => {
    const instancePath = getLandingSelectedInstancePath()
    await landingFs.ensureDir(instancePath)
    const error = await landingShell.openPath(instancePath)
    if(error){
        setOverlayContent('Impossible d\'ouvrir le dossier', error, 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}

document.getElementById('landingOpenLatestLogButton').onclick = async () => {
    const logsPath = landingPath.join(getLandingSelectedInstancePath(), 'logs')
    await landingFs.ensureDir(logsPath)
    const latestLog = landingPath.join(logsPath, 'latest.log')
    const target = landingFs.existsSync(latestLog) ? latestLog : logsPath
    const error = await landingShell.openPath(target)
    if(error){
        setOverlayContent('Impossible d\'ouvrir les logs', error, 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}


document.getElementById('landingCopyLatestLogButton').onclick = async () => {
    const latestLog = landingPath.join(getLandingSelectedInstancePath(), 'logs', 'latest.log')
    if(!landingFs.existsSync(latestLog)){
        setOverlayContent('latest.log introuvable', 'Aucun fichier latest.log n\'a été trouvé pour cette instance.', 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
        setLandingQuickToolsOpen(false)
        return
    }
    try {
        const content = await landingFs.readFile(latestLog, 'utf8')
        landingClipboard.writeText(content)
        setOverlayContent('latest.log copié', 'Le contenu de latest.log a été copié dans le presse-papiers.', 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    } catch(err) {
        setOverlayContent('Impossible de copier latest.log', err.message || String(err), 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}

document.getElementById('landingOpenCrashReportsButton').onclick = async () => {
    const crashPath = landingPath.join(getLandingSelectedInstancePath(), 'crash-reports')
    await landingFs.ensureDir(crashPath)
    const error = await landingShell.openPath(crashPath)
    if(error){
        setOverlayContent('Impossible d\'ouvrir crash-reports', error, 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}

document.getElementById('landingCopyDiagnosticsButton').onclick = async () => {
    try {
        const distro = await DistroAPI.getDistribution()
        const serverId = ConfigManager.getSelectedServer()
        const server = serverId != null ? distro.getServerById(serverId) : null
        const totalRam = (require('os').totalmem()/1073741824).toFixed(1)
        const freeRam = (require('os').freemem()/1073741824).toFixed(1)
        const javaExec = serverId != null ? ConfigManager.getJavaExecutable(serverId) : null
        const lines = [
            '=== Diagnostic Bedragoth ===',
            `Launcher : ${remote.app.getVersion()}`,
            `Système : ${process.platform} ${process.arch} - ${require('os').release()}`,
            `RAM : ${freeRam} Go libre / ${totalRam} Go total`,
            `Serveur : ${server?.rawServer?.name || serverId || 'Non sélectionné'}`,
            `ID serveur : ${serverId || 'N/A'}`,
            `Minecraft : ${server?.rawServer?.minecraftVersion || 'N/A'}`,
            `Version modpack : ${server?.rawServer?.version || server?.rawServer?.mainServer || 'N/A'}`,
            `Java : ${javaExec || 'Non sélectionné'}`,
            `Dossier données : ${ConfigManager.getDataDirectory()}`,
            `Instance : ${getLandingSelectedInstancePath()}`
        ]
        landingClipboard.writeText(lines.join('\n'))
        setOverlayContent('Diagnostic copié', 'Les informations de diagnostic ont été copiées dans le presse-papiers.', 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    } catch(err) {
        setOverlayContent('Diagnostic impossible', err.message || String(err), 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}

document.getElementById('landingRepairButton').onclick = () => {
    setLandingQuickToolsOpen(false)
    requestRepairInstallation()
}

document.getElementById('landingClearCacheButton').onclick = async () => {
    try {
        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()
        await landingRemote.session.defaultSession.clearCache()
        await landingRemote.session.defaultSession.clearStorageData({
            storages: ['appcache', 'serviceworkers', 'cachestorage', 'shadercache']
        })
        setOverlayContent('Cache vidé', 'Le cache du launcher a été vidé. Les news et ressources mises en cache seront rechargées au prochain affichage.', 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    } catch(err) {
        setOverlayContent('Impossible de vider le cache', err.message || String(err), 'OK')
        setOverlayHandler(() => toggleOverlay(false))
        toggleOverlay(true)
    }
    setLandingQuickToolsOpen(false)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    const serverDisplayName = serv != null ? String(serv.rawServer.name).replace(/\s*\(\s*Minecraft\s+[^)]+\)\s*$/i, '') : Lang.queryJS('landing.noSelection')
    server_selection_button.innerHTML = '&#8226; ' + serverDisplayName
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null && !bedragothMaintenanceEnabled)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const distro = await DistroAPI.getDistribution()
    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    let capsuleOnline = false
    let capsulePlayers = null
    let capsuleMaxPlayers = null
    let capsulePing = null

    if(serv != null){
        const pingStarted = performance.now()
        try {
            const servStat = await getServerStatus(47, serv.hostname, serv.port)
            capsulePing = performance.now() - pingStarted
            capsuleOnline = true
            capsulePlayers = servStat.players.online
            capsuleMaxPlayers = servStat.players.max
        } catch (err) {
            loggerLanding.warn('Unable to refresh server status, assuming offline.')
            loggerLanding.debug(err)
        }
    }

    setServerCapsuleState(capsuleOnline, capsulePlayers, capsuleMaxPlayers, capsulePing)

    // Player count and connection state are displayed exclusively by the new
    // #bedragothServerCapsule component above. Never reanimate the legacy
    // #server_status_wrapper: fadeIn() made it reappear every five minutes.
}


refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    hideMajorOperationOverlay(0)
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
    showLandingDiagnosticAlert('Le dernier lancement a rencontré un problème', requestRepairInstallation)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        // The Java prompt must remain actionable rather than hidden behind
        // the full-screen branded launch overlay.
        toggleLaunchArea(false)
        hideMajorOperationOverlay(0)
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    showMajorOperationOverlay(
        `INSTALLATION DE JAVA ${effectiveJavaOptions.suggestedMajor}`,
        'Téléchargement de l’environnement Java...',
        'java'
    )
    toggleLaunchArea(true)
    setLaunchPercentage(0)

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
// Look for Forge, NeoForge, or Fabric boot messages. NeoForge's log includes
// additional logger prefixes, so do not require an exact line-start match.
const GAME_LAUNCH_REGEX = /(?:MinecraftForge .+ Initialized|ModLauncher .+ starting:|Loading Minecraft .+ with Fabric Loader|Sound engine started)/i
const MIN_LINGER = 5000

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            showLaunchFailure('Compte Minecraft requis', 'Connectez-vous à votre compte Microsoft avant de jouer.')
            return
        }
    }

    // Java installation might have shown its own screen. Return to the game
    // progress screen before validation, even if nothing needs downloading.
    if(!majorOperationActive || majorOperationKind !== 'game'){
        showMajorOperationOverlay('PRÉPARATION DE BEDRAGOTH', 'Vérification des fichiers...', 'game')
    }
    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    // Path diagnostics: common and instances must be siblings under the data root.
    // This log helps verify the same layout on every player's machine.
    loggerLaunchSuite.info('Bedragoth game paths', {
        dataDirectory: ConfigManager.getDataDirectory(),
        commonDirectory: ConfigManager.getCommonDirectory(),
        instanceDirectory: ConfigManager.getInstanceDirectory(),
        selectedInstance: landingPath.join(ConfigManager.getInstanceDirectory(), serv.rawServer.id)
    })

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        // Same full-screen overlay for one missing file or many missing files.
        setLaunchUiMode('updating')
        setLaunchDetails(`${invalidFileCount} fichier${invalidFileCount === 1 ? '' : 's'} à télécharger...`)
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
        setLaunchDetails('Tous les fichiers sont à jour. Aucun téléchargement nécessaire.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchUiMode('launching')
    // Percentages are per stage: verification, optional download, launch.
    setLaunchPercentage(0)
    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        setLaunchDetails('Actualisation de la session Minecraft...')
        const refreshResult = await AuthManager.refreshSelectedForLaunch()
        if(!refreshResult.success) {
            loggerLaunchSuite.error('The selected account could not be refreshed before launch.')
            toggleLaunchArea(false)
            if(refreshResult.reauthenticationRequired) {
                await validateSelectedAccount(false)
            } else {
                const refreshError = refreshResult.error
                showLaunchFailure(
                    refreshError?.title || Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'),
                    refreshError?.desc || 'Le renouvellement de la session a échoué. Réessayez dans quelques instants.'
                )
            }
            return
        }

        // Fetch the account again: refreshing replaces its tokens in ConfigManager.
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        let launchComplete = false
        let launchFinishTimer = null
        let runningProc = null
        const onLoadComplete = () => {
            if(launchComplete) return
            launchComplete = true
            launchFinishTimer = null
            setLaunchDetails('Minecraft est démarré.')
            setLaunchPercentage(100)
            toggleLaunchArea(false)
            hideLandingDiagnosticAlert()
            if(runningProc){
                if(hasRPC){
                    DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                    runningProc.stdout.on('data', gameStateChange)
                }
                runningProc.stdout.removeListener('data', tempListener)
                runningProc.stderr.removeListener('data', gameErrorListener)
            }
        }
        const start = Date.now()

        // NeoForge and Forge may emit slightly different boot messages.
        // Keep the progress screen visible for at least MIN_LINGER milliseconds.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(String(data))){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    if(launchFinishTimer == null){
                        launchFinishTimer = setTimeout(onLoadComplete, MIN_LINGER-diff)
                    }
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()
            runningProc = proc

            // Bind listeners to stdout and handle early exits so the full
            // screen never gets stranded if Minecraft crashes before boot.
            runningProc.stdout.on('data', tempListener)
            runningProc.stderr.on('data', gameErrorListener)
            runningProc.once('error', err => {
                if(launchFinishTimer != null) clearTimeout(launchFinishTimer)
                if(!launchComplete){
                    launchComplete = true
                    loggerLaunchSuite.error('Minecraft process error', err)
                    showLaunchFailure('Échec du lancement', err.message || 'Impossible de démarrer Minecraft.')
                }
            })
            runningProc.once('close', code => {
                if(launchFinishTimer != null) clearTimeout(launchFinishTimer)
                if(!launchComplete){
                    launchComplete = true
                    if(code === 0){
                        toggleLaunchArea(false)
                    } else {
                        showLaunchFailure('Minecraft s’est arrêté', `Minecraft a quitté avant la fin du démarrage (code ${code}). Consulte les logs de l’instance.`)
                    }
                }
                if(proc === runningProc) proc = null
            })

            setLaunchDetails('Réveil en cours...')

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 * 
 * @param {boolean} up True to slide up, otherwise false. 
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.getElementById('newsButtonContainer')
    const newsBtnControl = document.getElementById('newsButton')
    const newsBtnHome = document.getElementById('leftIconStack')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    // The original news button lives inside #upper, which slides -200vh away.
    // Move it into the news view while open so it stays visible AND remains the
    // same working toggle (no duplicate listeners, no other UI to maintain).
    if(up){
        newsContainer.appendChild(newsBtn)
        newsBtn.classList.add('news-mode')
        newsBtnControl.setAttribute('aria-label', "Retour à l'accueil")
        newsBtnControl.title = "Retour à l'accueil"
    } else {
        newsBtnHome.appendChild(newsBtn)
        newsBtn.classList.remove('news-mode')
        newsBtnControl.setAttribute('aria-label', 'Nouvelles')
        newsBtnControl.title = 'Nouvelles'
    }
    // The legacy news tabbing toggle affects the button before it moves.
    newsBtnControl.removeAttribute('tabindex')

    newsGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        // The compact news button stays fixed on-screen so it can also close the news view.
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(newsGlideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = null
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        // Compact news button remains available.
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            const newsContainerButton = document.getElementById('newsButtonContainer')
            if(newsContainerButton != null){
                newsContainerButton.removeAttribute('unread')
            }
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 * 
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    const container = document.getElementById('newsButtonContainer')
    if(container != null){
        container.setAttribute('unread', '')
    }
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        const newHash = await digestMessage(lN.content)
        const newDate = Number.isFinite(lN.timestamp) ? lN.timestamp : 0
        let isNew = false

        if(cached.date != null && cached.content != null){
            const cachedDate = Number(cached.date)
            const sameContent = cached.content === newHash
            const sameOrOlderDate = Number.isFinite(cachedDate) && cachedDate >= newDate

            if(!sameContent || !sameOrOlderDate){
                isNew = true
                showNewsAlert()
            } else if(!cached.dismissed){
                isNew = true
                showNewsAlert()
            }
        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate,
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)
    
            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'Escape'){
            e.preventDefault()
            document.getElementById('newsButton').click()
            return
        }
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const newsFeed = distroData.rawDistribution.rss

    try {
        // Invalid RSS URLs should not trigger an unhandled rejection on launch.
        const feedUrl = new URL(newsFeed)
        if(!['http:', 'https:'].includes(feedUrl.protocol)){
            throw new Error('RSS URL must use http or https.')
        }
        const newsHost = feedUrl.origin + '/'
        // Fetch through Electron's main process. This uses Chromium's network
        // stack and is not subject to renderer file:// / CORS restrictions.
        const remoteResult = await ipcRenderer.invoke('bedragothFetchRemote', newsFeed, 'text')
        if(!remoteResult?.ok){
            throw new Error(remoteResult?.error || 'Unable to download RSS feed.')
        }

        const xmlText = remoteResult.data
        if(typeof xmlText !== 'string' || xmlText.trim().length === 0){
            throw new Error('RSS feed is empty.')
        }

        const xmlDocument = $.parseXML(xmlText)
        const items = $(xmlDocument).find('item')
        const articles = []

        for(let i=0; i<items.length; i++){
            const el = $(items[i])

            const rawDate = el.find('pubDate').text()
            const parsedDate = new Date(rawDate)
            const date = Number.isNaN(parsedDate.getTime())
                ? rawDate
                : parsedDate.toLocaleDateString('fr-FR', {month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'})

            let comments = el.find('slash\\:comments').text() || '0'
            comments = comments + ' Comment' + (comments === '1' ? '' : 's')

            let content = el.find('content\\:encoded').text()
            let regex = /src="(?!https?:\/\/)(.+?)"/g
            let matches
            while((matches = regex.exec(content))){
                content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
            }

            const link = el.find('link').first().text().trim()
            const title = el.find('title').first().text().trim()
            const author = el.find('dc\\:creator').text().trim() || 'Bedragoth'

            articles.push({
                link,
                title,
                date,
                timestamp: Number.isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime(),
                author,
                content,
                comments,
                commentsLink: link ? link + '#comments' : ''
            })
        }

        return { articles }
    } catch(err) {
        loggerLanding.error(`Unable to load Bedragoth RSS feed (${newsFeed}).`, err)
        console.error('[Bedragoth News] RSS load failed:', newsFeed, err)
        return { articles: null }
    }
}
