import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MODES, normaliserEmail, validerMotDePasse, analyserDestinataires, nettoyerTitre, validerTexte,
    extensionPourMime, estMimeAutorise, mimeDeBase, estErreurTemporaire, delaiReessai,
    retirerEmojis, estMajoritairementArabe, LIMITES
} from '../lib/utils.js';

test('tous les modes du menu ont un prompt', () => {
    for (const mode of ['resume', 'cours', 'reunion', 'bullet', 'todo', 'brut']) {
        assert.ok(MODES[mode], `mode ${mode} manquant`);
    }
});

test('normaliserEmail', () => {
    assert.equal(normaliserEmail('  Jean.Dupont@Exemple.FR '), 'jean.dupont@exemple.fr');
    assert.equal(normaliserEmail('pas-un-email'), null);
    assert.equal(normaliserEmail({ $ne: null }), null);   // injection NoSQL
    assert.equal(normaliserEmail('a@b'), null);
});

test('validerMotDePasse', () => {
    assert.equal(validerMotDePasse('12345678'), null);
    assert.match(validerMotDePasse('court'), /au moins/);
    assert.ok(validerMotDePasse({ $gt: '' }));
    assert.ok(validerMotDePasse('x'.repeat(200)));
});

test('analyserDestinataires', () => {
    assert.deepEqual(analyserDestinataires('a@x.fr; B@x.fr, a@x.fr').emails, ['a@x.fr', 'b@x.fr']);
    assert.ok(analyserDestinataires('a@x.fr, nimporte').erreur);
    assert.ok(analyserDestinataires('').erreur);
    const trop = Array.from({ length: LIMITES.destinatairesMax + 1 }, (_, i) => `u${i}@x.fr`).join(',');
    assert.match(analyserDestinataires(trop).erreur, /Maximum/);
});

test('nettoyerTitre', () => {
    assert.equal(nettoyerTitre('  Réunion\r\nBcc: x@y.z  '), 'Réunion Bcc: x@y.z');
    assert.equal(nettoyerTitre(undefined), 'Enregistrement audio');
    assert.equal(nettoyerTitre('x'.repeat(500)).length, LIMITES.titreMax);
});

test('validerTexte', () => {
    assert.equal(validerTexte('bonjour'), null);
    assert.ok(validerTexte('   '));
    assert.ok(validerTexte(42));
    assert.ok(validerTexte('x'.repeat(LIMITES.texteMax + 1)));
});

test('types MIME', () => {
    assert.equal(mimeDeBase('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(extensionPourMime('audio/mp4'), '.m4a');
    assert.equal(extensionPourMime('audio/mpeg'), '.mp3');
    assert.ok(estMimeAutorise('video/mp4'));
    assert.ok(!estMimeAutorise('application/pdf'));
});

test('estErreurTemporaire', () => {
    assert.ok(estErreurTemporaire({ status: 503 }));
    assert.ok(estErreurTemporaire({ status: 429 }));
    assert.ok(estErreurTemporaire(new Error('got status: 503 UNAVAILABLE')));
    assert.ok(!estErreurTemporaire({ status: 400, message: 'INVALID_ARGUMENT' }));
    const abandon = new Error('503'); abandon.name = 'AbortError';
    assert.ok(!estErreurTemporaire(abandon));
});

test('delaiReessai croît exponentiellement', () => {
    assert.equal(delaiReessai(0, 0), 1000);
    assert.equal(delaiReessai(2, 0), 4000);
});

test('retirerEmojis et détection de l’arabe', () => {
    assert.equal(retirerEmojis('📚 Notes ✅ ok'), ' Notes ok');
    assert.equal(retirerEmojis('Élève à l’école'), 'Élève à l’école');
    assert.ok(estMajoritairementArabe('مرحبا بكم في الاجتماع'));
    assert.ok(!estMajoritairementArabe('Bonjour à tous'));
});

test('corrigerNombresArabes ne touche que les nombres en contexte arabe', async () => {
    const { corrigerNombresArabes } = await import('../lib/utils.js');
    assert.equal(corrigerNombresArabes('بنسبة 10٪'), 'بنسبة 01٪');
    assert.equal(corrigerNombresArabes('Budget 2026 : ميزانية'), 'Budget 2026 : ميزانية');
    assert.equal(corrigerNombresArabes('2026 ميزانية'), '6202 ميزانية');
});
