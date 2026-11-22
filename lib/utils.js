// Fonctions pures (sans accès réseau ni base de données) : faciles à tester.

export const MODES = {
    resume: "Transcris cet audio en français de manière propre et fidèle, puis rédige un résumé clair des points importants.",
    cours: "Tu es un assistant pédagogique. À partir de cet audio (un cours ou une explication) : 1) donne la transcription nettoyée, 2) propose un plan structuré du cours (titres et sous-titres), 3) liste les notions clés à retenir avec une courte définition, 4) termine par un quiz de 5 questions avec leurs réponses.",
    reunion: "Tu es un assistant de réunion. À partir de cet audio : 1) résume la réunion en quelques phrases, 2) liste les décisions prises, 3) liste les actions à mener sous la forme « Action — Responsable (si mentionné) — Échéance (si mentionnée) », 4) liste les questions restées ouvertes.",
    bullet: "Transcris cet audio, puis fais un résumé sous forme de puces concises.",
    todo: "Analyse cet audio et extrais la liste des tâches à accomplir, sous forme de cases à cocher (- [ ] tâche). Indique le responsable et l'échéance quand ils sont mentionnés.",
    brut: "Transcris intégralement cet audio, mot pour mot, sans commentaire ni résumé."
};

export const LANGUES = ['Anglais', 'Espagnol', 'Allemand', 'Arabe', 'Italien', 'Français'];

export const MODELES_PDF = ['classique', 'executif', 'academique'];

export const LIMITES = {
    texteMax: 50_000,          // caractères (traduction, PDF, édition)
    titreMax: 120,             // caractères
    destinatairesMax: 5,       // e-mails par envoi de PDF
    motDePasseMin: 8,
    motDePasseMax: 128
};

const REGEX_EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normaliserEmail(valeur) {
    if (typeof valeur !== 'string') return null;
    const email = valeur.trim().toLowerCase();
    if (email.length > 254 || !REGEX_EMAIL.test(email)) return null;
    return email;
}

export function validerMotDePasse(valeur) {
    if (typeof valeur !== 'string') return "Mot de passe invalide.";
    if (valeur.length < LIMITES.motDePasseMin) return `Le mot de passe doit contenir au moins ${LIMITES.motDePasseMin} caractères.`;
    if (valeur.length > LIMITES.motDePasseMax) return `Le mot de passe ne doit pas dépasser ${LIMITES.motDePasseMax} caractères.`;
    return null;
}

/**
 * Découpe une liste d'e-mails séparés par , ou ;
 * Renvoie { emails } ou { erreur }.
 */
export function analyserDestinataires(valeur) {
    if (typeof valeur !== 'string') return { erreur: "Email manquant." };
    const bruts = valeur.split(/[,;]/).map(e => e.trim()).filter(Boolean);
    if (bruts.length === 0) return { erreur: "Aucun email fourni." };
    const emails = [];
    for (const brut of bruts) {
        const email = normaliserEmail(brut);
        if (!email) return { erreur: `Adresse e-mail invalide : ${brut.slice(0, 60)}` };
        if (!emails.includes(email)) emails.push(email);
    }
    if (emails.length > LIMITES.destinatairesMax) {
        return { erreur: `Maximum ${LIMITES.destinatairesMax} destinataires par envoi.` };
    }
    return { emails };
}

/** Titre court, sur une seule ligne, sans caractères de contrôle. */
export function nettoyerTitre(valeur, defaut = 'Enregistrement audio') {
    if (typeof valeur !== 'string') return defaut;
    const titre = valeur.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return titre ? titre.slice(0, LIMITES.titreMax) : defaut;
}

/** Texte libre : doit être une chaîne non vide et pas trop longue. */
export function validerTexte(valeur) {
    if (typeof valeur !== 'string' || !valeur.trim()) return "Texte manquant.";
    if (valeur.length > LIMITES.texteMax) return `Texte trop long (maximum ${LIMITES.texteMax} caractères).`;
    return null;
}

const EXTENSIONS = {
    'audio/webm': '.webm', 'video/webm': '.webm',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
    'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
    'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
    'audio/flac': '.flac', 'audio/x-flac': '.flac',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/mpeg': '.mpeg'
};

/** Type MIME sans paramètres (« audio/webm;codecs=opus » → « audio/webm »). */
export function mimeDeBase(mime) {
    return String(mime || '').split(';')[0].trim().toLowerCase();
}

export function extensionPourMime(mime) {
    return EXTENSIONS[mimeDeBase(mime)] || '.bin';
}

export function estMimeAutorise(mime) {
    const base = mimeDeBase(mime);
    return base.startsWith('audio/') || base.startsWith('video/');
}

