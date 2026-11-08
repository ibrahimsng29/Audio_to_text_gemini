'use strict';
// =========================================================
// Gemini Audio — logique de l'interface
// Tout le texte venant du serveur ou de l'utilisateur est inséré avec
// textContent (jamais innerHTML) : aucun HTML n'est interprété.
// =========================================================

// --- ÉTAT ---
let mediaRecorder = null, fluxMicro = null, audioChunks = [];
let minuterieEnregistrement = null, debutEnregistrement = 0;
let historiqueTranscriptions = [];
let historiqueEncorePlus = false;
let titreActuel = "Enregistrement";
let idActuel = null;            // transcription affichée (pour enregistrer les modifications)
let texteOriginal = null;       // texte avant traduction
let urlAudioActuelle = null;    // URL blob: à libérer
let requeteXhr = null;
let modeChoisi = 'resume';
const TAILLE_MAX = 100 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const resDiv = $('resultat');
const statut = $('statut');
const lecteurAudio = $('lecteurAudio');
// Gardé en mémoire : il est retiré de la page quand la liste contient des éléments.
const aucunHistorique = $('aucunHistorique');

const LIBELLES_MODES = {
    resume: "Résumé", cours: "Cours", reunion: "Réunion",
    bullet: "Puces", todo: "Tâches", brut: "Transcription brute"
};

// --- OUTILS ---
const token = () => localStorage.getItem('gemini_token');

function lireStockageLocal(cle) {
    try { return localStorage.getItem(cle); } catch { return null; }
}
function ecrireStockageLocal(cle, valeur) {
    try { localStorage.setItem(cle, valeur); } catch { /* navigation privée */ }
}

/** fetch avec le jeton ; gère l'expiration de session et les réponses non-JSON. */
async function appelApi(url, options = {}) {
    const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token()}` };
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        gererExpirationSession();
        throw new Error("Session expirée.");
    }
    try { return await response.json(); }
    catch { return { success: false, error: `Réponse inattendue du serveur (${response.status}).` }; }
}

function formaterDate(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const aujourdhui = new Date();
    const hier = new Date(); hier.setDate(aujourdhui.getDate() - 1);
    if (d.toDateString() === aujourdhui.toDateString()) return `aujourd'hui, ${heure}`;
    if (d.toDateString() === hier.toDateString()) return `hier, ${heure}`;
    const options = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== aujourdhui.getFullYear()) options.year = 'numeric';
    return `${d.toLocaleDateString('fr-FR', options)}, ${heure}`;
}

function versItemHistorique(item) {
    return {
        id: item.id,
        titre: item.titre || 'Enregistrement',
        mode: item.mode || 'resume',
        date: item.date,
        texte: item.texte || '',
        aAudio: Boolean(item.aAudio)
    };
}

function texteResultat() {
    return (resDiv.innerText || resDiv.textContent).trim();
}

function definirStatut(element, texte, type = '') {
    element.textContent = texte;
    element.className = element.className.replace(/\b(succes|erreur|alerte|info)\b/g, '').trim();
    if (type) element.classList.add(type);
}

// =========================================================
// AUTHENTIFICATION
// =========================================================
let modeInscription = false;

function messageAuth(texte, type = 'erreur') {
    definirStatut($('auth-message'), texte, type === 'succes' ? 'succes' : type === 'alerte' ? 'alerte' : 'erreur');
}

function basculerModeAuth() {
    modeInscription = !modeInscription;
    $('auth-title').textContent = modeInscription ? "Créer un compte" : "Connexion";
    $('auth-btn').textContent = modeInscription ? "Créer mon compte" : "Se connecter";
    $('auth-switch-text').textContent = modeInscription ? "Déjà un compte ?" : "Pas encore de compte ?";
    $('auth-switch-link').textContent = modeInscription ? "Se connecter" : "Créer un compte";
    $('auth-password').autocomplete = modeInscription ? "new-password" : "current-password";
    $('auth-password-hint').hidden = !modeInscription;
    $('auth-message').textContent = "";
    $('auth-renvoyer').hidden = true;
}

