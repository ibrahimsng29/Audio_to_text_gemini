'use strict';
// =========================================================
// Gemini Audio — l'orbe d'enregistrement et le ciel étoilé
// Dessin sur <canvas>, sans bibliothèque. Trois états :
//   repos       : l'orbe respire lentement ;
//   écoute      : il suit le volume du micro (Orbe.ecouter(flux)) ;
//   analyse     : il tourne plus vite pendant le traitement Gemini (Orbe.analyse(true)).
// Respecte « réduire les animations » : une image fixe est dessinée à la place.
// =========================================================
(function () {
    const calme = window.matchMedia('(prefers-reduced-motion: reduce)');
    const etat = { ecoute: false, analyse: false, niveau: 0 };
    let contexteAudio = null, analyseur = null, source = null, donnees = null;

    // ---------- Orbe ----------
    const toile = document.getElementById('orbeCanvas');
    const ctx = toile?.getContext('2d');

    function ajusterToile(c) {
        const r = c.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }

    function lireNiveau() {
        if (!analyseur) return 0;
        analyseur.getByteTimeDomainData(donnees);
        let somme = 0;
        for (let i = 0; i < donnees.length; i++) { const v = (donnees[i] - 128) / 128; somme += v * v; }
        return Math.min(1, Math.sqrt(somme / donnees.length) * 4);
    }

    function dessinerOrbe(t) {
        if (!ctx) return;
        ajusterToile(toile);
        const w = toile.width, h = toile.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
        // Le niveau du micro est lissé pour éviter les à-coups
        etat.niveau += ((etat.ecoute ? lireNiveau() : 0) - etat.niveau) * 0.2;
        const amp = etat.ecoute ? 0.06 + etat.niveau * 0.22 : etat.analyse ? 0.09 : 0.045;
        const vit = etat.ecoute ? 2.6 : etat.analyse ? 4 : 1;
        const respiration = 1 + Math.sin(t * 0.0012) * (etat.ecoute ? 0.01 : 0.025);

        ctx.clearRect(0, 0, w, h);

        // Halo
        const halo = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.5);
        halo.addColorStop(0, etat.ecoute ? 'rgba(255,122,138,0.5)' : etat.analyse ? 'rgba(255,201,138,0.42)' : 'rgba(182,156,255,0.38)');
        halo.addColorStop(1, 'rgba(182,156,255,0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2); ctx.fill();

        // Trois couches déformées : la principale et deux voiles de lumière
        for (let k = 0; k < 3; k++) {
            ctx.beginPath();
            for (let i = 0; i <= 120; i++) {
                const a = i / 120 * Math.PI * 2;
                const n = Math.sin(a * 3 + t * 0.0012 * vit + k) * 0.5
                        + Math.sin(a * 5 - t * 0.0017 * vit + k * 2) * 0.35
                        + Math.sin(a * 2 + t * 0.0007 * vit) * 0.3;
                const r = R * respiration * (1 - k * 0.07) * (1 + n * amp);
                const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
                if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            }
            const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 1.1);
            if (k === 0) {
                g.addColorStop(0, 'rgba(255,255,255,0.96)');
                g.addColorStop(0.35, 'rgba(255,201,138,0.92)');
                g.addColorStop(0.75, 'rgba(182,156,255,0.88)');
                g.addColorStop(1, 'rgba(255,122,138,0.75)');
            } else {
                g.addColorStop(0, 'rgba(255,255,255,0.25)');
                g.addColorStop(1, 'rgba(182,156,255,0.05)');
            }
            ctx.fillStyle = g; ctx.fill();
        }

        // Pendant l'enregistrement : un carré « stop » au centre
        if (etat.ecoute) {
            const c = R * 0.28, rayon = c * 0.22;
            ctx.fillStyle = 'rgba(26,16,48,0.85)';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(cx - c / 2, cy - c / 2, c, c, rayon); else ctx.rect(cx - c / 2, cy - c / 2, c, c);
            ctx.fill();
        }
    }

    // ---------- Ciel étoilé ----------
    const ciel = document.getElementById('ciel');
    const cctx = ciel?.getContext('2d');
    let etoiles = [];

    function preparerCiel() {
        if (!cctx) return;
        ajusterToile(ciel);
        const nombre = Math.round(Math.min(160, (ciel.width * ciel.height) / 14000));
        etoiles = Array.from({ length: nombre }, () => ({
            x: Math.random(), y: Math.random(), r: Math.random() * 1.2 + 0.3, p: Math.random() * 6
        }));
    }

    function dessinerCiel(t) {
        if (!cctx) return;
        const d = Math.min(window.devicePixelRatio || 1, 2);
        cctx.clearRect(0, 0, ciel.width, ciel.height);
        cctx.fillStyle = '#E9E2FF';
        for (const s of etoiles) {
            cctx.globalAlpha = 0.2 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.0008 + s.p));
            cctx.beginPath(); cctx.arc(s.x * ciel.width, s.y * ciel.height, s.r * d, 0, Math.PI * 2); cctx.fill();
        }
        cctx.globalAlpha = 1;
    }

    // ---------- Boucle ----------
    let enBoucle = false;
    function image(t) {
        if (document.hidden || calme.matches) { enBoucle = false; return; }
        dessinerOrbe(t);
        dessinerCiel(t);
        requestAnimationFrame(image);
    }
    function relancer() {
        if (calme.matches) { dessinerOrbe(0); dessinerCiel(0); return; }
        if (!enBoucle) { enBoucle = true; requestAnimationFrame(image); }
    }

    window.addEventListener('resize', () => { preparerCiel(); if (calme.matches) relancer(); });
    document.addEventListener('visibilitychange', relancer);
    calme.addEventListener?.('change', relancer);
    // L'orbe est masqué tant qu'on n'est pas connecté : on le redessine quand il prend sa taille
    if (toile && window.ResizeObserver) new ResizeObserver(() => { if (calme.matches) dessinerOrbe(0); }).observe(toile);

    // ---------- API utilisée par app.js ----------
    window.Orbe = {
        ecouter(flux) {
            etat.ecoute = true;
            try {
                contexteAudio = contexteAudio || new (window.AudioContext || window.webkitAudioContext)();
                contexteAudio.resume?.();
                analyseur = contexteAudio.createAnalyser();
                analyseur.fftSize = 512;
                donnees = new Uint8Array(analyseur.fftSize);
                source = contexteAudio.createMediaStreamSource(flux);
                source.connect(analyseur);   // pas relié aux haut-parleurs : aucun retour de son
            } catch { analyseur = null; }
            relancer();
        },
        silence() {
            etat.ecoute = false;
            try { source?.disconnect(); } catch { /* déjà déconnecté */ }
            source = null; analyseur = null;
            relancer();
        },
        analyse(actif) {
            etat.analyse = !!actif;
            relancer();
        }
    };

    preparerCiel();
    dessinerOrbe(0);
    dessinerCiel(0);
    relancer();
})();