/** Une erreur Gemini mérite-t-elle un nouvel essai ? (surcharge, quota, erreur interne) */
export function estErreurTemporaire(erreur) {
    if (!erreur || erreur.name === 'AbortError') return false;
    const statut = Number(erreur.status || erreur.code);
    if ([429, 500, 502, 503, 504].includes(statut)) return true;
    const message = String(erreur.message || erreur);
    return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded/i.test(message);
}

/** Délai (ms) avant l'essai n°(tentative+1) : 1 s, 2 s, 4 s… + un peu d'aléatoire. */
export function delaiReessai(tentative, aleatoire = Math.random()) {
    return Math.pow(2, tentative) * 1000 + Math.round(aleatoire * 500);
}

/** Retire les emojis (non gérés par les polices du PDF). */
export function retirerEmojis(texte) {
    return String(texte || '')
        .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
        .replace(/[ \t]{2,}/g, ' ');
}

/** Le texte est-il majoritairement en écriture arabe (droite à gauche) ? */
export function estMajoritairementArabe(texte) {
    const lettres = String(texte || '').match(/\p{L}/gu) || [];
    if (lettres.length === 0) return false;
    const arabes = lettres.filter(c => /\p{Script=Arabic}/u.test(c)).length;
    return arabes / lettres.length > 0.5;
}

const REGEX_NOMBRE = /[0-9٠-٩۰-۹]+(?:[.,:/][0-9٠-٩۰-۹]+)*/g;
const EST_LETTRE = /\p{L}/u;
const EST_ARABE = /\p{Script=Arabic}/u;

/**
 * pdfkit (via fontkit) inverse les segments en écriture arabe, chiffres compris :
 * « 10 » s'afficherait « 01 ». On pré-inverse donc les nombres situés dans un
 * segment arabe (déterminé par la lettre la plus proche avant, sinon après).
 */
export function corrigerNombresArabes(texte) {
    return String(texte || '').replace(REGEX_NOMBRE, (nombre, position, chaine) => {
        let lettre = null;
        for (let i = position - 1; i >= 0 && !lettre; i--) if (EST_LETTRE.test(chaine[i])) lettre = chaine[i];
        for (let i = position + nombre.length; i < chaine.length && !lettre; i++) if (EST_LETTRE.test(chaine[i])) lettre = chaine[i];
        return lettre && EST_ARABE.test(lettre) ? [...nombre].reverse().join('') : nombre;
    });
}

/** Clé de compteur pour la journée en cours (UTC), ex. « analyses:2026-11-06 ». */
export function cleQuotaDuJour(nom, date = new Date()) {
    return `${nom}:${date.toISOString().slice(0, 10)}`;
}

/** Empreinte SHA-256 d'un jeton : seule l'empreinte est stockée en base. */
export async function hacherJeton(jeton) {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(String(jeton)).digest('hex');
}

/** Lit un entier positif dans une variable d'environnement, sinon la valeur par défaut. */
export function entierEnv(valeur, defaut) {
    const n = Number.parseInt(valeur, 10);
    return Number.isFinite(n) && n >= 0 ? n : defaut;
}

/** Taille lisible : « 11,8 Mo » en dessous de 1 Go, « 5 Go » au-delà. */
export function formaterTaille(octets) {
    const mo = octets / 1024 / 1024;
    const [valeur, unite] = mo >= 1024 ? [mo / 1024, 'Go'] : [mo, 'Mo'];
    return `${valeur.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${unite}`;
}

/** Lit un cookie dans l'en-tête « Cookie » d'une requête. */
export function lireCookie(entete, nom) {
    for (const morceau of String(entete || '').split(';')) {
        const egal = morceau.indexOf('=');
        if (egal > 0 && morceau.slice(0, egal).trim() === nom) return morceau.slice(egal + 1).trim();
    }
    return null;
}

/** Contenu (non vérifié) d'un jeton JWT, ou null s'il est illisible. */
export function decoderJwt(jeton) {
    try {
        const charge = String(jeton).split('.')[1];
        const contenu = JSON.parse(Buffer.from(charge, 'base64url').toString('utf8'));
        return contenu && typeof contenu === 'object' ? contenu : null;
    } catch {
        return null;
    }
}

const EMETTEURS_GOOGLE = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Contrôle le contenu d'un jeton d'identité Google : il doit être destiné à cette application,
 * ne pas être expiré, et porter une adresse e-mail confirmée par Google.
 * Renvoie { googleId, email } ou null.
 */
export function profilGoogleValide(contenu, clientId, maintenant = Date.now()) {
    if (!contenu || !clientId) return null;
    if (!EMETTEURS_GOOGLE.includes(contenu.iss)) return null;
    if (contenu.aud !== clientId) return null;
    if (typeof contenu.exp !== 'number' || contenu.exp * 1000 < maintenant) return null;
    if (contenu.email_verified !== true && contenu.email_verified !== 'true') return null;
    const email = normaliserEmail(contenu.email);
    if (!email || typeof contenu.sub !== 'string' || !contenu.sub) return null;
    return { googleId: contenu.sub, email };
}