async function gererConnexion() {
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;

    if (!email || !password) return messageAuth("Veuillez remplir tous les champs.");
    if (modeInscription && password.length < 8) return messageAuth("Le mot de passe doit contenir au moins 8 caractères.");

    const btn = $('auth-btn');
    btn.disabled = true;
    $('auth-renvoyer').hidden = true;
    try {
        const response = await fetch(modeInscription ? '/api/register' : '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json().catch(() => ({ success: false, error: "Réponse inattendue du serveur." }));

        if (!data.success) {
            messageAuth(data.error || "Erreur.");
            if (data.code === 'EMAIL_NON_VERIFIE') $('auth-renvoyer').hidden = false;
            return;
        }

        if (modeInscription) {
            basculerModeAuth();
            $('auth-password').value = '';
            messageAuth(data.message || "Compte créé. Vérifiez vos e-mails pour l'activer.", 'succes');
        } else {
            localStorage.setItem('gemini_token', data.token);
            localStorage.setItem('gemini_email', data.email);
            $('auth-password').value = '';
            demarrerApplication();
        }
    } catch {
        messageAuth("Erreur de connexion au serveur.");
    } finally {
        btn.disabled = false;
    }
}

async function renvoyerVerification() {
    const email = $('auth-email').value.trim();
    if (!email) return messageAuth("Saisissez votre adresse e-mail.");
    const btn = $('auth-renvoyer');
    btn.disabled = true;
    try {
        const response = await fetch('/api/renvoyer-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json().catch(() => ({ success: false, error: "Réponse inattendue du serveur." }));
        if (data.success) messageAuth(data.message, 'succes');
        else messageAuth(data.error || "Erreur.");
    } catch {
        messageAuth("Erreur de connexion au serveur.");
    } finally {
        btn.disabled = false;
    }
}

/** Message affiché au retour du lien de confirmation reçu par e-mail. */
function afficherRetourVerification() {
    const etat = new URLSearchParams(window.location.search).get('verification');
    if (!etat) return;
    history.replaceState(null, '', window.location.pathname);
    if (etat === 'ok') messageAuth("Adresse confirmée ! Vous pouvez maintenant vous connecter.", 'succes');
    else if (etat === 'expiree') {
        messageAuth("Ce lien a expiré. Saisissez votre e-mail et demandez-en un nouveau.");
        $('auth-renvoyer').hidden = false;
    } else messageAuth("Lien de confirmation invalide ou déjà utilisé.");
}

function demarrerApplication() {
    $('auth-section').hidden = true;
    $('app-section').hidden = false;

    const email = localStorage.getItem('gemini_email') || 'Utilisateur';
    $('profil-email').textContent = email;
    $('avatar-lettre').textContent = email.charAt(0).toUpperCase();

    chargerHistoriqueDepuisBDD();
    actualiserStockage();
}

/** Remet l'interface à zéro pour que l'utilisateur suivant ne voie rien du précédent. */
function reinitialiserEspaceTravail() {
    if (requeteXhr) { requeteXhr.abort(); requeteXhr = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
    }
    arreterMicro();
    arreterMinuterie();
    reinitialiserBoutonEnregistrer();
    historiqueTranscriptions = [];
    historiqueEncorePlus = false;
    $('inputRechercheHistorique').value = '';
    $('inputRechercheMobile').value = '';
    $('inputEmail').value = '';
    $('inputFileAudio').value = '';
    viderDocument();
    definirStatut(statut, '');
    masquerProgression();
    fermerMenuCompte();
    definirSidebar(false);
    document.querySelectorAll('.stockage').forEach(el => { el.hidden = true; });
    mettreAJourAffichageHistorique();
}

function seDeconnecter() {
    localStorage.removeItem('gemini_token');
    localStorage.removeItem('gemini_email');
    reinitialiserEspaceTravail();
    $('auth-section').hidden = false;
    $('app-section').hidden = true;
    $('auth-email').value = '';
    $('auth-password').value = '';
}

let expirationEnCours = false;
function gererExpirationSession() {
    if (expirationEnCours) return;
    expirationEnCours = true;
    seDeconnecter();
    messageAuth("Votre session a expiré. Veuillez vous reconnecter.", 'alerte');
    setTimeout(() => { expirationEnCours = false; }, 1000);
}

// =========================================================
// NAVIGATION : historique (tiroir sur mobile) et menu du compte
// =========================================================
const estMobile = () => !window.matchMedia('(min-width: 768px)').matches;

function definirSidebar(ouverte) {
    const sidebar = $('sidebar');
    sidebar.classList.toggle('ouverte', ouverte);
    $('voile').hidden = !(ouverte && estMobile());
    $('btnToggleSidebar').setAttribute('aria-expanded', String(ouverte));
    ongletActif(ouverte ? 'historique' : 'enregistrer');
}

/** Onglet actif de la navigation mobile : 'enregistrer', 'historique' ou 'compte'. */
function ongletActif(nom) {
    $('navEnregistrer').classList.toggle('actif', nom === 'enregistrer');
    $('navHistorique').classList.toggle('actif', nom === 'historique');
    $('navCompte').classList.toggle('actif', nom === 'compte');
}

function fermerMenuCompte() {
    if ($('menuCompte').hidden) return;
    $('menuCompte').hidden = true;
    $('btnCompte').setAttribute('aria-expanded', 'false');
    ongletActif($('sidebar').classList.contains('ouverte') ? 'historique' : 'enregistrer');
}

function basculerMenuCompte() {
    const ouvrir = $('menuCompte').hidden;
    if (!ouvrir) return fermerMenuCompte();
    definirSidebar(false);
    $('menuCompte').hidden = false;
    $('btnCompte').setAttribute('aria-expanded', 'true');
    ongletActif('compte');
}

/** Espace utilisé par les audios de l'utilisateur. */
async function actualiserStockage() {
    try {
        const data = await appelApi('/api/moi');
        if (!data.success || !data.stockage) return;
        const { utilise, maximum } = data.stockage;
        const mo = (o) => (o / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
        const pourcent = maximum > 0 ? Math.min(100, Math.round((utilise / maximum) * 100)) : 100;
        document.querySelectorAll('.stockage').forEach(bloc => {
            bloc.hidden = false;
            bloc.querySelector('.stockage-texte').textContent = `Stockage ${mo(utilise)} / ${mo(maximum)} Mo`;
            const barre = bloc.querySelector('.jauge-remplie');
            barre.style.width = pourcent + '%';
            barre.classList.toggle('moyen', pourcent >= 70 && pourcent < 90);
            barre.classList.toggle('plein', pourcent >= 90);
        });
    } catch (err) {
        console.error("Erreur chargement stockage :", err);
    }
}

// =========================================================
// LECTEUR AUDIO
// =========================================================
function viderLecteurAudio() {
    if (urlAudioActuelle) URL.revokeObjectURL(urlAudioActuelle);
    urlAudioActuelle = null;
    lecteurAudio.removeAttribute('src');
    lecteurAudio.load();
    $('lecteurContainer').hidden = true;
}

function chargerAudioDansLecteur(blob) {
    viderLecteurAudio();
    urlAudioActuelle = URL.createObjectURL(blob);
    lecteurAudio.src = urlAudioActuelle;
    $('lecteurContainer').hidden = false;
}

/** L'audio est protégé : on le télécharge avec le jeton puis on le lit localement. */
async function chargerAudioDepuisServeur(id) {
    viderLecteurAudio();
    try {
        const response = await fetch(`/audio/${encodeURIComponent(id)}`, {
            headers: { 'Authorization': `Bearer ${token()}` }
        });
        if (response.status === 401) return gererExpirationSession();
        if (!response.ok || idActuel !== id) return;
        chargerAudioDansLecteur(await response.blob());
    } catch (err) {
        console.error("Erreur chargement audio :", err);
    }
}

// =========================================================
// DOCUMENT AFFICHÉ
// =========================================================
function viderDocument() {
    idActuel = null;
    texteOriginal = null;
    titreActuel = "Enregistrement";
    $('docTitre').textContent = "Aucun document ouvert";
    $('docMeta').textContent = "Enregistrez ou importez un audio : le résultat s'affichera ici.";
    resDiv.textContent = '';
    resDiv.removeAttribute('contenteditable');
    resDiv.dir = 'ltr';
    $('actionsContainer').hidden = true;
    $('panneauPdf').hidden = true;
    $('btnOuvrirPdf').setAttribute('aria-expanded', 'false');
    $('modeEditionBadge').hidden = true;
    $('btnTexteOriginal').hidden = true;
    $('statutTraduction').textContent = '';
    $('statutEmail').textContent = '';
    viderLecteurAudio();
    mettreAJourAffichageHistorique();
}

function afficherDocument(item) {
    idActuel = item.id;
    titreActuel = item.titre;
    texteOriginal = null;
    $('docTitre').textContent = item.titre;
    const morceaux = [LIBELLES_MODES[item.mode] || "Résumé", formaterDate(item.date)];
    if (!item.aAudio) morceaux.push("sans audio");
    $('docMeta').textContent = morceaux.filter(Boolean).join(' · ');
    resDiv.textContent = item.texte;
    resDiv.dir = 'ltr';
    resDiv.setAttribute('contenteditable', 'true');
    $('actionsContainer').hidden = false;
    $('btnSauvegarder').hidden = !item.id;
    $('modeEditionBadge').hidden = false;
    $('btnTexteOriginal').hidden = true;
    $('statutTraduction').textContent = '';
    $('statutEmail').textContent = '';
    mettreAJourAffichageHistorique();
}

/** Affiche un message dans la zone du document (pendant le traitement ou en cas d'erreur). */
function messageDocument(titre, meta) {
    idActuel = null;
    $('docTitre').textContent = titre;
    $('docMeta').textContent = meta;
    resDiv.textContent = '';
    resDiv.removeAttribute('contenteditable');
    $('actionsContainer').hidden = true;
    $('panneauPdf').hidden = true;
    $('modeEditionBadge').hidden = true;
    $('btnTexteOriginal').hidden = true;
    $('statutTraduction').textContent = '';
}

// =========================================================
// PROGRESSION DE L'ANALYSE
// =========================================================
const etapes = () => document.querySelectorAll('.etapes li');

function etatEtape(numero, etat) {
    const li = document.querySelector(`.etapes li[data-etape="${numero}"]`);
    if (li) li.dataset.etat = etat;
}

function masquerProgression() {
    $('progression').hidden = true;
    $('btnAnnuler').hidden = true;
}

function demarrerPipeline() {
    const p = $('progression');
    p.hidden = false;
    p.dataset.etat = 'encours';
    $('progressionBarre').style.width = '0%';
    $('etapeEnvoi').textContent = '0 %';
    etapes().forEach(li => { li.dataset.etat = ''; });
    etatEtape(1, 'encours');
    $('btnAnnuler').hidden = false;
}

let televersementTermine = false;
function actualiserUploadProgress(pourcent) {
    // L'envoi représente 60 % de la barre, l'analyse le reste.
    $('progressionBarre').style.width = Math.round(pourcent * 0.6) + '%';
    $('etapeEnvoi').textContent = `${pourcent} %`;
    if (pourcent < 100 || televersementTermine) return;
    televersementTermine = true;
    $('etapeEnvoi').textContent = '';
    etatEtape(1, 'ok');
    etatEtape(2, 'ok');
    etatEtape(3, 'encours');
    $('progressionBarre').style.width = '75%';
}

function finaliserPipelineSucces() {
    $('progression').dataset.etat = 'ok';
    [1, 2, 3, 4].forEach(n => etatEtape(n, 'ok'));
    $('progressionBarre').style.width = '100%';
    $('btnAnnuler').hidden = true;
    setTimeout(() => { if (!requeteXhr) masquerProgression(); }, 2500);
}

function erreurPipeline() {
    $('progression').dataset.etat = 'erreur';
    const enCours = document.querySelector('.etapes li[data-etat="encours"]');
    if (enCours) enCours.dataset.etat = 'erreur';
    $('btnAnnuler').hidden = true;
}

function annulerPipeline() {
    masquerProgression();
}

function verrouillerEnvoi(verrouiller) {
    $('zoneDepot').classList.toggle('desactive', verrouiller);
    $('inputFileAudio').disabled = verrouiller;
    if (!mediaRecorder || mediaRecorder.state === 'inactive') $('btnEnregistrer').disabled = verrouiller;
}

function annulerAnalyse() {
    if (requeteXhr) {
        requeteXhr.abort();   // le serveur détecte la coupure et n'enregistre rien
        requeteXhr = null;
    }
    verrouillerEnvoi(false);
    annulerPipeline();
    definirStatut(statut, "Analyse annulée.", 'alerte');
    messageDocument("Aucun document ouvert", "Analyse annulée. Rien n'a été enregistré.");
}

// =========================================================
// ENREGISTREMENT MICRO
// =========================================================
function choisirFormatEnregistrement() {
    const candidats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return candidats.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function extensionPour(mime) {
    if (mime.includes('mp4')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    return 'webm';
}

function arreterMicro() {
    if (fluxMicro) fluxMicro.getTracks().forEach(piste => piste.stop());
    fluxMicro = null;
}

function arreterMinuterie() {
    clearInterval(minuterieEnregistrement);
    minuterieEnregistrement = null;
}

function reinitialiserBoutonEnregistrer() {
    const btn = $('btnEnregistrer');
    btn.classList.remove('en-cours');
    btn.querySelector('.libelle').textContent = "Enregistrer";
    btn.setAttribute('aria-pressed', 'false');
}

function dureeEcoulee() {
    const s = Math.floor((Date.now() - debutEnregistrement) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function demarrerEnregistrement() {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
        definirStatut(statut, "L'enregistrement audio n'est pas pris en charge par ce navigateur.", 'erreur');
        return;
    }
    try {
        fluxMicro = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        const format = choisirFormatEnregistrement();
        mediaRecorder = format ? new MediaRecorder(fluxMicro, { mimeType: format }) : new MediaRecorder(fluxMicro);
        audioChunks = [];

        mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            arreterMicro();   // éteint le micro (et le voyant du navigateur)
            // Type réel produit par le navigateur (audio/mp4 sur Safari/iOS, audio/webm ailleurs)
            const mime = (mediaRecorder.mimeType || audioChunks[0]?.type || 'audio/webm').split(';')[0];
            const blob = new Blob(audioChunks, { type: mime });
            if (blob.size === 0) {
                definirStatut(statut, "Aucun son n'a été enregistré.", 'erreur');
                return;
            }
            const date = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            envoyerAuServeur(blob, `enregistrement.${extensionPour(mime)}`, `Enregistrement du ${date}`);
        };

        mediaRecorder.start(1000);
        debutEnregistrement = Date.now();
        const btn = $('btnEnregistrer');
        btn.classList.add('en-cours');
        btn.setAttribute('aria-pressed', 'true');
        btn.querySelector('.libelle').textContent = "Arrêter et analyser · 0:00";
        minuterieEnregistrement = setInterval(() => {
            btn.querySelector('.libelle').textContent = `Arrêter et analyser · ${dureeEcoulee()}`;
        }, 500);
        $('zoneDepot').classList.add('desactive');
        definirStatut(statut, "Enregistrement en cours… parlez normalement.");
    } catch (e) {
        arreterMicro();
        definirStatut(statut, e.name === 'NotAllowedError'
            ? "Accès au micro refusé. Autorisez-le dans les réglages du navigateur."
            : "Impossible d'utiliser le micro : " + e.message, 'erreur');
    }
}

function arreterEnregistrement() {
    arreterMinuterie();
    reinitialiserBoutonEnregistrer();
    $('zoneDepot').classList.remove('desactive');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

// =========================================================
// FICHIER (sélection ou glisser-déposer)
// =========================================================
function traiterFichier(fichier) {
    if (!fichier) return;
    if (!/^(audio|video)\//.test(fichier.type)) {
        definirStatut(statut, "Ce fichier n'est pas un fichier audio ou vidéo.", 'erreur');
        return;
    }
    if (fichier.size > TAILLE_MAX) {
        definirStatut(statut, "Fichier trop volumineux (100 Mo maximum).", 'erreur');
        return;
    }
    envoyerAuServeur(fichier, fichier.name, fichier.name.replace(/\.[^.]+$/, ''));
}

// =========================================================
// ENVOI AU SERVEUR (transcription)
// =========================================================
function envoyerAuServeur(audioBlob, nomFichier, titre) {
    if (requeteXhr) return;   // une analyse à la fois

    definirStatut(statut, "Envoi de l'audio…");
    messageDocument(titre, "Analyse en cours… le résultat s'affichera ici.");
    chargerAudioDansLecteur(audioBlob);
    verrouillerEnvoi(true);
    if (estMobile()) definirSidebar(false);

    const formData = new FormData();
    formData.append('mode', modeChoisi);
    formData.append('titreSource', titre);
    formData.append('audio', audioBlob, nomFichier);   // en dernier : les champs texte arrivent avant le fichier

    televersementTermine = false;
    demarrerPipeline();

    const xhr = new XMLHttpRequest();
    requeteXhr = xhr;
    xhr.open('POST', '/transcrire');
    xhr.setRequestHeader('Authorization', `Bearer ${token()}`);

    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pourcent = Math.round((e.loaded / e.total) * 100);
        actualiserUploadProgress(pourcent);
        definirStatut(statut, pourcent < 100 ? `Envoi de l'audio (${pourcent} %)…` : "Analyse par Gemini…");
    };

    const terminer = () => {
        if (requeteXhr === xhr) requeteXhr = null;
        verrouillerEnvoi(false);
        $('inputFileAudio').value = '';
    };

    xhr.onload = () => {
        terminer();
        if (xhr.status === 401) {
            erreurPipeline();
            return gererExpirationSession();
        }

        let data;
        try { data = JSON.parse(xhr.responseText); }
        catch { data = { success: false, error: `Réponse inattendue du serveur (${xhr.status}).` }; }

        if (data.success) {
            finaliserPipelineSucces();
            if (data.avertissement) definirStatut(statut, data.avertissement, 'alerte');
            else definirStatut(statut, "Analyse terminée.", 'succes');
            const nouvelItem = versItemHistorique(data);
            historiqueTranscriptions.unshift(nouvelItem);
            afficherDocument(nouvelItem);
            if (!nouvelItem.aAudio) viderLecteurAudio();
            actualiserStockage();
        } else {
            erreurPipeline();
            definirStatut(statut, data.error || "Erreur de transcription.", 'erreur');
            messageDocument("L'analyse a échoué", data.error || "Erreur de transcription.");
            viderLecteurAudio();
        }
    };

    xhr.onerror = () => {
        terminer();
        erreurPipeline();
        definirStatut(statut, "Erreur réseau : impossible de joindre le serveur.", 'erreur');
        messageDocument("L'analyse a échoué", "Erreur de connexion au serveur.");
    };

    xhr.onabort = () => {
        terminer();
        annulerPipeline();
    };

    xhr.send(formData);
}

// =========================================================
// ACTIONS SUR LE DOCUMENT
// =========================================================
async function traduire() {
    const texteActuel = texteResultat();
    const langueCible = $('selectLangue').value;
    if (!texteActuel) return;

    const btn = $('btnTraduire');
    const statutTrad = $('statutTraduction');
    definirStatut(statutTrad, "Traduction en cours…");
    btn.disabled = true;
    try {
        const data = await appelApi('/traduire', {
            method: 'POST',
            body: JSON.stringify({ texteOriginal: texteActuel, langueCible })
        });
        if (data.success) {
            if (texteOriginal === null) texteOriginal = texteActuel;   // on garde la version d'origine
            resDiv.textContent = data.texteTraduit;
            resDiv.dir = langueCible === 'Arabe' ? 'rtl' : 'ltr';
            $('btnTexteOriginal').hidden = false;
            definirStatut(statutTrad, `Traduit en ${langueCible.toLowerCase()}.`);
        } else {
            definirStatut(statutTrad, data.error || "Erreur de traduction.", 'erreur');
        }
    } catch {
        if (token()) definirStatut(statutTrad, "Erreur réseau.", 'erreur');
    } finally {
        btn.disabled = false;
    }
}

function revenirTexteOriginal() {
    if (texteOriginal === null) return;
    resDiv.textContent = texteOriginal;
    resDiv.dir = 'ltr';
    texteOriginal = null;
    $('btnTexteOriginal').hidden = true;
    $('statutTraduction').textContent = '';
}

function retourBouton(btn, texte, libelle) {
    btn.textContent = texte;
    setTimeout(() => { btn.textContent = libelle; }, 2000);
}

async function sauvegarder() {
    if (!idActuel) return;
    const texte = texteResultat();
    if (!texte) return;
    const btn = $('btnSauvegarder');
    btn.disabled = true;
    try {
        const data = await appelApi(`/historique/${encodeURIComponent(idActuel)}`, {
            method: 'PATCH',
            body: JSON.stringify({ texte })
        });
        if (data.success) {
            const item = historiqueTranscriptions.find(i => i.id === idActuel);
            if (item) item.texte = texte;
            texteOriginal = null;
            $('btnTexteOriginal').hidden = true;
            retourBouton(btn, "Enregistré", "Enregistrer");
        } else {
            retourBouton(btn, "Échec", "Enregistrer");
            definirStatut($('statutTraduction'), data.error || "Impossible d'enregistrer.", 'erreur');
        }
    } catch {
        retourBouton(btn, "Échec", "Enregistrer");
    } finally {
        btn.disabled = false;
    }
}

function copier() {
    const btn = $('btnCopier');
    navigator.clipboard.writeText(texteResultat())
        .then(() => retourBouton(btn, "Copié", "Copier"))
        .catch(() => retourBouton(btn, "Échec", "Copier"));
}

function basculerPanneauPdf() {
    const panneau = $('panneauPdf');
    panneau.hidden = !panneau.hidden;
    $('btnOuvrirPdf').setAttribute('aria-expanded', String(!panneau.hidden));
    if (!panneau.hidden) $('inputEmail').focus();
}

async function envoyerPdf() {
    const email = $('inputEmail').value.trim();
    const texte = texteResultat();
    const statutEmail = $('statutEmail');

    if (!email) return definirStatut(statutEmail, "Saisissez au moins une adresse e-mail.", 'erreur');
    if (!texte) return definirStatut(statutEmail, "Aucun texte à envoyer.", 'erreur');

    definirStatut(statutEmail, "Envoi du PDF…", 'info');
    const btn = $('btnEnvoyerEmail');
    btn.disabled = true;
    try {
        const data = await appelApi('/envoyer-pdf', {
            method: 'POST',
            body: JSON.stringify({
                emailDestinataire: email,
                texteAAfficher: texte,
                titreSource: titreActuel,
                modePdf: $('selectModelePdf').value
            })
        });
        if (data.success) definirStatut(statutEmail, data.message || "PDF envoyé.", 'succes');
        else definirStatut(statutEmail, data.error || "Échec de l'envoi.", 'erreur');
    } catch {
        if (token()) definirStatut(statutEmail, "Erreur réseau.", 'erreur');
    } finally {
        btn.disabled = false;
    }
}

// =========================================================
// HISTORIQUE
// =========================================================
function termeRecherche() {
    return (estMobile() ? $('inputRechercheMobile') : $('inputRechercheHistorique')).value.toLowerCase().trim();
}

async function chargerHistoriqueDepuisBDD(suite = false) {
    try {
        let url = '/historique';
        if (suite && historiqueTranscriptions.length > 0) {
            const dernier = historiqueTranscriptions[historiqueTranscriptions.length - 1];
            url += `?avant=${encodeURIComponent(new Date(dernier.date).toISOString())}`;
        }
        const data = await appelApi(url);
        if (!data.success) return;

        const elements = data.historique.map(versItemHistorique);
        historiqueTranscriptions = suite ? historiqueTranscriptions.concat(elements) : elements;
        historiqueEncorePlus = Boolean(data.encorePlus);
        mettreAJourAffichageHistorique();
    } catch (err) {
        console.error("Erreur chargement historique :", err);
    }
}

function element(tag, classe, texte) {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (texte !== undefined) el.textContent = texte;   // textContent : aucun HTML interprété (anti-XSS)
    return el;
}

function iconeCorbeille() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const chemin = document.createElementNS(ns, 'path');
    chemin.setAttribute('d', 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3');
    svg.appendChild(chemin);
    return svg;
}

async function supprimerTranscription(item) {
    if (!confirm(`Supprimer « ${item.titre} » et son audio ? Cette action est définitive.`)) return;
    try {
        const data = await appelApi(`/historique/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        if (!data.success) return alert(data.error || "Suppression impossible.");
        historiqueTranscriptions = historiqueTranscriptions.filter(i => i.id !== item.id);
        actualiserStockage();
        if (idActuel === item.id) viderDocument();
        else mettreAJourAffichageHistorique();
    } catch (err) {
        console.error("Erreur suppression :", err);
    }
}

function ouvrirDepuisHistorique(item) {
    afficherDocument(item);
    if (item.aAudio) chargerAudioDepuisServeur(item.id);
    else viderLecteurAudio();
    if (estMobile()) definirSidebar(false);
    $('document').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mettreAJourAffichageHistorique() {
    const terme = termeRecherche();
    const liste = $('listeHistorique');
    const vide = aucunHistorique;
    const filtres = historiqueTranscriptions.filter(item =>
        item.titre.toLowerCase().includes(terme) || item.texte.toLowerCase().includes(terme)
    );

    liste.replaceChildren();
    $('btnChargerPlus').hidden = !(historiqueEncorePlus && !terme);

    if (filtres.length === 0) {
        vide.textContent = terme ? "Aucun résultat" : "Aucun enregistrement pour l'instant";
        liste.appendChild(vide);
        return;
    }

    filtres.forEach(item => {
        const ligne = element('div', 'historique-element' + (item.id === idActuel ? ' actif' : ''));
        const ouvrir = element('button', 'historique-ouvrir');
        ouvrir.type = 'button';
        if (item.id === idActuel) ouvrir.setAttribute('aria-current', 'true');
        ouvrir.append(
            element('span', 'historique-titre', item.titre),
            element('span', 'historique-meta', `${LIBELLES_MODES[item.mode] || "Résumé"} · ${formaterDate(item.date)}`)
        );
        ouvrir.addEventListener('click', () => ouvrirDepuisHistorique(item));

        const suppr = element('button', 'historique-suppr');
        suppr.type = 'button';
        suppr.setAttribute('aria-label', `Supprimer « ${item.titre} »`);
        suppr.appendChild(iconeCorbeille());
        suppr.addEventListener('click', () => supprimerTranscription(item));

        ligne.append(ouvrir, suppr);
        liste.appendChild(ligne);
    });
}

// =========================================================
// CHOIX DU FORMAT
// =========================================================
function choisirMode(mode) {
    if (!LIBELLES_MODES[mode]) return;
    modeChoisi = mode;
    document.querySelectorAll('#choixMode .pastille').forEach(p => {
        p.setAttribute('aria-pressed', String(p.dataset.mode === mode));
    });
    ecrireStockageLocal('gemini_mode', mode);
}

// =========================================================
// BRANCHEMENT DES ÉVÉNEMENTS
// =========================================================
function brancherEvenements() {
    // Connexion
    $('auth-form').addEventListener('submit', (e) => { e.preventDefault(); gererConnexion(); });
    $('auth-switch-link').addEventListener('click', basculerModeAuth);
    $('auth-renvoyer').addEventListener('click', renvoyerVerification);

    // Navigation
    $('btnToggleSidebar').addEventListener('click', () => definirSidebar(!$('sidebar').classList.contains('ouverte')));
    $('voile').addEventListener('click', () => definirSidebar(false));
    $('btnCompte').addEventListener('click', (e) => { e.stopPropagation(); basculerMenuCompte(); });
    $('navCompte').addEventListener('click', (e) => { e.stopPropagation(); basculerMenuCompte(); });
    $('navHistorique').addEventListener('click', () => { fermerMenuCompte(); definirSidebar(true); });
    $('navEnregistrer').addEventListener('click', () => {
        fermerMenuCompte();
        definirSidebar(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('btnDeconnexion').addEventListener('click', seDeconnecter);
    document.addEventListener('click', (e) => {
        if (!$('menuCompte').hidden && !$('menuCompte').contains(e.target)) fermerMenuCompte();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        fermerMenuCompte();
        if (estMobile()) definirSidebar(false);
    });

    // Capture
    $('btnEnregistrer').addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') arreterEnregistrement();
        else demarrerEnregistrement();
    });
    $('inputFileAudio').addEventListener('change', (e) => traiterFichier(e.target.files[0]));
    const zone = $('zoneDepot');
    ['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.add('survol');
    }));
    ['dragleave', 'drop'].forEach(type => zone.addEventListener(type, () => zone.classList.remove('survol')));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (requeteXhr) return;
        traiterFichier(e.dataTransfer.files[0]);
    });
    // Un fichier lâché à côté de la zone ne doit pas ouvrir le fichier dans l'onglet
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    document.querySelectorAll('#choixMode .pastille').forEach(p => {
        p.addEventListener('click', () => choisirMode(p.dataset.mode));
    });
    $('btnAnnuler').addEventListener('click', annulerAnalyse);

    // Document
    $('btnCopier').addEventListener('click', copier);
    $('btnSauvegarder').addEventListener('click', sauvegarder);
    $('btnTraduire').addEventListener('click', traduire);
    $('btnTexteOriginal').addEventListener('click', revenirTexteOriginal);
    $('btnOuvrirPdf').addEventListener('click', basculerPanneauPdf);
    $('btnEnvoyerEmail').addEventListener('click', envoyerPdf);
    $('inputEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') envoyerPdf(); });

    // Historique
    $('inputRechercheHistorique').addEventListener('input', mettreAJourAffichageHistorique);
    $('inputRechercheMobile').addEventListener('input', mettreAJourAffichageHistorique);
    $('btnChargerPlus').addEventListener('click', () => chargerHistoriqueDepuisBDD(true));

    // Passage mobile ↔ ordinateur : on referme le tiroir
    window.matchMedia('(min-width: 768px)').addEventListener('change', () => definirSidebar(false));
}

// =========================================================
// DÉMARRAGE
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
    brancherEvenements();
    choisirMode(lireStockageLocal('gemini_mode') || 'resume');
    viderDocument();
    afficherRetourVerification();
    if (token()) demarrerApplication();
});
